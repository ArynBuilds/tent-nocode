import { z } from 'zod';

// The Living Scene Graph document format. Stored shapes are passthrough (unknown fields preserved); op shapes are strict.

export const SCENE_SCHEMA_VERSION = 1;
export const SCENE_ROOT_ID = 'root';

/** Actor-minted node ids: short, readable, kernel-verified-unique per scene. */
export const NODE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
/** Component entry keys are always pinned definition refs: `ns::name@ver`. */
export const COMPONENT_REF_RE = /^[a-z0-9-]+::[a-z0-9-]+@\d+$/;
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const nodeId = z.string().regex(NODE_ID_RE, 'node ids are 1-64 chars: letters, digits, - and _, starting alphanumeric');
const setOrOptionName = z.string().regex(NAME_RE);
// Slot names allow camelCase; a strict superset of NAME_RE so historical values stay legal.
const slotName = z.string().regex(/^[a-z0-9][a-zA-Z0-9-]{0,63}$/, "slot names start alphanumeric: letters/digits/dashes ('header', 'cellAction')");
/** A ref target is a node in this scene or `scene:<slug>` — a reference to another scene. */
const refTarget = z.union([
  nodeId,
  z.string().regex(/^scene:[a-z0-9]+(-[a-z0-9]+)*$/, "scene refs are 'scene:<slug>'"),
]);

const variantSetSchema = z
  .object({
    options: z.array(setOrOptionName).min(1),
    default: setOrOptionName,
    selection: setOrOptionName.optional(),
  })
  .passthrough();

export const sceneNodeSchema = z
  .object({
    id: nodeId,
    /** Parent reference lives on the child — null only for the root. */
    parent: nodeId.nullable(),
    /** Kernel-assigned fractional order key — authors never write this. */
    order: z.string().min(1).max(64),
    /** Optional named slot within the parent. */
    slot: slotName.optional(),
    /** Flat variant membership tag: this node exists only when parent's set selects option. */
    variantOf: z.object({ set: setOrOptionName, option: setOrOptionName }).passthrough().optional(),
    /** Typed components keyed by pinned definition ref; payloads validated per-definition at the wall. */
    components: z.record(z.string().regex(COMPONENT_REF_RE, 'component keys are pinned refs: ns::name@ver'), z.record(z.string(), z.unknown())),
    /** Flat variant sets declared on this node. */
    variants: z.record(setOrOptionName, variantSetSchema).optional(),
    /** Typed non-parent node→node edges; a target may also be `scene:<slug>`. */
    refs: z.record(setOrOptionName, refTarget).optional(),
  })
  .passthrough();
export type SceneNode = z.infer<typeof sceneNodeSchema>;

export const sceneDocumentSchema = z
  .object({
    schemaVersion: z.number().int().min(1),
    /** The scene revision counter — stamped into rendered output and telemetry. */
    revision: z.number().int().min(0),
    nodes: z.record(z.string(), sceneNodeSchema),
  })
  .passthrough();
export type SceneDocument = z.infer<typeof sceneDocumentSchema>;

export function emptySceneDocument(): SceneDocument {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    revision: 0,
    nodes: { [SCENE_ROOT_ID]: { id: SCENE_ROOT_ID, parent: null, order: 'a', components: {} } },
  };
}

// ---------------------------------------------------------------------------
// The op grammar: intent-shaped state-setters. Absolute values only — deltas are banned.
// ---------------------------------------------------------------------------

/** Position INTENT — the model says where, the kernel derives the fractional key. */
const positionSchema = z
  .object({
    anchor: z.enum(['before', 'after', 'end']).describe('where among siblings: before/after a named sibling, or at the end'),
    ref: nodeId.optional().describe('the sibling anchor — required for before/after, forbidden for end'),
  })
  .strict()
  .refine((p) => (p.anchor === 'end' ? p.ref === undefined : p.ref !== undefined), {
    message: "position: anchors 'before'/'after' require ref (the sibling id); anchor 'end' takes no ref",
  });

const componentRef = z.string().regex(COMPONENT_REF_RE, 'component is a pinned ref: ns::name@ver');

export const sceneOpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('create_node'),
    id: nodeId.describe('caller-minted id for the new node — replays no-op on collision with identical intent'),
    parent: nodeId,
    position: positionSchema,
    slot: slotName.optional(),
    variantOf: z.object({ set: setOrOptionName, option: setOrOptionName }).strict().optional(),
    components: z.record(componentRef, z.record(z.string(), z.unknown())).optional(),
  }).strict(),
  z.object({
    op: z.literal('remove_node'),
    id: nodeId.describe('subtree tombstone — descendants cascade; removing a gone node no-ops'),
  }).strict(),
  z.object({
    op: z.literal('set_property'),
    node: nodeId,
    component: componentRef,
    key: z.string().min(1).max(128),
    value: z.unknown().describe('the FULL new value — never a delta'),
  }).strict(),
  z.object({
    op: z.literal('move_node'),
    node: nodeId,
    parent: nodeId,
    position: positionSchema,
  }).strict(),
  z.object({
    op: z.literal('set_variant'),
    node: nodeId,
    set: setOrOptionName,
    selection: setOrOptionName,
  }).strict(),
  z.object({
    op: z.literal('set_ref'),
    node: nodeId,
    key: setOrOptionName,
    target: refTarget,
  }).strict(),
  z.object({
    op: z.literal('set_component'),
    node: nodeId,
    component: componentRef,
    value: z.record(z.string(), z.unknown()).describe('the FULL component payload — add-or-replace, never a partial merge'),
  }).strict(),
  z.object({
    op: z.literal('remove_component'),
    node: nodeId,
    component: componentRef,
  }).strict(),
  z.object({
    op: z.literal('declare_variant_set'),
    node: nodeId,
    set: setOrOptionName,
    options: z.array(setOrOptionName).min(1).max(12),
    default: setOrOptionName,
  }).strict(),
  z.object({
    op: z.literal('remove_variant_set'),
    node: nodeId,
    set: setOrOptionName,
  }).strict(),
  z.object({
    op: z.literal('remove_ref'),
    node: nodeId,
    key: setOrOptionName,
  }).strict(),
]);
export type SceneOp = z.infer<typeof sceneOpSchema>;

/** One revision = one ordered batch, applied atomically. */
export const sceneOpsBatchSchema = z.array(sceneOpSchema).min(1).max(200);

// ---------------------------------------------------------------------------
// Structural validity (beyond field shapes). Pure; errors name the fix.
// ---------------------------------------------------------------------------

export function validateSceneStructure(doc: SceneDocument): string[] {
  const errs: string[] = [];
  const nodes = doc.nodes;
  const root = nodes[SCENE_ROOT_ID];
  if (!root) errs.push(`the document has no '${SCENE_ROOT_ID}' node — every scene has exactly one root with parent null`);
  else if (root.parent !== null) errs.push(`'${SCENE_ROOT_ID}' must have parent null`);

  for (const [key, node] of Object.entries(nodes)) {
    const at = `node '${key}'`;
    if (node.id !== key) errs.push(`${at}: its id field says '${node.id}' — the key and id must match`);
    if (key !== SCENE_ROOT_ID) {
      if (node.parent === null) {
        errs.push(`${at}: parent is null but only '${SCENE_ROOT_ID}' may be parentless`);
      } else if (!nodes[node.parent]) {
        errs.push(`${at}: parent '${node.parent}' does not exist — create the parent first or fix the id`);
      }
    }
    for (const [setName, set] of Object.entries(node.variants ?? {})) {
      const dup = new Set(set.options);
      if (dup.size !== set.options.length) errs.push(`${at}: variant set '${setName}' repeats an option`);
      if (!set.options.includes(set.default)) {
        errs.push(`${at}: variant set '${setName}' default '${set.default}' is not one of its options [${set.options.join(', ')}]`);
      }
      if (set.selection !== undefined && !set.options.includes(set.selection)) {
        errs.push(`${at}: variant set '${setName}' selection '${set.selection}' is not one of its options [${set.options.join(', ')}]`);
      }
    }
    if (node.variantOf) {
      if (node.variants && Object.keys(node.variants).length > 0) {
        errs.push(`${at}: carries variantOf and declares its own variant sets — variants may not nest (D-141); lift the set to a non-member node`);      }
      const parent = node.parent ? nodes[node.parent] : undefined;
      const set = parent?.variants?.[node.variantOf.set];
      if (!set) {
        errs.push(`${at}: variantOf names set '${node.variantOf.set}' but its parent declares no such set`);
      } else if (!set.options.includes(node.variantOf.option)) {
        errs.push(`${at}: variantOf option '${node.variantOf.option}' is not in parent set '${node.variantOf.set}' options [${set.options.join(', ')}]`);
      }
    }
    for (const [refKey, target] of Object.entries(node.refs ?? {})) {
      // `scene:<slug>` targets are org data the wall validates at apply.
      if (target.startsWith('scene:')) continue;
      if (!nodes[target]) errs.push(`${at}: ref '${refKey}' targets '${target}' which does not exist`);
    }
  }

  // Reachability doubles as cycle detection: every node must walk up to the root.
  for (const key of Object.keys(nodes)) {
    const seen = new Set<string>();
    let cur: string | null = key;
    while (cur !== null && !seen.has(cur)) {
      seen.add(cur);
      const n: SceneNode | undefined = nodes[cur];
      if (!n) break; // dangling parent already reported above
      cur = n.parent;
    }
    if (cur !== null && seen.has(cur)) {
      errs.push(`node '${key}': its ancestry forms a cycle through '${cur}' — reparent one of them under the root tree`);
      break; // one cycle report is enough to name the fix
    }
  }
  return errs;
}

// ---------------------------------------------------------------------------
// Composition: a variant member is present iff its parent set's selection (or default) picks it.
// ---------------------------------------------------------------------------

export function composedChildren(doc: SceneDocument, parentId: string): SceneNode[] {
  const parent = doc.nodes[parentId];
  if (!parent) return [];
  const out: SceneNode[] = [];
  for (const node of Object.values(doc.nodes)) {
    if (node.parent !== parentId) continue;
    if (node.variantOf) {
      const set = parent.variants?.[node.variantOf.set];
      const active = set ? (set.selection ?? set.default) === node.variantOf.option : false;
      if (!active) continue;
    }
    out.push(node);
  }
  return out.sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : a.id < b.id ? -1 : 1));
}
