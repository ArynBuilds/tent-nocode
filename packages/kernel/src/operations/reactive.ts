import type postgres from 'postgres';
import { emitEvent } from '../events.js';
import { getOrgConfig } from '../config.js';
import { resolveOperation } from './registry.js';
import { runOperation, validateOperationInputs } from './dispatch.js';

// Reactive chains: watch output names and re-run their operation when a watched name registers.

const ACTOR = 'kernel.reactive';

export interface ReactiveChainRow {
  id: string;
  orgId: string;
  /** The chain lives with its operation's project. */
  projectId: string | null;
  operation: string;
  inputs: Record<string, unknown>;
  watch: string[];
  enabled: boolean;
  grantMode: 'ask-approved' | 'auto';
  createdBy: string;
  revokedAt: string | null;
  createdAt: string;
}

/** Checks whether adding candidate would let it transitively re-feed its own watch-set; returns the offending path or null. */
export function wouldCycle(
  chains: Array<{ operation: string; watch: string[]; produces: string[] }>,
  candidate: { operation: string; watch: string[]; produces: string[] },
): string[] | null {
  const all = [...chains, candidate];
  const watchSet = new Set(candidate.watch);
  const queue: Array<{ name: string; path: string[] }> = candidate.produces.map((n) => ({
    name: n, path: [candidate.operation, n],
  }));
  const visited = new Set<string>();
  while (queue.length > 0) {
    const { name, path } = queue.shift()!;
    if (watchSet.has(name)) return path;
    if (visited.has(name)) continue;
    visited.add(name);
    for (const chain of all) {
      if (!chain.watch.includes(name)) continue;
      for (const produced of chain.produces) {
        if (!visited.has(produced)) queue.push({ name: produced, path: [...path, chain.operation, produced] });
      }
    }
  }
  return null;
}

async function liveChainShapes(
  sql: postgres.Sql, orgId: string,
): Promise<Array<{ operation: string; watch: string[]; produces: string[] }>> {
  const rows = await sql<{ operation: string; watch: string[]; project_id: string | null }[]>`
    select operation, watch, project_id from reactive_chains
    where org_id = ${orgId} and enabled = true and revoked_at is null`;
  const shapes: Array<{ operation: string; watch: string[]; produces: string[] }> = [];
  for (const row of rows) {
    const op = await resolveOperation(sql, orgId, { name: row.operation }, row.project_id);
    shapes.push({ operation: row.operation, watch: row.watch, produces: op ? Object.keys(op.ioContract.outputs) : [] });
  }
  return shapes;
}

/** Resolves the op, validates the input template, derives the watch-set, and runs the cycle check. */
export async function validateReactiveChain(
  sql: postgres.Sql,
  input: { orgId: string; projectId: string | null; operation: string; inputs: Record<string, unknown> },
): Promise<
  | { ok: true; operation: string; projectId: string | null; inputs: Record<string, string | number | boolean>; watch: string[] }
  | { ok: false; reason: string }
> {
  const op = await resolveOperation(sql, input.orgId, { name: input.operation }, input.projectId);
  if (!op) return { ok: false, reason: `no active operation named '${input.operation}'` };
  const valid = await validateOperationInputs(sql, input.orgId, op.ioContract, input.inputs, op.projectId ?? input.projectId);
  if (!valid.ok) return valid;
  // watch = the template's output-typed input values; dataset inputs deliberately do not watch.
  const watch = Object.entries(op.ioContract.inputs)
    .filter(([, decl]) => decl.type === 'array' || decl.type === 'raster')
    .map(([key]) => valid.inputs[key])
    .filter((v): v is string => typeof v === 'string');
  if (watch.length === 0) {
    return { ok: false, reason: `'${input.operation}' takes no result to watch — a trigger re-runs it when table rows change` };
  }
  const candidate = { operation: op.name, watch, produces: Object.keys(op.ioContract.outputs) };
  const cycle = wouldCycle(await liveChainShapes(sql, input.orgId), candidate);
  if (cycle) {
    return { ok: false, reason: `this chain would create a cycle — it (transitively) feeds its own watch-set: ${cycle.join(' → ')}` };
  }
  // Chains carry template inputs alone; inline rows have no standing form.
  if (Object.values(valid.inputs).some((v) => typeof v === 'object')) {
    return { ok: false, reason: 'a chain cannot carry inline rows - name a dataset instead' };
  }
  return { ok: true, operation: op.name, projectId: op.projectId ?? input.projectId, inputs: valid.inputs as Record<string, string | number | boolean>, watch };
}

export async function createReactiveChain(
  sql: postgres.Sql,
  input: {
    orgId: string;
    projectId: string | null;
    operation: string;
    inputs: Record<string, unknown>;
    createdBy: string;
    grantMode: 'ask-approved' | 'auto';
  },
): Promise<{ ok: true; chainId: string; watch: string[] } | { ok: false; reason: string }> {
  const valid = await validateReactiveChain(sql, input);
  if (!valid.ok) return valid;
  const [row] = await sql<{ id: string }[]>`
    insert into reactive_chains (org_id, project_id, operation, inputs, watch, grant_mode, created_by)
    values (${input.orgId}, ${valid.projectId}, ${valid.operation}, ${sql.json(valid.inputs as unknown as postgres.JSONValue)},
            ${sql.array(valid.watch)}, ${input.grantMode}, ${input.createdBy})
    returning id`;
  await emitEvent(sql, {
    orgId: input.orgId, actor: ACTOR, type: 'reactive.chain_created',
    payload: { chainId: row!.id, operation: valid.operation, watch: valid.watch, grantMode: input.grantMode },
  });
  return { ok: true, chainId: row!.id, watch: valid.watch };
}

/** The row survives revoked; the event is the record. */
export async function revokeReactiveChain(
  sql: postgres.Sql, input: { orgId: string; chainId: string },
): Promise<void> {
  const rows = await sql<{ id: string; operation: string }[]>`
    update reactive_chains set revoked_at = now()
    where id = ${input.chainId} and org_id = ${input.orgId} and revoked_at is null
    returning id, operation`;
  if (!rows[0]) throw new Error(`reactive chain not found (or already revoked): ${input.chainId}`);
  await emitEvent(sql, {
    orgId: input.orgId, actor: ACTOR, type: 'reactive.chain_revoked',
    payload: { chainId: input.chainId, operation: rows[0].operation },
  });
}

export async function listReactiveChains(sql: postgres.Sql, orgId: string): Promise<ReactiveChainRow[]> {
  const rows = await sql<Array<Record<string, unknown>>>`
    select id, org_id, project_id, operation, inputs, watch, enabled, grant_mode, created_by, revoked_at, created_at
    from reactive_chains where org_id = ${orgId} order by created_at asc, id asc`;
  return rows.map((r) => ({
    id: r['id'] as string, orgId: r['org_id'] as string,
    projectId: (r['project_id'] as string | null) ?? null,
    operation: r['operation'] as string,
    inputs: r['inputs'] as Record<string, unknown>, watch: r['watch'] as string[],
    enabled: r['enabled'] as boolean, grantMode: r['grant_mode'] as 'ask-approved' | 'auto',
    createdBy: r['created_by'] as string,
    revokedAt: r['revoked_at'] ? new Date(r['revoked_at'] as string).toISOString() : null,
    createdAt: new Date(r['created_at'] as string).toISOString(),
  }));
}

/** Fires matching chains once per confirm; a fire-time refusal disables the chain with the reason evented. */
export async function fireReactiveChains(
  sql: postgres.Sql,
  input: { orgId: string; registeredNames: string[]; causedByRunId: string | null },
): Promise<{ fired: number; skipped: number }> {
  if (input.registeredNames.length === 0) return { fired: 0, skipped: 0 };
  const chains = await sql<{ id: string; operation: string; inputs: Record<string, unknown>; created_by: string; project_id: string | null }[]>`
    select id, operation, inputs, created_by, project_id from reactive_chains
    where org_id = ${input.orgId} and enabled = true and revoked_at is null
      and watch && ${sql.array(input.registeredNames)}
    order by created_at asc, id asc`;
  if (chains.length === 0) return { fired: 0, skipped: 0 };

  // A reactive-triggered parent deepens the cascade; manual work is depth 0.
  let parentDepth = 0;
  if (input.causedByRunId !== null) {
    const [parent] = await sql<{ trigger: Record<string, unknown> }[]>`
      select trigger from operation_executions where id = ${input.causedByRunId}`;
    if (parent && parent.trigger['kind'] === 'reactive' && typeof parent.trigger['depth'] === 'number') {
      parentDepth = parent.trigger['depth'];
    }
  }
  const depth = parentDepth + 1;
  const cfg = await getOrgConfig(sql, input.orgId);

  let fired = 0, skipped = 0;
  for (const chain of chains) {
    if (depth > cfg.reactive.maxChainDepth) {
      skipped++;
      await emitEvent(sql, {
        orgId: input.orgId, actor: ACTOR, type: 'reactive.depth_capped',
        payload: { chainId: chain.id, operation: chain.operation, depth, cap: cfg.reactive.maxChainDepth },
      });
      continue;
    }
    const [budget] = await sql<{ n: string }[]>`
      select count(*) as n from operation_executions
      where org_id = ${input.orgId} and trigger->>'chainId' = ${chain.id}
        and created_at >= date_trunc('day', now())`;
    if (Number(budget?.n ?? 0) >= cfg.reactive.dailyBudgetPerChain) {
      skipped++;
      await emitEvent(sql, {
        orgId: input.orgId, actor: ACTOR, type: 'reactive.budget_capped',
        payload: { chainId: chain.id, operation: chain.operation, cap: cfg.reactive.dailyBudgetPerChain },
      });
      continue;
    }
    const res = await runOperation(sql, {
      orgId: input.orgId, projectId: chain.project_id, operation: chain.operation, inputs: chain.inputs,
      trigger: { kind: 'reactive', chainId: chain.id, depth }, createdBy: chain.created_by,
    });
    if (res.ok) {
      fired++;
    } else {
      skipped++;
      await sql`update reactive_chains set enabled = false where id = ${chain.id}`;
      await emitEvent(sql, {
        orgId: input.orgId, actor: ACTOR, type: 'reactive.chain_disabled',
        payload: { chainId: chain.id, operation: chain.operation, reason: res.reason },
      });
    }
  }
  return { fired, skipped };
}
