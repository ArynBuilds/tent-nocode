import {
  PRIMITIVES, PRIMITIVE_NAMES, columnSentence, initialValues, prettifyColumn, primitiveOfRef, primitiveRef, propertiesOf, typeText,
} from '@nodeloom/core';
import type {
  BindableOutputRow, ColumnStats, ComponentCatalogEntry, ComponentCatalogParam, ComponentShelfRow, PrimitiveName,
  SceneBindingFeed, SceneCatalogEntry, SceneDataResult, SceneEditRead, SceneExplainResult,
  SceneNodeInspect, SceneProjectionResult, TabDataResult, TabRow,
} from '@nodeloom/core';
import type postgres from 'postgres';
import { createThread } from '../chat/chat.js';
import { listConnections, MCP_GALLERY } from '../connections.js';
import { projectArm } from '../containment.js';
import { projectHasAssistant } from '../observatory.js';
import { listBindableOutputs } from '../scenes/derivedOutputs.js';
import { TAB_TOKENS_CSS, buildThemeCss } from '../scenes/hostPage.js';
import { libraryItemUsage, listLibraryItems } from '../scenes/library.js';
import { explainProperty, getSubtree } from '../scenes/read.js';
import { serveSceneBindingData, serveSceneData, serveSceneProjection, type MediaUrlMinter } from '../scenes/serve.js';
import { getSceneDocument, getSceneForServe, listScenes } from '../scenes/store.js';
import { listTabs } from '../tabs/model.js';
import { z } from 'zod';
import { assertOwnOrg, read, router, write } from './registry.js';

// The tab and scene reads the desktop's editor and the web dashboard call. The scene reads serve the
// five primitives from the contract (primitives.ts) and the library (library.ts): the catalog is the
// five plus the items a project may place, a node's defaults are the contract's initial values, and
// the feed carries the host css a direct mount rescopes.

export async function listTabsImpl(sql: postgres.Sql, orgId: string): Promise<TabRow[]> {
  const tabs = await listTabs(sql, orgId);
  return tabs.map((t) => ({
    id: t.id, slug: t.slug, title: t.title, status: t.status,
    currentVersion: t.currentVersion, createdAt: t.createdAt, sceneId: t.sceneId,
    sceneSlug: t.sceneSlug, sceneImportedFrom: t.sceneImportedFrom,
    projectId: t.projectId,
  }));
}

export async function ensureSceneThreadImpl(
  sql: postgres.Sql, orgId: string, sceneSlug: string, userId: string,
): Promise<{ threadId: string; sceneId: string; title: string; hasAssistant: boolean }> {
  const [scene] = await sql<{ id: string; title: string }[]>`
    select id, title from scenes where org_id = ${orgId} and slug = ${sceneSlug} and status != 'deleted'`;
  if (!scene) throw new Error(`scene not found in org: ${sceneSlug}`);
  const roomTitle = `${scene.title} - scene requests`;
  const room = await sql.begin(async (txRaw) => {
    const tx = txRaw as unknown as postgres.Sql;
    await tx`select pg_advisory_xact_lock(hashtext(${orgId} || ':scene-room:' || ${sceneSlug}))`;
    const [host] = await tx<{ project_id: string | null }[]>`
      select project_id from tabs
      where org_id = ${orgId} and scene_id = ${scene.id} and status != 'deleted'
      order by created_at asc limit 1`;
    const [existing] = await tx<{ id: string }[]>`
      select id from threads where org_id = ${orgId} and title = ${roomTitle} and deleted_at is null order by created_at asc limit 1`;
    let threadId = existing?.id;
    if (threadId === undefined) {
      if (host?.project_id == null) throw new Error(`scene '${sceneSlug}' has no project home for its request room`);
      threadId = (await createThread(tx, { orgId, title: roomTitle, createdBy: userId, projectId: host.project_id })).threadId;
    }
    return { threadId, projectId: host?.project_id ?? null };
  });
  const hasAssistant = room.projectId !== null
    ? await projectHasAssistant(sql, orgId, room.projectId)
    : false;
  return { threadId: room.threadId, sceneId: scene.id, title: scene.title, hasAssistant };
}

export async function tabDataImpl(sql: postgres.Sql, orgId: string, tabId: string): Promise<TabDataResult> {
  const tabs = await listTabsImpl(sql, orgId);
  const tab = tabs.find((t) => t.id === tabId);
  if (!tab) throw new Error(`tab not found in org: ${tabId}`);
  return { tab, results: [] };
}

/** A node's defaults per component key: the contract's initial values for a primitive; nothing for anything else. */
function defaultsFor(refs: readonly string[]): Record<string, Record<string, unknown>> {
  const defaults: Record<string, Record<string, unknown>> = {};
  for (const ref of refs) {
    const name = primitiveOfRef(ref);
    if (name !== null) defaults[ref] = initialValues(name);
  }
  return defaults;
}

export async function sceneNodeImpl(
  sql: postgres.Sql, orgId: string, sceneSlug: string, nodeId: string,
): Promise<SceneNodeInspect> {
  const { revision, subtree } = await getSubtree(sql, { orgId, sceneSlug, nodeId, depth: 1 });
  if (!subtree) return { revision, node: null, defaults: {} };
  const children = Array.isArray(subtree.children) ? subtree.children.map((c) => c.id) : [];
  let siblings: string[] = [subtree.id];
  if (subtree.parent !== null) {
    const parent = await getSubtree(sql, { orgId, sceneSlug, nodeId: subtree.parent, depth: 1 });
    if (parent.subtree && Array.isArray(parent.subtree.children)) siblings = parent.subtree.children.map((c) => c.id);
  }
  return {
    revision,
    node: {
      id: subtree.id, parent: subtree.parent,
      ...(subtree.slot !== undefined ? { slot: subtree.slot } : {}),
      components: subtree.components,
      ...(subtree.variants !== undefined ? { variants: subtree.variants } : {}),
      ...(subtree.refs !== undefined ? { refs: subtree.refs } : {}),
      childCount: Array.isArray(subtree.children) ? subtree.children.length : subtree.children.omitted,
      children,
      siblings,
    },
    defaults: defaultsFor(Object.keys(subtree.components)),
  };
}

export async function sceneExplainImpl(
  sql: postgres.Sql, orgId: string, sceneSlug: string, nodeId: string, component: string, key: string,
): Promise<SceneExplainResult> {
  return explainProperty(sql, { orgId, sceneSlug, nodeId, component, key });
}

/** The raw editing document: the store's own nodes, never expanded; the design size beside it. */
export async function sceneEditImpl(sql: postgres.Sql, orgId: string, sceneSlug: string): Promise<SceneEditRead | null> {
  const [row] = await sql<{ id: string; slug: string; title: string; head_revision: number; target_screen: { w: number; h: number } | null }[]>`
    select id, slug, title, head_revision, target_screen from scenes
    where org_id = ${orgId} and slug = ${sceneSlug} and status != 'deleted'`;
  if (!row) return null;
  const document = await getSceneDocument(sql, { orgId, sceneId: row.id });
  return {
    scene: { id: row.id, slug: row.slug, title: row.title, headRevision: row.head_revision },
    document,
    targetScreen: row.target_screen ?? null,
  };
}

/** The feed with the host css a direct mount rescopes: the scene tokens and the project's theme block. */
export async function sceneDataWithHostCss(
  sql: postgres.Sql, orgId: string, sceneId: string, mint: MediaUrlMinter, rowKey?: string,
): Promise<SceneDataResult> {
  const feed = await serveSceneData(sql, orgId, sceneId, mint, rowKey);
  const serve = await getSceneForServe(sql, { orgId, sceneId });
  return {
    ...feed,
    hostCss: `${TAB_TOKENS_CSS}\n${buildThemeCss(serve?.theme ?? null)}`,
    ...(serve?.theme?.breakpoints !== undefined ? { breakpoints: serve.theme.breakpoints } : {}),
  };
}

export async function listComponentsImpl(sql: postgres.Sql, orgId: string, projectId: string | null): Promise<ComponentShelfRow[]> {
  const rows = await listLibraryItems(sql, orgId, projectId);
  return rows.map((r) => ({
    name: r.name, version: r.version, title: r.item.title, description: r.item.description,
    status: r.status, versions: 1,
  }));
}

/** The five and the library items in one list; the item documents ride so the editor's engine expands instances. */
export async function sceneCatalogImpl(sql: postgres.Sql, orgId: string, projectId: string | null): Promise<SceneCatalogEntry[]> {
  const primitives: SceneCatalogEntry[] = PRIMITIVE_NAMES.map((name) => ({
    kind: 'primitive', name, title: PRIMITIVES[name].title, breath: PRIMITIVES[name].breath,
  }));
  const items = await listLibraryItems(sql, orgId, projectId);
  const itemEntries: SceneCatalogEntry[] = items
    .filter((r) => r.status === 'active')
    .map((r) => ({
      kind: 'item', ref: `${r.name}@${r.version}`, name: r.name, version: r.version,
      title: r.item.title, description: r.item.description, item: r.item,
    }));
  return [...primitives, ...itemEntries];
}

/** The one catalog over the five and the items: the contract's own lines, hints kept (the
 * hint-dropping legacy projection is gone; type is the contract's type text, never a re-bucketed word). */
export async function componentCatalogImpl(sql: postgres.Sql, orgId: string, projectId: string | null): Promise<ComponentCatalogEntry[]> {
  const items = await listLibraryItems(sql, orgId, projectId);
  return [
    ...PRIMITIVE_NAMES.map((name: PrimitiveName): ComponentCatalogEntry => {
      const def = PRIMITIVES[name];
      const params: ComponentCatalogParam[] = Object.entries(propertiesOf(name)).map(([key, p]) => ({
        name: key, type: typeText(p.schema), required: false, hint: p.hint,
        ...(p.initial !== undefined ? { default: p.initial } : {}),
      }));
      return {
        ref: primitiveRef(name), title: def.title, purpose: def.breath, params,
        ...(Object.keys(def.emits).length > 0 ? { emits: Object.entries(def.emits).map(([n, e]) => ({ name: n, type: e.type, description: e.hint })) } : {}),
      };
    }),
    ...items.filter((r) => r.status === 'active').map((r): ComponentCatalogEntry => ({
      ref: `${r.name}@${r.version}`, title: r.item.title, purpose: r.item.description, composition: true,
      params: r.item.exposed.map((id) => ({ name: id, type: 'json', required: false })),
    })),
  ];
}

export async function listBindableOutputsImpl(sql: postgres.Sql, orgId: string): Promise<BindableOutputRow[]> {
  const rows = await listBindableOutputs(sql, orgId);
  return rows.map((r) => ({ name: r.name, kind: r.kind, descriptor: r.descriptor, runId: r.runId, createdAt: r.createdAt.toISOString(), staleAt: r.staleAt?.toISOString() ?? null, binding: r.binding }));
}

const orgId = z.string();
const optProject = z.string().optional();

export const tabReadsRouter = router({
  listTabs: read([orgId], async (ctx, org) => {
    assertOwnOrg(ctx.identity, org);
    return listTabsImpl(ctx.sql, ctx.identity.orgId);
  }),

  tabData: read([orgId, z.string()], async (ctx, org, tabId) => {
    assertOwnOrg(ctx.identity, org);
    return tabDataImpl(ctx.sql, ctx.identity.orgId, tabId);
  }),

  sceneData: read([orgId, z.string(), z.string().optional()], async (ctx, org, sceneId, rowKey): Promise<SceneDataResult> => {
    assertOwnOrg(ctx.identity, org);
    return sceneDataWithHostCss(ctx.sql, ctx.identity.orgId, sceneId, ctx.deps.mintMediaUrls, rowKey !== '' ? rowKey : undefined);
  }),

  sceneBindingData: read([orgId, z.string(), z.string()], async (ctx, org, sceneId, binding): Promise<SceneBindingFeed> => {
    assertOwnOrg(ctx.identity, org);
    return serveSceneBindingData(ctx.sql, ctx.identity.orgId, sceneId, binding);
  }),

  sceneProjection: read([orgId, z.string(), z.string(), z.unknown()], async (ctx, org, sceneId, binding, request): Promise<SceneProjectionResult> => {
    assertOwnOrg(ctx.identity, org);
    return serveSceneProjection(ctx.sql, ctx.identity.orgId, sceneId, binding, request ?? {});
  }),

  listBindableOutputs: read([orgId], async (ctx, org) => {
    assertOwnOrg(ctx.identity, org);
    return listBindableOutputsImpl(ctx.sql, ctx.identity.orgId);
  }),

  sceneNode: read([orgId, z.string(), z.string()], async (ctx, org, sceneSlug, nodeId) => {
    assertOwnOrg(ctx.identity, org);
    return sceneNodeImpl(ctx.sql, ctx.identity.orgId, sceneSlug, nodeId);
  }),

  sceneEdit: read([orgId, z.string()], async (ctx, org, sceneSlug) => {
    assertOwnOrg(ctx.identity, org);
    return sceneEditImpl(ctx.sql, ctx.identity.orgId, sceneSlug);
  }),

  sceneExplain: read([orgId, z.string(), z.string(), z.string(), z.string()], async (ctx, org, sceneSlug, nodeId, component, key) => {
    assertOwnOrg(ctx.identity, org);
    return sceneExplainImpl(ctx.sql, ctx.identity.orgId, sceneSlug, nodeId, component, key);
  }),

  listComponents: read([orgId, optProject], async (ctx, org, projectId) => {
    assertOwnOrg(ctx.identity, org);
    return listComponentsImpl(ctx.sql, ctx.identity.orgId, projectId ?? null);
  }),

  componentCatalog: read([orgId, optProject], async (ctx, org, projectId) => {
    assertOwnOrg(ctx.identity, org);
    return componentCatalogImpl(ctx.sql, ctx.identity.orgId, projectId ?? null);
  }),

  sceneCatalog: read([orgId, optProject], async (ctx, org, projectId) => {
    assertOwnOrg(ctx.identity, org);
    return sceneCatalogImpl(ctx.sql, ctx.identity.orgId, projectId ?? null);
  }),

  componentUsage: read([orgId, z.string(), optProject], async (ctx, org, name, projectId) => {
    assertOwnOrg(ctx.identity, org);
    return libraryItemUsage(ctx.sql, ctx.identity.orgId, name, projectId ?? null);
  }),

  sceneForServe: read([z.string()], async (ctx, sceneId) => getSceneForServe(ctx.sql, { orgId: ctx.identity.orgId, sceneId })),

  sceneBySlug: read([orgId, z.string()], async (ctx, org, slug) => {
    assertOwnOrg(ctx.identity, org);
    const hit = (await listScenes(ctx.sql, ctx.identity.orgId)).find((s) => s.slug === slug);
    return hit ? { id: hit.id } : null;
  }),

  ensureSceneThread: write([orgId, z.string()], async (ctx, org, sceneSlug) => {
    assertOwnOrg(ctx.identity, org);
    return ensureSceneThreadImpl(ctx.sql, ctx.identity.orgId, sceneSlug, ctx.identity.userId);
  }),

  listGalleryServices: read([orgId], async (ctx, org) => {
    assertOwnOrg(ctx.identity, org);
    return MCP_GALLERY.map((s) => ({
      id: s.id, title: s.title, blurb: s.blurb, command: [...s.command],
      secretName: s.secretName, tokenHelp: s.tokenHelp,
      defaultRules: s.defaultRules.map((r) => ({ ...r })),
    }));
  }),

  listConnections: read([orgId], async (ctx, org) => {
    assertOwnOrg(ctx.identity, org);
    return listConnections(ctx.sql, ctx.identity.orgId);
  }),
});

// ---- The dataset brief: per-column stats, display names, sample rows carrying kernel ids ----

export interface BriefColumn {
  key: string;
  display: string;
  type: 'string' | 'number' | 'boolean';
  sentence: string;
  stats: ColumnStats;
}

export interface DatasetBrief {
  exists: boolean;
  dataset: string;
  rowCount: number;
  columns: BriefColumn[];
  /** Newest rows (<=5), each carrying its kernel `_id`. */
  sampleRows: Array<Record<string, unknown> & { _id: string }>;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}/;

export async function datasetBrief(
  sql: postgres.Sql,
  input: { orgId: string; projectId: string | null; dataset: string; sampleLimit?: number },
): Promise<DatasetBrief> {
  const [d] = await sql<{ id: string; row_schema: Record<string, 'string' | 'number' | 'boolean'>; column_display: Record<string, string> | null; column_order: string[] | null }[]>`
    select id, row_schema, column_display, column_order from datasets
    where org_id = ${input.orgId} and ${projectArm(sql, input.projectId)} and name = ${input.dataset} and deleted_at is null`;
  if (!d) return { exists: false, dataset: input.dataset, rowCount: 0, columns: [], sampleRows: [] };

  const [cnt] = await sql<{ n: string }[]>`select count(*) as n from dataset_rows where dataset_id = ${d.id}`;
  const rowCount = Number(cnt?.n ?? 0);

  // One aggregate per column; types come from the declared schema, never sniffed.
  const columns: BriefColumn[] = [];
  // The declared order wins over jsonb's key sort; unlisted keys follow.
  const stored = d.column_order ?? [];
  const ordered = [
    ...stored.filter((k) => k in d.row_schema).map((k) => [k, d.row_schema[k]!] as const),
    ...Object.entries(d.row_schema).filter(([k]) => !stored.includes(k)),
  ];
  for (const [key, type] of ordered) {
    let stats: ColumnStats = { type };
    if (rowCount > 0 && type === 'number') {
      const [agg] = await sql<{ mn: string | null; mx: string | null }[]>`
        select min((row->>${key})::numeric) as mn, max((row->>${key})::numeric) as mx
        from dataset_rows where dataset_id = ${d.id} and row->>${key} is not null`;
      stats = { type, min: agg?.mn === null || agg?.mn === undefined ? null : Number(agg.mn), max: agg?.mx === null || agg?.mx === undefined ? null : Number(agg.mx) };
    } else if (rowCount > 0 && type === 'string') {
      const [agg] = await sql<{ card: string; mn: string | null; mx: string | null }[]>`
        select count(distinct row->>${key}) as card, min(row->>${key}) as mn, max(row->>${key}) as mx
        from dataset_rows where dataset_id = ${d.id} and row->>${key} is not null`;
      const distinct = Number(agg?.card ?? 0);
      const looksDated = agg?.mn != null && agg?.mx != null && DATE_RE.test(agg.mn) && DATE_RE.test(agg.mx);
      stats = looksDated
        ? { type, distinct, dateMin: agg!.mn, dateMax: agg!.mx }
        : { type, distinct };
    }
    const display = prettifyColumn(key, d.column_display);
    columns.push({ key, display, type, sentence: columnSentence(display, stats), stats });
  }

  const sample = await sql<{ id: string; row: Record<string, unknown> }[]>`
    select id, row from dataset_rows where dataset_id = ${d.id}
    order by id desc limit ${Math.min(input.sampleLimit ?? 5, 20)}`;

  return {
    exists: true, dataset: input.dataset, rowCount, columns,
    sampleRows: sample.map((r) => ({ ...r.row, _id: r.id })),
  };
}

/** The grid's page read - rows with their kernel ids. */
export async function datasetRowsPage(
  sql: postgres.Sql,
  input: { orgId: string; projectId: string | null; dataset: string; limit?: number; offset?: number },
): Promise<{ rows: Array<Record<string, unknown> & { _id: string }>; total: number }> {
  const [d] = await sql<{ id: string }[]>`
    select id from datasets
    where org_id = ${input.orgId} and ${projectArm(sql, input.projectId)} and name = ${input.dataset} and deleted_at is null`;
  if (!d) return { rows: [], total: 0 };
  const [cnt] = await sql<{ n: string }[]>`select count(*) as n from dataset_rows where dataset_id = ${d.id}`;
  // Oldest first - a just-added row lands at the bottom, in view.
  const rows = await sql<{ id: string; row: Record<string, unknown> }[]>`
    select id, row from dataset_rows where dataset_id = ${d.id}
    order by created_at asc, id asc
    limit ${Math.min(input.limit ?? 200, 1000)} offset ${Math.max(input.offset ?? 0, 0)}`;
  return { rows: rows.map((r) => ({ ...r.row, _id: r.id })), total: Number(cnt?.n ?? 0) };
}
