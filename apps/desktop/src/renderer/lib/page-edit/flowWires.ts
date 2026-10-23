import { PRIMITIVES, isChannelRef, channelRefParts, primitiveOfNode, primitiveRef } from '@tent-nocode/core';
import type { SceneNode } from '@tent-nocode/core';

// The wires a screen's document carries, read over the five: a flow wire is a text with href
// 'screen:<slug>' or a frame whose action is {goto}; a channel wire is any property holding
// {from: '<node>.<emit>'}. Pure reads and pure node builders; the writes ride the store.

export interface NavEdge { nodeId: string; targetSlug: string; label: string; through: 'href' | 'goto' }

/** What the channel reads need of a node: its id and its components (a flat walk answers it). */
export type FlowNodeLike = Pick<SceneNode, 'id' | 'components'>;

/** The screen's flow wires: every href to a screen and every goto action. */
export function navEdgesOf(nodes: readonly SceneNode[]): NavEdge[] {
  const out: NavEdge[] = [];
  for (const node of nodes) {
    const prim = primitiveOfNode(node);
    if (prim === null) continue;
    if (prim.name === 'text' && typeof prim.payload['href'] === 'string' && prim.payload['href'].startsWith('screen:')) {
      out.push({ nodeId: node.id, targetSlug: prim.payload['href'].slice('screen:'.length), label: typeof prim.payload['text'] === 'string' ? prim.payload['text'] : node.id, through: 'href' });
    }
    const action = prim.payload['action'];
    if (typeof action === 'object' && action !== null && typeof (action as Record<string, unknown>)['goto'] === 'string') {
      out.push({ nodeId: node.id, targetSlug: (action as Record<string, string>)['goto']!, label: node.id, through: 'goto' });
    }
  }
  return out;
}

/** A flow link node: one text at the root's end that leads to the target screen. */
export function flowLinkNode(id: string, targetSlug: string, targetTitle: string, order: string): SceneNode {
  return {
    id, parent: 'root', order,
    components: { [primitiveRef('text')]: { text: `Go to ${targetTitle}`, href: `screen:${targetSlug}`, color: 'primary' } },
  };
}

/** The node with its screen link removed (a text loses href; a frame loses the goto action). */
export function withoutFlowLink(node: SceneNode, targetSlug: string): SceneNode | null {
  const prim = primitiveOfNode(node);
  if (prim === null) return null;
  const payload = { ...prim.payload };
  if (prim.name === 'text' && payload['href'] === `screen:${targetSlug}`) { delete payload['href']; }
  else if (typeof payload['action'] === 'object' && payload['action'] !== null && (payload['action'] as Record<string, unknown>)['goto'] === targetSlug) { delete payload['action']; }
  else return null;
  return { ...node, components: { ...node.components, [prim.ref]: payload } };
}

/** A fresh node id from a base word: base, base-2, base-3 past the taken set. */
export function freshId(base: string, taken: ReadonlySet<string>): string {
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'node';
  let id = slug;
  for (let n = 2; taken.has(id); n += 1) id = `${slug}-${n}`;
  return id.slice(0, 64);
}

// ---- the channel lane: a property holding {from: '<node>.<emit>'} is a wire element to element ----

export interface ChannelEdge { fromNode: string; emit: string; toNode: string; ref: string; key: string; param?: string }

/** Every stored channel value - a property, or one level into an object property (an action's `with`). */
export function channelEdgesOf(nodes: readonly FlowNodeLike[]): ChannelEdge[] {
  const ids = new Set(nodes.map((n) => n.id));
  const out: ChannelEdge[] = [];
  const push = (toNode: string, ref: string, key: string, v: unknown, param?: string): void => {
    if (!isChannelRef(v)) return;
    const parts = channelRefParts(v.from);
    if (parts === null || (parts.node !== 'screen' && !ids.has(parts.node))) return;
    out.push({ fromNode: parts.node, emit: parts.emit, toNode, ref, key, ...(param !== undefined ? { param } : {}) });
  };
  for (const node of nodes) {
    for (const [ref, payload] of Object.entries(node.components)) {
      for (const [key, v] of Object.entries(payload)) {
        push(node.id, ref, key, v);
        if (typeof v === 'object' && v !== null && !Array.isArray(v) && !isChannelRef(v)) {
          for (const [sub, sv] of Object.entries(v as Record<string, unknown>)) {
            if (isChannelRef(sv)) push(node.id, ref, key, sv, sub);
            else if (typeof sv === 'object' && sv !== null && !Array.isArray(sv)) for (const [sub2, sv2] of Object.entries(sv as Record<string, unknown>)) push(node.id, ref, key, sv2, `${sub}.${sub2}`);
          }
        }
      }
    }
  }
  return out;
}

/** The emits a node declares (the contract's own): a frame's open, a field's value, a chart's picked. */
export function emitsOf(node: SceneNode): Array<{ emit: string; type: string; hint: string }> {
  const prim = primitiveOfNode(node);
  if (prim === null) return [];
  return Object.entries(PRIMITIVES[prim.name].emits).map(([emit, d]) => ({ emit, type: d.type, hint: d.hint }));
}

/** The node with one property (or one action param) consuming a channel. */
export function withChannel(node: SceneNode, key: string, from: string, param?: string): SceneNode | null {
  const prim = primitiveOfNode(node);
  if (prim === null) return null;
  const payload = { ...prim.payload };
  if (param === undefined) payload[key] = { from };
  else {
    const holder = typeof payload[key] === 'object' && payload[key] !== null ? { ...(payload[key] as Record<string, unknown>) } : {};
    const withMap = typeof holder['with'] === 'object' && holder['with'] !== null ? { ...(holder['with'] as Record<string, unknown>) } : {};
    withMap[param] = { from };
    holder['with'] = withMap;
    payload[key] = holder;
  }
  return { ...node, components: { ...node.components, [prim.ref]: payload } };
}

/** The node with the consume removed (the property leaves, or the action param leaves its map). */
export function withoutChannel(node: SceneNode, edge: ChannelEdge): SceneNode | null {
  const payload = node.components[edge.ref];
  if (payload === undefined) return null;
  const next = { ...payload };
  if (edge.param === undefined) delete next[edge.key];
  else {
    const holder = typeof next[edge.key] === 'object' && next[edge.key] !== null ? { ...(next[edge.key] as Record<string, unknown>) } : {};
    const [head, tail] = edge.param.split('.');
    if (head === 'with' && tail !== undefined) {
      const withMap = typeof holder['with'] === 'object' && holder['with'] !== null ? { ...(holder['with'] as Record<string, unknown>) } : {};
      delete withMap[tail];
      if (Object.keys(withMap).length === 0) delete holder['with']; else holder['with'] = withMap;
    } else delete holder[edge.param];
    next[edge.key] = holder;
  }
  return { ...node, components: { ...node.components, [edge.ref]: next } };
}

const EMIT_WORDS: Record<string, string> = { value: 'value', picked: 'picked row', open: 'open state', scrollProgress: 'scroll' };
export const emitWord = (emit: string): string => EMIT_WORDS[emit] ?? emit.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();

/** The element's noun: the primitive's title, or the field's label, or the text's first words. */
export function elementNoun(node: FlowNodeLike | undefined): string {
  const prim = node !== undefined ? primitiveOfNode(node) : null;
  if (prim === null) return 'element';
  if (prim.name === 'field' && typeof prim.payload['label'] === 'string') return prim.payload['label'].toLowerCase();
  if (prim.name === 'text' && typeof prim.payload['text'] === 'string') return `"${prim.payload['text'].slice(0, 24)}"`;
  if (prim.name === 'frame' && typeof prim.payload['action'] === 'object' && prim.payload['action'] !== null) return 'button';
  return PRIMITIVES[prim.name].title.toLowerCase();
}

export const followsClause = (sourceWord: string, emit: string): string => `follows the ${sourceWord}'s ${emitWord(emit)}`;

export function channelSentence(nodes: readonly FlowNodeLike[], edge: ChannelEdge): string {
  const source = nodes.find((n) => n.id === edge.fromNode);
  const target = nodes.find((n) => n.id === edge.toNode);
  const sourceWord = edge.fromNode === 'screen' ? 'page' : elementNoun(source);
  return `the ${elementNoun(target)} ${followsClause(sourceWord, edge.emit)}`;
}

// ---------------------------------------------------------------------------
// The words a surface speaks for machine names (a param key, a versioned label, a component ref).
// ---------------------------------------------------------------------------

const PARAM_WORDS: Readonly<Record<string, string>> = {
  padding: 'Spacing', gap: 'Gap', tone: 'Color', weight: 'Thickness', 'font-size': 'Size', align: 'Alignment',
  direction: 'Direction', columns: 'Columns', rows: 'Rows', text: 'Text', label: 'Label', value: 'Value', title: 'Title',
  w: 'Width', h: 'Height', width: 'Width', height: 'Height', 'border-radius': 'Corners', border: 'Border',
  'box-shadow': 'Shadow', background: 'Background', caption: 'Caption', placeholder: 'Placeholder', max: 'Highest',
  min: 'Lowest', wrap: 'Wrapping', layout: 'Layout', style: 'Look', 'aria-label': 'Spoken label',
};

export function paramWord(key: string): string {
  const word = PARAM_WORDS[key];
  if (word !== undefined) return word;
  const spaced = key.replace(/[-_]+/g, ' ').trim();
  return spaced.length === 0 ? key : spaced[0]!.toUpperCase() + spaced.slice(1);
}

export function paramValueLabel(resolved: unknown, overridden: boolean): string {
  const shown = typeof resolved === 'string' ? resolved : JSON.stringify(resolved);
  if (overridden) return shown ?? '-';
  return shown === undefined ? 'Auto' : `Auto (${shown.length > 24 ? `${shown.slice(0, 21)}...` : shown})`;
}

const ACRONYMS = new Set(['kpi', 'kv', 'id', 'url', 'csv']);
const ENGINE_NS = new Set(['core', 'c2d', 'three', 'media', 'chart']);

/** A component ref (ns::kpi-card@1) as words; a project's own item reads as "your <name>". */
export function componentWord(ref: string): string {
  const m = /^([a-z0-9-]+)::([a-z0-9-]+)@\d+$/.exec(ref);
  if (m === null) return ref;
  const [, ns, name] = m;
  if (!ENGINE_NS.has(ns!)) return `your ${name}`;
  return name!.split('-').map((w, i) => (ACRONYMS.has(w) ? w.toUpperCase() : i === 0 ? w[0]!.toUpperCase() + w.slice(1) : w)).join(' ');
}

/** A versioned label without its version. */
export const humanLabel = (label: string): string => label.replace(/@\d+$/, '');
