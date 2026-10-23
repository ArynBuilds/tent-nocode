import type postgres from 'postgres';
import { z } from 'zod';
import { emitEvent } from '../events.js';

// Thread-attached mission record: outcome parts each carry a one-line acceptance test.

export const partStatusSchema = z.enum(['pending', 'in_flight', 'done', 'blocked', 'dropped']);
export type PartStatus = z.infer<typeof partStatusSchema>;

export const intentPartSchema = z.object({
  text: z.string().min(1),
  acceptance: z.string().min(1),
  status: partStatusSchema.default('pending'),
  runId: z.string().uuid().optional(),
  note: z.string().optional(),
});
export type IntentPart = z.infer<typeof intentPartSchema>;

export type IntentStatus = 'open' | 'done' | 'parked' | 'cancelled';

export interface IntentRow {
  id: string;
  orgId: string;
  threadId: string;
  status: IntentStatus;
  parts: IntentPart[];
  wakesUsed: number;
  note: string | null;
  // The chat run holding its turn open over this mission's settles; null when unawaited.
  awaitedBy: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

const ACTOR = 'kernel.intents';

function rowToIntent(r: {
  id: string; org_id: string; thread_id: string; status: string; parts: unknown;
  wakes_used: number; note: string | null; awaited_by: string | null; created_by: string | null;
  created_at: Date; updated_at: Date;
}): IntentRow {
  return {
    id: r.id, orgId: r.org_id, threadId: r.thread_id, status: r.status as IntentStatus,
    parts: z.array(intentPartSchema).parse(r.parts), wakesUsed: r.wakes_used, note: r.note,
    awaitedBy: r.awaited_by,
    createdBy: r.created_by, createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
  };
}

const SELECT_COLS = 'id, org_id, thread_id, status, parts, wakes_used, note, awaited_by, created_by, created_at, updated_at';

export interface CreateIntentInput {
  orgId: string;
  threadId: string;
  parts: { text: string; acceptance: string }[];
  createdBy: string | null;
}

// Writes the mission; any prior live intent on the thread is cancelled - one thread, one mission.
export async function createIntent(
  sql: postgres.Sql, input: CreateIntentInput,
): Promise<{ intentId: string }> {
  const fresh = z.array(intentPartSchema).min(1).parse(
    input.parts.map((p) => ({ text: p.text, acceptance: p.acceptance, status: 'pending' })),
  );
  return sql.begin(async (tx) => {
    const prior = await tx<{ id: string; parts: IntentPart[] }[]>`
      update thread_intents set status = 'cancelled', updated_at = now()
      where org_id = ${input.orgId} and thread_id = ${input.threadId} and status in ('open','parked')
      returning id, parts`;
    // Unsettled parts of a superseded mission carry forward as dropped tombstones.
    const tombstones: IntentPart[] = prior.flatMap((p) =>
      (p.parts ?? [])
        .filter((part) => part.status === 'pending' || part.status === 'in_flight')
        .map((part) => ({
          text: part.text, acceptance: part.acceptance, status: 'dropped' as const,
          note: 'superseded by a new mission',
        })),
    );
    const parts = [...fresh, ...tombstones];
    const [row] = await tx<{ id: string }[]>`
      insert into thread_intents (org_id, thread_id, parts, created_by)
      values (${input.orgId}, ${input.threadId}, ${tx.json(parts as unknown as postgres.JSONValue)}, ${input.createdBy})
      returning id`;
    if (!row) throw new Error('intent insert returned no row');
    for (const p of prior) {
      await emitEvent(tx as unknown as postgres.Sql, {
        orgId: input.orgId, actor: ACTOR, type: 'intent.cancelled',
        payload: { intentId: p.id, threadId: input.threadId, reason: 'superseded', supersededBy: row.id },
      });
    }
    await emitEvent(tx as unknown as postgres.Sql, {
      orgId: input.orgId, actor: ACTOR, type: 'intent.created',
      payload: { intentId: row.id, threadId: input.threadId, partCount: parts.length, parts },
    });
    return { intentId: row.id };
  }) as Promise<{ intentId: string }>;
}

// The thread's live mission (open or parked); done/cancelled intents are never returned.
export async function getOpenIntent(
  sql: postgres.Sql, orgId: string, threadId: string,
): Promise<IntentRow | null> {
  const rows = await sql<Parameters<typeof rowToIntent>[0][]>`
    select ${sql.unsafe(SELECT_COLS)} from thread_intents
    where org_id = ${orgId} and thread_id = ${threadId} and status in ('open','parked')
    order by created_at desc limit 1`;
  const row = rows[0];
  return row ? rowToIntent(row) : null;
}

export interface UpdateIntentInput {
  orgId: string;
  intentId: string;
  parts?: IntentPart[];
  status?: IntentStatus;
  note?: string;
}

// Every part settled with at least one done outcome completes the mission.
function allPartsDone(parts: IntentPart[]): boolean {
  return parts.every((p) => p.status === 'done' || p.status === 'dropped')
    && parts.some((p) => p.status === 'done');
}

// Revise the mission; revisions are evented, and finishing the last part flips the intent to done.
export async function updateIntent(sql: postgres.Sql, input: UpdateIntentInput): Promise<void> {
  const parts = input.parts === undefined ? undefined : z.array(intentPartSchema).parse(input.parts);
  await sql.begin(async (tx) => {
    const [old] = await tx<Parameters<typeof rowToIntent>[0][]>`
      select ${tx.unsafe(SELECT_COLS)} from thread_intents
      where id = ${input.intentId} and org_id = ${input.orgId} for update`;
    if (!old) throw new Error(`intent ${input.intentId} not found`);
    // An unsettled part can never simply vanish: any vanishing part is auto-tombstoned as dropped.
    let effectiveParts = parts;
    let autoDropped: string[] = [];
    if (parts !== undefined) {
      const oldParts = z.array(intentPartSchema).parse(old.parts);
      const nextTexts = new Set(parts.map((p) => p.text));
      const vanished = oldParts.filter((p) => p.status !== 'done' && p.status !== 'dropped' && !nextTexts.has(p.text));
      if (vanished.length > 0) {
        autoDropped = vanished.map((p) => p.text);
        effectiveParts = [
          ...parts,
          ...vanished.map((p) => ({
            ...p, status: 'dropped' as const,
            note: p.note ?? 'removed in a mission revision — no reason recorded',
          })),
        ];
      }
    }
    const next = {
      parts: effectiveParts ?? z.array(intentPartSchema).parse(old.parts),
      status: input.status ?? (old.status as IntentStatus),
      note: input.note ?? old.note,
    };
    // Only an open mission auto-completes; an explicit status write always wins.
    const finished = input.status === undefined && next.status === 'open' && allPartsDone(next.parts);
    if (finished) next.status = 'done';
    await tx`
      update thread_intents
      set parts = ${tx.json(next.parts as unknown as postgres.JSONValue)},
          status = ${next.status}, note = ${next.note}, updated_at = now()
      where id = ${input.intentId}`;
    const statusChanged = (input.status !== undefined && input.status !== old.status) || finished;
    const type = statusChanged && next.status === 'parked' ? 'intent.parked'
      : statusChanged && next.status === 'done' ? 'intent.completed'
      : statusChanged && next.status === 'cancelled' ? 'intent.cancelled'
      : 'intent.updated';
    await emitEvent(tx as unknown as postgres.Sql, {
      orgId: input.orgId, actor: ACTOR, type,
      payload: {
        intentId: input.intentId, threadId: old.thread_id,
        old: { parts: old.parts, status: old.status, note: old.note },
        new: next,
        ...(autoDropped.length > 0 ? { autoDropped } : {}),
      },
    });
  });
}

// Attach a settled work run to a runless part (in_flight, then done, then pending); false = nothing to attach to.
export async function attachRunToInFlightPart(
  sql: postgres.Sql, input: { orgId: string; threadId: string; runId: string },
): Promise<boolean> {
  return sql.begin(async (tx) => {
    const [row] = await tx<{ id: string; parts: unknown }[]>`
      select id, parts from thread_intents
      where org_id = ${input.orgId} and thread_id = ${input.threadId} and status = 'open'
      order by created_at desc limit 1 for update`;
    if (!row) return false;
    const parts = z.array(intentPartSchema).parse(row.parts);
    let partIdx = parts.findIndex((p) => p.status === 'in_flight' && p.runId === undefined);
    if (partIdx < 0) partIdx = parts.findIndex((p) => p.status === 'done' && p.runId === undefined);
    if (partIdx < 0) partIdx = parts.findIndex((p) => p.status === 'pending' && p.runId === undefined);
    if (partIdx < 0) return false;
    const next = parts.map((p, i) => (i === partIdx ? { ...p, runId: input.runId } : p));
    await tx`update thread_intents
      set parts = ${tx.json(next as unknown as postgres.JSONValue)}, updated_at = now()
      where id = ${row.id}`;
    return true;
  }) as Promise<boolean>;
}

// Intent blocks: bookkeeping writes applied directly, no consent card.

export type IntentBlock =
  | { kind: 'set'; parts: { text: string; acceptance: string }[] }
  | { kind: 'update'; partIdx: number; status: PartStatus; note?: string }
  | { kind: 'revise'; parts: IntentPart[] };

/** The plan wall: with an active plan, a part naming no planned row is refused - never added silently. */
async function offPlanRefusal(
  sql: postgres.Sql, orgId: string, threadId: string, texts: string[],
): Promise<string | null> {
  const { activeAppPlanForThread } = await import('../consent.js');
  const plan = await activeAppPlanForThread(sql, orgId, threadId);
  if (plan === null) return null;
  const rows = plan.rows as {
    tables?: { name: string }[]; screens?: { name: string }[]; flows?: string[]; services?: string[];
  };
  const names = [
    ...(rows.tables ?? []).map((t) => t.name),
    ...(rows.screens ?? []).map((s) => s.name),
    ...(rows.flows ?? []),
    ...(rows.services ?? []),
  ].map((n) => n.toLowerCase());
  const off = texts.filter((t) => !names.some((n) => t.toLowerCase().includes(n)));
  if (off.length === 0) return null;
  return `off-plan part${off.length === 1 ? '' : 's'}: ${off.map((t) => `'${t}'`).join(', ')} - `
    + `the approved plan (revision ${plan.revision}) is the scope ceiling; report the gap or revise the plan through app_plan`;
}

// Apply an intent block: set supersedes, update marks one part, revise replaces the parts array; missing targets are no-ops.
export async function applyIntentBlock(
  sql: postgres.Sql,
  input: { orgId: string; threadId: string; createdBy: string | null; block: IntentBlock },
): Promise<{ applied: boolean; intentId?: string; reason?: string }> {
  const { block } = input;
  if (block.kind === 'set') {
    const refusal = await offPlanRefusal(sql, input.orgId, input.threadId, block.parts.map((p) => p.text));
    if (refusal !== null) return { applied: false, reason: refusal };
    const { intentId } = await createIntent(sql, {
      orgId: input.orgId, threadId: input.threadId, parts: block.parts, createdBy: input.createdBy,
    });
    return { applied: true, intentId };
  }
  const intent = await getOpenIntent(sql, input.orgId, input.threadId);
  if (!intent) return { applied: false };
  if (block.kind === 'update') {
    const part = intent.parts[block.partIdx];
    if (!part) return { applied: false };
    const parts = intent.parts.map((p, i) => (i === block.partIdx
      ? { ...p, status: block.status, ...(block.note !== undefined ? { note: block.note } : {}) }
      : p));
    await updateIntent(sql, { orgId: input.orgId, intentId: intent.id, parts });
    return { applied: true, intentId: intent.id };
  }
  const liveTexts = block.parts
    .filter((p) => p.status !== 'dropped' && p.status !== 'done')
    .map((p) => p.text);
  const refusal = await offPlanRefusal(sql, input.orgId, input.threadId, liveTexts);
  if (refusal !== null) return { applied: false, reason: refusal };
  await updateIntent(sql, { orgId: input.orgId, intentId: intent.id, parts: block.parts });
  return { applied: true, intentId: intent.id };
}

// Fixed rescue-tank cap: a safety bound, never a tunable iteration budget.
export const RESCUE_TANK_CAP = 3;

// A user message resets the rescue tank to 0 and reopens a parked mission; evented, no-op when nothing changes.
export async function resetWakeTank(
  sql: postgres.Sql, input: { orgId: string; threadId: string },
): Promise<boolean> {
  const [row] = await sql<{ id: string; old_wakes: number; old_status: string }[]>`
    update thread_intents t
    set wakes_used = 0, status = 'open', updated_at = now()
    from (select id, wakes_used as old_wakes, status as old_status from thread_intents
          where org_id = ${input.orgId} and thread_id = ${input.threadId}
            and status in ('open', 'parked') and (wakes_used > 0 or status = 'parked')
          order by created_at desc limit 1 for update) prior
    where t.id = prior.id
    returning t.id, prior.old_wakes, prior.old_status`;
  if (!row) return false;
  await emitEvent(sql, {
    orgId: input.orgId, actor: ACTOR, type: 'intent.updated',
    payload: {
      intentId: row.id, threadId: input.threadId, tankReset: true,
      old: { wakesUsed: row.old_wakes, status: row.old_status }, new: { wakesUsed: 0, status: 'open' },
    },
  });
  return true;
}

// Mark the intent awaited by a live desk turn; only an open mission can be awaited.
export async function setAwaitedBy(
  sql: postgres.Sql, input: { orgId: string; intentId: string; runId: string },
): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    update thread_intents set awaited_by = ${input.runId}, updated_at = now()
    where id = ${input.intentId} and org_id = ${input.orgId} and status = 'open'
    returning id`;
  return rows.length > 0;
}

// Clear the awaited marker; idempotent.
export async function clearAwaitedBy(
  sql: postgres.Sql, input: { orgId: string; intentId: string },
): Promise<void> {
  await sql`
    update thread_intents set awaited_by = null, updated_at = now()
    where id = ${input.intentId} and org_id = ${input.orgId} and awaited_by is not null`;
}

// Count a rescue wake against the intent's tank; returns the new total.
export async function bumpWake(
  sql: postgres.Sql, input: { orgId: string; intentId: string },
): Promise<{ wakesUsed: number }> {
  const [row] = await sql<{ wakes_used: number }[]>`
    update thread_intents set wakes_used = wakes_used + 1, updated_at = now()
    where id = ${input.intentId} and org_id = ${input.orgId}
    returning wakes_used`;
  if (!row) throw new Error(`intent ${input.intentId} not found`);
  return { wakesUsed: row.wakes_used };
}
