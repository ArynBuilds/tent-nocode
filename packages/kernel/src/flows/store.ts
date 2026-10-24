import type postgres from 'postgres';
import { flowDocSchema, flowEnvelopeSchema, mintFlowEnvelope, FLOW_DOC_VERSION, type FlowDoc, type FlowEffect, type FlowEnvelope } from '@nodeloom/core';
import { emitEvent } from '../events.js';
import { projectArm } from '../containment.js';

/** The flow store: flows hold the doc; flow_executions hold a doc snapshot + envelope, persisted every step. */

const ACTOR = 'kernel.flows';

export interface FlowRow {
  id: string;
  org_id: string;
  project_id: string;
  name: string;
  doc: FlowDoc;
  enabled: boolean;
}

export async function saveFlow(
  sql: postgres.Sql,
  input: { orgId: string; projectId: string; name: string; doc: unknown; by: string },
): Promise<{ ok: true; flowId: string } | { ok: false; errors: string[] }> {
  const parsed = flowDocSchema.safeParse(input.doc);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`) };
  }
  const [existing] = await sql<{ id: string }[]>`
    select id from flows
    where org_id = ${input.orgId} and project_id = ${input.projectId} and name = ${input.name} and deleted_at is null`;
  if (existing) {
    await sql`update flows set doc = ${sql.json(parsed.data as unknown as postgres.JSONValue)}, updated_at = now() where id = ${existing.id}`;
    await emitEvent(sql, { orgId: input.orgId, actor: ACTOR, type: 'flow.saved', payload: { flowId: existing.id, name: input.name, by: input.by } });
    return { ok: true, flowId: existing.id };
  }
  const [row] = await sql<{ id: string }[]>`
    insert into flows (org_id, project_id, name, doc, created_by)
    values (${input.orgId}, ${input.projectId}, ${input.name}, ${sql.json(parsed.data as unknown as postgres.JSONValue)}, ${input.by})
    returning id`;
  if (!row) return { ok: false, errors: ['the flow could not be saved'] };
  await emitEvent(sql, { orgId: input.orgId, actor: ACTOR, type: 'flow.saved', payload: { flowId: row.id, name: input.name, by: input.by } });
  return { ok: true, flowId: row.id };
}

export async function getFlow(
  sql: postgres.Sql, orgId: string, ref: { flowId?: string; projectId?: string; name?: string },
): Promise<FlowRow | null> {
  const [row] = ref.flowId !== undefined
    ? await sql<FlowRow[]>`select id, org_id, project_id, name, doc, enabled from flows where org_id = ${orgId} and id = ${ref.flowId} and deleted_at is null`
    : await sql<FlowRow[]>`
      select id, org_id, project_id, name, doc, enabled from flows
      where org_id = ${orgId} and ${projectArm(sql, ref.projectId ?? null)} and name = ${ref.name ?? ''} and deleted_at is null`;
  return row ?? null;
}

export async function listFlows(sql: postgres.Sql, orgId: string, projectId?: string): Promise<FlowRow[]> {
  return sql<FlowRow[]>`
    select id, org_id, project_id, name, doc, enabled from flows
    where org_id = ${orgId} and ${projectArm(sql, projectId ?? null)} and deleted_at is null order by name`;
}

export interface FlowExecutionRow {
  id: string;
  org_id: string;
  project_id: string;
  flow_id: string;
  doc: FlowDoc;
  envelope: FlowEnvelope;
  status: 'pending' | 'running' | 'waiting' | 'succeeded' | 'failed';
  steps_run: number;
  step_budget: number;
  deadline: Date;
  parent_execution_id: string | null;
  error: string | null;
}

/** Queue a run: the doc snapshots onto the row so edits never mutate a live run. */
export async function startFlowExecution(
  sql: postgres.Sql,
  input: {
    orgId: string; flowId: string;
    trigger?: Record<string, unknown>; inputs?: Record<string, unknown>;
    parentExecutionId?: string;
    /** A trigger names its entry step; absent = every entry step seeds. */
    entry?: string;
    /** Partial run overlay: seeded boundary results + the ready stack frontier. */
    seed?: { results: FlowEnvelope['results']; stack: FlowEnvelope['stack'] };
  },
): Promise<{ ok: true; executionId: string } | { ok: false; refusal: string }> {
  const flow = await getFlow(sql, input.orgId, { flowId: input.flowId });
  if (flow === null) return { ok: false, refusal: 'that flow is gone' };
  if (!flow.enabled) return { ok: false, refusal: `'${flow.name}' is switched off` };
  const doc = flowDocSchema.safeParse(flow.doc);
  if (!doc.success) return { ok: false, refusal: `'${flow.name}' does not parse — re-save it` };
  if (input.entry !== undefined && !(input.entry in doc.data.steps)) {
    return { ok: false, refusal: `no step '${input.entry}' in '${flow.name}'` };
  }
  const envelope = mintFlowEnvelope({ trigger: input.trigger ?? {}, inputs: input.inputs ?? {} });
  if (input.entry !== undefined) {
    envelope.stack.push({ step: input.entry, inputs: { in: [{ json: input.trigger ?? {} }] } });
  }
  // Partial-run overlay: a non-empty stack skips the engine's fresh-run auto-seed.
  if (input.seed !== undefined) {
    envelope.results = input.seed.results;
    envelope.stack.push(...input.seed.stack);
  }
  const [row] = await sql<{ id: string }[]>`
    insert into flow_executions (org_id, project_id, flow_id, doc, envelope, trigger, parent_execution_id)
    values (${input.orgId}, ${flow.project_id}, ${flow.id},
            ${sql.json(doc.data as unknown as postgres.JSONValue)},
            ${sql.json(envelope as unknown as postgres.JSONValue)},
            ${sql.json((input.trigger ?? {}) as postgres.JSONValue)},
            ${input.parentExecutionId ?? null})
    returning id`;
  if (!row) return { ok: false, refusal: 'the run could not be queued' };
  await emitEvent(sql, {
    orgId: input.orgId, actor: ACTOR, type: 'flow.run_queued',
    payload: { flowId: flow.id, executionId: row.id, name: flow.name },
  });
  return { ok: true, executionId: row.id };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A published page reads back only the run its own scene action started; null = not this page's to see. */
export async function getSceneActionFlowResult(
  sql: postgres.Sql,
  input: { orgId: string; sceneSlug: string; executionId: string },
): Promise<{ status: 'pending' | 'succeeded' | 'failed'; effects?: FlowEffect[]; error?: string } | null> {
  if (!UUID_RE.test(input.executionId)) return null;
  const [row] = await sql<{ status: string; envelope: unknown; error: string | null }[]>`
    select status, envelope, error from flow_executions
    where org_id = ${input.orgId} and id = ${input.executionId}
      and trigger->>'kind' = 'scene_action' and trigger->>'sceneSlug' = ${input.sceneSlug}`;
  if (!row) return null;
  if (row.status === 'failed') return { status: 'failed', error: (row.error ?? 'the flow failed').slice(0, 300) };
  if (row.status === 'succeeded') {
    const env = flowEnvelopeSchema.safeParse(row.envelope);
    return { status: 'succeeded', effects: env.success ? env.data.effects : [] };
  }
  return { status: 'pending' };
}

/** The sweeper's SKIP LOCKED claim over pending rows and waits whose wait_till has passed. */
export async function claimNextFlowExecution(sql: postgres.Sql, orgId?: string): Promise<FlowExecutionRow | null> {
  const rows = orgId !== undefined
    ? await sql<FlowExecutionRow[]>`
      update flow_executions set status = 'running', started_at = coalesce(started_at, now())
      where id = (
        select id from flow_executions
        where org_id = ${orgId} and (status = 'pending' or (status = 'waiting' and wait_till is not null and wait_till <= now()))
        order by created_at asc, id asc limit 1
        for update skip locked)
      returning *`
    : await sql<FlowExecutionRow[]>`
      update flow_executions set status = 'running', started_at = coalesce(started_at, now())
      where id = (
        select id from flow_executions
        where status = 'pending' or (status = 'waiting' and wait_till is not null and wait_till <= now())
        order by created_at asc, id asc limit 1
        for update skip locked)
      returning *`;
  const row = rows[0];
  if (row === undefined) return null;
  const env = flowEnvelopeSchema.safeParse(row.envelope);
  if (!env.success) {
    await sql`update flow_executions set status = 'failed', error = 'the run envelope does not parse', finished_at = now() where id = ${row.id}`;
    return null;
  }
  return { ...row, envelope: env.data };
}

/** Persist the envelope + counters after every step so a crash loses nothing. */
export async function persistFlowEnvelope(
  sql: postgres.Sql, executionId: string, envelope: FlowEnvelope, stepsRun: number,
): Promise<void> {
  await sql`update flow_executions
    set envelope = ${sql.json(envelope as unknown as postgres.JSONValue)}, steps_run = ${stepsRun}
    where id = ${executionId}`;
}

export async function settleFlowExecution(
  sql: postgres.Sql,
  input: { executionId: string; orgId: string; status: 'succeeded' | 'failed' | 'waiting'; error?: string; waitTill?: string | null },
): Promise<void> {
  if (input.status === 'waiting') {
    await sql`update flow_executions set status = 'waiting', wait_till = ${input.waitTill ?? null} where id = ${input.executionId}`;
  } else {
    await sql`update flow_executions
      set status = ${input.status}, error = ${input.error ?? null}, finished_at = now(), wait_till = null
      where id = ${input.executionId}`;
  }
  await emitEvent(sql, {
    orgId: input.orgId, actor: ACTOR, type: `flow.run_${input.status}`,
    payload: { executionId: input.executionId, ...(input.error !== undefined ? { error: input.error } : {}) },
  });
}
