import type postgres from 'postgres';
import {
  getOpenIntent, attachRunToInFlightPart, bumpWake, clearAwaitedBy, updateIntent,
  RESCUE_TANK_CAP, type IntentRow,
} from './intents.js';
import { spawnDeskTurn } from './chat.js';

// Mission wakes: quiet settles while siblings run, one review wake on the last settle, immediate wakes for failures and denials, and a tank-braked rescue for stalls.

type WakeOutcome = 'woken' | 'parked' | 'skipped';

// Un-budgeted wake spawn: event-bounded, never tank-metered.
async function spawnWake(
  sql: postgres.Sql,
  input: { orgId: string; threadId: string; userMessage: string; extraInput: Record<string, unknown> },
): Promise<'woken'> {
  await spawnDeskTurn(sql, {
    orgId: input.orgId, threadId: input.threadId,
    userMessage: input.userMessage, extraInput: input.extraInput,
  });
  return 'woken';
}

// Braked rescue spawn: each rescue burns tank; an empty tank parks the mission with one final wake.
async function spawnRescueWake(
  sql: postgres.Sql,
  input: { orgId: string; threadId: string; intent: IntentRow; userMessage: string; extraInput: Record<string, unknown> },
): Promise<Exclude<WakeOutcome, 'skipped'>> {
  if (input.intent.wakesUsed >= RESCUE_TANK_CAP) {
    const note = `rescue tank exhausted (${input.intent.wakesUsed} of ${RESCUE_TANK_CAP} used) — reply to continue or revise the mission`;
    await updateIntent(sql, { orgId: input.orgId, intentId: input.intent.id, status: 'parked', note });
    await spawnDeskTurn(sql, {
      orgId: input.orgId, threadId: input.threadId,
      userMessage: `LOOP PARKED: ${note}. Tell the user plainly what is done and what is not, and ask ONE sharp question.`,
      extraInput: { ...input.extraInput, loopParked: true },
    });
    return 'parked';
  }
  await bumpWake(sql, { orgId: input.orgId, intentId: input.intent.id });
  return spawnWake(sql, input);
}

// An awaited mission never wakes unless the marker is stale, which self-heals; true = stay quiet.
async function awaitedAndLive(
  sql: postgres.Sql, orgId: string, intent: IntentRow,
): Promise<boolean> {
  if (intent.awaitedBy === null) return false;
  const [live] = await sql<{ one: number }[]>`
    select 1 as one from runs
    where id = ${intent.awaitedBy} and org_id = ${orgId}
      and status = 'running'`;
  if (live) return true;
  await clearAwaitedBy(sql, { orgId, intentId: intent.id });
  return false;
}

// Settle hook: attach the settled run to a part; failure wakes now, quiet while siblings run, the last settle triggers the one review wake.
export async function maybeSpawnLoopWake(
  sql: postgres.Sql,
  input: { orgId: string; threadId: string; settledRunId: string },
): Promise<WakeOutcome> {
  const intent = await getOpenIntent(sql, input.orgId, input.threadId);
  if (!intent || intent.status !== 'open') return 'skipped';
  await attachRunToInFlightPart(sql, { orgId: input.orgId, threadId: input.threadId, runId: input.settledRunId });
  const outstanding = intent.parts.some((p) => p.status === 'pending' || p.status === 'in_flight');
  if (!outstanding) return 'skipped'; // nothing left to act on
  if (await awaitedAndLive(sql, input.orgId, intent)) return 'skipped';
  const [settled] = await sql<{ status: string }[]>`
    select status from runs where id = ${input.settledRunId} and org_id = ${input.orgId}`;
  if (settled?.status !== 'failed') {
    const [siblings] = await sql<{ n: number }[]>`
      select count(*)::int as n from runs
      where org_id = ${input.orgId} and thread_id = ${input.threadId} and kind = 'work'
        and status = 'running' and id != ${input.settledRunId}`;
    if ((siblings?.n ?? 0) > 0) return 'skipped';
  }
  return spawnWake(sql, {
    orgId: input.orgId, threadId: input.threadId,
    userMessage: `LOOP WAKE: run ${input.settledRunId.slice(0, 8)} settled — this is THE review: check every settled run against its part's acceptance line, mark ALL parts with cited evidence in ONE mission call, and deliver the assembled outcome (redispatch only what failed acceptance).`,
    extraInput: { loopWake: input.settledRunId },
  });
}

// A denial wakes the mission exactly like a failure does.
export async function wakeOnDeniedAction(
  sql: postgres.Sql,
  input: { orgId: string; threadId: string; deniedKind: string; note?: string | null },
): Promise<WakeOutcome> {
  const intent = await getOpenIntent(sql, input.orgId, input.threadId);
  if (!intent || intent.status !== 'open') return 'skipped';
  const outstanding = intent.parts.some((p) => p.status === 'pending' || p.status === 'in_flight');
  if (!outstanding) return 'skipped';
  if (await awaitedAndLive(sql, input.orgId, intent)) return 'skipped';
  const note = typeof input.note === 'string' && input.note.length > 0 ? ` The note: "${input.note.slice(0, 300)}"` : '';
  return spawnWake(sql, {
    orgId: input.orgId, threadId: input.threadId,
    userMessage: `LOOP WAKE: your ${input.deniedKind} was DENIED.${note} Reckon with it — revise the approach per the note, or mark the part blocked and ask ONE sharp question.`,
    extraInput: { loopDenied: input.deniedKind },
  });
}

// Rescue stalled missions: open intent, outstanding parts, no active work, no live desk turn, no unanswered escalation, untouched for staleMinutes.
export async function rescueStalledIntents(
  sql: postgres.Sql,
  opts?: { staleMinutes?: number; limit?: number },
): Promise<number> {
  const staleMinutes = opts?.staleMinutes ?? 5;
  const limit = opts?.limit ?? 3;
  const rows = await sql<{ org_id: string; thread_id: string }[]>`
    select i.org_id, i.thread_id from thread_intents i
    where i.status = 'open'
      and i.updated_at < now() - make_interval(mins => ${staleMinutes})
      and exists (select 1 from jsonb_array_elements(i.parts) p
                  where p->>'status' in ('pending', 'in_flight'))
      and not exists (select 1 from runs r
                  where r.org_id = i.org_id and r.thread_id = i.thread_id
                    and r.status = 'running')
      and not exists (select 1 from messages m
                  where m.org_id = i.org_id and m.type = 'escalation' and m.answered_at is null
                    and m.payload->>'threadId' = i.thread_id::text)
    order by i.updated_at asc limit ${limit}`;
  let rescued = 0;
  for (const row of rows) {
    const intent = await getOpenIntent(sql, row.org_id, row.thread_id);
    if (!intent || intent.status !== 'open') continue;
    await spawnRescueWake(sql, {
      orgId: row.org_id, threadId: row.thread_id, intent,
      userMessage: 'LOOP WAKE: the mission stalled with no work running — check the intent, mark the parts, act or park honestly.',
      extraInput: { loopRescue: true },
    });
    rescued++;
  }
  return rescued;
}
