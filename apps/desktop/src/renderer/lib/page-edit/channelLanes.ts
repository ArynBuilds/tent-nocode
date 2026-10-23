import { primitiveOfNode } from '@tent-nocode/core';
import type { SceneNode } from '@tent-nocode/core';
import { desk } from '../desk.js';
import { store } from '../canvas/store.js';
import type { History } from '../canvas/history.js';
import { channelEdgesOf, channelSentence, elementNoun, emitsOf, withChannel, withoutChannel } from './flowWires.js';
import type { ChannelEdge } from './flowWires.js';

// The channel lane over the five: an emit port dragged onto an element writes the consume into the
// property that takes it - a field's value, a text's words, a chart's query key, or an action's param
// (the declared action's params ask when several fit); the screen's scroll port feeds a number.

export interface ChannelLaneDeps {
  orgId: string;
  history: History;
  say: (sentence: string) => void;
}

const TYPE_FITS: Record<string, string[]> = {
  any: ['string', 'number', 'boolean', 'json'], row: ['json'], boolean: ['boolean', 'json'], number: ['number', 'json'], string: ['string', 'json'],
};

/** The emit-port drop -> the consume write (the one channel law). */
export async function channelDrop(deps: ChannelLaneDeps, scene: string, fromEl: string, emit: string, emitType: string, toElId: string | null): Promise<void> {
  const { say } = deps;
  const target = toElId !== null ? store.element(scene, toElId) : undefined;
  if (target === undefined) { say('drop it on something that takes a value - a field, a text, or a button'); return; }
  const prim = primitiveOfNode(target.node);
  if (prim === null) { say('that element takes no fed value'); return; }
  const from = `${fromEl}.${emit}`;
  const land = (next: SceneNode | null, word: string): void => {
    if (next === null) { say('that element takes no fed value'); return; }
    void deps.history.transaction('feed', () => store.put([{ ...target, node: next }], 'user')).then((r) => { if (r.ok) say(word); });
  };
  if (prim.name === 'field') { land(withChannel(target.node, 'value', from), `the ${elementNoun(target.node)} follows the ${emit === 'scrollProgress' ? "page's scroll" : emitWordOf(emit)}`); return; }
  if (prim.name === 'text') { land(withChannel(target.node, 'text', from), 'the text follows it'); return; }
  if (prim.name === 'chart') { say('a chart reads a query - feed a search field that filters it instead'); return; }
  if (prim.name === 'frame') {
    const action = prim.payload['action'];
    const run = typeof action === 'object' && action !== null ? (action as Record<string, unknown>)['run'] : undefined;
    if (typeof run !== 'string') { say('only a button carries fed values into its action from here'); return; }
    const acts = await desk.sceneActions(deps.orgId, scene).catch(() => []);
    const act = acts.find((a) => a.name === run);
    const fits = (act?.params ?? []).filter((p) => (TYPE_FITS[emitType] ?? TYPE_FITS['any']!).includes(p.type));
    const feed = (param: string): void => land(withChannel(target.node, 'action', from, param), `the button's ${param} follows it`);
    if (fits.length > 1) {
      const opened = store.openBrowser({
        mode: 'wire', headline: 'Feed which field?',
        doors: fits.map((p) => ({ id: p.name, word: p.required ? `${p.name} (needed)` : p.name, klass: 'write' as const })),
        projectId: null, onPick: (choice) => { if (choice.pick === 'door') feed(choice.id); },
      });
      if (!opened) say('open the side panel to pick a field');
      return;
    }
    feed(fits[0]?.name ?? (emitType === 'row' ? 'row' : emit));
    return;
  }
  say('that element takes no fed value');
}

const emitWordOf = (emit: string): string => (emit === 'picked' ? 'picked row' : emit === 'value' ? 'value' : emit === 'open' ? 'open state' : emit);

/** The frame face's channel contract: the emits per element, the landed edges, the doors. */
export interface ChannelsFace {
  emitsOf: (elementId: string) => Array<{ emit: string; type: string }>;
  edges: Array<{ fromEl: string; toEl: string; key: string }>;
  onDrop: (fromEl: string, emit: string, type: string, toEl: string | null) => void;
  onEdgeSelect: (key: string) => void;
  onEdgeRemove: (key: string) => void;
  screenPort: boolean;
}

export function channelExtras(deps: ChannelLaneDeps, scene: string): ChannelsFace {
  const nodes = store.elementsOf(scene).map((e) => e.node);
  const edges: ChannelEdge[] = channelEdgesOf(nodes);
  const keyOf = (e: ChannelEdge): string => `${e.toNode}·${e.ref}·${e.key}·${e.param ?? ''}`;
  const at = (key: string): ChannelEdge | undefined => edges.find((e) => keyOf(e) === key);
  return {
    emitsOf: (elId) => { const el = store.element(scene, elId); return el === undefined ? [] : emitsOf(el.node).map(({ emit, type }) => ({ emit, type })); },
    edges: edges.map((e) => ({ fromEl: e.fromNode, toEl: e.toNode, key: keyOf(e) })),
    onDrop: (fromEl, emit, type, toEl) => void channelDrop(deps, scene, fromEl, emit, type, toEl),
    onEdgeSelect: (key) => { const e = at(key); if (e !== undefined) store.openInspector({ wire: true, sentence: channelSentence(nodes, e) }); },
    onEdgeRemove: (key) => {
      const e = at(key);
      const el = e !== undefined ? store.element(scene, e.toNode) : undefined;
      if (e === undefined || el === undefined) return;
      const next = withoutChannel(el.node, e);
      if (next !== null) void deps.history.transaction('unfeed', () => store.put([{ ...el, node: next }], 'user'));
    },
    screenPort: true,
  };
}
