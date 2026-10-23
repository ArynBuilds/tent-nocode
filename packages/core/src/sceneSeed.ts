import { SCENE_ROOT_ID, type SceneDocument, type SceneNode, type SceneOp } from './scene.js';

// The seed fold: document → the one ops batch that recreates it through the normal mutation wall. Refs land last.
export function documentToOps(doc: SceneDocument): SceneOp[] {
  const ops: SceneOp[] = [];
  const refOps: SceneOp[] = [];

  const emitVariantSets = (node: SceneNode): void => {
    for (const [set, decl] of Object.entries(node.variants ?? {})) {
      ops.push({ op: 'declare_variant_set', node: node.id, set, options: [...decl.options], default: decl.default });
      if (decl.selection !== undefined) {
        ops.push({ op: 'set_variant', node: node.id, set, selection: decl.selection });
      }
    }
  };

  const collectRefs = (node: SceneNode): void => {
    for (const [key, target] of Object.entries(node.refs ?? {})) {
      refOps.push({ op: 'set_ref', node: node.id, key, target });
    }
  };

  // The root already exists in every scene — its components/variants arrive by setter ops.
  const root = doc.nodes[SCENE_ROOT_ID];
  if (root) {
    for (const [component, value] of Object.entries(root.components)) {
      ops.push({ op: 'set_component', node: SCENE_ROOT_ID, component, value: value as Record<string, unknown> });
    }
    emitVariantSets(root);
    collectRefs(root);
  }

  const childrenOf = (parentId: string): SceneNode[] =>
    Object.values(doc.nodes)
      .filter((n) => n.parent === parentId)
      .sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : a.id < b.id ? -1 : 1));

  const walk = (parentId: string): void => {
    for (const node of childrenOf(parentId)) {
      const create: SceneOp = {
        op: 'create_node',
        id: node.id,
        parent: parentId,
        position: { anchor: 'end' },
        ...(node.slot !== undefined ? { slot: node.slot } : {}),
        ...(node.variantOf !== undefined ? { variantOf: { set: node.variantOf.set, option: node.variantOf.option } } : {}),
        ...(Object.keys(node.components).length > 0
          ? { components: node.components as Record<string, Record<string, unknown>> }
          : {}),
      };
      ops.push(create);
      emitVariantSets(node);
      collectRefs(node);
      walk(node.id);
    }
  };
  walk(SCENE_ROOT_ID);

  return [...ops, ...refOps];
}
