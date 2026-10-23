import type postgres from 'postgres';
import { getOrgConfig } from '../config.js';
import { getOpenIntent, setAwaitedBy, clearAwaitedBy } from './intents.js';

// Long-polls watched runs until one settles, the chunk elapses, or the budget spends out.
// Budget arithmetic is kernel-side over the awaiting run's own started_at; blocks on work, never on a human.

// `succeeded/failed/cancelled` are the terminal run states.
const TERMINAL_RUN = new Set(['succeeded', 'failed', 'cancelled']);
const FAILURE_CLASS = new Set(['failed']);

export interface AwaitedRunSnapshot {
  runId: string;
  status: string;
  /** The run's ask, head only — enough to recognize which deliverable settled. */
  prompt: string;
  /** The run's result (truncated) — terminal runs only. */
  result?: string;
  failure?: string;
}

export interface AwaitWorkResult {
  phase: 'all_settled' | 'settled' | 'still_running' | 'budget_spent' | 'nothing_to_await';
  runs: AwaitedRunSnapshot[];
  /** Runs that settled DURING this call — the news. */
  settledNow: string[];
  elapsedSec: number;
  remainingSec: number;
  note: string;
}

export interface AwaitWorkInput {
  orgId: string;
  threadId: string;
  /** The awaiting desk run — budget anchor + marker value. */
  runId: string;
  runIds?: string[];
  waitSeconds?: number;
  /** Test seams — production callers omit all three. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
}

interface SnapRow { id: string; status: string; prompt: string | null; output: unknown; failure: string | null }

function toSnapshot(rows: SnapRow[]): AwaitedRunSnapshot[] {
  return rows.map((r) => {
    const snap: AwaitedRunSnapshot = { runId: r.id, status: r.status, prompt: (r.prompt ?? '').slice(0, 200) };
    if (TERMINAL_RUN.has(r.status)) {
      const out = r.output as Record<string, unknown> | null;
      const result = out !== null && typeof out === 'object' && 'result' in out
        ? String((out as { result: unknown }).result) : out !== null ? JSON.stringify(out) : '';
      if (result.length > 0) snap.result = result.slice(0, 500);
      if (r.failure !== null && r.failure.length > 0) snap.failure = r.failure.slice(0, 400);
    }
    return snap;
  });
}

export async function awaitWork(sql: postgres.Sql, input: AwaitWorkInput): Promise<AwaitWorkResult> {
  const now = input.now ?? ((): number => Date.now());
  const sleep = input.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)));
  const pollMs = input.pollIntervalMs ?? 1500;

  const cfg = await getOrgConfig(sql, input.orgId);
  const budgetSec = cfg.chat.awaitBudgetSec;
  const chunkSec = Math.max(5, Math.min(input.waitSeconds ?? cfg.chat.awaitChunkSec, cfg.chat.awaitChunkSec));

  const [me] = await sql<{ started_at: Date | null }[]>`
    select started_at from runs where id = ${input.runId} and org_id = ${input.orgId}`;
  const startedMs = me?.started_at?.getTime() ?? now();
  const elapsedSec = (): number => Math.max(0, Math.round((now() - startedMs) / 1000));
  const remainingSec = (): number => Math.max(0, budgetSec - elapsedSec());

  // The watch set: explicit ids (this thread's runs only — cross-thread awaits refuse quietly),
  // else every live work run of the thread plus the mission parts' runs. Never the turn itself.
  const explicit = (input.runIds ?? []).filter((id) => id !== input.runId);
  const intent = await getOpenIntent(sql, input.orgId, input.threadId);
  let watchedIds: string[];
  if (explicit.length > 0) {
    const rows = await sql<{ id: string }[]>`
      select id from runs where org_id = ${input.orgId} and thread_id = ${input.threadId}
        and id in ${sql(explicit)}`;
    watchedIds = rows.map((r) => r.id);
  } else {
    // Live work runs + this turn's own dispatches (spawned since the turn started — covers the
    // fast-settle race where a run lands before the first await call) + mission part runs.
    const live = await sql<{ id: string }[]>`
      select id from runs where org_id = ${input.orgId} and thread_id = ${input.threadId}
        and kind = 'work'
        and (status = 'running' or created_at >= ${new Date(startedMs)})`;
    const fromParts = (intent?.parts ?? []).flatMap((p) => (p.runId !== undefined ? [p.runId] : []));
    watchedIds = [...new Set([...live.map((r) => r.id), ...fromParts])].filter((id) => id !== input.runId);
  }

  const snapshot = async (): Promise<SnapRow[]> => (watchedIds.length === 0 ? [] : sql<SnapRow[]>`
    select id, status, prompt, output, failure
    from runs
    where org_id = ${input.orgId} and id in ${sql(watchedIds)}`);

  const release = async (): Promise<void> => {
    if (intent !== null) await clearAwaitedBy(sql, { orgId: input.orgId, intentId: intent.id });
  };

  if (watchedIds.length === 0) {
    return {
      phase: 'nothing_to_await', runs: [], settledNow: [], elapsedSec: elapsedSec(), remainingSec: remainingSec(),
      note: 'no dispatched work to await in this thread — dispatch first, or just reply.',
    };
  }

  let snap = await snapshot();
  const terminalAtStart = new Set(snap.filter((r) => TERMINAL_RUN.has(r.status)).map((r) => r.id));

  if (terminalAtStart.size === watchedIds.length) {
    await release();
    return {
      phase: 'all_settled', runs: toSnapshot(snap), settledNow: [], elapsedSec: elapsedSec(), remainingSec: remainingSec(),
      note: 'every watched run is settled — review each outcome against the mission, mark its parts, and write the ONE final report in THIS reply. Nothing more to await.',
    };
  }

  if (remainingSec() <= 0) {
    await release();
    return {
      phase: 'budget_spent', runs: toSnapshot(snap), settledNow: [], elapsedSec: elapsedSec(), remainingSec: 0,
      note: 'await budget spent — end this reply honestly: what settled, what still runs. The mission wakes you when the rest lands; never claim an outcome you have not seen.',
    };
  }

  // Mark the mission awaited (idempotent; missionless dispatches need no marker).
  if (intent !== null && intent.status === 'open') {
    await setAwaitedBy(sql, { orgId: input.orgId, intentId: intent.id, runId: input.runId });
  }

  const deadlineMs = now() + Math.min(chunkSec, remainingSec()) * 1000;
  for (;;) {
    await sleep(pollMs);
    snap = await snapshot();
    const settledNow = snap.filter((r) => TERMINAL_RUN.has(r.status) && !terminalAtStart.has(r.id)).map((r) => r.id);
    if (settledNow.length > 0) {
      const failedNow = snap.filter((r) => FAILURE_CLASS.has(r.status) && settledNow.includes(r.id));
      const allTerminal = snap.every((r) => TERMINAL_RUN.has(r.status));
      if (allTerminal) {
        await release();
        return {
          phase: 'all_settled', runs: toSnapshot(snap), settledNow, elapsedSec: elapsedSec(), remainingSec: remainingSec(),
          note: (failedNow.length > 0
            ? 'settled with a FAILURE — handle it NOW (retry, revise, or ask ONE sharp question). '
            : '') +
            'every watched run is settled — review outcomes, mark the mission parts, and write the ONE final report in THIS reply. Nothing more to await.',
        };
      }
      return {
        phase: 'settled', runs: toSnapshot(snap), settledNow, elapsedSec: elapsedSec(), remainingSec: remainingSec(),
        note: (failedNow.length > 0
          ? 'a watched run FAILED — that is news you handle NOW (retry, revise, or ask ONE sharp question). '
          : `settled: ${settledNow.length} — `) +
          'narrate the news in one short line; the await continues for the rest.',
      };
    }
    if (remainingSec() <= 0) {
      await release();
      return {
        phase: 'budget_spent', runs: toSnapshot(snap), settledNow: [], elapsedSec: elapsedSec(), remainingSec: 0,
        note: 'await budget spent — end this reply honestly: what settled, what still runs. The mission wakes you when the rest lands; never claim an outcome you have not seen.',
      };
    }
    if (now() >= deadlineMs) {
      return {
        phase: 'still_running', runs: toSnapshot(snap), settledNow: [], elapsedSec: elapsedSec(), remainingSec: remainingSec(),
        note: `nothing new this beat — one short progress line only if there is real news; the await continues. Await budget remaining: ${remainingSec()}s.`,
      };
    }
  }
}
