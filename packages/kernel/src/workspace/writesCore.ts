import type postgres from 'postgres';
import { z } from 'zod';
import { answerApproval, WORK_RULES } from '../consent.js';
import { updateIntent } from '../chat/intents.js';
import { deleteNote, readNotes, saveNote, supersedeNote } from '../notes.js';
import { automationNodeDetail, orgAutomationGraph } from '../observatory.js';
import { cancelRun, spawnRun } from '../scheduler.js';
import { DESK_SLUG, ensureDeskAgent } from '../chat/desk.js';
import { assertOwnOrg, read, router, write } from './registry.js';

/** A submitted ask spawns one work run directly (the loop collapse). */
export async function submitJobImpl(sql: postgres.Sql, orgId: string, prompt: string, _createdBy: string): Promise<{ runId: string }> {
  await ensureDeskAgent(sql, orgId);
  const { runId } = await spawnRun(sql, {
    orgId, agentSlug: DESK_SLUG, kind: 'work', threadId: null,
    prompt: prompt.slice(0, 200), input: { task: prompt }, permissionRules: WORK_RULES,
  });
  return { runId };
}

export async function answerApprovalImpl(
  sql: postgres.Sql,
  orgId: string,
  messageId: string,
  approved: boolean,
  answeredBy: string,
  note?: string,
): Promise<undefined> {
  // Resolution is inline: answer + (ask-once grant) + execute in one call - no daemon sweep.
  await answerApproval(sql, { messageId, orgId, approved, note, answeredBy });
  return undefined;
}

export async function escalationKindImpl(sql: postgres.Sql, orgId: string, messageId: string): Promise<string | null> {
  const [row] = await sql<{ kind: string | null }[]>`
    select payload->>'kind' as kind from messages where id = ${messageId} and org_id = ${orgId}
  `;
  return row?.kind ?? null;
}

export async function cancelRunImpl(sql: postgres.Sql, orgId: string, runId: string): Promise<undefined> {
  const [row] = await sql<{ org_id: string }[]>`select org_id from runs where id = ${runId}`;
  if (!row || row.org_id !== orgId) throw new Error('run not found');
  await cancelRun(sql, runId);
  return undefined;
}

export async function cancelIntentImpl(sql: postgres.Sql, orgId: string, intentId: string): Promise<undefined> {
  const [row] = await sql<{ org_id: string; thread_id: string; status: string }[]>`
    select org_id, thread_id, status from thread_intents where id = ${intentId}`;
  if (!row || row.org_id !== orgId) throw new Error('intent not found');
  if (row.status === 'done' || row.status === 'cancelled') throw new Error(`intent already ${row.status}`);
  await updateIntent(sql, { orgId, intentId, status: 'cancelled' });
  const liveWork = await sql<{ id: string }[]>`
    select id from runs where org_id = ${orgId} and thread_id = ${row.thread_id}
      and kind = 'work' and status = 'running'`;
  for (const r of liveWork) {
    try { await cancelRun(sql, r.id); }
    catch (err) {
      if (!(err instanceof Error && err.message.startsWith('run not cancellable:'))) throw err;
    }
  }
  return undefined;
}

export async function liveAgentsImpl(sql: postgres.Sql, orgId: string): Promise<Array<{
  runId: string; threadId: string | null; threadTitle: string; role: string; kind: string;
  step: { kind: string; tool?: string; target?: string; text?: string } | null;
}>> {
  const rows = await sql<Array<{
    id: string; thread_id: string | null; title: string | null; slug: string; kind: string; last_step: unknown;
  }>>`
    select r.id, r.thread_id, t.title, a.slug, r.kind,
      (select e.payload->'steps'->-1
         from events e
        where e.org_id = r.org_id and e.type = 'run.activity'
          and e.payload->>'runId' = r.id::text
        order by e.id desc limit 1) as last_step
      from runs r
      join agents a on a.id = r.agent_id
      left join threads t on t.id = r.thread_id
     where r.org_id = ${orgId} and r.status = 'running'
     order by r.created_at asc`;
  return rows.map((r) => ({
    runId: r.id, threadId: r.thread_id, threadTitle: r.title ?? '', role: r.slug,
    kind: r.kind,
    step: (r.last_step ?? null) as { kind: string; tool?: string; target?: string; text?: string } | null,
  }));
}

const orgId = z.string();

export const coreWritesRouter = router({
  submitJob: write([orgId, z.string()], async (ctx, org, prompt) => {
    assertOwnOrg(ctx.identity, org);
    return submitJobImpl(ctx.sql, ctx.identity.orgId, prompt, ctx.identity.userId);
  }),

  answerApproval: write([orgId, z.string(), z.boolean(), z.string().optional()], async (ctx, org, messageId, approved, note) => {
    assertOwnOrg(ctx.identity, org);
    const kind = await escalationKindImpl(ctx.sql, ctx.identity.orgId, messageId);
    if (kind === null) throw new Error('not found');
    await answerApprovalImpl(ctx.sql, ctx.identity.orgId, messageId, approved, ctx.identity.userId, note);
    return undefined;
  }),

  cancelRun: write([orgId, z.string()], async (ctx, org, runId) => {
    assertOwnOrg(ctx.identity, org);
    return cancelRunImpl(ctx.sql, ctx.identity.orgId, runId);
  }),

  cancelIntent: write([orgId, z.string()], async (ctx, org, intentId) => {
    assertOwnOrg(ctx.identity, org);
    return cancelIntentImpl(ctx.sql, ctx.identity.orgId, intentId);
  }),

  liveAgents: read([orgId], async (ctx, org) => {
    assertOwnOrg(ctx.identity, org);
    return liveAgentsImpl(ctx.sql, ctx.identity.orgId);
  }),

  automationGraph: read([orgId, z.string().optional()], async (ctx, org, projectId) => {
    assertOwnOrg(ctx.identity, org);
    return orgAutomationGraph(ctx.sql, ctx.identity.orgId, projectId ?? null);
  }),

  automationNodeDetail: read([orgId, z.string()], async (ctx, org, nodeId) => {
    assertOwnOrg(ctx.identity, org);
    return automationNodeDetail(ctx.sql, { orgId: ctx.identity.orgId, nodeId });
  }),

  projectNotes: read([orgId, z.string()], async (ctx, org, projectId) => {
    assertOwnOrg(ctx.identity, org);
    return readNotes(ctx.sql, { orgId: ctx.identity.orgId, projectId, includeSuperseded: true, limit: 500 });
  }),

  saveProjectNote: write([orgId, z.string(), z.string()], async (ctx, org, projectId, body) => {
    assertOwnOrg(ctx.identity, org);
    return saveNote(ctx.sql, { orgId: ctx.identity.orgId, projectId, author: 'user', body });
  }),

  supersedeProjectNote: write([orgId, z.string(), z.string()], async (ctx, org, noteId, body) => {
    assertOwnOrg(ctx.identity, org);
    return supersedeNote(ctx.sql, { orgId: ctx.identity.orgId, noteId, body, author: 'user' });
  }),

  deleteProjectNote: write([orgId, z.string()], async (ctx, org, noteId) => {
    assertOwnOrg(ctx.identity, org);
    return deleteNote(ctx.sql, { orgId: ctx.identity.orgId, noteId, by: ctx.identity.userId });
  }),
});
