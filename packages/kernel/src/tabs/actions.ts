import { z } from 'zod';
import type postgres from 'postgres';
import { isSystemQueryTable, sceneActionsSchema, sceneBindingsSchema, type SceneAction, type SceneBinding } from '@tent-nocode/core';
import type { ActionSpec } from '../chat/actions.js';
import { projectArm, resolveProject } from '../containment.js';
import { projectThemeSchema, setProjectTheme } from '../projects.js';
import { deleteTab, renameTab } from './model.js';
import { ensureDataset } from './datasets.js';
import { createScene, createSceneTab, requireScene } from '../scenes/store.js';
import { deleteSceneHuman } from '../human/deletion.js';
import { setSceneContracts } from '../scenes/actions.js';

// View lifecycle as governed actions (create/revise/delete/rename_view); the consent card is the data grant.
// The query bindings validate through the one contract (columns against the row schema) at the gate and
// again through validate.ts's one pass inside setSceneContracts.

/** Deep grammars validate at the gate: an invalid declaration bounces as status 'invalid' naming the path. */
const createViewSchema = z.object({
  title: z.string().min(1),
  purpose: z.string().min(10),
  bindings: sceneBindingsSchema.default([]),
  actions: sceneActionsSchema.default([]),
  /** The v1's theme (the no-plan fast path); lands on the project. */
  theme: projectThemeSchema.optional(),
}).strict();

const reviseViewSchema = z.object({
  viewSlug: z.string().min(1),
  complaint: z.string().min(5),
  /** Listed only when the contracts change; absent = keep. */
  bindings: sceneBindingsSchema.optional(),
  actions: sceneActionsSchema.optional(),
  /** The node the user pointed at; the builder starts its read there. */
  focusNodeId: z.string().min(1).optional(),
}).strict();

const deleteViewSchema = z.object({ viewSlug: z.string().min(1), reason: z.string().min(5) }).strict();
const renameViewSchema = z.object({ viewSlug: z.string().min(1), title: z.string().min(1) }).strict();

/** Resolves the view tab within the asking thread's project and refuses a tab from another project. */
async function requireViewTab(
  sql: postgres.Sql,
  ctx: { orgId: string; threadId: string },
  viewSlug: string,
  verb: string,
): Promise<{ id: string; title: string; scene_id: string | null; project_id: string | null }> {
  const [tab] = await sql<{ id: string; title: string; scene_id: string | null; project_id: string | null }[]>`
    select id, title, scene_id, project_id from tabs
    where org_id = ${ctx.orgId} and slug = ${viewSlug} and status != 'deleted'`;
  if (!tab) throw new Error(`${verb}: view not found: ${viewSlug}`);
  const projectId = await resolveProject(sql, { orgId: ctx.orgId, threadId: ctx.threadId });
  if (projectId !== null && tab.project_id !== null && tab.project_id !== projectId) {
    throw new Error(`${verb}: no view '${viewSlug}' in this project - a view by that slug lives in another project, and view actions never cross projects`);
  }
  return tab;
}

/** Ensures the tables named by query bindings and row writes exist as part of the grant (the system tables need nothing). */
async function ensureTablesFor(
  sql: postgres.Sql, orgId: string, projectId: string | null, bindings: SceneBinding[], actions: SceneAction[],
): Promise<void> {
  for (const b of bindings) {
    if (b.kind === 'query' && !isSystemQueryTable(b.table) && b.rowSchema !== undefined) {
      await ensureDataset(sql, { orgId, projectId, name: b.table, rowSchema: b.rowSchema });
    }
  }
  for (const a of actions) {
    for (const rule of a.rules) {
      if (rule.rule !== 'append_row') continue;
      const [exists] = await sql<{ id: string }[]>`
        select id from datasets where org_id = ${orgId} and ${projectArm(sql, projectId)} and name = ${rule.table} and deleted_at is null`;
      if (exists) continue;
      // Derive the row shape from the rule's declared columns, string default.
      const rowSchema: Record<string, 'string' | 'number' | 'boolean'> = {};
      for (const col of Object.keys(rule.row)) rowSchema[col] = 'string';
      await ensureDataset(sql, { orgId, projectId, name: rule.table, rowSchema });
    }
  }
}

export const TAB_ACTIONS: Record<string, ActionSpec> = {
  create_view: {
    name: 'create_view',
    escalationKind: 'create_view',
    lands: 'the view shell and its query/action contracts land now; the screen body rides the same edit',
    route: { kind: 'screen', verb: 'exists' },
    paramsSchema: createViewSchema,
    async execute(sql, ctx, params): Promise<void> {
      const p = createViewSchema.parse(params);
      const bindings = sceneBindingsSchema.parse(p.bindings);
      const actions = sceneActionsSchema.parse(p.actions);
      // The asking thread's project contains everything this view mints, tables included.
      const projectId = await resolveProject(sql, { orgId: ctx.orgId, threadId: ctx.threadId });
      // The v1's theme commits on the project (the no-plan fast path).
      if (p.theme !== undefined && projectId !== null) {
        await setProjectTheme(sql, { orgId: ctx.orgId, projectId, theme: p.theme, by: ctx.createdBy });
      }
      // Throwable steps first: rows are born only once the walls have passed.
      await ensureTablesFor(sql, ctx.orgId, projectId, bindings, actions);
      const { sceneId, slug } = await createScene(sql, { orgId: ctx.orgId, title: p.title, createdBy: ctx.createdBy, projectId });
      const contracts = await setSceneContracts(sql, { orgId: ctx.orgId, sceneSlug: slug, bindings, actions });
      if (!contracts.ok) throw new Error(`create_view contracts: ${contracts.errors.join('; ')}`);
      await createSceneTab(sql, {
        orgId: ctx.orgId, sceneId, sceneSlug: slug, title: p.title, createdBy: ctx.createdBy,
        projectId,
      });
    },
  },
  revise_view: {
    name: 'revise_view',
    escalationKind: 'revise_view',
    lands: 'contracts apply at approval in any mode; the styling run dispatches only in agent mode',
    route: { kind: 'screen', verb: 'connect' },
    paramsSchema: reviseViewSchema,
    async execute(sql, ctx, params): Promise<void> {
      const p = reviseViewSchema.parse(params);
      const tab = await requireViewTab(sql, ctx, p.viewSlug, 'revise_view');
      if (tab.scene_id === null) {
        throw new Error(`revise_view: '${p.viewSlug}' was built on an older system - ask to rebuild it (create_view) and its data carries over`);
      }
      const [sceneRow] = await sql<{ slug: string; bindings: unknown; actions: unknown }[]>`
        select slug, bindings, actions from scenes where id = ${tab.scene_id}`;
      if (!sceneRow) throw new Error(`revise_view: scene missing for view '${p.viewSlug}'`);
      await requireScene(sql, ctx.orgId, sceneRow.slug);
      let bindings = sceneBindingsSchema.parse(sceneRow.bindings ?? []);
      let actions = sceneActionsSchema.parse(sceneRow.actions ?? []);
      if (p.bindings || p.actions) {
        // The card re-listed what changes; the absent half carries over.
        bindings = p.bindings ? sceneBindingsSchema.parse(p.bindings) : bindings;
        actions = p.actions ? sceneActionsSchema.parse(p.actions) : actions;
        // A revision's new tables land in the view's own project before the contracts validate against them.
        await ensureTablesFor(
          sql, ctx.orgId,
          await resolveProject(sql, { orgId: ctx.orgId, sceneId: tab.scene_id, threadId: ctx.threadId }),
          bindings, actions,
        );
        const contracts = await setSceneContracts(sql, { orgId: ctx.orgId, sceneSlug: sceneRow.slug, bindings, actions });
        if (!contracts.ok) throw new Error(`revise_view contracts: ${contracts.errors.join('; ')}`);
      }
    },
  },
  delete_view: {
    name: 'delete_view',
    escalationKind: 'delete_view',
    lands: 'the view tombstones like the right-click gesture; history survives',
    route: { kind: 'screen', verb: 'exists' },
    paramsSchema: deleteViewSchema,
    async execute(sql, ctx, params): Promise<void> {
      const p = deleteViewSchema.parse(params);
      // Scene-backed views ride the same deleteSceneHuman door the right-click gesture calls; bare tabs keep their own arm.
      const tab = await requireViewTab(sql, ctx, p.viewSlug, 'delete_view');
      if (tab?.scene_id) {
        const [scene] = await sql<{ slug: string }[]>`select slug from scenes where id = ${tab.scene_id} and status = 'active'`;
        if (scene) {
          const res = await deleteSceneHuman(sql, { orgId: ctx.orgId, sceneSlug: scene.slug, by: ctx.resolvedBy ?? ctx.createdBy });
          if (!res.ok) throw new Error(`delete_view: ${res.error}`);
          return;
        }
      }
      await deleteTab(sql, { orgId: ctx.orgId, tabSlug: p.viewSlug, reason: p.reason });
    },
  },
  rename_view: {
    name: 'rename_view',
    escalationKind: 'rename_view',
    lands: 'the view is renamed in place',
    route: { kind: 'screen', verb: 'configure' },
    paramsSchema: renameViewSchema,
    async execute(sql, ctx, params): Promise<void> {
      const p = renameViewSchema.parse(params);
      await requireViewTab(sql, ctx, p.viewSlug, 'rename_view');
      await renameTab(sql, { orgId: ctx.orgId, tabSlug: p.viewSlug, title: p.title });
    },
  },
};
