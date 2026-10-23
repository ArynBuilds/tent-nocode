// The one door for integration calls: resolve, validate, budget-check, queue; the sweep does the calling.
import type postgres from 'postgres';
import { emitEvent } from '../events.js';
import { getOrgConfig } from '../config.js';
import { integrationSpecHash, resolveIntegrationDef, type IntegrationDef, type IntegrationEndpointDef } from './catalog.js';
import { paramsWithSettingsDefaults, validateIntegrationParams, type IntegrationParams } from './executor.js';
import { getIntegrationConnection, type IntegrationConnectionRow } from './connections.js';

const ACTOR = 'kernel.integrations';

/** Trigger provenance; additive - nothing switches exhaustively on it. */
export type IntegrationTrigger =
  | { kind: 'human'; by: string }
  | { kind: 'scene_action'; sceneSlug: string; action: string }
  | { kind: 'chain'; chainId: string }
  | { kind: 'trigger'; triggerId: string }
  | { kind: 'run'; runId: string }
  | { kind: 'chat'; threadId: string }
  | { kind: 'sync' }
  | { kind: 'import'; importId: string };

export interface IntegrationExecutionRow {
  id: string;
  org_id: string;
  project_id: string;
  connection_id: string;
  integration: string;
  version: number;
  endpoint: string;
  class: 'read' | 'write' | 'send';
  params: IntegrationParams;
  trigger: Record<string, unknown>;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  error: string | null;
  http_status: number | null;
  result: unknown;
  started_at: Date | null;
  finished_at: Date | null;
  duration_ms: number | null;
  created_at: Date;
}

export type RunIntegrationResult = { ok: true; executionId: string } | { ok: false; refusal: string };

/** Resolve the (connection, def, endpoint) triple with every wall checked; the sweep re-verifies at fire time. */
export async function resolveCallTarget(
  sql: postgres.Sql,
  input: { orgId: string; connectionId: string; endpoint: string },
): Promise<
  | { ok: true; connection: IntegrationConnectionRow; def: IntegrationDef; endpoint: IntegrationEndpointDef }
  | { ok: false; refusal: string }
> {
  const connection = await getIntegrationConnection(sql, input.orgId, input.connectionId);
  if (!connection || connection.revoked_at) return { ok: false, refusal: 'that connection is already gone' };
  if (connection.status === 'unconnected') {
    // The node places free; the call refuses until connected.
    return { ok: false, refusal: `${connection.label} is not connected yet - connect it first` };
  }
  const def = resolveIntegrationDef(connection.integration, connection.version);
  if (!def) return { ok: false, refusal: `"${connection.integration}" is not in the integration catalog` };
  if (integrationSpecHash(def) !== connection.spec_hash) {
    return { ok: false, refusal: `${def.displayName} changed since it was connected - reconnect it to accept the new shape` };
  }
  const endpoint = def.endpoints.find((e) => e.id === input.endpoint);
  if (!endpoint) return { ok: false, refusal: `${def.displayName} has no "${input.endpoint}"` };
  return { ok: true, connection, def, endpoint };
}

export interface RunIntegrationCallInput {
  orgId: string;
  connectionId: string;
  endpoint: string;
  params: IntegrationParams;
  trigger: IntegrationTrigger;
  createdBy: string;
}

export async function runIntegrationCall(sql: postgres.Sql, input: RunIntegrationCallInput): Promise<RunIntegrationResult> {
  const target = await resolveCallTarget(sql, input);
  if (!target.ok) return target;
  const { connection, def, endpoint } = target;

  // The node's settings fill unset params by name.
  const params = paramsWithSettingsDefaults(endpoint, input.params, connection.settings);
  const verdict = validateIntegrationParams(endpoint, params);
  if (!verdict.ok) return { ok: false, refusal: verdict.refusal };

  // Daily budgets per connection; sends tighter.
  const cfg = (await getOrgConfig(sql, input.orgId)).integrations;
  const [counts] = await sql<{ calls: string; sends: string }[]>`
    select count(*) as calls,
           count(*) filter (where class = 'send') as sends
    from integration_executions
    where connection_id = ${connection.id} and created_at >= date_trunc('day', now())`;
  if (Number(counts?.calls ?? 0) >= cfg.callsPerDayPerConnection) {
    return { ok: false, refusal: `${def.displayName} reached its daily call budget` };
  }
  if (endpoint.class === 'send' && Number(counts?.sends ?? 0) >= cfg.sendsPerDayPerConnection) {
    return { ok: false, refusal: `${def.displayName} reached its daily send budget` };
  }

  const trigger = { ...input.trigger, by: input.createdBy };
  const [row] = await sql<{ id: string }[]>`
    insert into integration_executions (org_id, project_id, connection_id, integration, version, endpoint, class, params, trigger)
    values (${input.orgId}, ${connection.project_id}, ${connection.id}, ${def.name}, ${def.version}, ${endpoint.id},
            ${endpoint.class}, ${sql.json(params as postgres.JSONValue)}, ${sql.json(trigger as postgres.JSONValue)})
    returning id`;
  if (!row) return { ok: false, refusal: 'the call could not be queued' };

  await emitEvent(sql, {
    orgId: input.orgId,
    actor: ACTOR,
    type: 'integration.call_queued',
    payload: { executionId: row.id, integration: def.name, endpoint: endpoint.id, class: endpoint.class, trigger: input.trigger.kind },
  });
  return { ok: true, executionId: row.id };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Read back the projected result of an execution queued by this scene's own action; null = not this page's to see. */
export async function getSceneActionExecutionResult(
  sql: postgres.Sql,
  input: { orgId: string; sceneSlug: string; executionId: string },
): Promise<{ status: 'pending' | 'succeeded' | 'failed'; result?: unknown; error?: string } | null> {
  if (!UUID_RE.test(input.executionId)) return null;
  const [row] = await sql<{ status: string; result: unknown; error: string | null }[]>`
    select status, result, error from integration_executions
    where org_id = ${input.orgId} and id = ${input.executionId}
      and trigger->>'kind' = 'scene_action' and trigger->>'sceneSlug' = ${input.sceneSlug}`;
  if (!row) return null;
  if (row.status === 'succeeded') return { status: 'succeeded', result: row.result };
  if (row.status === 'failed') return { status: 'failed', error: row.error ?? 'the call failed' };
  return { status: 'pending' };
}

/** Claim the oldest pending execution (for update skip locked - many sweepers, one claimant). */
export async function claimNextIntegrationExecution(
  sql: postgres.Sql,
  opts?: { orgId?: string },
): Promise<IntegrationExecutionRow | null> {
  const rows = opts?.orgId
    ? await sql<IntegrationExecutionRow[]>`
        update integration_executions set status = 'running', started_at = now()
        where id = (
          select id from integration_executions
          where status = 'pending' and org_id = ${opts.orgId}
          order by created_at asc, id asc limit 1
          for update skip locked)
        returning *`
    : await sql<IntegrationExecutionRow[]>`
        update integration_executions set status = 'running', started_at = now()
        where id = (
          select id from integration_executions
          where status = 'pending'
          order by created_at asc, id asc limit 1
          for update skip locked)
        returning *`;
  return rows[0] ?? null;
}

/** Settle a running execution; errors arrive pre-scrubbed by the executor. */
export async function settleIntegrationExecution(
  sql: postgres.Sql,
  input: { id: string; ok: boolean; error?: string; httpStatus?: number; result?: unknown },
): Promise<void> {
  const error = input.ok ? null : (input.error ?? 'failed').slice(0, 900);
  const [row] = await sql<{ org_id: string; integration: string; endpoint: string; started_at: Date | null }[]>`
    update integration_executions
    set status = ${input.ok ? 'succeeded' : 'failed'},
        error = ${error},
        http_status = ${input.httpStatus ?? null},
        result = ${input.result === undefined ? null : sql.json(input.result as postgres.JSONValue)},
        finished_at = now(),
        duration_ms = (extract(epoch from (now() - started_at)) * 1000)::int
    where id = ${input.id} and status = 'running'
    returning org_id, integration, endpoint, started_at`;
  if (!row) return; // already settled or never claimed - never throw from settle
  await emitEvent(sql, {
    orgId: row.org_id,
    actor: ACTOR,
    type: input.ok ? 'integration.call_succeeded' : 'integration.call_failed',
    payload: {
      executionId: input.id,
      integration: row.integration,
      endpoint: row.endpoint,
      ...(input.ok ? {} : { error: (error ?? '').slice(0, 300) }),
    },
  });
}
