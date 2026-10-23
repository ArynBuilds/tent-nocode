import type postgres from 'postgres';
import {
  SCENE_ROOT_ID, libraryItemRef, libraryItemSchema, payloadSchema, primitiveOfNode, primitiveRef, sceneDocumentSchema,
  type LibraryItem, type SceneDocument, type SceneNode,
} from '@tent-nocode/core';
import { emitEvent } from '../events.js';
import { projectArm } from '../containment.js';

// THE LIBRARY (Phase 12, ruling 6; the stock seed died in 12R): one file - the store of saved
// items (a document of the five plus the children an instance may override), the mint from a
// selection and the instance mint. Figma's shape: the main component is a tree, an instance
// points at it and carries overrides. There is no shipped seed - every item is user-minted.

const ACTOR = 'kernel.scenes';

export interface LibraryItemRow {
  id: string;
  name: string;
  version: number;
  item: LibraryItem;
  status: 'active' | 'retired';
  createdBy: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// The gate: an item is a document of the five whose exposed and variant ids exist.
// ---------------------------------------------------------------------------

export function validateLibraryItem(input: unknown): { ok: true; item: LibraryItem; notes: string[] } | { ok: false; errors: string[] } {
  const parsed = libraryItemSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.slice(0, 10).map((i) => `${i.path.join('.') || 'item'}: ${i.message}`) };
  }
  const item = parsed.data;
  const errors: string[] = [];
  const notes: string[] = [];
  const nodes = item.document.nodes;
  if (nodes[SCENE_ROOT_ID] === undefined) errors.push("the item's document has no root");
  for (const node of Object.values(nodes)) {
    const keys = Object.keys(node.components);
    if (keys.length === 0 && node.id !== SCENE_ROOT_ID) { errors.push(`node '${node.id}' carries no primitive`); continue; }
    if (keys.length > 1) errors.push(`node '${node.id}' carries ${keys.length} components - a node is one primitive`);
    const p = primitiveOfNode(node);
    if (p === null) { if (keys.length > 0) errors.push(`node '${node.id}': '${keys[0]}' is not a primitive`); continue; }
    if (node.id === SCENE_ROOT_ID && p.name !== 'frame') errors.push('the root of an item is a frame');
    if (p.name === 'instance' && typeof p.payload['component'] === 'string' && p.payload['component'].replace(/@\d+$/, '') === item.name) {
      errors.push(`node '${node.id}' places '${item.name}' inside itself`);
    }
    const check = payloadSchema(p.name).safeParse(p.payload);
    if (!check.success) for (const i of check.error.issues.slice(0, 6)) errors.push(`node '${node.id}'.${i.path.join('.') || p.name}: ${i.message}`);
  }
  for (const id of item.exposed) if (nodes[id] === undefined) errors.push(`exposed '${id}' is not a node of the item`);
  for (const [variant, patches] of Object.entries(item.variants)) {
    for (const id of Object.keys(patches)) {
      if (nodes[id] === undefined) errors.push(`variant '${variant}' patches '${id}' which the item does not hold`);
      else if (id !== SCENE_ROOT_ID && !item.exposed.includes(id)) notes.push(`variant '${variant}' patches '${id}' which is not exposed - an instance cannot override it by hand`);
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, item, notes };
}

// ---------------------------------------------------------------------------
// The store: immutable versions per name; a name resolves to its latest.
// ---------------------------------------------------------------------------

export async function saveLibraryItem(
  sql: postgres.Sql,
  input: { orgId: string; projectId: string | null; item: unknown; createdBy: string },
): Promise<{ ok: true; ref: string; version: number } | { ok: false; errors: string[] }> {
  const valid = validateLibraryItem(input.item);
  if (!valid.ok) return valid;
  const item = valid.item;
  return sql.begin(async (tx) => {
    const t = tx as unknown as postgres.Sql;
    const [head] = await t<{ version: number }[]>`
      select version from component_definitions
      where org_id = ${input.orgId} and ${projectArm(t, input.projectId)} and name = ${item.name}
      order by version desc limit 1`;
    const version = head === undefined ? 1 : head.version + 1;
    const stored: LibraryItem = { ...item, version };
    await t`
      insert into component_definitions (org_id, project_id, name, version, definition, created_by)
      values (${input.orgId}, ${input.projectId}, ${item.name}, ${version}, ${t.json(stored as unknown as postgres.JSONValue)}, ${input.createdBy})`;
    await emitEvent(t, {
      orgId: input.orgId, actor: ACTOR, type: 'component.published',
      payload: { name: item.name, version, ref: libraryItemRef(stored), projectId: input.projectId },
    });
    return { ok: true as const, ref: libraryItemRef(stored), version };
  });
}

/** Hard delete of every version under a name (no users yet). */
export async function deleteLibraryItem(
  sql: postgres.Sql, input: { orgId: string; projectId: string | null; name: string; reason: string },
): Promise<{ ok: true; deleted: number } | { ok: false; errors: string[] }> {
  const rows = await sql<{ id: string }[]>`
    delete from component_definitions
    where org_id = ${input.orgId} and ${projectArm(sql, input.projectId)} and name = ${input.name}
    returning id`;
  if (rows.length === 0) return { ok: false, errors: [`'${input.name}' has no versions to delete`] };
  await emitEvent(sql, {
    orgId: input.orgId, actor: ACTOR, type: 'component.retired',
    payload: { name: input.name, versions: rows.length, reason: input.reason },
  });
  return { ok: true, deleted: rows.length };
}

/** A name or name@version -> the saved item; there is no shipped seed. */
export async function resolveLibraryItem(
  sql: postgres.Sql, orgId: string, projectId: string | null, nameOrRef: string,
): Promise<{ item: LibraryItem; status: 'active' | 'retired' } | null> {
  const at = nameOrRef.lastIndexOf('@');
  const name = at === -1 ? nameOrRef : nameOrRef.slice(0, at);
  const version = at === -1 ? null : Number(nameOrRef.slice(at + 1));
  if (version !== null && !Number.isInteger(version)) return null;
  const [row] = await sql<{ definition: unknown; status: 'active' | 'retired' }[]>`
    select definition, status from component_definitions
    where org_id = ${orgId} and ${projectArm(sql, projectId)} and name = ${name}
      and ${version === null ? sql`true` : sql`version = ${version}`}
    order by version desc limit 1`;
  if (row === undefined) return null;
  const parsed = libraryItemSchema.safeParse(row.definition);
  return parsed.success ? { item: parsed.data, status: row.status } : null;
}

/** Every item this project can place: the latest version per saved name - saved rows alone. */
export async function listLibraryItems(sql: postgres.Sql, orgId: string, projectId: string | null): Promise<LibraryItemRow[]> {
  const rows = await sql<Array<{ id: string; name: string; version: number; definition: unknown; status: 'active' | 'retired'; created_by: string; created_at: string }>>`
    select id, name, version, definition, status, created_by, created_at
    from component_definitions where org_id = ${orgId} and ${projectArm(sql, projectId)}
    order by name asc, version desc`;
  const out: LibraryItemRow[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.name)) continue;
    const parsed = libraryItemSchema.safeParse(r.definition);
    if (!parsed.success) continue;
    seen.add(r.name);
    out.push({ id: r.id, name: r.name, version: r.version, item: parsed.data, status: r.status, createdBy: r.created_by, createdAt: new Date(r.created_at).toISOString() });
  }
  return out;
}

/** Which screens place which versions - one query over the documents. */
export async function libraryItemUsage(
  sql: postgres.Sql, orgId: string, name: string, projectId: string | null = null,
): Promise<Array<{ slug: string; title: string; ref: string }>> {
  const instanceKey = primitiveRef('instance');
  const rows = await sql<Array<{ slug: string; title: string; ref: string }>>`
    select s.slug, s.title, refs.ref
    from scenes s,
      lateral (
        select distinct node.value->'components'->${instanceKey}->>'component' as ref
        from jsonb_each(s.document->'nodes') as node(id, value)
        where split_part(node.value->'components'->${instanceKey}->>'component', '@', 1) = ${name}
      ) refs
    where s.org_id = ${orgId} and ${projectArm(sql, projectId, 's')} and s.status != 'deleted'
    order by s.slug asc, refs.ref asc`;
  return rows;
}

// ---------------------------------------------------------------------------
// The mints: an item from a selection (the hand door), an instance from an item.
// ---------------------------------------------------------------------------

function slugOf(words: string): string {
  return words.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'item';
}

/** The instance payload that places an item (Figma's createInstance): the name, its first variant when it has one. */
export function mintInstance(item: LibraryItem, opts?: { pin?: boolean; variant?: string }): Record<string, unknown> {
  const variants = Object.keys(item.variants);
  const variant = opts?.variant ?? variants[0];
  return {
    component: opts?.pin === true ? libraryItemRef(item) : item.name,
    ...(variant !== undefined ? { variant } : {}),
  };
}

/** A selected node's subtree becomes an item: the selection is the root, every text and field child is exposed. */
export async function mintLibraryItem(
  sql: postgres.Sql,
  input: { orgId: string; projectId: string | null; sceneSlug: string; nodeId: string; title: string; createdBy: string },
): Promise<{ ok: true; ref: string; notes: string[] } | { ok: false; errors: string[] }> {
  const [scene] = await sql<{ document: unknown; project_id: string | null }[]>`
    select document, project_id from scenes
    where org_id = ${input.orgId} and slug = ${input.sceneSlug} and status != 'deleted'`;
  if (scene === undefined) return { ok: false, errors: [`scene not found in org: ${input.sceneSlug}`] };
  const doc: SceneDocument = sceneDocumentSchema.parse(scene.document);
  const source = doc.nodes[input.nodeId];
  if (source === undefined) return { ok: false, errors: [`'${input.nodeId}' is not on this screen anymore`] };
  const inSubtree = new Set<string>([input.nodeId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const node of Object.values(doc.nodes)) {
      if (node.parent !== null && inSubtree.has(node.parent) && !inSubtree.has(node.id)) { inSubtree.add(node.id); grew = true; }
    }
  }
  const notes: string[] = [];
  const map = (id: string): string => (id === input.nodeId ? SCENE_ROOT_ID : id === SCENE_ROOT_ID ? 'root-1' : id);
  const nodes: Record<string, SceneNode> = {};
  const exposed: string[] = [];
  for (const id of inSubtree) {
    const node = structuredClone(doc.nodes[id]!);
    const mapped: SceneNode = { ...node, id: map(id), parent: id === input.nodeId ? null : map(node.parent!) };
    if (id === input.nodeId) {
      mapped.order = 'a';
      delete mapped.slot;
      delete mapped.variantOf;
      // The item's root carries no position of its own; each instance places itself.
      const p = primitiveOfNode(mapped);
      if (p !== null) {
        const { x: _x, y: _y, free: _f, pin: _pin, ...rest } = p.payload;
        mapped.components[p.ref] = rest;
      }
    } else {
      const p = primitiveOfNode(mapped);
      if (p !== null && (p.name === 'text' || p.name === 'field')) exposed.push(mapped.id);
    }
    for (const [key, target] of Object.entries(mapped.refs ?? {})) {
      if (target.startsWith('scene:')) continue;
      if (!inSubtree.has(target)) {
        delete mapped.refs![key];
        notes.push(`ref '${key}' pointed outside the selection - it stays on the screen, not in the item`);
      } else mapped.refs![key] = map(target);
    }
    nodes[mapped.id] = mapped;
  }
  const item = {
    name: slugOf(input.title), version: 1, title: input.title,
    description: `${input.title} - made from a selection`,
    keywords: slugOf(input.title).split('-').join(' '),
    document: { schemaVersion: 1, revision: 0, nodes }, exposed, variants: {},
  };
  const created = await saveLibraryItem(sql, { orgId: input.orgId, projectId: input.projectId ?? scene.project_id, item, createdBy: input.createdBy });
  if (!created.ok) return created;
  return { ok: true, ref: created.ref, notes };
}

// ---------------------------------------------------------------------------
// STANDING DOORS - the names the old component library's callers still import
// (chat/actions, governed, portability, packageImport, packageExport, serve,
// readsTabs, writesOrg, room-server data, the project lens). Each rides the item
// store above; the callers are rewritten in waves C-E and the names go with them.
// ---------------------------------------------------------------------------

/** Namespaces the old refs wore; an item name carries no namespace, and these words refuse. */
export const RESERVED_NAMESPACES = ['core', 'c2d', 'three', 'media', 'chart', 'stock'];

export type ProjectDefinition = LibraryItem;

/** The old version-bump map; an item's versions carry no migration, the field is accepted and unused. */
export interface ComponentMigrationMap { renamed?: Record<string, string>; removed?: string[]; defaultChanged?: string[] }

export interface OrgComponentRow {
  id: string; name: string; version: number; definition: LibraryItem;
  status: 'active' | 'retired'; createdBy: string; createdAt: string;
}

export function parseStoredDefinition(v: unknown): ProjectDefinition {
  return libraryItemSchema.parse(v);
}

export function validateOrgDefinition(input: unknown): { ok: true; def: ProjectDefinition; notes: string[] } | { ok: false; errors: string[] } {
  const r = validateLibraryItem(input);
  return r.ok ? { ok: true, def: r.item, notes: r.notes } : r;
}

export async function createOrgComponent(
  sql: postgres.Sql,
  input: { orgId: string; projectId: string | null; definition: unknown; migration?: ComponentMigrationMap; createdBy: string },
): Promise<{ ok: true; ref: string; version: number } | { ok: false; errors: string[] }> {
  return saveLibraryItem(sql, { orgId: input.orgId, projectId: input.projectId, item: input.definition, createdBy: input.createdBy });
}

export async function retireOrgComponent(
  sql: postgres.Sql, input: { orgId: string; projectId: string | null; name: string; reason: string },
): Promise<{ ok: true; retired: number } | { ok: false; errors: string[] }> {
  const r = await deleteLibraryItem(sql, input);
  return r.ok ? { ok: true, retired: r.deleted } : r;
}

export async function resolveOrgDefinition(
  sql: postgres.Sql, orgId: string, ref: string, projectId: string | null = null,
): Promise<{ definition: ProjectDefinition; status: string } | null> {
  const r = await resolveLibraryItem(sql, orgId, projectId, ref);
  return r === null ? null : { definition: r.item, status: r.status };
}

export async function listOrgComponents(sql: postgres.Sql, orgId: string, projectId: string | null = null): Promise<OrgComponentRow[]> {
  return (await listLibraryItems(sql, orgId, projectId))
    .map((r) => ({ id: r.id, name: r.name, version: r.version, definition: r.item, status: r.status, createdBy: r.createdBy, createdAt: r.createdAt }));
}

export const componentUsage = libraryItemUsage;

/** The five carry no org-authored definitions: the map is always empty (its callers served the old code components). */
export async function orgDefinitionsForRefs(
  _sql: postgres.Sql, _orgId: string, _refs: string[], _projectId: string | null = null,
): Promise<Map<string, { definition: { params: Record<string, { default?: unknown }>; code?: string }; status: string }>> {
  return new Map();
}
