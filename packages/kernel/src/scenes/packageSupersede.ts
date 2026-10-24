import type postgres from 'postgres';
import { SCENE_ROOT_ID, documentToOps, type SceneDocument, type SceneOp } from '@nodeloom/core';
import { applyRevision } from './apply.js';
import { setSceneContracts } from './actions.js';
import { createScene, createSceneTab, deleteScene, getSceneDocument, requireScene } from './store.js';

// Republish landing over tproject@2: same-slug screens advance in place, absent screens retire, retired slugs
// revive; every step pushes an undo. A screen entry carries its primitives document; the fold is
// documentToOps over it.

export interface SupersedeScene {
  name: string; title: string; document: SceneDocument; bindings?: unknown[]; actions?: unknown[];
  targetScreen?: { w: number; h: number };
}

/** Ops that empty a document so the incoming fold rebuilds from true empty. */
export function clearingOps(doc: SceneDocument): SceneOp[] {
  const ops: SceneOp[] = [];
  for (const node of Object.values(doc.nodes)) {
    if (node.parent === SCENE_ROOT_ID) ops.push({ op: 'remove_node', id: node.id });
  }
  const root = doc.nodes[SCENE_ROOT_ID];
  if (root) {
    for (const component of Object.keys(root.components)) ops.push({ op: 'remove_component', node: SCENE_ROOT_ID, component });
    for (const set of Object.keys(root.variants ?? {})) ops.push({ op: 'remove_variant_set', node: SCENE_ROOT_ID, set });
    for (const key of Object.keys(root.refs ?? {})) ops.push({ op: 'remove_ref', node: SCENE_ROOT_ID, key });
  }
  return ops;
}

export async function supersedeScenes(
  sql: postgres.Sql,
  input: {
    orgId: string; createdBy: string; actor: string;
    /** The landing project; null on the room lane. */
    projectId: string | null;
    scenes: SupersedeScene[]; priorScenes: string[];
    /** The caller's compensation stack, undone in reverse on failure. */
    compensations: Array<() => Promise<void>>;
  },
): Promise<{ landed: string[]; advanced: string[]; retired: string[] }> {
  const prior = new Set(input.priorScenes);
  const incoming = new Set(input.scenes.map((s) => s.name));
  const landed: string[] = [];
  const advanced: string[] = [];
  const retired: string[] = [];

  const setTarget = async (id: string, target: { w: number; h: number } | undefined): Promise<void> => {
    if (target === undefined) return;
    await sql`update scenes set target_screen = ${sql.json(target as unknown as postgres.JSONValue)} where id = ${id}`;
  };

  const advanceInPlace = async (
    row: { id: string; title: string; head_revision: number; bindings: unknown; actions: unknown }, s: SupersedeScene,
  ): Promise<void> => {
    // Three steps so each validates against the right neighbour: clear the document, land the new contracts
    // over the empty root, then fold the new document over them.
    const before = await getSceneDocument(sql, { orgId: input.orgId, sceneId: row.id });
    let mutation = row.head_revision + 1;
    const clear = clearingOps(before);
    if (clear.length > 0) {
      const cleared = await applyRevision(sql, { orgId: input.orgId, sceneSlug: s.name, actor: input.actor, mutationId: mutation++, ops: clear as never });
      if (!cleared.ok) throw new Error(`screen ${s.name}: the wall refused the clearing - ${cleared.errors.join('; ')}`);
    }
    const contracts = await setSceneContracts(sql, {
      orgId: input.orgId, sceneSlug: s.name, bindings: s.bindings ?? [], actions: s.actions ?? [],
    });
    if (!contracts.ok) throw new Error(`screen ${s.name}: contracts refused - ${contracts.errors.join('; ')}`);
    const nextOps = documentToOps(s.document);
    if (nextOps.length > 0) {
      const applied = await applyRevision(sql, { orgId: input.orgId, sceneSlug: s.name, actor: input.actor, mutationId: mutation++, ops: nextOps as never });
      if (!applied.ok) throw new Error(`screen ${s.name}: the wall refused the supersede - ${applied.errors.join('; ')}`);
    }
    if (s.title !== row.title) await sql`update scenes set title = ${s.title} where id = ${row.id}`;
    await setTarget(row.id, s.targetScreen);
    // undo restores the prior document, contracts, and title by appended revisions in the same three steps
    const priorFold = documentToOps(before);
    input.compensations.push(async () => {
      const now = await getSceneDocument(sql, { orgId: input.orgId, sceneId: row.id });
      const undoClear = clearingOps(now);
      let head = (await requireScene(sql, input.orgId, s.name)).head_revision;
      if (undoClear.length > 0) await applyRevision(sql, { orgId: input.orgId, sceneSlug: s.name, actor: input.actor, mutationId: ++head, ops: undoClear as never });
      await setSceneContracts(sql, {
        orgId: input.orgId, sceneSlug: s.name,
        bindings: (row.bindings as unknown[] | null) ?? [], actions: (row.actions as unknown[] | null) ?? [],
      });
      if (priorFold.length > 0) await applyRevision(sql, { orgId: input.orgId, sceneSlug: s.name, actor: input.actor, mutationId: ++head, ops: priorFold as never });
      await sql`update scenes set title = ${row.title} where id = ${row.id}`;
    });
    advanced.push(s.name);
    landed.push(s.name);
  };

  // two passes: pass 1 makes every slug exist so sibling links validate, pass 2 applies folds and contracts
  type Planned = { s: SupersedeScene } & (
    | { kind: 'advance'; row: { id: string; title: string; head_revision: number; bindings: unknown; actions: unknown } }
    | { kind: 'born'; id: string });
  const planned: Planned[] = [];
  for (const s of input.scenes) {
    const [row] = await sql<{ id: string; title: string; status: string; head_revision: number; bindings: unknown; actions: unknown }[]>`
      select id, title, status, head_revision, bindings, actions from scenes
      where org_id = ${input.orgId} and slug = ${s.name}
      order by created_at desc limit 1`;
    if (row && row.status !== 'deleted') {
      if (!prior.has(s.name)) {
        // stage 1 refuses this before anything lands; defense in depth
        throw new Error(`screen ${s.name}: an app already serves a screen at this address - slug collisions refuse (nothing rename-and-dangles)`);
      }
      planned.push({ kind: 'advance', s, row });
    } else if (row) {
      // a retired slug returns: revive its scene, then advance
      await sql`update scenes set status = 'active' where id = ${row.id}`;
      input.compensations.push(async () => { await sql`update scenes set status = 'deleted' where id = ${row.id}`; });
      planned.push({ kind: 'advance', s, row });
    } else {
      // born under the exact package slug so nav refs stay whole
      const { sceneId, slug: minted } = await createScene(sql, { orgId: input.orgId, title: s.title, createdBy: input.createdBy, projectId: input.projectId });
      if (minted !== s.name) await sql`update scenes set slug = ${s.name} where id = ${sceneId}`;
      input.compensations.push(async () => {
        await sql`delete from scene_revisions where scene_id = ${sceneId}`;
        await sql`delete from scenes where id = ${sceneId}`;
      });
      const { tabId } = await createSceneTab(sql, {
        orgId: input.orgId, sceneId, sceneSlug: s.name, title: s.title, createdBy: input.createdBy, projectId: input.projectId,
      });
      input.compensations.push(async () => { await sql`delete from tabs where id = ${tabId}`; });
      planned.push({ kind: 'born', s, id: sceneId });
    }
  }
  // pass 2: folds and contracts
  for (const p of planned) {
    if (p.kind === 'advance') {
      await advanceInPlace(p.row, p.s);
      continue;
    }
    const s = p.s;
    // Contracts first (over the ground root), then the document whose queries they declare.
    if (s.bindings?.length || s.actions?.length) {
      const contracts = await setSceneContracts(sql, {
        orgId: input.orgId, sceneSlug: s.name, bindings: s.bindings ?? [], actions: s.actions ?? [],
      });
      if (!contracts.ok) throw new Error(`screen ${s.name}: contracts refused - ${contracts.errors.join('; ')}`);
    }
    const ops = documentToOps(s.document);
    if (ops.length > 0) {
      const applied = await applyRevision(sql, {
        orgId: input.orgId, sceneSlug: s.name, actor: input.actor, mutationId: 1, ops: ops as never,
      });
      if (!applied.ok) throw new Error(`screen ${s.name}: the wall refused the folded document - ${applied.errors.join('; ')}`);
    }
    await setTarget(p.id, s.targetScreen);
    landed.push(s.name);
  }

  // prior screens absent from the new release leave serving; data survives
  for (const slug of input.priorScenes) {
    if (incoming.has(slug)) continue;
    const [row] = await sql<{ id: string }[]>`
      select id from scenes where org_id = ${input.orgId} and slug = ${slug} and status != 'deleted'`;
    if (!row) continue;
    await deleteScene(sql, { orgId: input.orgId, sceneSlug: slug, reason: 'superseded - absent from the new release' });
    input.compensations.push(async () => { await sql`update scenes set status = 'active' where id = ${row.id}`; });
    retired.push(slug);
  }

  return { landed, advanced, retired };
}
