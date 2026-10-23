import type postgres from 'postgres';

export interface EmitEventInput {
  orgId: string | null;
  actor: string;
  type: string;
  payload?: Record<string, unknown>;
}

export interface KernelEvent {
  id: bigint;
  orgId: string | null;
  actor: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

// Append one event; a table trigger guarantees immutability.
export async function emitEvent(sql: postgres.Sql, input: EmitEventInput): Promise<bigint> {
  const rows = await sql<{ id: string }[]>`
    insert into events (org_id, actor, type, payload)
    values (${input.orgId}, ${input.actor}, ${input.type}, ${sql.json((input.payload ?? {}) as unknown as postgres.JSONValue)})
    returning id`;
  const row = rows[0];
  if (!row) throw new Error('event insert returned no row');
  return BigInt(row.id);
}

export interface ListEventsFilter {
  orgId: string;
  type?: string;
  limit?: number;
  /** Exact-id lookup; cast to bigint, never widened to a fuzzy match. */
  id?: string;
}

// Read the last n events, newest first; `contains` narrows by type or payload text. `appFailures`
// is the running app's engine-failure lane: failed flow runs and failed service calls alone, joined
// to their project through the execution row; a flow's failing step (the last step its run entered)
// rides payload.step. Render errors and empty bindings are not recorded anywhere - they die in the page.
export async function recentEvents(
  sql: postgres.Sql,
  input: { orgId: string; limit?: number; contains?: string; appFailures?: { projectId: string | null } },
): Promise<KernelEvent[]> {
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
  const needle = typeof input.contains === 'string' && input.contains.length > 0 ? `%${input.contains}%` : null;
  const app = input.appFailures;
  const rows = await sql<
    { id: string; org_id: string | null; actor: string; type: string; payload: Record<string, unknown>; created_at: Date; step: string | null }[]
  >`
    select e.id, e.org_id, e.actor, e.type, e.payload, e.created_at,
      ${app !== undefined ? sql`(fe.envelope->'ran') ->> -1 as step` : sql`null::text as step`}
    from events e
    ${app !== undefined
      ? sql`
        left join flow_executions fe on e.type = 'flow.run_failed'
          and fe.id = (case when e.payload->>'executionId' ~ '^[0-9a-fA-F-]{36}$' then (e.payload->>'executionId')::uuid end)
        left join integration_executions ie on e.type = 'integration.call_failed'
          and ie.id = (case when e.payload->>'executionId' ~ '^[0-9a-fA-F-]{36}$' then (e.payload->>'executionId')::uuid end)`
      : sql``}
    where e.org_id = ${input.orgId}
    ${app !== undefined ? sql`and e.type in ('flow.run_failed', 'integration.call_failed')` : sql``}
    ${app !== undefined && app.projectId !== null ? sql`and coalesce(fe.project_id, ie.project_id) = ${app.projectId}` : sql``}
    ${needle !== null ? sql`and (e.type ilike ${needle} or e.payload::text ilike ${needle})` : sql``}
    order by e.id desc
    limit ${limit}`;
  return rows.map((r) => ({
    id: BigInt(r.id),
    orgId: r.org_id,
    actor: r.actor,
    type: r.type,
    payload: r.step !== null ? { ...r.payload, step: r.step } : r.payload,
    createdAt: r.created_at,
  }));
}

export async function listEvents(sql: postgres.Sql, filter: ListEventsFilter): Promise<KernelEvent[]> {
  const rows = await sql<
    { id: string; org_id: string | null; actor: string; type: string; payload: Record<string, unknown>; created_at: Date }[]
  >`
    select id, org_id, actor, type, payload, created_at from events
    where org_id = ${filter.orgId}
    ${filter.type ? sql`and type = ${filter.type}` : sql``}
    ${filter.id ? sql`and id = ${filter.id}::bigint` : sql``}
    order by id asc
    limit ${filter.limit ?? 100}`;
  return rows.map((r) => ({
    id: BigInt(r.id),
    orgId: r.org_id,
    actor: r.actor,
    type: r.type,
    payload: r.payload,
    createdAt: r.created_at,
  }));
}
