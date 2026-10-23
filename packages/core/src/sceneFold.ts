import {
  SCENE_ROOT_ID, composedChildren, validateSceneStructure,
  type SceneDocument, type SceneNode, type SceneOp,
} from './scene.js';
import { keyBetween } from './sceneOrder.js';

// The pure op fold: (document, ops) → new document. Deterministic; the batch is atomic — the first failing op rejects the whole fold.

// Generous structural caps.
const MAX_NODES = 1000;
const MAX_DEPTH = 24;
const MAX_COMPONENTS_PER_NODE = 16;

export type FoldResult =
  | { ok: true; doc: SceneDocument; notes: string[] }
  | { ok: false; errors: string[] };

export function applyOpsToDocument(input: SceneDocument, ops: SceneOp[]): FoldResult {
  const doc = structuredClone(input) as SceneDocument;
  const notes: string[] = [];

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    const err = applyOne(doc, op, notes);
    if (err) return { ok: false, errors: [`ops[${i}] (${op.op}): ${err}`] };
  }

  const structural = validateSceneStructure(doc);
  if (structural.length > 0) {
    return { ok: false, errors: structural.map((e) => `after applying the batch: ${e}`) };
  }
  if (Object.keys(doc.nodes).length > MAX_NODES) {
    return { ok: false, errors: [`the document would hold ${Object.keys(doc.nodes).length} nodes — the cap is ${MAX_NODES}; split the scene or remove unused subtrees`] };
  }
  return { ok: true, doc, notes };
}

function applyOne(doc: SceneDocument, op: SceneOp, notes: string[]): string | null {
  switch (op.op) {
    case 'create_node': {
      if (doc.nodes[op.id]) return `a node '${op.id}' already exists — pick a fresh id or target it with set_property/move_node`;
      const parent = doc.nodes[op.parent];
      if (!parent) return `parent '${op.parent}' does not exist — create it first or fix the id`;
      if (depthOf(doc, op.parent) + 1 > MAX_DEPTH) return `this would nest deeper than ${MAX_DEPTH} levels — flatten the tree`;
      const comps = op.components ?? {};
      if (Object.keys(comps).length > MAX_COMPONENTS_PER_NODE) return `a node carries at most ${MAX_COMPONENTS_PER_NODE} components`;
      if (op.variantOf) {
        const vErr = checkMembership(parent, op.variantOf);
        if (vErr) return vErr;
      }
      const order = orderFor(doc, op.parent, op.position, null);
      if (typeof order !== 'string') return order.err;
      const node: SceneNode = { id: op.id, parent: op.parent, order, components: comps };
      if (op.slot !== undefined) node.slot = op.slot;
      if (op.variantOf !== undefined) node.variantOf = op.variantOf;
      doc.nodes[op.id] = node;
      return null;
    }
    case 'remove_node': {
      if (op.id === SCENE_ROOT_ID) return `the root cannot be removed — remove its children instead`;
      if (!doc.nodes[op.id]) return null; // gone-node no-op: retries and repeats are safe
      const doomed = subtreeIds(doc, op.id);
      for (const id of doomed) delete doc.nodes[id];
      for (const survivor of Object.values(doc.nodes)) {
        for (const [key, target] of Object.entries(survivor.refs ?? {})) {
          if (doomed.has(target)) {
            delete survivor.refs![key];
            notes.push(`ref '${key}' on '${survivor.id}' dropped — its target was removed with '${op.id}'`);
          }
        }
        if (survivor.refs && Object.keys(survivor.refs).length === 0) delete survivor.refs;
      }
      return null;
    }
    case 'set_property': {
      const node = doc.nodes[op.node];
      if (!node) return `node '${op.node}' does not exist`;
      const comp = node.components[op.component];
      if (!comp) {
        const have = Object.keys(node.components);
        return `node '${op.node}' has no component '${op.component}' — its components are [${have.join(', ') || 'none'}]`;
      }
      // If the replaced value repeats on siblings' same component+key, surface them in notes.
      const prev = comp[op.key];
      if (prev !== undefined && node.parent) {
        const twins = composedChildren(doc, node.parent)
          .filter((s) => s.id !== node.id && JSON.stringify(s.components[op.component]?.[op.key]) === JSON.stringify(prev))
          .map((s) => s.id);
        if (twins.length > 0) {
          notes.push(`'${op.node}'.${op.component}.${op.key} changed — siblings [${twins.join(', ')}] still carry the old value; edit them too if the change was meant for all`);
        }
      }
      comp[op.key] = op.value;
      return null;
    }
    case 'move_node': {
      const node = doc.nodes[op.node];
      if (!node) return `node '${op.node}' does not exist`;
      if (op.node === SCENE_ROOT_ID) return `the root cannot move`;
      if (!doc.nodes[op.parent]) return `parent '${op.parent}' does not exist`;
      if (op.parent === op.node || subtreeIds(doc, op.node).has(op.parent)) {
        return `moving '${op.node}' under '${op.parent}' would create a cycle — '${op.parent}' is inside '${op.node}'`;
      }
      if (node.variantOf) {
        const vErr = checkMembership(doc.nodes[op.parent]!, node.variantOf);
        if (vErr) return `this node is a variant member and ${vErr}`;
      }
      const order = orderFor(doc, op.parent, op.position, op.node);
      if (typeof order !== 'string') return order.err;
      node.parent = op.parent; // parent + order atomic in one op
      node.order = order;
      return null;
    }
    case 'set_variant': {
      const node = doc.nodes[op.node];
      if (!node) return `node '${op.node}' does not exist`;
      const set = node.variants?.[op.set];
      if (!set) {
        const have = Object.keys(node.variants ?? {});
        return `node '${op.node}' declares no variant set '${op.set}' — its sets are [${have.join(', ') || 'none'}]`;
      }
      if (!set.options.includes(op.selection)) {
        return `'${op.selection}' is not an option of set '${op.set}' — the options are [${set.options.join(', ')}]`;
      }
      set.selection = op.selection;
      return null;
    }
    case 'set_ref': {
      const node = doc.nodes[op.node];
      if (!node) return `node '${op.node}' does not exist`;
      // `scene:<slug>` targets are checked by the wall; this pure fold validates node targets only.
      if (!op.target.startsWith('scene:') && !doc.nodes[op.target]) return `ref target '${op.target}' does not exist`;
      node.refs = { ...(node.refs ?? {}), [op.key]: op.target };
      return null;
    }
    case 'set_component': {
      const node = doc.nodes[op.node];
      if (!node) return `node '${op.node}' does not exist`;
      const isNew = node.components[op.component] === undefined;
      if (isNew && Object.keys(node.components).length >= MAX_COMPONENTS_PER_NODE) {
        return `a node carries at most ${MAX_COMPONENTS_PER_NODE} components`;
      }
      node.components[op.component] = op.value;
      return null;
    }
    case 'remove_component': {
      const node = doc.nodes[op.node];
      if (!node) return `node '${op.node}' does not exist`;
      delete node.components[op.component]; // absent = no-op (idempotent unsetter)
      return null;
    }
    case 'declare_variant_set': {
      const node = doc.nodes[op.node];
      if (!node) return `node '${op.node}' does not exist`;
      if (node.variantOf) return `node '${op.node}' is itself a variant member — variants may not nest (D-141); declare the set on a non-member node`;
      if (new Set(op.options).size !== op.options.length) return `options repeat — each option once`;
      if (!op.options.includes(op.default)) return `default '${op.default}' is not one of the options [${op.options.join(', ')}]`;
      const prev = node.variants?.[op.set];
      const next: { options: string[]; default: string; selection?: string } = { options: op.options, default: op.default };
      if (prev?.selection !== undefined && op.options.includes(prev.selection)) next.selection = prev.selection;
      node.variants = { ...(node.variants ?? {}), [op.set]: next };
      return null; // members orphaned by dropped options are named by the final structural gate
    }
    case 'remove_variant_set': {
      const node = doc.nodes[op.node];
      if (!node) return `node '${op.node}' does not exist`;
      if (!node.variants?.[op.set]) return null; // absent = no-op
      const members = Object.values(doc.nodes)
        .filter((n) => n.parent === op.node && n.variantOf?.set === op.set)
        .map((n) => n.id);
      if (members.length > 0) {
        return `set '${op.set}' still has members [${members.join(', ')}] — remove or re-tag them first`;
      }
      delete node.variants[op.set];
      if (Object.keys(node.variants).length === 0) delete node.variants;
      return null;
    }
    case 'remove_ref': {
      const node = doc.nodes[op.node];
      if (!node) return `node '${op.node}' does not exist`;
      if (node.refs) {
        delete node.refs[op.key]; // absent = no-op
        if (Object.keys(node.refs).length === 0) delete node.refs;
      }
      return null;
    }
  }
}

function checkMembership(parent: SceneNode, m: { set: string; option: string }): string | null {
  const set = parent.variants?.[m.set];
  if (!set) return `parent '${parent.id}' declares no variant set '${m.set}' — declare the set on the parent first`;
  if (!set.options.includes(m.option)) return `option '${m.option}' is not in set '${m.set}' — the options are [${set.options.join(', ')}]`;
  return null;
}

function depthOf(doc: SceneDocument, id: string): number {
  let d = 0;
  let cur: string | null = id;
  while (cur !== null && d <= MAX_DEPTH + 1) {
    const n: SceneNode | undefined = doc.nodes[cur];
    if (!n) break;
    cur = n.parent;
    d++;
  }
  return d;
}

function subtreeIds(doc: SceneDocument, rootId: string): Set<string> {
  const out = new Set<string>([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of Object.values(doc.nodes)) {
      if (n.parent !== null && out.has(n.parent) && !out.has(n.id)) { out.add(n.id); grew = true; }
    }
  }
  return out;
}

/** Resolves a position intent into a fractional key among the parent's current children. */
function orderFor(
  doc: SceneDocument, parentId: string,
  position: { anchor: 'before' | 'after' | 'end'; ref?: string },
  movingId: string | null,
): string | { err: string } {
  const siblings = Object.values(doc.nodes)
    .filter((n) => n.parent === parentId && n.id !== movingId)
    .sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : a.id < b.id ? -1 : 1));
  if (position.anchor === 'end') {
    const last = siblings[siblings.length - 1];
    return keyBetween(last ? last.order : null, null);
  }
  const idx = siblings.findIndex((s) => s.id === position.ref);
  if (idx === -1) {
    return { err: `position ref '${position.ref}' is not a child of '${parentId}' — anchor on a real sibling or use anchor 'end'` };
  }
  if (position.anchor === 'before') {
    const below = idx > 0 ? siblings[idx - 1]!.order : null;
    return keyBetween(below, siblings[idx]!.order);
  }
  const above = idx < siblings.length - 1 ? siblings[idx + 1]!.order : null;
  return keyBetween(siblings[idx]!.order, above);
}
