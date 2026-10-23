import { isAbsolute, join, relative } from 'node:path';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { z } from 'zod';
import type postgres from 'postgres';
import { KEBAB_RE } from '@tent-nocode/core';
import { emitEvent } from './events.js';
import { projectArm } from './containment.js';
import { globToRegExp } from './tabs/media.js';
import { findActiveFolderGrant } from './consent.js';
import { resolveOperation } from './operations/registry.js';
import { runOperation, validateOperationInputs } from './operations/dispatch.js';
import { resolveCallTarget, runIntegrationCall } from './integrations/dispatch.js';
import { validateIntegrationParams } from './integrations/executor.js';
import { cronVerdict, intervalVerdict, scheduleVerdict } from './triggerClock.js';

// Event-condition triggers: edge-fired evaluation with zero LLM; a file_landed folder must hold a live grant at creation and every evaluation.

const ACTOR = 'kernel.triggers';
const MAX_TRACKED_FILES = 500;

// The trigger vocabulary lives in triggerSpecs.ts; re-exported for consumers.
export { TRIGGER_SPECS, TRIGGER_ACTIONS } from './triggerSpecs.js';
export type { TriggerKind, TriggerAction } from './triggerSpecs.js';
import { TRIGGER_SPECS, TRIGGER_ACTIONS, type TriggerKind, type TriggerAction } from './triggerSpecs.js';

export interface TriggerRow {
  id: string;
  orgId: string;
  /** The trigger lives with what it watches. */
  projectId: string | null;
  kind: TriggerKind;
  spec: Record<string, unknown>;
  action: TriggerAction;
  enabled: boolean;
  createdBy: string;
  revokedAt: string | null;
  createdAt: string;
  /** Last-fire info and the paused reason, derived from edge_state. */
  lastFiredAt: string | null;
  lastFireCount: number | null;
  pausedReason: string | null;
}

/** Deep validator shared by createTrigger and the raise gate: spec shape per kind, action through its real gate, the file_landed live-grant check. */
export async function validateTrigger(
  sql: postgres.Sql,
  input: { orgId: string; projectId: string | null; kind: string; spec: unknown; action: unknown },
): Promise<{ ok: true; kind: TriggerKind; spec: Record<string, unknown>; action: TriggerAction } | { ok: false; reason: string }> {
  const kindSchema = TRIGGER_SPECS[input.kind as TriggerKind];
  if (!kindSchema) return { ok: false, reason: `kind: unknown trigger kind '${String(input.kind)}' — one of ${Object.keys(TRIGGER_SPECS).join(', ')}` };
  const spec = kindSchema.safeParse(input.spec);
  if (!spec.success) {
    const i = spec.error.issues[0];
    return { ok: false, reason: `spec.${i?.path.join('.') ?? ''}: ${i?.message ?? 'invalid'}` };
  }
  const action = TRIGGER_ACTIONS.safeParse(input.action);
  if (!action.success) {
    const i = action.error.issues[0];
    return { ok: false, reason: `action.${i?.path.join('.') ?? ''}: ${i?.message ?? 'invalid'}` };
  }
  if (input.kind === 'dataset_threshold') {
    const s = spec.data as z.infer<typeof TRIGGER_SPECS.dataset_threshold>;
    const [ds] = await sql<{ id: string }[]>`
      select id from datasets
      where org_id = ${input.orgId} and ${projectArm(sql, input.projectId)} and name = ${s.dataset} and deleted_at is null`;
    if (!ds) return { ok: false, reason: `spec.dataset: no dataset named '${s.dataset}'` };
  }
  if (input.kind === 'file_landed') {
    const s = spec.data as z.infer<typeof TRIGGER_SPECS.file_landed>;
    if (!isAbsolute(s.folder)) return { ok: false, reason: 'spec.folder: must be an absolute path' };
    const grant = await findActiveFolderGrant(sql, input.orgId, s.folder);
    if (!grant) return { ok: false, reason: `spec.folder: '${s.folder}' has no live folder grant — grant it first (no new reach class)` };
  }
  if (input.kind === 'webhook_in') {
    const s = spec.data as z.infer<typeof TRIGGER_SPECS.webhook_in>;
    const [ep] = await sql<{ id: string }[]>`
      select id from webhook_endpoints
      where org_id = ${input.orgId} and token = ${s.endpoint} and revoked_at is null`;
    if (!ep) return { ok: false, reason: `spec.endpoint: no live webhook endpoint with that address` };
  }
  if (action.data.type === 'run_operation') {
    const op = await resolveOperation(sql, input.orgId, { name: action.data.operation }, input.projectId);
    if (!op) return { ok: false, reason: `action.operation: no active operation named '${action.data.operation}'` };
    const valid = await validateOperationInputs(sql, input.orgId, op.ioContract, action.data.inputs, input.projectId);
    if (!valid.ok) return { ok: false, reason: `action.inputs: ${valid.reason}` };
  } else if (action.data.type === 'call_integration') {
    // Missing params are allowed at creation; the fire refuses them and pauses the trigger.
    const target = await resolveCallTarget(sql, { orgId: input.orgId, connectionId: action.data.connection, endpoint: action.data.endpoint });
    if (!target.ok) return { ok: false, reason: `action.connection: ${target.refusal}` };
    const verdict = validateIntegrationParams(target.endpoint, action.data.params, { requireAll: false });
    if (!verdict.ok) return { ok: false, reason: `action.params: ${verdict.refusal}` };
  } else if (action.data.type === 'propose_work') {
    const [thread] = await sql<{ id: string }[]>`
      select id from threads where id = ${action.data.threadId} and org_id = ${input.orgId} and deleted_at is null`;
    if (!thread) return { ok: false, reason: `action.threadId: thread not found in org` };
  }
  // start_flow validates shape alone; a gone flow/entry refuses at fire.
  return { ok: true, kind: input.kind as TriggerKind, spec: spec.data as Record<string, unknown>, action: action.data };
}

export async function createTrigger(
  sql: postgres.Sql,
  input: { orgId: string; projectId: string | null; kind: string; spec: unknown; action: unknown; createdBy: string },
): Promise<{ ok: true; triggerId: string } | { ok: false; reason: string }> {
  const valid = await validateTrigger(sql, input);
  if (!valid.ok) return valid;
  const [row] = await sql<{ id: string }[]>`
    insert into triggers (org_id, project_id, kind, spec, action, created_by)
    values (${input.orgId}, ${input.projectId}, ${valid.kind}, ${sql.json(valid.spec as unknown as postgres.JSONValue)},
            ${sql.json(valid.action as unknown as postgres.JSONValue)}, ${input.createdBy})
    returning id`;
  await emitEvent(sql, {
    orgId: input.orgId, actor: ACTOR, type: 'trigger.created',
    payload: { triggerId: row!.id, kind: valid.kind, spec: valid.spec, actionType: valid.action.type },
  });
  return { ok: true, triggerId: row!.id };
}

/** Hard delete; the event carries the full record as the tombstone. */
export async function deleteTrigger(
  sql: postgres.Sql, input: { orgId: string; triggerId: string },
): Promise<void> {
  const [row] = await sql<{ id: string; kind: string; spec: Record<string, unknown>; action: Record<string, unknown> }[]>`
    delete from triggers where id = ${input.triggerId} and org_id = ${input.orgId}
    returning id, kind, spec, action`;
  if (!row) throw new Error(`trigger not found in org: ${input.triggerId}`);
  await emitEvent(sql, {
    orgId: input.orgId, actor: ACTOR, type: 'trigger.deleted',
    payload: { triggerId: row.id, kind: row.kind, spec: row.spec, action: row.action },
  });
}

export async function setTriggerEnabled(
  sql: postgres.Sql, input: { orgId: string; triggerId: string; enabled: boolean },
): Promise<void> {
  const rows = await sql<{ id: string }[]>`
    update triggers set enabled = ${input.enabled},
      edge_state = case when ${input.enabled} then coalesce(edge_state, '{}'::jsonb) - 'pausedReason' else edge_state end
    where id = ${input.triggerId} and org_id = ${input.orgId} and revoked_at is null
    returning id`;
  if (!rows[0]) throw new Error(`trigger not found in org: ${input.triggerId}`);
  await emitEvent(sql, {
    orgId: input.orgId, actor: ACTOR, type: input.enabled ? 'trigger.resumed' : 'trigger.paused',
    payload: { triggerId: input.triggerId },
  });
}

export async function listTriggers(sql: postgres.Sql, orgId: string): Promise<TriggerRow[]> {
  const rows = await sql<Array<Record<string, unknown>>>`
    select id, org_id, project_id, kind, spec, action, enabled, created_by, revoked_at, created_at, edge_state
    from triggers where org_id = ${orgId} order by created_at asc, id asc`;
  return rows.map((r) => {
    const es = (r['edge_state'] ?? {}) as Record<string, unknown>;
    return {
      id: r['id'] as string, orgId: r['org_id'] as string,
      projectId: (r['project_id'] as string | null) ?? null,
      kind: r['kind'] as TriggerKind,
      spec: r['spec'] as Record<string, unknown>, action: r['action'] as TriggerAction,
      enabled: r['enabled'] as boolean, createdBy: r['created_by'] as string,
      revokedAt: r['revoked_at'] ? new Date(r['revoked_at'] as string).toISOString() : null,
      createdAt: new Date(r['created_at'] as string).toISOString(),
      lastFiredAt: typeof es['lastFiredAt'] === 'string' ? es['lastFiredAt'] : null,
      lastFireCount: typeof es['lastFireCount'] === 'number' ? es['lastFireCount'] : null,
      pausedReason: typeof es['pausedReason'] === 'string' ? es['pausedReason'] : null,
    };
  });
}

/** Orgs with live triggers, for the sweep loop. */
export async function triggerSweepDueOrgs(sql: postgres.Sql, limit = 5): Promise<string[]> {
  const rows = await sql<{ org_id: string }[]>`
    select distinct org_id from triggers where enabled = true and revoked_at is null limit ${limit}`;
  return rows.map((r) => r.org_id);
}

async function disableTrigger(sql: postgres.Sql, orgId: string, triggerId: string, reason: string): Promise<void> {
  // The paused reason stays on the trigger row.
  await sql`update triggers set enabled = false,
    edge_state = coalesce(edge_state, '{}'::jsonb) || jsonb_build_object('pausedReason', ${reason}::text)
    where id = ${triggerId}`;
  await emitEvent(sql, { orgId, actor: ACTOR, type: 'trigger.disabled', payload: { triggerId, reason } });
}

function compare(value: number, op: string, threshold: number): boolean {
  switch (op) {
    case '>': return value > threshold;
    case '>=': return value >= threshold;
    case '<': return value < threshold;
    case '<=': return value <= threshold;
    default: return value === threshold;
  }
}

function listMatchingFiles(folder: string, glob: string): string[] {
  const re = globToRegExp(glob);
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (out.length >= MAX_TRACKED_FILES) return;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (out.length >= MAX_TRACKED_FILES) return;
      const abs = join(dir, name);
      let st;
      try { st = statSync(abs); } catch { continue; }
      if (st.isDirectory()) { walk(abs); continue; }
      const rel = relative(folder, abs).replaceAll('\\', '/');
      if (re.test(rel)) out.push(rel);
    }
  };
  walk(folder);
  return out.sort();
}

/** The evaluation sweep: per live trigger, decide the edge against edge_state and fire; one broken trigger never blocks the rest. */
export async function evaluateTriggers(sql: postgres.Sql, orgId: string): Promise<number> {
  const rows = await sql<Array<{ id: string; kind: TriggerKind; spec: Record<string, unknown>; action: TriggerAction; edge_state: Record<string, unknown>; created_by: string; project_id: string | null }>>`
    select id, kind, spec, action, edge_state, created_by, project_id from triggers
    where org_id = ${orgId} and enabled = true and revoked_at is null
    order by created_at asc, id asc`;
  let fired = 0;
  for (const t of rows) {
    try {
      const es = t.edge_state ?? {};
      // A revoked folder grant disables the trigger before anything else runs.
      if (t.kind === 'file_landed') {
        const s = t.spec as { folder: string };
        const grant = await findActiveFolderGrant(sql, orgId, s.folder);
        if (!grant) {
          await disableTrigger(sql, orgId, t.id, `folder grant for '${s.folder}' was revoked`);
          continue;
        }
      }
      // A fired flow run still pending/running = skip; a waiting run does not block.
      if (typeof es['activeFlowExecutionId'] === 'string') {
        const [fx] = await sql<{ status: string }[]>`
          select status from flow_executions where id = ${es['activeFlowExecutionId'] as string}`;
        if (fx && (fx.status === 'pending' || fx.status === 'running')) {
          await emitEvent(sql, { orgId, actor: ACTOR, type: 'trigger.skipped', payload: { triggerId: t.id, reason: 'previous_active' } });
          continue;
        }
      }
      // Skip while a fired execution, an unanswered card, or a live work job is still active.
      if (typeof es['activeExecutionId'] === 'string') {
        // The execution table matches the action kind.
        const [ex] = t.action.type === 'call_integration'
          ? await sql<{ status: string }[]>`
              select status from integration_executions where id = ${es['activeExecutionId'] as string}`
          : await sql<{ status: string }[]>`
              select status from operation_executions where id = ${es['activeExecutionId'] as string}`;
        if (ex && (ex.status === 'pending' || ex.status === 'running')) {
          await emitEvent(sql, { orgId, actor: ACTOR, type: 'trigger.skipped', payload: { triggerId: t.id, reason: 'previous_active' } });
          continue;
        }
      }
      if (t.action.type === 'propose_work') {
        if (typeof es['activeCardId'] === 'string') {
          const [card] = await sql<{ answer: unknown }[]>`
            select answer from messages where id = ${es['activeCardId'] as string}`;
          if (card && card.answer === null) {
            await emitEvent(sql, { orgId, actor: ACTOR, type: 'trigger.skipped', payload: { triggerId: t.id, reason: 'previous_active' } });
            continue;
          }
        }
        const live = await sql<{ id: string }[]>`
          select id from runs where org_id = ${orgId} and thread_id = ${t.action.threadId} and kind = 'work'
            and status = 'running' limit 1`;
        if (live[0]) {
          await emitEvent(sql, { orgId, actor: ACTOR, type: 'trigger.skipped', payload: { triggerId: t.id, reason: 'previous_running' } });
          continue;
        }
      }

      // Read current state + decide the edge.
      let shouldFire = false;
      // A webhook fire carries its event payload into the flow.
      let firePayload: Record<string, unknown> | null = null;
      const nextState: Record<string, unknown> = { ...es };
      if (t.kind === 'dataset_threshold') {
        // Every new row past the watermark that passes the check fires; one fire per sweep carries all crossers.
        const s = t.spec as { dataset: string; column: string; op: string; value: number };
        const mark = typeof es['watermark'] === 'string' ? es['watermark'] : null;
        const rows = await sql<{ row: Record<string, unknown>; created_at: Date }[]>`
          select r.row, r.created_at from dataset_rows r join datasets d on d.id = r.dataset_id
          where d.org_id = ${orgId} and ${projectArm(sql, t.project_id, 'd')} and d.name = ${s.dataset} and d.deleted_at is null
            and (${mark}::timestamptz is null or r.created_at > ${mark}::timestamptz)
          order by r.created_at asc, r.id asc limit 200`;
        const newest = rows[rows.length - 1]?.created_at;
        if (newest !== undefined) nextState['watermark'] = newest.toISOString();
        else if (mark === null) nextState['watermark'] = new Date(0).toISOString();
        const crossed = mark === null ? [] : rows
          .map((r) => r.row)
          .filter((r) => { const v = Number(r[s.column]); return Number.isFinite(v) && compare(v, s.op, s.value); });
        shouldFire = crossed.length > 0;
        if (shouldFire) firePayload = { rows: crossed, ...crossed[0] };
      } else if (t.kind === 'output_registered') {
        const s = t.spec as { name?: string; kind?: 'array' | 'raster' };
        const [row] = await sql<{ id: string }[]>`
          select id from derived_outputs
          where org_id = ${orgId} and ${projectArm(sql, t.project_id)} and status = 'registered'
            and (${s.name ?? null}::text is null or name = ${s.name ?? null})
            and (${s.kind ?? null}::text is null or kind = ${s.kind ?? null})
          order by created_at desc, id desc limit 1`;
        const lastId = row?.id ?? null;
        shouldFire = lastId !== null && lastId !== es['lastId'];
        // Arm on first sight: the first evaluation observes without firing.
        if (es['lastId'] === undefined && lastId !== null) shouldFire = false;
        nextState['lastId'] = lastId;
      } else if (t.kind === 'schedule' || t.kind === 'cron' || t.kind === 'interval') {
        // The three clock kinds: pure verdicts from triggerClock.ts.
        const now = new Date();
        const v = t.kind === 'interval'
          ? intervalVerdict(t.spec as { minutes: number }, es, now)
          : t.kind === 'schedule'
            ? scheduleVerdict(t.spec as { time: string }, es, now)
            : cronVerdict(t.spec as { expr: string }, es, now);
        shouldFire = v.fire;
        Object.assign(nextState, v.nextState);
      } else if (t.kind === 'webhook_in') {
        // Fire once per verified arriving event; the optional event filter gates on the payload value at `path`.
        const s = t.spec as { endpoint: string; event?: { path: string; oneOf: string[] } };
        const [ev] = await sql<{ id: string; payload: Record<string, unknown> | null }[]>`
          select e.id, e.payload from integration_webhook_events e
          join webhook_endpoints w on w.id = e.endpoint_id
          where e.org_id = ${orgId} and w.token = ${s.endpoint}
          order by e.id desc limit 1`;
        const lastId = ev?.id === undefined ? null : String(ev.id);
        shouldFire = lastId !== null && es['lastEventId'] !== undefined && lastId !== es['lastEventId'];
        if (shouldFire && s.event !== undefined) {
          let v: unknown = ev?.payload ?? {};
          for (const seg of s.event.path.split('.')) {
            v = typeof v === 'object' && v !== null ? (v as Record<string, unknown>)[seg] : undefined;
          }
          if (typeof v !== 'string' || !s.event.oneOf.includes(v)) shouldFire = false;
        }
        if (shouldFire) firePayload = ev?.payload ?? {};
        nextState['lastEventId'] = lastId;
      } else if (t.kind === 'rows_changed') {
        // Fires when a table gains a row; the optional `where` narrows the watched rows.
        const s = t.spec as { dataset: string; where?: { column: string; equals: string } };
        const [row] = await sql<{ id: string; row: Record<string, unknown> }[]>`
          select r.id, r.row from dataset_rows r join datasets d on d.id = r.dataset_id
          where d.org_id = ${orgId} and ${projectArm(sql, t.project_id, 'd')} and d.name = ${s.dataset} and d.deleted_at is null
            and (${s.where?.column ?? null}::text is null or r.row->>${s.where?.column ?? null} = ${s.where?.equals ?? null})
          order by r.created_at desc, r.id desc limit 1`;
        const lastId = row?.id ?? null;
        shouldFire = lastId !== null && es['lastRowId'] !== undefined && lastId !== es['lastRowId'];
        if (shouldFire) firePayload = row?.row ?? {};
        nextState['lastRowId'] = lastId;
      } else {
        const s = t.spec as { folder: string; glob: string };
        if (!existsSync(s.folder)) {
          await emitEvent(sql, { orgId, actor: ACTOR, type: 'trigger.skipped', payload: { triggerId: t.id, reason: 'folder_missing' } });
          continue;
        }
        const files = listMatchingFiles(s.folder, s.glob);
        const known = new Set(Array.isArray(es['files']) ? (es['files'] as string[]) : []);
        const fresh = files.filter((f) => !known.has(f));
        // Arm on first sight.
        shouldFire = es['files'] !== undefined && fresh.length > 0;
        nextState['files'] = files;
      }

      // The fire and the edge-state update share one transaction — a crossing never double-fires.
      await sql.begin(async (tx) => {
        const txSql = tx as unknown as postgres.Sql;
        if (shouldFire) {
          if (t.action.type === 'run_operation') {
            const res = await runOperation(txSql, {
              orgId, projectId: t.project_id, operation: t.action.operation, inputs: t.action.inputs,
              trigger: { kind: 'trigger', triggerId: t.id }, createdBy: t.created_by,
            });
            if (res.ok) {
              nextState['activeExecutionId'] = res.executionId;
            } else {
              nextState['pausedReason'] = 'refusal' in res ? res.refusal : ('reason' in res ? res.reason : 'the fire refused');
            await txSql`update triggers set enabled = false where id = ${t.id}`;
              await emitEvent(txSql, { orgId, actor: ACTOR, type: 'trigger.disabled', payload: { triggerId: t.id, reason: res.reason } });
            }
          } else if (t.action.type === 'call_integration') {
            // A fire-time refusal disables the trigger with its reason.
            const res = await runIntegrationCall(txSql, {
              orgId, connectionId: t.action.connection, endpoint: t.action.endpoint,
              params: t.action.params, trigger: { kind: 'trigger', triggerId: t.id }, createdBy: t.created_by,
            });
            if (res.ok) {
              nextState['activeExecutionId'] = res.executionId;
            } else {
              nextState['pausedReason'] = res.refusal;
              await txSql`update triggers set enabled = false where id = ${t.id}`;
              await emitEvent(txSql, { orgId, actor: ACTOR, type: 'trigger.disabled', payload: { triggerId: t.id, reason: res.refusal } });
            }
          } else if (t.action.type === 'start_flow') {
            // Entry-scoped flow run; a gone flow/entry disables with its reason.
            const { getFlow, startFlowExecution } = await import('./flows/store.js');
            const flow = await getFlow(txSql, orgId, { projectId: t.project_id ?? undefined, name: t.action.flow });
            const res = flow === null
              ? { ok: false as const, refusal: `no flow named '${t.action.flow}' here` }
              : await startFlowExecution(txSql, {
                orgId, flowId: flow.id, entry: t.action.entry,
                // The fresh event/row payload is the trigger item.
                trigger: { kind: t.kind, triggerId: t.id, firedAt: new Date().toISOString(), ...(firePayload ?? {}) },
              });
            if (res.ok) {
              nextState['activeFlowExecutionId'] = res.executionId;
            } else {
              nextState['pausedReason'] = res.refusal;
              await txSql`update triggers set enabled = false where id = ${t.id}`;
              await emitEvent(txSql, { orgId, actor: ACTOR, type: 'trigger.disabled', payload: { triggerId: t.id, reason: res.refusal } });
            }
          } else {
            // Dynamic import: triggers and the action registry form a module cycle.
            const { raiseGovernedAction } = await import('./chat/governed.js');
            const res = await raiseGovernedAction(txSql, {
              orgId, threadId: t.action.threadId, action: 'work_proposal',
              params: { goal: t.action.goal, rationale: `fired by a standing trigger (${t.kind})`, brief: t.action.brief, role: t.action.role },
            });
            if (res && res.status !== 'invalid' && res.cardId) nextState['activeCardId'] = res.cardId;
          }
          // Record when the fire happened and how many rows rode it.
          nextState['lastFiredAt'] = new Date().toISOString();
          nextState['lastFireCount'] = Array.isArray(firePayload?.['rows']) ? (firePayload['rows'] as unknown[]).length : 1;
          await emitEvent(txSql, {
            orgId, actor: ACTOR, type: 'trigger.fired',
            payload: { triggerId: t.id, kind: t.kind, actionType: t.action.type },
          });
        }
        await txSql`update triggers set edge_state = ${txSql.json(nextState as unknown as postgres.JSONValue)} where id = ${t.id}`;
      });
      if (shouldFire) fired++;
    } catch (err) {
      console.error('evaluateTriggers error for trigger', t.id, err instanceof Error ? err.message : String(err));
    }
  }
  return fired;
}
