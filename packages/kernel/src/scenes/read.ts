import type postgres from 'postgres';
import { composedChildren, sceneOpsBatchSchema, type SceneDocument, type SceneNode } from '@nodeloom/core';
import { getSceneDocument, requireScene } from './store.js';

// Bounded scene reads: getSubtree (depth/count-budgeted) and explainProperty (provenance from the revision log).

export interface SubtreeNode {
  id: string;
  parent: string | null;
  slot?: string;
  variantOf?: { set: string; option: string };
  components: Record<string, Record<string, unknown>>;
  variants?: Record<string, { options: string[]; default: string; selection?: string }>;
  refs?: Record<string, string>;
  /** Children in composed order (variant-selected only), depth-limited. */
  children: SubtreeNode[] | { omitted: number; note: string };
}

const DEFAULT_DEPTH = 3;
const DEFAULT_MAX_NODES = 60;

export async function getSubtree(
  sql: postgres.Sql,
  input: { orgId: string; sceneSlug: string; nodeId?: string; depth?: number; maxNodes?: number },
): Promise<{ revision: number; subtree: SubtreeNode | null; truncated: boolean }> {
  const scene = await requireScene(sql, input.orgId, input.sceneSlug);
  const doc = await getSceneDocument(sql, { orgId: input.orgId, sceneId: scene.id });
  const rootId = input.nodeId ?? 'root';
  const node = doc.nodes[rootId];
  if (!node) return { revision: doc.revision, subtree: null, truncated: false };

  const budget = { left: Math.max(1, input.maxNodes ?? DEFAULT_MAX_NODES), truncated: false };
  const subtree = project(doc, node, input.depth ?? DEFAULT_DEPTH, budget);
  return { revision: doc.revision, subtree, truncated: budget.truncated };
}

function project(
  doc: SceneDocument, node: SceneNode, depth: number,
  budget: { left: number; truncated: boolean },
): SubtreeNode {
  budget.left--;
  const out: SubtreeNode = { id: node.id, parent: node.parent, components: node.components, children: [] };
  if (node.slot !== undefined) out.slot = node.slot;
  if (node.variantOf !== undefined) out.variantOf = node.variantOf;
  if (node.variants !== undefined) out.variants = node.variants;
  if (node.refs !== undefined) out.refs = node.refs;

  const kids = composedChildren(doc, node.id);
  if (depth <= 0 || budget.left <= 0) {
    if (kids.length > 0) {
      budget.truncated = true;
      out.children = { omitted: kids.length, note: `fetch getSubtree(nodeId: '${node.id}') for the ${kids.length} children` };
    }
    return out;
  }
  const shown: SubtreeNode[] = [];
  for (const kid of kids) {
    if (budget.left <= 0) {
      budget.truncated = true;
      shown.push({
        id: kid.id, parent: node.id, components: {},
        children: { omitted: 1, note: `budget reached — fetch getSubtree(nodeId: '${kid.id}')` },
      });
      continue;
    }
    shown.push(project(doc, kid, depth - 1, budget));
  }
  out.children = shown;
  return out;
}

export interface PropertyProvenance {
  revisionNo: number;
  actor: string;
  createdAt: string;
  op: string;
  value: unknown;
}

/** The winner (last op to touch node.component.key) and up to five losers beneath it. */
export async function explainProperty(
  sql: postgres.Sql,
  input: { orgId: string; sceneSlug: string; nodeId: string; component: string; key: string },
): Promise<{ winner: PropertyProvenance | null; losers: PropertyProvenance[] }> {
  const scene = await requireScene(sql, input.orgId, input.sceneSlug);
  const revisions = await sql<{ revision_no: number; ops: unknown; actor: string; created_at: string }[]>`
    select revision_no, ops, actor, created_at from scene_revisions
    where scene_id = ${scene.id} order by revision_no desc`;

  const touches: PropertyProvenance[] = [];
  for (const rev of revisions) {
    const ops = sceneOpsBatchSchema.safeParse(rev.ops);
    if (!ops.success) continue; // a future op grammar this build can't parse: skip honestly
    for (let i = ops.data.length - 1; i >= 0; i--) {
      const op = ops.data[i]!;
      const touch =
        (op.op === 'set_property' && op.node === input.nodeId && op.component === input.component && op.key === input.key)
          ? { op: 'set_property', value: op.value }
          : (op.op === 'create_node' && op.id === input.nodeId && op.components?.[input.component] !== undefined
              && input.key in (op.components[input.component] ?? {}))
            ? { op: 'create_node', value: op.components[input.component]![input.key] }
            : null;
      if (touch) {
        touches.push({
          revisionNo: rev.revision_no, actor: rev.actor,
          createdAt: new Date(rev.created_at).toISOString(), ...touch,
        });
      }
    }
    if (touches.length >= 6) break;
  }
  return { winner: touches[0] ?? null, losers: touches.slice(1, 6) };
}
