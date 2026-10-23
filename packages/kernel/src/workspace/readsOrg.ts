import type { AgentRow, AgentStatus, EventRow, MemberRow, OrgConfig, ThreadIntent, ThreadIntentView, ThreadUsage } from '@tent-nocode/core';
import type postgres from 'postgres';
import { getOrgConfig } from '../config.js';
import { listEvents } from '../events.js';
import { z } from 'zod';
import { orgHealth, type HealthReport } from '../health.js';
import { assertOwnOrg, read, router } from './registry.js';

interface AgentDbRow {
  id: string;
  org_id: string;
  slug: string;
  status: AgentStatus;
  current_version: number;
  capability: string;
  created_at: Date;
  reserved: 'voice' | 'hands' | null;
}

export async function listAgentsImpl(sql: postgres.Sql, orgId: string): Promise<AgentRow[]> {
  const rows = await sql<AgentDbRow[]>`
    select id, org_id, slug, status, current_version, capability, created_at, reserved
    from agents
    where org_id = ${orgId}
    order by slug asc`;
  return rows.map((r) => ({
    id: r.id, orgId: r.org_id, slug: r.slug, status: r.status,
    currentVersion: r.current_version, capability: r.capability,
    createdAt: r.created_at.toISOString(), reserved: r.reserved,
  }));
}

export async function listMembersImpl(sql: postgres.Sql, orgId: string): Promise<MemberRow[]> {
  const rows = await sql<{ user_id: string; role: MemberRow['role']; email: string | null; display_name: string | null; created_at: Date }[]>`
    select om.user_id, om.role, p.email, p.display_name, om.created_at
    from org_members om
    left join profiles p on p.user_id = om.user_id
    where om.org_id = ${orgId}
    order by om.created_at asc`;
  return rows.map((r) => ({
    userId: r.user_id,
    role: r.role,
    email: r.email ?? '',
    displayName: r.display_name,
    createdAt: r.created_at.toISOString(),
  }));
}

export async function getOrgConfigImpl(sql: postgres.Sql, orgId: string): Promise<OrgConfig> {
  return getOrgConfig(sql, orgId);
}

export async function threadIntentImpl(sql: postgres.Sql, orgId: string, threadId: string): Promise<ThreadIntentView> {
  const [row] = await sql<{
    id: string; status: string; parts: ThreadIntent['parts']; wakes_used: number; note: string | null;
    created_at: Date; updated_at: Date;
  }[]>`
    select id, status, parts, wakes_used, note, created_at, updated_at from thread_intents
    where org_id = ${orgId} and thread_id = ${threadId}
    order by created_at desc limit 1`;

  const events = await sql<{ id: string; org_id: string | null; actor: string; type: string; payload: Record<string, unknown>; created_at: Date }[]>`
    select id, org_id, actor, type, payload, created_at from events
    where org_id = ${orgId} and type like ${'intent.%'} and payload->>'threadId' = ${threadId}
    order by id asc limit 200`;
  const eventRows: EventRow[] = events.map((e) => ({
    id: String(e.id), orgId: e.org_id, actor: e.actor, type: e.type,
    payload: e.payload, createdAt: e.created_at.toISOString(),
  }));

  if (!row) return { intent: null, events: eventRows };

  const runIds = row.parts.map((p) => p.runId).filter((j): j is string => typeof j === 'string');
  let spendTokens = 0;
  let spendUsd = 0;
  if (runIds.length > 0) {
    const [sum] = await sql<{ tokens: string | null; spent: string | null }[]>`
      select sum(tokens_used) as tokens, sum(cost_estimate) as spent from runs
      where org_id = ${orgId} and id = any(${runIds}::uuid[])`;
    spendTokens = Number(sum?.tokens ?? 0);
    spendUsd = Number(sum?.spent ?? 0);
  }

  return {
    intent: {
      id: row.id,
      status: row.status as ThreadIntent['status'],
      parts: row.parts,
      note: row.note,
      spendTokens,
      spendUsd,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    },
    events: eventRows,
  };
}

export async function orgHealthImpl(sql: postgres.Sql, orgId: string, _userId: string): Promise<HealthReport> {
  return orgHealth(sql, orgId);
}

export async function threadUsageImpl(sql: postgres.Sql, orgId: string, threadId: string): Promise<ThreadUsage> {
  const rows = await sql<{ run_id: string; tokens: string | null; spent: string | null }[]>`
    select r.id as run_id, sum(r.tokens_used) as tokens, sum(r.cost_estimate) as spent
    from runs r
    where r.org_id = ${orgId} and r.thread_id = ${threadId}
    group by r.id`;
  const byRun: ThreadUsage['byRun'] = {};
  let totalTokens = 0;
  for (const r of rows) {
    const tokens = Number(r.tokens ?? 0);
    byRun[r.run_id] = { tokens, spentUsd: Number(r.spent ?? 0) };
    totalTokens += tokens;
  }
  const config = await getOrgConfig(sql, orgId);
  return { totalTokens, byRun, capUsd: config.chat.autoBudgetUsdPerJob ?? null };
}

export async function listEventsImpl(
  sql: postgres.Sql, orgId: string, filter?: { type?: string; limit?: number; id?: string },
): Promise<EventRow[]> {
  const events = await listEvents(sql, { orgId, type: filter?.type, limit: filter?.limit, id: filter?.id });
  return events.map((e) => ({
    id: e.id.toString(),
    orgId: e.orgId,
    actor: e.actor,
    type: e.type,
    payload: e.payload,
    createdAt: e.createdAt.toISOString(),
  }));
}

const orgId = z.string();

export const orgReadsRouter = router({
  listAgents: read([orgId], async (ctx, org) => {
    assertOwnOrg(ctx.identity, org);
    return listAgentsImpl(ctx.sql, ctx.identity.orgId);
  }),
  listMembers: read([orgId], async (ctx, org) => {
    assertOwnOrg(ctx.identity, org);
    return listMembersImpl(ctx.sql, ctx.identity.orgId);
  }),
  getOrgConfig: read([orgId], async (ctx, org) => {
    assertOwnOrg(ctx.identity, org);
    return getOrgConfigImpl(ctx.sql, ctx.identity.orgId);
  }),
  threadIntent: read([orgId, z.string()], async (ctx, org, threadId) => {
    assertOwnOrg(ctx.identity, org);
    return threadIntentImpl(ctx.sql, ctx.identity.orgId, threadId);
  }),
  orgHealth: read([orgId], async (ctx, org) => {
    assertOwnOrg(ctx.identity, org);
    return orgHealthImpl(ctx.sql, ctx.identity.orgId, ctx.identity.userId);
  }),
  threadUsage: read([orgId, z.string()], async (ctx, org, threadId) => {
    assertOwnOrg(ctx.identity, org);
    return threadUsageImpl(ctx.sql, ctx.identity.orgId, threadId);
  }),
  listEvents: read([orgId, z.object({ type: z.string().optional(), limit: z.number().optional(), id: z.string().optional() }).optional()], async (ctx, org, filter) => {
    assertOwnOrg(ctx.identity, org);
    return listEventsImpl(ctx.sql, ctx.identity.orgId, filter);
  }),
});
