import type postgres from 'postgres';

/**
 * Tier 28 (D-117/FR-315): the WORK-LANE warm-chain policy — kernel-owned, engine-neutral (the
 * session ref is opaque; the driver turns it into argv via the D-119 contract).
 *
 * A follow-up run on the same pinned workspace may resume the previous run's engine session —
 * paying only new tokens AND remembering its own last attempt — behind four walls:
 *   1. ARTIFACT + CWD: same `jobs.workspace_path` (pinned folders are claim-wall serialized,
 *      and engines scope sessions by working directory).
 *   2. FRESHNESS: the previous run settled within `domain.warmChainMaxAgeMin`.
 *   3. APPROVAL HYGIENE (the A2 wall): engines carry in-session tool approvals across resume —
 *      so a chain never crosses a HUMAN-ANSWERED permission ask. Any `permission.prompted` on
 *      the previous run that was not the auto-mode lift forces a cold start: the next job must
 *      re-ask its own asks (D-48 — the approval was consent for THAT job).
 *   4. CHAIN CAP: at `domain.warmChainMaxRuns` runs on one session, cold restart — deliberately
 *      far below any compaction territory (D-118).
 * A failed/cancelled latest run, a missing session ref, attempt > 1 (the caller's retry wall),
 * or any wall miss simply means COLD — never an error, never a log-worthy event.
 */
export interface WarmChainInput {
  orgId: string;
  workspacePath: string;
  maxAgeMin: number;
  maxRuns: number;
}

export async function findWarmChainRef(
  sql: postgres.Sql,
  input: WarmChainInput,
): Promise<string | null> {
  // Wall 1+2: the LATEST settled run for this workspace, succeeded, with a session, fresh.
  // Tier 32 wall (the 02:41 same-file specimen): a session left by an ISOLATED run lived in
  // a worktree cwd — its whole conversational worldview names paths that evaporated at
  // merge. Such sessions never become chain refs (the resume-INTO-isolation half lives in
  // the runner's warm condition).
  const prev = await sql<{ id: string; status: string; session_id: string | null }[]>`
    select r.id, r.status, r.session_id
    from runs r
    where r.org_id = ${input.orgId} and r.workspace_path = ${input.workspacePath}
      and r.status in ('succeeded', 'failed', 'cancelled')
      and r.finished_at is not null
      and r.finished_at > now() - make_interval(mins => ${input.maxAgeMin})
      and r.isolation is distinct from 'worktree'
    order by r.finished_at desc, r.id desc limit 1`;
  const head = prev[0];
  if (!head || head.status !== 'succeeded' || head.session_id === null) return null;

  // Wall 3: approval hygiene — a human-answered ask in the previous run poisons the chain
  // (the engine would carry that approval into a job it was never granted to). The auto-mode
  // lift (via = mode:auto) is not a human answer and would re-lift identically next run.
  const [asks] = await sql<{ n: string }[]>`
    select count(*) as n from events
    where org_id = ${input.orgId} and type = 'permission.prompted'
      and payload->>'runId' = ${head.id}
      and coalesce(payload->>'via', '') <> 'mode:auto'`;
  if (Number(asks!.n) > 0) return null;

  // Wall 4: chain cap — count the runs already riding this session.
  const [chain] = await sql<{ n: string }[]>`
    select count(*) as n from runs
    where org_id = ${input.orgId} and session_id = ${head.session_id}`;
  if (Number(chain!.n) >= input.maxRuns) return null;

  return head.session_id;
}
