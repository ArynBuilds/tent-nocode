import type {
  ActivityRow, EventRow, JobKind, MessageRow,
  MessageType, RunRow, RunsOverviewDto, RunStatus, WorkRunView,
} from '@tent-nocode/core';
import type postgres from 'postgres';
import { findActiveFolderGrant } from '../consent.js';
import { z } from 'zod';
import { assertOwnOrg, read, router, type WorkspaceIdentity } from './registry.js';

interface RunsOverviewDbRow {
  id: string;
  status: RunStatus;
  heartbeat_at: Date | null;
}

export async function runsOverviewImpl(sql: postgres.Sql, orgId: string): Promise<RunsOverviewDto> {
  const rows = await sql<RunsOverviewDbRow[]>`
    select id, status, heartbeat_at
    from runs
    where org_id = ${orgId}`;

  let queued = 0;
  let running = 0;
  const runningRuns: RunsOverviewDto['runningRuns'] = [];

  for (const row of rows) {
    if (row.status === 'queued') queued += 1;
    else if (row.status === 'running') {
      running += 1;
      runningRuns.push({ id: row.id, heartbeatAt: row.heartbeat_at ? row.heartbeat_at.toISOString() : null });
    }
  }

  return { counts: { queued, running }, runningRuns };
}

export interface MessageDbRow {
  id: string;
  org_id: string;
  from_run: string | null;
  to_run: string | null;
  type: MessageType;
  payload: Record<string, unknown>;
  answered_at: Date | null;
  answer: Record<string, unknown> | null;
  created_at: Date;
}

export function mapMessageRow(r: MessageDbRow): MessageRow {
  return {
    id: r.id,
    orgId: r.org_id,
    fromRun: r.from_run,
    toRun: r.to_run,
    type: r.type,
    payload: r.payload,
    answeredAt: r.answered_at ? r.answered_at.toISOString() : null,
    answer: r.answer,
    createdAt: r.created_at.toISOString(),
  };
}

export interface RunDbRow {
  id: string;
  org_id: string;
  agent_id: string;
  agent_version: number;
  status: RunStatus;
  verdict: RunRow['verdict'];
  verdict_by: RunRow['verdictBy'];
  cost_estimate: string | number | null;
  duration_ms: number | null;
  tokens_used: number | null;
  output_tail: string | null;
  output: Record<string, unknown> | null;
  failure: string | null;
  prompt: string | null;
  thread_id: string | null;
  kind: JobKind;
  heartbeat_at: Date | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

export function mapRunRow(r: RunDbRow): RunRow {
  return {
    id: r.id,
    orgId: r.org_id,
    agentId: r.agent_id,
    agentVersion: r.agent_version,
    status: r.status,
    verdict: r.verdict,
    verdictBy: r.verdict_by,
    costEstimate: r.cost_estimate === null ? null : Number(r.cost_estimate),
    durationMs: r.duration_ms,
    tokensUsed: r.tokens_used,
    outputTail: r.output_tail,
    output: r.output,
    failure: r.failure,
    prompt: r.prompt,
    threadId: r.thread_id,
    kind: r.kind,
    heartbeatAt: r.heartbeat_at ? r.heartbeat_at.toISOString() : null,
    createdAt: r.created_at.toISOString(),
    startedAt: r.started_at ? r.started_at.toISOString() : null,
    finishedAt: r.finished_at ? r.finished_at.toISOString() : null,
  };
}

interface EventDbRow {
  id: string;
  org_id: string | null;
  actor: string;
  type: string;
  payload: Record<string, unknown>;
  created_at: Date;
}

function mapEventRow(r: EventDbRow): EventRow {
  return {
    id: r.id,
    orgId: r.org_id,
    actor: r.actor,
    type: r.type,
    payload: r.payload,
    createdAt: r.created_at.toISOString(),
  };
}

/** One work run's detail: the run row + its messages + its events. */
export async function getThreadImpl(sql: postgres.Sql, orgId: string, runId: string): Promise<WorkRunView> {
  const runRows = await sql<RunDbRow[]>`
    select id, org_id, agent_id, agent_version, status, verdict, verdict_by,
           cost_estimate, duration_ms, tokens_used, output_tail, output, failure,
           prompt, thread_id, kind, heartbeat_at, created_at, started_at, finished_at
    from runs
    where id = ${runId} and org_id = ${orgId}`;
  const runRow = runRows[0];
  if (!runRow) throw new Error(`run not found: ${runId}`);
  const run = mapRunRow(runRow);

  const messageRows = await sql<MessageDbRow[]>`
    select id, org_id, from_run, to_run, type, payload, answered_at, answer, created_at
    from messages
    where org_id = ${orgId}
      and (
        payload->>'runId' = ${runId}
        or from_run = ${runId}
        or to_run = ${runId}
      )
    order by created_at asc`;
  const messages = messageRows.map(mapMessageRow);

  const eventRows = await sql<EventDbRow[]>`
    select id, org_id, actor, type, payload, created_at
    from events
    where org_id = ${orgId} and payload->>'runId' = ${runId}
    order by id asc`;
  const events = eventRows.map(mapEventRow);

  return { run, messages, events };
}

export async function listActivityImpl(sql: postgres.Sql, orgId: string, threadId: string, limit = 1000): Promise<ActivityRow[]> {
  const rows = await sql<{ id: string; payload: Record<string, unknown>; created_at: Date }[]>`
    select e.id, e.payload, e.created_at
    from events e
    join runs rr on rr.id = (e.payload ->> 'runId')::uuid
    where e.org_id = ${orgId} and e.type = 'run.activity' and rr.thread_id = ${threadId}
    order by e.id asc
    limit ${limit}`;
  return rows.map((r) => {
    const p = r.payload as { runId?: string; steps?: unknown[] };
    return {
      id: String(r.id),
      runId: p.runId ?? '',
      steps: (Array.isArray(p.steps) ? p.steps : []) as ActivityRow['steps'],
      at: r.created_at.toISOString(),
    };
  });
}

const orgId = z.string();

export const readsRouter = router({
  runsOverview: read([orgId], async (ctx, org) => {
    assertOwnOrg(ctx.identity, org);
    return runsOverviewImpl(ctx.sql, ctx.identity.orgId);
  }),

  getThread: read([orgId, z.string()], async (ctx, org, runId) => {
    assertOwnOrg(ctx.identity, org);
    return getThreadImpl(ctx.sql, ctx.identity.orgId, runId);
  }),

  listActivity: read([orgId, z.string(), z.number().optional()], async (ctx, org, threadId, limit) => {
    assertOwnOrg(ctx.identity, org);
    return listActivityImpl(ctx.sql, ctx.identity.orgId, threadId, limit);
  }),

  findActiveFolderGrant: read([z.string()], async (ctx, directory) => findActiveFolderGrant(ctx.sql, ctx.identity.orgId, directory)),

  identity: read([], async (ctx): Promise<WorkspaceIdentity> => ({
    userId: ctx.identity.userId,
    orgId: ctx.identity.orgId,
    role: ctx.identity.role,
    displayName: ctx.identity.displayName,
    email: ctx.identity.email,
  })),
});
