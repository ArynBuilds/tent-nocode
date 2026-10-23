import type postgres from 'postgres';
import { emitEvent } from '../events.js';
import { projectArm } from '../containment.js';
import { resolveDerivedOutput } from '../scenes/derivedOutputs.js';
import { resolveOperation, type OperationContract } from './registry.js';

// Dispatch door: validates inputs against the declared io contract and records one execution row. No model on this path.

const ACTOR = 'kernel.operations';

export type OperationTrigger =
  | { kind: 'chat'; threadId: string }
  | { kind: 'scene_action'; sceneSlug: string; action: string }
  | { kind: 'run'; runId: string }
  // A reactive chain re-running its operation; depth is the cascade level the brakes read.
  | { kind: 'reactive'; chainId: string; depth: number }
  | { kind: 'trigger'; triggerId: string }
  // A human pressed Run; no thread to name.
  | { kind: 'human' };

export interface RunOperationInput {
  orgId: string;
  /** The caller's project; null = the serving/whole-account lane. */
  projectId: string | null;
  operation: string;
  version?: number;
  inputs: Record<string, unknown>;
  trigger: OperationTrigger;
  createdBy: string;
}

// Transit items landing as a dataset input: plain rows, capped.
export interface InlineRows { __rows: Array<Record<string, unknown>> }
export const INLINE_ROWS_CEILING = 5000;

export function isInlineRows(v: unknown): v is InlineRows {
  return typeof v === 'object' && v !== null && Array.isArray((v as InlineRows).__rows)
    && (v as InlineRows).__rows.every((r) => typeof r === 'object' && r !== null && !Array.isArray(r));
}

// Validate provided inputs against the contract; every refusal names the fix.
export async function validateOperationInputs(
  sql: postgres.Sql, orgId: string, contract: OperationContract, provided: Record<string, unknown>,
  projectId: string | null = null,
): Promise<{ ok: true; inputs: Record<string, string | number | boolean | InlineRows> } | { ok: false; reason: string }> {
  const out: Record<string, string | number | boolean | InlineRows> = {};
  for (const key of Object.keys(provided)) {
    if (!contract.inputs[key]) return { ok: false, reason: `unknown input '${key}' — the contract declares [${Object.keys(contract.inputs).join(', ')}]` };
  }
  for (const [key, decl] of Object.entries(contract.inputs)) {
    const value = provided[key];
    if (decl.type === 'param') {
      const v = value === undefined ? decl.default : value;
      if (v === undefined) return { ok: false, reason: `input '${key}' is required (${decl.valueType})` };
      if (typeof v !== decl.valueType) return { ok: false, reason: `input '${key}' must be a ${decl.valueType}` };
      out[key] = v as string | number | boolean;
      continue;
    }
    // Transit rows ride a dataset slot directly, capped.
    if (decl.type === 'dataset' && isInlineRows(value)) {
      if (value.__rows.length > INLINE_ROWS_CEILING) {
        return { ok: false, reason: `input '${key}': ${value.__rows.length} rows exceed the ${INLINE_ROWS_CEILING}-row inline ceiling` };
      }
      out[key] = value;
      continue;
    }
    if (typeof value !== 'string' || value.length === 0) {
      return { ok: false, reason: `input '${key}' names a ${decl.type === 'dataset' ? 'dataset' : decl.type === 'file' ? 'file path' : `registered ${decl.type} output`}` };
    }
    // File inputs are path strings; existence checks live at the executor.
    if (decl.type === 'file') {
      out[key] = value;
      continue;
    }
    if (decl.type === 'dataset') {
      const [ds] = await sql<{ id: string }[]>`
        select id from datasets
        where org_id = ${orgId} and ${projectArm(sql, projectId)} and name = ${value} and deleted_at is null`;
      if (!ds) return { ok: false, reason: `input '${key}': no dataset named '${value}'` };
    } else {
      const hit = await resolveDerivedOutput(sql, { orgId, projectId, name: value });
      if (!hit) return { ok: false, reason: `input '${key}': no registered output named '${value}'` };
      if (hit.kind !== decl.type) return { ok: false, reason: `input '${key}': output '${value}' is ${hit.kind}, the contract wants ${decl.type}` };
    }
    out[key] = value;
  }
  return { ok: true, inputs: out };
}

export async function runOperation(
  sql: postgres.Sql, input: RunOperationInput,
): Promise<{ ok: true; executionId: string; operation: string; version: number } | { ok: false; reason: string }> {
  const op = await resolveOperation(sql, input.orgId, {
    name: input.operation, ...(input.version !== undefined ? { version: input.version } : {}),
  }, input.projectId);
  if (!op) {
    return { ok: false, reason: input.version !== undefined
      ? `no operation '${input.operation}@${input.version}'`
      : `no active operation named '${input.operation}'` };
  }
  // An unbound dataset output has nowhere to land; refuse before compute burns.
  for (const [name, decl] of Object.entries(op.ioContract.outputs)) {
    if (decl.kind === 'dataset' && decl.dataset === undefined && decl.datasetFrom === undefined) {
      return { ok: false, reason: `output '${name}' declares rows but names no table — connect '${op.name}' to a table on the Map first` };
    }
  }
  const valid = await validateOperationInputs(sql, input.orgId, op.ioContract, input.inputs, input.projectId);
  if (!valid.ok) return valid;
  // The execution records the resolved op's project.
  const [row] = await sql<{ id: string }[]>`
    insert into operation_executions (org_id, project_id, operation, version, inputs, trigger)
    values (${input.orgId}, ${op.projectId ?? input.projectId}, ${op.name}, ${op.version},
            ${sql.json(valid.inputs as unknown as postgres.JSONValue)},
            ${sql.json({ ...input.trigger, by: input.createdBy } as unknown as postgres.JSONValue)})
    returning id`;
  await emitEvent(sql, {
    orgId: input.orgId, actor: ACTOR, type: 'operation.execution_queued',
    payload: { executionId: row!.id, operation: op.name, version: op.version, trigger: input.trigger.kind },
  });
  return { ok: true, executionId: row!.id, operation: op.name, version: op.version };
}

export interface ClaimedExecution {
  id: string;
  orgId: string;
  /** The execution's project; the executor materializes inputs and registers outputs within it. */
  projectId: string | null;
  operation: string;
  version: number;
  inputs: Record<string, string | number | boolean | InlineRows>;
}

// Claim the oldest pending execution; opts.orgId scopes the claim to one account.
export async function claimNextExecution(sql: postgres.Sql, opts?: { orgId?: string }): Promise<ClaimedExecution | null> {
  const orgArm = opts?.orgId !== undefined ? sql`and org_id = ${opts.orgId}` : sql``;
  const rows = await sql<Array<Record<string, unknown>>>`
    update operation_executions set status = 'running', started_at = now()
    where id = (
      select id from operation_executions where status = 'pending' ${orgArm}
      order by created_at asc, id asc limit 1
      for update skip locked)
    returning id, org_id, project_id, operation, version, inputs`;
  const r = rows[0];
  if (!r) return null;
  return {
    id: r['id'] as string, orgId: r['org_id'] as string,
    projectId: (r['project_id'] as string | null) ?? null,
    operation: r['operation'] as string, version: r['version'] as number,
    inputs: r['inputs'] as Record<string, string | number | boolean | InlineRows>,
  };
}

export async function settleExecution(
  sql: postgres.Sql,
  input: { orgId: string; executionId: string; ok: boolean; error?: string; outputs?: Record<string, string> },
): Promise<void> {
  await sql`
    update operation_executions
    set status = ${input.ok ? 'succeeded' : 'failed'},
        error = ${input.error?.slice(0, 900) ?? null},
        outputs = ${input.outputs !== undefined ? sql.json(input.outputs as unknown as postgres.JSONValue) : null},
        finished_at = now(),
        duration_ms = (extract(epoch from (now() - started_at)) * 1000)::int
    where id = ${input.executionId} and org_id = ${input.orgId} and status = 'running'`;
  await emitEvent(sql, {
    orgId: input.orgId, actor: ACTOR,
    type: input.ok ? 'operation.execution_succeeded' : 'operation.execution_failed',
    payload: { executionId: input.executionId, ...(input.error !== undefined ? { error: input.error.slice(0, 300) } : {}), ...(input.outputs !== undefined ? { outputs: Object.keys(input.outputs) } : {}) },
  });
}
