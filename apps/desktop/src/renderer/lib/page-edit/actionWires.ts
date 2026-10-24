import { primitiveOfNode, primitiveRef } from '@nodeloom/core';
import type { SceneNode } from '@nodeloom/core';
import { freshId } from './flowWires.js';

// The declared-action writes over the five and the wave C vocabulary: a frame's action {run: name} fires a
// declared action whose rules are the row writes or start_flow (a tool or a connection runs inside a flow
// step; the button starts the flow at it). Pure builders: the action document for the setAction door and
// the node that carries the action.

export type ActionWrite = 'append' | 'start-flow';

export interface DeclaredAction {
  name: string;
  title: string;
  whenToUse: string;
  params: Record<string, { type: 'string' | 'number' | 'boolean' | 'json'; description: string; source: 'user' }>;
  rules: unknown[];
  criteria: string[];
}

const slugify = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** The words a frame shows: its first text child, else 'button'. */
export function buttonWordOf(node: SceneNode, children: readonly SceneNode[]): string {
  for (const c of children) {
    const p = primitiveOfNode(c);
    if (p !== null && p.name === 'text' && typeof p.payload['text'] === 'string' && p.payload['text'] !== '') return p.payload['text'];
  }
  const own = primitiveOfNode(node);
  return own !== null && typeof own.payload['aria-label'] === 'string' ? own.payload['aria-label'] : 'button';
}

/** The action a wired frame declares: a row write over the table's columns, or the flow started at a step. */
export function declareAction(input: {
  node: SceneNode;
  buttonWord: string;
  write: { kind: 'append'; table: string; columns: Array<{ key: string; type: 'string' | 'number' | 'boolean' }> } | { kind: 'start-flow'; flow?: string; entry: string; label: string };
  takenNames: ReadonlySet<string>;
}): { action: DeclaredAction; node: SceneNode } | null {
  const prim = primitiveOfNode(input.node);
  if (prim === null || prim.name !== 'frame') return null;
  const existing = typeof prim.payload['action'] === 'object' && prim.payload['action'] !== null ? (prim.payload['action'] as Record<string, unknown>)['run'] : undefined;
  let name = typeof existing === 'string' ? existing : (slugify(input.buttonWord) || 'run');
  if (typeof existing !== 'string') { const base = name; for (let n = 2; input.takenNames.has(name); n += 1) name = `${base}-${n}`; }
  const params: DeclaredAction['params'] = {};
  let title: string;
  let rules: unknown[];
  if (input.write.kind === 'append') {
    title = `Save to ${input.write.table}`;
    const row: Record<string, unknown> = {};
    for (const col of input.write.columns) {
      if (col.key === '_id') continue;
      params[col.key] = { type: col.type, description: col.key, source: 'user' };
      row[col.key] = { from: 'param', param: col.key };
    }
    rules = [{ rule: 'append_row', table: input.write.table, row }];
  } else {
    title = `Start ${input.write.label}`;
    rules = [{ rule: 'start_flow', ...(input.write.flow !== undefined ? { flow: input.write.flow } : {}), entry: input.write.entry }];
  }
  const action: DeclaredAction = { name, title, whenToUse: `when the '${input.buttonWord}' button is pressed`, params, rules, criteria: [] };
  const node: SceneNode = { ...input.node, components: { ...input.node.components, [prim.ref]: { ...prim.payload, action: { run: name } } } };
  return { action, node };
}

/** The field children an append action still needs, born beside the button in its parent. */
export function formFieldNodes(input: {
  parent: string;
  params: Array<{ name: string; type: string; description?: string }>;
  taken: ReadonlySet<string>;
  existingIds: ReadonlySet<string>;
  orderAfter: (index: number) => string;
}): SceneNode[] {
  const out: SceneNode[] = [];
  const minted = new Set<string>(input.existingIds);
  for (const p of input.params) {
    if (input.taken.has(p.name)) continue;
    const id = freshId(`field-${p.name}`, minted);
    minted.add(id);
    const label = p.description !== undefined && p.description.length > 0 && p.description.length <= 48 ? p.description : p.name.replace(/[-_]+/g, ' ');
    const kind = p.type === 'boolean' ? 'toggle' : p.type === 'number' ? 'number' : 'text';
    out.push({ id, parent: input.parent, order: input.orderAfter(out.length), components: { [primitiveRef('field')]: { kind, name: p.name, label } } });
  }
  return out;
}

/** A row-nav button: a frame inside the each template whose action is {goto, key}. */
export function rowNavNode(id: string, parent: string, order: string, goto: string, key: string): SceneNode {
  return { id, parent, order, components: { [primitiveRef('frame')]: { layout: 'row', align: 'center', padding: { top: 4, right: 10, bottom: 4, left: 10 }, fill: 'muted', 'border-radius': 'capsule', action: { goto, key } } } };
}
