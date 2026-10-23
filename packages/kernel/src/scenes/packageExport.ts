import type postgres from 'postgres';
import {
  LSG_PACKAGE_FORMAT, SCENE_SCHEMA_VERSION, instanceRefsIn, isSystemQueryTable,
  sceneActionsSchema, sceneBindingsSchema, sceneDocumentSchema,
  type LsgEntry, type LsgEntryDraft, type LsgPackage, type SceneDocument,
} from '@tent-nocode/core';
import { canonicalContentHash, packageHashOf } from './packageVerify.js';
import { projectArm } from '../containment.js';
import { projectThemeSchema } from '../projects.js';
import { resolveOperation } from '../operations/registry.js';
import { collectTravelEntries, startFlowRefsOf } from './packageFlows.js';
import { getSceneDocument } from './store.js';
import { sceneSlugsNamed } from './validate.js';

// THE EXPORT WALK (Phase 12, ruling 14): the package is the project document - export walks the model from
// the selected screens and emits its collections as tproject@2 entries (Webstudio's fragment shape). This
// module never reads a grant table, so a package cannot carry standing consent.

/** Pure: every screen slug a document names (scene: refs and goto actions); linked screens are hard refs. */
export function sceneRefsOf(doc: SceneDocument): string[] {
  return sceneSlugsNamed(doc).sort();
}

/** Pure: the tables a screen's contracts read or write, with the row schema its query bindings declare. */
export function contractTablesOf(actionsRaw: unknown, bindingsRaw: unknown): Map<string, Record<string, 'string' | 'number' | 'boolean'> | null> {
  const tables = new Map<string, Record<string, 'string' | 'number' | 'boolean'> | null>();
  const bindings = sceneBindingsSchema.safeParse(bindingsRaw ?? []);
  if (bindings.success) {
    for (const b of bindings.data) {
      if (b.kind === 'query' && !isSystemQueryTable(b.table)) tables.set(b.table, b.rowSchema ?? tables.get(b.table) ?? null);
    }
  }
  const actions = sceneActionsSchema.safeParse(actionsRaw ?? []);
  if (actions.success) {
    for (const action of actions.data) {
      for (const rule of action.rules) {
        if (rule.rule === 'append_row' || rule.rule === 'update_row' || rule.rule === 'delete_row') {
          if (!tables.has(rule.table)) tables.set(rule.table, null);
        }
      }
    }
  }
  return tables;
}

export interface ExportSelection {
  /** The screens the walk starts from (slugs). */
  scenes?: string[];
  /** Library items by name or name@version, as roots. */
  components?: string[];
  operations?: Array<{ name: string; version?: number }>;
  /** Data travels only by this explicit per-table choice, and always whole. */
  inlineDatasets?: string[];
  /** Projects whose notes travel; only ride when named. */
  notesProjects?: string[];
}

/** Per-table report of what actually travels, shown on the consent card and record. */
export interface InlineDatasetReport {
  name: string;
  /** Always the table's whole row count. */
  rowsIncluded: number;
  /** Serialized size of those rows. */
  bytes: number;
}

/** Data lane thresholds; injectable only so tests can exercise the lane cheaply. */
export interface DataLaneLimits {
  inlineComfortBytes: number;
  chunkTargetBytes: number;
  ceilingBytes: number;
}
export const DATA_LANE_LIMITS: DataLaneLimits = {
  inlineComfortBytes: 1024 * 1024,
  chunkTargetBytes: 4 * 1024 * 1024,
  ceilingBytes: 200 * 1024 * 1024,
};

/** Optional app and assistant identity written into the manifest at export. */
export interface ExportIdentity {
  app?: { title: string; kind?: 'app' | 'website' };
  assistant?: { name: string; description?: string };
}

type Draft = LsgEntryDraft;

export async function buildPackageClosure(
  sql: postgres.Sql,
  input: {
    orgId: string;
    /** The closure walks one project; null means the whole-account lane. */
    projectId?: string | null;
    selection: ExportSelection; license: string;
    provenance: { org: string; appVersion: string; exportedAt: string };
    identity?: ExportIdentity;
    /** Test injection only - see DataLaneLimits. */
    laneLimits?: DataLaneLimits;
  },
): Promise<{ ok: true; pkg: LsgPackage; inlineData: InlineDatasetReport[] } | { ok: false; errors: string[] }> {
  const projectId = input.projectId ?? null;
  const lane = input.laneLimits ?? DATA_LANE_LIMITS;
  const errors: string[] = [];
  const entries: LsgEntry[] = [];
  const inlineData: InlineDatasetReport[] = [];
  /** Chunk bodies keyed by canonical hash. */
  const laneData: Record<string, Record<string, unknown>[]> = {};
  let laneBytesTotal = 0;
  const seen = new Set<string>();
  const push = (e: Draft): void => {
    const key = `${e.kind}:${e.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    const { kind: _k, name: _n, role: _r, ...body } = e as Record<string, unknown>;
    entries.push({ ...e, contentHash: canonicalContentHash(body) } as LsgEntry);
  };

  // The project entry: name, kind and theme - the importer finds or births the project by it.
  if (projectId !== null) {
    const [proj] = await sql<{ name: string; kind: 'app' | 'website' | null; theme: unknown }[]>`
      select name, kind, theme from projects where id = ${projectId} and org_id = ${input.orgId} and archived_at is null`;
    if (!proj) return { ok: false, errors: [`project not found in this org: ${projectId}`] };
    const theme = projectThemeSchema.safeParse(proj.theme);
    push({
      kind: 'project', name: proj.name, role: 'root', projectName: proj.name,
      ...(proj.kind !== null ? { projectKind: proj.kind } : {}),
      ...(theme.success ? { theme: theme.data as unknown as Record<string, unknown> } : {}),
    });
  }

  const addLibraryItem = async (ref: string, role: 'root' | 'hard'): Promise<void> => {
    const at = ref.lastIndexOf('@');
    const name = at === -1 ? ref : ref.slice(0, at);
    const version = at === -1 ? undefined : Number(ref.slice(at + 1));
    const rows = version !== undefined
      ? await sql<{ name: string; version: number; definition: unknown }[]>`
          select name, version, definition from component_definitions
          where org_id = ${input.orgId} and ${projectArm(sql, projectId)} and name = ${name} and version = ${version} and status = 'active'`
      : await sql<{ name: string; version: number; definition: unknown }[]>`
          select name, version, definition from component_definitions
          where org_id = ${input.orgId} and ${projectArm(sql, projectId)} and name = ${name} and status = 'active'
          order by version desc limit 1`;
    const row = rows[0];
    // A stock item has no row and travels nowhere: it exists in every install by name.
    if (!row) { if (role === 'root') errors.push(`library item ${ref}: not found in this project's library`); return; }
    push({ kind: 'library-item', name: `${row.name}@${row.version}`, role, item: row.definition as Record<string, unknown> });
  };

  const addOperation = async (ref: { name: string; version?: number }, role: 'root' | 'hard'): Promise<void> => {
    const op = await resolveOperation(sql, input.orgId, ref, projectId);
    if (!op) { errors.push(`operation ${ref.name}${ref.version !== undefined ? `@${ref.version}` : ''}: not found`); return; }
    push({
      kind: 'operation', name: `${op.name}@${op.version}`, role,
      registration: {
        name: op.name, version: op.version, runtime: op.runtime, codeHash: op.codeHash,
        ioContract: op.ioContract as unknown, ...(op.modelHash ? { modelHash: op.modelHash } : {}),
      } as Record<string, unknown>,
      source: op.code,
      // import verifies the model's sha and license before any load
      ...(op.modelHash ? { model: { sha256: op.modelHash, license: op.modelLicense ?? 'unspecified' } } : {}),
    });
  };

  const tables = new Map<string, Record<string, 'string' | 'number' | 'boolean'> | null>();
  const noteTable = (name: string, schema: Record<string, 'string' | 'number' | 'boolean'> | null): void => {
    if (!tables.has(name) || (tables.get(name) === null && schema !== null)) tables.set(name, schema);
  };

  // Screen walk is a queue: roots first, then every linked screen joins as a hard entry; the visited set guards cycles.
  const rootScenes = new Set(input.selection.scenes ?? []);
  const sceneQueue: string[] = [...(input.selection.scenes ?? [])];
  const visitedScenes = new Set<string>();
  const flowNames = new Set<string>();
  while (sceneQueue.length > 0) {
    const slug = sceneQueue.shift()!;
    if (visitedScenes.has(slug)) continue;
    visitedScenes.add(slug);
    const [scene] = await sql<Array<{ id: string; slug: string; title: string; bindings: unknown; actions: unknown; target_screen: { w: number; h: number } | null }>>`
      select id, slug, title, bindings, actions, target_screen from scenes where org_id = ${input.orgId} and slug = ${slug} and status != 'deleted'`;
    if (!scene) { errors.push(`screen ${slug}: not found`); continue; }
    const doc = sceneDocumentSchema.parse(await getSceneDocument(sql, { orgId: input.orgId, sceneId: scene.id }));
    const sceneBindings = sceneBindingsSchema.safeParse(scene.bindings ?? []);
    const sceneActions = sceneActionsSchema.safeParse(scene.actions ?? []);
    push({
      kind: 'screen', name: scene.slug, role: rootScenes.has(slug) ? 'root' : 'hard', title: scene.title,
      document: doc,
      ...(sceneBindings.success && sceneBindings.data.length ? { bindings: sceneBindings.data as unknown[] } : {}),
      ...(sceneActions.success && sceneActions.data.length ? { actions: sceneActions.data as unknown[] } : {}),
      ...(scene.target_screen !== null ? { targetScreen: scene.target_screen } : {}),
    });
    for (const linked of sceneRefsOf(doc)) if (!visitedScenes.has(linked)) sceneQueue.push(linked);
    for (const ref of instanceRefsIn(doc)) await addLibraryItem(ref, 'hard');
    for (const flow of startFlowRefsOf(scene.actions)) flowNames.add(flow);
    for (const [name, schema] of contractTablesOf(scene.actions, scene.bindings)) noteTable(name, schema);
  }

  // Flows named by screen actions travel hard; their triggers ride soft and keyless; their tables and tools join the closure.
  if (flowNames.size > 0) {
    const travel = await collectTravelEntries(sql, { orgId: input.orgId, projectId, flowNames: [...flowNames].sort() });
    errors.push(...travel.errors);
    for (const e of travel.entries) push(e);
    for (const table of travel.tableRefs) noteTable(table, null);
    for (const tool of travel.toolRefs) await addOperation({ name: tool }, 'hard');
  }
  for (const ref of input.selection.components ?? []) await addLibraryItem(ref, 'root');
  for (const opRef of input.selection.operations ?? []) await addOperation(opRef, 'root');

  // Tables: the live schema, grain and keys; rows ride only by the explicit inline choice, and always whole.
  const inlineVisited = new Set<string>();
  for (const [name] of tables) {
    const [ds] = await sql<Array<{ id: string; row_schema: Record<string, 'string' | 'number' | 'boolean'>; key_columns: string[] | null; user_scope: string }>>`
      select id, row_schema, key_columns, user_scope from datasets
      where org_id = ${input.orgId} and ${projectArm(sql, projectId)} and name = ${name} and deleted_at is null`;
    const declared = ds?.row_schema ?? tables.get(name) ?? null;
    if (declared === null) { errors.push(`table ${name}: not declared in this project and no screen declares its columns`); continue; }
    const base: Draft = {
      kind: 'table', name, role: 'soft', rowSchema: declared,
      ...(ds?.key_columns && ds.key_columns.length > 0 ? { keyColumns: ds.key_columns } : {}),
      ...(ds && (ds.user_scope === 'own' || ds.user_scope === 'shared' || ds.user_scope === 'submitted' || ds.user_scope === 'app') ? { grain: ds.user_scope } : {}),
    };
    if (!input.selection.inlineDatasets?.includes(name)) { push(base); continue; }
    if (!ds) { errors.push(`table ${name}: cannot inline - not declared in this project`); continue; }
    inlineVisited.add(name);
    // all rows ride when ticked; created_at plus id tiebreak keeps repeated exports byte-stable
    const rowsRaw = await sql<Array<{ row: Record<string, unknown> }>>`
      select row from dataset_rows where org_id = ${input.orgId} and dataset_id = ${ds.id}
      order by created_at asc, id asc`;
    const rows = rowsRaw.map((r) => r.row);
    const bytes = Buffer.byteLength(JSON.stringify(rows), 'utf8');
    laneBytesTotal += bytes;
    if (laneBytesTotal > lane.ceilingBytes) {
      errors.push(`table ${name}: its rows push the package's data to ${(laneBytesTotal / (1024 * 1024)).toFixed(1)}MB - beyond the ${(lane.ceilingBytes / (1024 * 1024)).toFixed(0)}MB ceiling a package can carry; trim the table or untick it`);
      continue;
    }
    inlineData.push({ name, rowsIncluded: rows.length, bytes });
    if (bytes <= lane.inlineComfortBytes && rows.length <= 100_000) {
      push({ ...base, rows } as Draft);
      continue;
    }
    // greedy byte-bounded chunking; each chunk hashed canonically
    const rowChunks: Array<{ sha256: string; rows: number; bytes: number }> = [];
    let chunk: Record<string, unknown>[] = [];
    let chunkBytes = 2; // '[]'
    const flush = (): void => {
      if (chunk.length === 0) return;
      const sha256 = canonicalContentHash(chunk);
      rowChunks.push({ sha256, rows: chunk.length, bytes: Buffer.byteLength(JSON.stringify(chunk), 'utf8') });
      laneData[sha256] = chunk;
      chunk = [];
      chunkBytes = 2;
    };
    for (const row of rows) {
      const rowBytes = Buffer.byteLength(JSON.stringify(row), 'utf8') + 1;
      if (chunk.length > 0 && chunkBytes + rowBytes > lane.chunkTargetBytes) flush();
      chunk.push(row);
      chunkBytes += rowBytes;
    }
    flush();
    push({ ...base, rowChunks } as Draft);
  }
  // a requested inline table no selected screen touches refuses instead of silently dropping
  for (const name of input.selection.inlineDatasets ?? []) {
    if (!inlineVisited.has(name) && !errors.some((e) => e.startsWith(`table ${name}:`))) {
      errors.push(`table ${name}: not in the selected screens' closure - inline data rides only with a screen that reads or writes it`);
    }
  }

  // Placed services: the integration and its label, never a secret; a serving database without the table has none.
  if (projectId !== null) {
    const [reg] = await sql<{ rel: string | null }[]>`select to_regclass('public.integration_connections')::text as rel`;
    if (reg?.rel !== null && reg?.rel !== undefined) {
      const conns = await sql<Array<{ integration: string; version: number; label: string; scope: 'builder' | 'app-user' }>>`
        select integration, version, label, scope from integration_connections
        where org_id = ${input.orgId} and project_id = ${projectId} and status = 'active'
        order by created_at asc, id asc`;
      const used = new Map<string, number>();
      for (const c of conns) {
        const n = (used.get(c.integration) ?? 0) + 1;
        used.set(c.integration, n);
        push({ kind: 'service', name: n === 1 ? c.integration : `${c.integration}-${n}`, role: 'soft', integration: c.integration, version: c.version, label: c.label, scope: c.scope });
      }
    }
  }

  // notes: an unknown project or empty notes list refuses by name, never drops silently
  for (const projectName of input.selection.notesProjects ?? []) {
    const [proj] = await sql<Array<{ id: string; name: string }>>`
      select id, name from projects where org_id = ${input.orgId} and name = ${projectName} and archived_at is null`;
    if (!proj) { errors.push(`notes ${projectName}: project not found in this org`); continue; }
    const { readNotes } = await import('../notes.js');
    const notes = await readNotes(sql, { orgId: input.orgId, projectId: proj.id, limit: 200 });
    if (notes.length === 0) { errors.push(`notes ${projectName}: the project has no notes to export`); continue; }
    push({
      kind: 'notes', name: proj.name, role: 'soft', projectName: proj.name,
      notes: notes.map((n) => ({ body: n.body, author: n.author, createdAt: n.createdAt })),
    });
  }

  if (!entries.some((e) => e.kind !== 'project')) errors.push('selection: nothing to export - name at least one screen, library item, or operation');
  if (errors.length) return { ok: false, errors };

  const manifest: LsgPackage['manifest'] = {
    format: LSG_PACKAGE_FORMAT, schemaVersion: SCENE_SCHEMA_VERSION, license: input.license,
    provenance: input.provenance,
    ...(input.identity?.app !== undefined ? { app: input.identity.app } : {}),
    ...(input.identity?.assistant !== undefined ? { assistant: input.identity.assistant } : {}),
    closure: entries.map((e) => ({ kind: e.kind, name: e.name, role: e.role, contentHash: e.contentHash })),
  };
  return {
    ok: true,
    pkg: {
      manifest, entries, packageHash: packageHashOf(manifest, entries),
      // the data lane rides only when a table outgrew inline comfort
      ...(Object.keys(laneData).length > 0 ? { data: laneData } : {}),
    },
    inlineData,
  };
}

/** Dry-run of the walk: the entries a selection would carry, with reasons and counts, zero writes. */
export interface ClosurePreviewEntry {
  kind: 'screen' | 'library-item' | 'operation' | 'table';
  name: string;
  /** Screens only: the human title. */
  title?: string;
  role: 'root' | 'hard' | 'soft';
  /** One plain reason a ref rides. */
  reason?: string;
  /** Screen slugs that require this entry. */
  usedBy?: string[];
  /** Tables only: rows the org holds locally. */
  totalRows?: number;
}

export async function closurePreview(
  sql: postgres.Sql,
  input: { orgId: string; projectId?: string | null; sceneSlugs: string[] },
): Promise<{ ok: true; entries: ClosurePreviewEntry[] } | { ok: false; errors: string[] }> {
  const projectId = input.projectId ?? null;
  const errors: string[] = [];
  const entries: ClosurePreviewEntry[] = [];
  const byKey = new Map<string, ClosurePreviewEntry>();
  const add = (e: ClosurePreviewEntry, usedBySlug: string): void => {
    const key = `${e.kind}:${e.name}`;
    const prior = byKey.get(key);
    if (prior !== undefined) {
      if (prior.usedBy !== undefined && !prior.usedBy.includes(usedBySlug)) prior.usedBy.push(usedBySlug);
      return;
    }
    const withUse = { ...e, ...(e.kind === 'screen' ? {} : { usedBy: [usedBySlug] }) };
    byKey.set(key, withUse);
    entries.push(withUse);
  };
  const rootSet = new Set(input.sceneSlugs);
  const queue: Array<{ slug: string; viaRoot: string; viaTitle: string | null }> =
    input.sceneSlugs.map((slug) => ({ slug, viaRoot: slug, viaTitle: null }));
  const visited = new Set<string>();
  while (queue.length > 0) {
    const item = queue.shift()!;
    const slug = item.slug;
    if (visited.has(slug)) continue;
    visited.add(slug);
    const [scene] = await sql<Array<{ id: string; slug: string; title: string; bindings: unknown; actions: unknown }>>`
      select id, slug, title, bindings, actions from scenes where org_id = ${input.orgId} and slug = ${slug} and status != 'deleted'`;
    if (!scene) { errors.push(`screen ${slug}: not found`); continue; }
    const isRoot = rootSet.has(slug);
    add({
      kind: 'screen', name: scene.slug, title: scene.title, role: isRoot ? 'root' : 'hard',
      ...(isRoot ? {} : { reason: `the ${item.viaTitle ?? item.viaRoot} screen links to it`, usedBy: [item.viaRoot] }),
    }, item.viaRoot);
    const doc = sceneDocumentSchema.parse(await getSceneDocument(sql, { orgId: input.orgId, sceneId: scene.id }));
    for (const linked of sceneRefsOf(doc)) {
      if (!visited.has(linked)) queue.push({ slug: linked, viaRoot: isRoot ? slug : item.viaRoot, viaTitle: scene.title });
    }
    const reason = (verb: string): string => `the ${scene.title} screen ${verb} it`;
    for (const ref of instanceRefsIn(doc)) add({ kind: 'library-item', name: ref, role: 'hard', reason: reason('places') }, item.viaRoot);
    for (const [name] of contractTablesOf(scene.actions, scene.bindings)) {
      const [ds] = await sql<Array<{ id: string }>>`
        select id from datasets where org_id = ${input.orgId} and ${projectArm(sql, projectId)} and name = ${name} and deleted_at is null`;
      let totalRows = 0;
      if (ds) {
        const [cnt] = await sql<Array<{ n: string }>>`select count(*) as n from dataset_rows where org_id = ${input.orgId} and dataset_id = ${ds.id}`;
        totalRows = Number(cnt?.n ?? 0);
      }
      add({ kind: 'table', name, role: 'soft', reason: reason('reads'), totalRows }, item.viaRoot);
    }
    const flows = startFlowRefsOf(scene.actions);
    if (flows.length > 0) {
      const travel = await collectTravelEntries(sql, { orgId: input.orgId, projectId, flowNames: flows });
      for (const tool of travel.toolRefs) {
        const op = await resolveOperation(sql, input.orgId, { name: tool }, projectId);
        if (!op) { errors.push(`operation ${tool}: not found`); continue; }
        add({ kind: 'operation', name: `${op.name}@${op.version}`, role: 'hard', reason: reason('runs') }, item.viaRoot);
      }
    }
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, entries };
}
