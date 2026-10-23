import type postgres from 'postgres';
import { sceneActionsSchema, tablesWrittenBy, type ActionAnswer, type FlowEffect } from '@tent-nocode/core';
import { getSceneActionExecutionResult, getSceneActionFlowResult, requireScene, submitSceneAction } from '@tent-nocode/kernel';
import type { HostLookup } from '@tent-nocode/kernel';
import { withTenant } from './tenancy.js';

// Visitor action routes: declared scene actions through the kernel action wall; the answer carries its effects.
// A submit announces what it wrote so the live route pushes the fresh rows to every open page of the org.

const VISITOR = '00000000-0000-4000-8000-000000000001'; // the anonymous visitor actor id

export type RoomActionResult = ActionAnswer & { failures?: string[] };

export interface RoomActionAnnounce {
  (a: { orgId: string; tables?: string[]; all?: boolean; executions?: string[] }): void;
}

export async function roomAction(
  sql: postgres.Sql, app: HostLookup,
  input: { name: string; values: Record<string, unknown> },
  /** Signed-in app user id; anonymous visitors use the visitor marker. */
  endUserId?: string | null,
  /** The live route's announcer; absent on a host without the push. */
  announce?: RoomActionAnnounce,
): Promise<RoomActionResult> {
  if (app.currentReleaseId === null) return { ok: false, failures: ['this app has no published release'] };
  const out = await withTenant(sql, { orgId: app.orgId, endUserId: endUserId ?? null }, async (tx): Promise<{ answer: ActionAnswer; tables: string[] }> => {
    const [release] = await tx<{ entry_scene_slug: string | null }[]>`
      select entry_scene_slug from room_releases where id = ${app.currentReleaseId}`;
    if (!release?.entry_scene_slug) return { answer: { ok: false, failures: ['this app has no published release'] }, tables: [] };
    const scene = await requireScene(tx, app.orgId, release.entry_scene_slug).catch(() => null);
    if (!scene) return { answer: { ok: false, failures: ['this app has no published release'] }, tables: [] };
    const [row] = await tx<{ actions: unknown }[]>`select actions from scenes where id = ${scene.id}`;
    const declared = sceneActionsSchema.safeParse(row?.actions ?? []);
    const action = declared.success ? declared.data.find((a) => a.name === input.name) : undefined;
    const answer = await submitSceneAction(tx, {
      orgId: app.orgId, sceneSlug: scene.slug, action: input.name,
      values: input.values, userId: endUserId ?? VISITOR,
    });
    return { answer, tables: action !== undefined ? tablesWrittenBy(action) : [] };
  });
  if (out.answer.ok && announce !== undefined) {
    // A start_flow that settled may have written any table; one that is still running announces when it settles.
    const ranFlow = out.answer.results.some((r) => r['rule'] === 'start_flow' && r['settled'] === true);
    const pending = out.answer.execution !== undefined && out.answer.execution.status !== 'failed' ? [out.answer.execution.id] : [];
    if (ranFlow || out.tables.length > 0) announce({ orgId: app.orgId, ...(ranFlow ? { all: true } : { tables: out.tables }) });
    if (pending.length > 0) announce({ orgId: app.orgId, executions: pending });
  }
  return out.answer.ok ? { ...out.answer, failures: [] } : out.answer;
}

/** Reads the result of an execution a visitor's action queued; integration miss falls through to the flow lane. */
export async function roomExecutionResult(
  sql: postgres.Sql, app: HostLookup, executionId: string,
): Promise<{ status: 'pending' | 'succeeded' | 'failed'; result?: unknown; error?: string; effects?: FlowEffect[] } | null> {
  if (app.currentReleaseId === null) return null;
  return withTenant(sql, { orgId: app.orgId }, async (tx) => {
    const [release] = await tx<{ entry_scene_slug: string | null }[]>`
      select entry_scene_slug from room_releases where id = ${app.currentReleaseId}`;
    if (!release?.entry_scene_slug) return null;
    // to_regclass probes whether each lane's table exists in this DB; a missing table falls through.
    const [ireg] = await tx<{ rel: string | null }[]>`select to_regclass('public.integration_executions')::text as rel`;
    if (ireg?.rel !== null && ireg?.rel !== undefined) {
      const integration = await getSceneActionExecutionResult(tx, { orgId: app.orgId, sceneSlug: release.entry_scene_slug, executionId });
      if (integration !== null) return integration;
    }
    const [reg] = await tx<{ rel: string | null }[]>`select to_regclass('public.flow_executions')::text as rel`;
    if (reg?.rel === null || reg?.rel === undefined) return null;
    return getSceneActionFlowResult(tx, { orgId: app.orgId, sceneSlug: release.entry_scene_slug, executionId });
  });
}
