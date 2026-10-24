import type { ChatTurn, ConversationView, RunStatus, ThreadMode, ThreadOverview, ThreadRow } from '@nodeloom/core';
import type postgres from 'postgres';
import { z } from 'zod';
import { listProjects } from '../projects.js';
import { assertOwnOrg, read, router } from './registry.js';
import { mapMessageRow, mapRunRow, type MessageDbRow, type RunDbRow } from './reads.js';

interface ThreadDbRow {
  id: string;
  org_id: string;
  title: string;
  mode: ThreadMode | null;
  /** NOT NULL since migration 71. */
  project_id: string;
  created_by: string;
  created_at: Date;
}

function mapThreadRow(r: ThreadDbRow): ThreadRow {
  return {
    id: r.id,
    orgId: r.org_id,
    title: r.title,
    mode: r.mode,
    projectId: r.project_id,
    createdBy: r.created_by,
    createdAt: r.created_at.toISOString(),
  };
}

interface ThreadOverviewDbRow extends ThreadDbRow {
  open_gates: string | number;
  running: string | number;
  last_activity_at: Date;
}

export async function listThreadsImpl(sql: postgres.Sql, orgId: string): Promise<ThreadOverview[]> {
  const rows = await sql<ThreadOverviewDbRow[]>`
    select
      t.id, t.org_id, t.title, t.mode, t.project_id, t.created_by, t.created_at,
      coalesce(gates.n, 0) as open_gates,
      coalesce(running_runs.n, 0) as running,
      greatest(
        t.created_at,
        coalesce(msgs.last_at, t.created_at),
        coalesce(runs_all.last_at, t.created_at)
      ) as last_activity_at
    from threads t
    left join lateral (
      select count(*) as n from messages m
      where m.org_id = t.org_id and m.type = 'escalation' and m.answered_at is null
        and m.payload->>'threadId' = t.id::text
    ) gates on true
    left join lateral (
      select count(*) as n from runs r
      where r.thread_id = t.id and r.status = 'running'
    ) running_runs on true
    left join lateral (
      select max(m.created_at) as last_at from messages m
      where m.org_id = t.org_id and m.payload->>'threadId' = t.id::text
    ) msgs on true
    left join lateral (
      select max(r.created_at) as last_at from runs r
      where r.thread_id = t.id
    ) runs_all on true
    where t.org_id = ${orgId} and t.deleted_at is null
    order by last_activity_at desc`;

  return rows.map((r) => ({
    thread: mapThreadRow(r),
    openGates: Number(r.open_gates),
    running: Number(r.running),
    lastActivityAt: r.last_activity_at.toISOString(),
  }));
}

interface DeskRunDbRow {
  id: string;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  status: RunStatus;
  output: Record<string, unknown> | null;
  output_tail: string | null;
  failure: string | null;
}

export async function getConversationImpl(sql: postgres.Sql, orgId: string, threadId: string): Promise<ConversationView> {
  const [threadRow] = await sql<ThreadDbRow[]>`
    select id, org_id, title, mode, project_id, created_by, created_at from threads
    where id = ${threadId} and org_id = ${orgId} and deleted_at is null`;
  if (!threadRow) throw new Error(`thread not found: ${threadId}`);
  const thread = mapThreadRow(threadRow);

  const userMsgRows = await sql<{ id: string; created_at: Date; text: string }[]>`
    select id, created_at, payload->>'text' as text from messages
    where org_id = ${orgId} and type = 'chat' and payload->>'threadId' = ${threadId}
    order by created_at asc`;

  const deskRunRows = await sql<DeskRunDbRow[]>`
    select r.id, r.created_at, r.started_at, r.finished_at, r.status, r.output, r.output_tail, r.failure
    from runs r
    where r.org_id = ${orgId} and r.thread_id = ${threadId} and r.kind = 'chat'
    order by r.created_at asc`;

  const userTurns: ChatTurn[] = userMsgRows.map((m) => ({
    messageId: m.id, runId: null, role: 'user', text: m.text,
    status: null, outputTail: null, createdAt: m.created_at.toISOString(),
  }));
  const deskTurns: ChatTurn[] = deskRunRows.map((r) => {
    const result = r.output && typeof r.output['result'] === 'string' ? (r.output['result'] as string) : null;
    return {
      messageId: null, runId: r.id, role: 'desk', text: result ?? '',
      status: r.status, failure: r.failure, outputTail: r.output_tail, createdAt: r.created_at.toISOString(),
      startedAt: r.started_at?.toISOString() ?? null,
      finishedAt: r.finished_at?.toISOString() ?? null,
    };
  });
  const turns = [...userTurns, ...deskTurns].sort((a, b) => {
    const byTime = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    if (byTime !== 0) return byTime;
    return a.role === b.role ? 0 : a.role === 'user' ? -1 : 1;
  });

  const workRows = await sql<RunDbRow[]>`
    select id, org_id, agent_id, agent_version, status, verdict, verdict_by,
           cost_estimate, duration_ms, tokens_used, output_tail, output, failure,
           prompt, thread_id, kind, heartbeat_at, created_at, started_at, finished_at
    from runs
    where org_id = ${orgId} and thread_id = ${threadId} and kind = 'work'
    order by created_at asc`;
  const work = workRows.map(mapRunRow);

  const gateRows = await sql<MessageDbRow[]>`
    select id, org_id, from_run, to_run, type, payload, answered_at, answer, created_at
    from messages
    where org_id = ${orgId} and type = 'escalation'
      and payload->>'threadId' = ${threadId}
    order by created_at asc`;
  const gates = gateRows.map(mapMessageRow);

  return { thread, turns, work, gates };
}

const orgId = z.string();

export const chatReadsRouter = router({
  listThreads: read([orgId], async (ctx, org) => {
    assertOwnOrg(ctx.identity, org);
    return listThreadsImpl(ctx.sql, ctx.identity.orgId);
  }),

  listProjects: read([orgId], async (ctx, org) => {
    assertOwnOrg(ctx.identity, org);
    return listProjects(ctx.sql, ctx.identity.orgId);
  }),

  getConversation: read([orgId, z.string()], async (ctx, org, threadId) => {
    assertOwnOrg(ctx.identity, org);
    return getConversationImpl(ctx.sql, ctx.identity.orgId, threadId);
  }),
});
