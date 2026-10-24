import { threadModeSchema, type ThreadMode } from '@nodeloom/core';
import type postgres from 'postgres';
import { z } from 'zod';
import { createChatTurn, createThread, type AmbientEnvelopeInput } from '../chat/chat.js';
import { setThreadMode } from '../consent.js';
import { createChatProject, renameProject } from '../projects.js';
import { assertOwnOrg, router, write } from './registry.js';

export async function sendChatImpl(
  sql: postgres.Sql,
  orgId: string,
  threadId: string | null,
  text: string,
  createdBy: string,
  selection?: { sceneSlug: string; nodeId: string },
  projectId?: string,
  ambient?: AmbientEnvelopeInput,
): Promise<{ threadId: string; runId: string | null }> {
  let resolvedThreadId = threadId;
  if (resolvedThreadId === null) {
    let birthProjectId = projectId ?? null;
    if (birthProjectId !== null) {
      const [p] = await sql<{ id: string }[]>`select id from projects where id = ${birthProjectId} and org_id = ${orgId}`;
      if (!p) throw new Error('project not found');
    } else {
      const provisional = text.trim().replace(/\s+/g, ' ').slice(0, 48) || 'new project';
      birthProjectId = (await createChatProject(sql, { orgId, name: provisional, createdBy })).projectId;
    }
    const { threadId: newThreadId } = await createThread(sql, { orgId, title: text.slice(0, 120), createdBy, projectId: birthProjectId });
    resolvedThreadId = newThreadId;
  } else {
    const [row] = await sql<{ org_id: string }[]>`select org_id from threads where id = ${resolvedThreadId} and deleted_at is null`;
    if (!row || row.org_id !== orgId) throw new Error('thread not found');
  }

  // Mid-work sends are ordinary turns now: the host's per-thread chain queues them after the live turn (the Cline shape).
  const { runId } = await createChatTurn(sql, {
    orgId, threadId: resolvedThreadId, text, by: createdBy,
    ...(selection !== undefined ? { selection } : {}),
    ...(ambient !== undefined ? { envelope: ambient } : {}),
  });
  return { threadId: resolvedThreadId, runId };
}

export async function setThreadModeImpl(sql: postgres.Sql, orgId: string, threadId: string, mode: ThreadMode): Promise<undefined> {
  await setThreadMode(sql, { orgId, threadId, mode });
  return undefined;
}

const orgId = z.string();
const selectionSchema = z.object({ sceneSlug: z.string(), nodeId: z.string() });
const ambientSchema: z.ZodType<AmbientEnvelopeInput> = z.object({
  theme: z.enum(['dark', 'light']).optional(),
  screen: z.object({ sceneSlug: z.string() }).optional(),
  selection: z.union([
    z.object({ surface: z.literal('lens'), sceneSlug: z.string(), nodeId: z.string() }),
    z.object({ surface: z.literal('map'), kind: z.string(), nodeId: z.string(), label: z.string() }),
    z.null(),
  ]).optional(),
});

export const chatWritesRouter = router({
  sendChat: write(
    [orgId, z.string().nullable(), z.string(), selectionSchema.optional(), z.string().optional(), ambientSchema.optional()],
    async (ctx, org, threadId, text, selection, projectId, ambient) => {
      assertOwnOrg(ctx.identity, org);
      return sendChatImpl(ctx.sql, ctx.identity.orgId, threadId, text, ctx.identity.userId, selection, projectId, ambient);
    },
  ),

  setThreadMode: write([orgId, z.string(), threadModeSchema], async (ctx, org, threadId, mode) => {
    assertOwnOrg(ctx.identity, org);
    return setThreadModeImpl(ctx.sql, ctx.identity.orgId, threadId, mode);
  }),

  renameProject: write([orgId, z.string(), z.string()], async (ctx, org, projectId, name) => {
    assertOwnOrg(ctx.identity, org);
    await renameProject(ctx.sql, { orgId: ctx.identity.orgId, projectId, name, by: ctx.identity.userId });
    return undefined;
  }),

  createProjectOfKind: write([orgId, z.enum(['app', 'website'])], async (ctx, org, kind) => {
    assertOwnOrg(ctx.identity, org);
    return createChatProject(ctx.sql, {
      orgId: ctx.identity.orgId, kind, name: kind === 'app' ? 'New app' : 'New website', createdBy: ctx.identity.userId,
    });
  }),
});
