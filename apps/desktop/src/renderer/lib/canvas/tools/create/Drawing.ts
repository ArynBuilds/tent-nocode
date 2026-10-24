import { keyBetween, primitiveOfNode, primitiveRef } from '@nodeloom/core';
import type { DatasetWhere, SceneNode } from '@nodeloom/core';
import { desk } from '../../../desk.js';
import { StateNode, type Editor, type PointerInfo } from '../StateNode.js';
import { SCREEN_VIEW_SCALE, marqueeRect, store, type CreateArm, type ElementRecord, type Placed, type Rect } from '../../store.js';
import { gapAt, isFreeContainer } from '../select/Translating.js';
import { consumerNodeId, tableColumnsFor } from '../../../page-edit/bindingQuestions.js';
import { freshId } from '../../../page-edit/flowWires.js';
import type { WireLaneDeps } from '../select/DrawingWire.js';
import type { PickerPayload } from '../../../../components/page-edit/ExpressionPicker.js';

// CREATE / DRAWING: the drag draws the ghost; the release lands. Inside a screen the drawn thing is born in
// that document at the gap under its center (free parent = its own x/y at the drawn rect; a laid-out one = the
// slot); on the open canvas it lands in the canvas document; a screen is stamped at the hand. Unarmed, the
// release asks "what are you drawing?" at the rect (the doors' ask). The Table drop's show-as question
// (rows, cards, list) is this tool's other landing: the picked face is born from the five.

export class Drawing extends StateNode {
  static override id = 'drawing';

  private last: Rect | null = null;

  override onEnter(): void {
    this.last = { x: this.editor.inputs.originWorld.x, y: this.editor.inputs.originWorld.y, w: 0, h: 0 };
  }

  override onExit(): void {
    this.editor.store.setGesture({ createGhost: null });
    this.last = null;
  }

  override onPointerMove(): void {
    const { inputs, store: s } = this.editor;
    this.last = marqueeRect(inputs.originWorld, inputs.currentWorld);
    s.setGesture({ createGhost: this.last });
  }

  override onPointerUp(info: PointerInfo): void {
    const { store: s, doors } = this.editor;
    const rect = this.last ?? { x: info.world.x, y: info.world.y, w: 0, h: 0 };
    this.parent.transition('idle');
    const center = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
    const hit = s.screenAt(center);
    const fs = SCREEN_VIEW_SCALE;
    doors.createLand({
      rect, client: info.client,
      frame: hit !== null ? { screenId: hit.screen.nodeId, scene: hit.screen.slug, rel: { x: (rect.x - hit.origin.x) / fs, y: (rect.y - hit.origin.y) / fs, w: rect.w / fs, h: rect.h / fs } } : null,
    });
  }

  override onCancel(): void { this.parent.transition('idle'); }
  override onComplete(): void { this.parent.transition('idle'); }
}

// ---------------------------------------------------------------------------
// The landing: what a create gesture births.
// ---------------------------------------------------------------------------

const CLICK_BIRTH = { w: 240, h: 140 } as const;

export interface CreateLandDeps {
  orgId: string;
  projectId: string | null;
  projectKind: string | null;
  quiet: (sentence: string) => void;
  placeAt: { current: Placed | null };
  placeBorn: (nodeId: string | null) => void;
}

/** The node a primitive is born as: its prefill, the drawn size where the primitive takes one; x/y ALWAYS land (the invariant - under a laid-out parent the flow ignores them). */
function bornNode(arm: Extract<CreateArm, { kind: 'primitive' } | { kind: 'item' }>, id: string, parent: string, order: string, size: { w: number; h: number } | null, at: { x: number; y: number }): SceneNode {
  const payload: Record<string, unknown> = arm.kind === 'primitive' ? { ...arm.prefill } : { component: arm.item.name };
  if (arm.kind === 'primitive' && arm.name === 'text' && payload['text'] === undefined) payload['text'] = 'Text';
  if (arm.kind === 'primitive' && arm.name === 'field' && payload['name'] === undefined) { payload['kind'] = payload['kind'] ?? 'text'; payload['name'] = id.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 63); payload['label'] = payload['label'] ?? 'Label'; }
  if (arm.kind === 'primitive' && arm.name === 'frame' && payload['fill'] === undefined) payload['fill'] = 'card';
  if (size !== null && (arm.kind === 'item' || arm.name !== 'text')) { payload['width'] = Math.round(size.w); payload['height'] = Math.round(size.h); }
  payload['x'] = at.x;
  payload['y'] = at.y;
  return { id, parent, order, components: { [primitiveRef(arm.kind === 'primitive' ? arm.name : 'instance')]: payload } };
}

export async function landCreate(editor: Editor, deps: CreateLandDeps, armed: CreateArm, gesture: { rect: Rect; client: Placed; frame: { screenId: string; scene: string; rel: Rect } | null }): Promise<void> {
  const { store: s, history } = editor;
  if (armed.kind === 'stamp') { armed.land({ x: gesture.rect.x, y: gesture.rect.y }, gesture.client); return; }
  if (armed.kind === 'screen') {
    const size = deps.projectKind === 'website' ? { w: 1920, h: 1080 } : { w: 1440, h: 900 };
    const r = await desk.humanInsertScene(deps.orgId, 'New screen', size, deps.projectId ?? undefined);
    if (!r.ok || r.data === undefined) { if (!r.ok) deps.quiet(r.error); return; }
    deps.placeAt.current = { x: gesture.rect.x, y: gesture.rect.y };
    deps.placeBorn(`scene:${r.data.sceneId}`);
    return;
  }
  const drawn = gesture.rect.w >= 8 && gesture.rect.h >= 8;
  const scene = gesture.frame?.scene ?? s.canvasDoc.get()?.slug ?? null;
  if (scene === null) { deps.quiet('the canvas is still waking up - try again in a beat'); return; }
  if (s.documentOf(scene) === null) { deps.quiet('that screen is still loading - try again in a beat'); return; }
  const taken = new Set(s.elementsOf(scene).map((e) => e.node.id));
  const base = armed.kind === 'primitive' ? armed.name : armed.item.name;
  const id = freshId(base, taken);
  let parent = 'root';
  let before: string | null = null;
  const rel: Rect = gesture.frame !== null
    ? (drawn ? gesture.frame.rel : { x: gesture.frame.rel.x, y: gesture.frame.rel.y, ...CLICK_BIRTH })
    : (drawn ? gesture.rect : { x: gesture.rect.x, y: gesture.rect.y, ...CLICK_BIRTH });
  // x/y always land: the drawn rect relative to the landing parent (the invariant - a laid-out parent ignores them).
  let at = { x: Math.round(rel.x), y: Math.round(rel.y) };
  let freeParent = gesture.frame === null;
  if (gesture.frame !== null) {
    const gap = gapAt(editor, scene, gesture.frame.screenId, { x: rel.x + rel.w / 2, y: rel.y + rel.h / 2 });
    if (gap !== null) { parent = gap.parent; before = gap.before; }
    freeParent = isFreeContainer(editor, scene, parent);
    const pr = editor.frameOf(gesture.frame.screenId)?.rects.get(parent) ?? { x: 0, y: 0 };
    at = { x: Math.round(rel.x - (parent === 'root' ? 0 : pr.x)), y: Math.round(rel.y - (parent === 'root' ? 0 : pr.y)) };
  }
  const rail = s.childrenOf(scene, parent);
  const idx = before !== null ? rail.indexOf(before) : rail.length;
  const lo = idx > 0 ? s.element(scene, rail[idx - 1]!)?.node.order ?? null : null;
  const hi = before !== null ? s.element(scene, before)?.node.order ?? null : null;
  const node = bornNode(armed, id, parent, keyBetween(lo, hi), drawn || freeParent ? { w: rel.w, h: rel.h } : null, at);
  const res = await history.transaction(`add ${base}`, () => s.put([{ typeName: 'element', id: s.elementId(scene, id), scene, node }], 'user'));
  if (!res.ok) return;
  const screenId = gesture.frame?.screenId ?? (s.canvasDoc.get() !== null ? `scene:${s.canvasDoc.get()!.sceneId}` : null);
  if (screenId !== null) { s.selectElement(scene, screenId, id, []); s.setEditing({ tapped: screenId }); }
}

// ---------------------------------------------------------------------------
// The Table drop's show-as question: the binding lands first, then the picked face from the five.
// ---------------------------------------------------------------------------

export type PresentChoice = 'table' | 'cards' | 'list' | 'template' | 'existing';
export interface PresentColumn { key: string; label: string; type?: 'string' | 'number' | 'boolean' }

export const PRESENT_WORDS: ReadonlyArray<{ choice: Exclude<PresentChoice, 'existing'>; word: string }> = [
  { choice: 'table', word: 'A table' }, { choice: 'cards', word: 'Cards' }, { choice: 'list', word: 'A list' }, { choice: 'template', word: 'A design of your own' },
];

const rowText = (query: string, col: string, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ text: { $expr: `row('${col}')`, deps: [`bindings.${query}`] }, ...extra });
const colSlug = (key: string): string => key.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '') || 'col';

/** Where a data face lands on the free artboard root: a readable block at the top left (x/y always carried). */
const FACE_AT = { x: 24, y: 24, width: 640 } as const;

/** The nodes one face is built from: frame(each) + rows of texts, over the five alone. */
export function presentNodes(choice: Exclude<PresentChoice, 'existing'>, query: string, columns: PresentColumn[], taken: ReadonlySet<string>, rootOrder: string): SceneNode[] {
  const root = freshId(consumerNodeId(query), taken);
  const F = primitiveRef('frame');
  const T = primitiveRef('text');
  const out: SceneNode[] = [];
  let order: string | null = null;
  const next = (): string => (order = keyBetween(order, null));
  if (choice === 'table') {
    const track = columns.length;
    out.push({ id: root, parent: 'root', order: rootOrder, components: { [F]: { layout: 'column', gap: 4, ...FACE_AT } } });
    const header = `${root}-header`;
    out.push({ id: header, parent: root, order: next(), components: { [F]: { layout: 'grid', columns: track, gap: 8, padding: { top: 6, right: 8, bottom: 6, left: 8 }, width: 'fill' } } });
    let ho: string | null = null;
    for (const c of columns) out.push({ id: `${root}-head-${colSlug(c.key)}`, parent: header, order: (ho = keyBetween(ho, null)), components: { [T]: { text: c.label, 'font-size': 'small', color: 'mutedForeground', 'font-weight': 500 } } });
    const row = `${root}-row`;
    out.push({ id: row, parent: root, order: next(), components: { [F]: { layout: 'grid', columns: track, gap: 8, padding: { top: 8, right: 8, bottom: 8, left: 8 }, width: 'fill', each: { query, empty: 'No rows yet' }, 'border-color': 'border', 'border-width': { top: 1 } } } });
    let ro: string | null = null;
    for (const c of columns) out.push({ id: `${root}-cell-${colSlug(c.key)}`, parent: row, order: (ro = keyBetween(ro, null)), components: { [T]: rowText(query, c.key, c.type === 'number' ? { tabular: true } : {}) } });
    return out;
  }
  const title = columns.find((c) => c.type === 'string')?.key ?? columns[0]?.key ?? 'id';
  const value = columns.find((c) => c.type === 'number')?.key;
  const badge = columns.find((c) => c.key === 'status' || c.key === 'state')?.key;
  if (choice === 'cards') {
    out.push({ id: root, parent: 'root', order: rootOrder, components: { [F]: { layout: 'grid', columns: 3, gap: 12, ...FACE_AT, each: { query, empty: 'No rows yet' } } } });
    const card = `${root}-card`;
    out.push({ id: card, parent: root, order: next(), components: { [F]: { layout: 'column', gap: 8, padding: 16, fill: 'card', 'border-radius': 'theme' } } });
    let co: string | null = null;
    out.push({ id: `${root}-title`, parent: card, order: (co = keyBetween(co, null)), components: { [T]: rowText(query, title, { 'font-weight': 500 }) } });
    if (value !== undefined && value !== title) out.push({ id: `${root}-value`, parent: card, order: (co = keyBetween(co, null)), components: { [T]: rowText(query, value, { 'font-size': 'metric', tabular: true }) } });
    if (badge !== undefined && badge !== title) out.push({ id: `${root}-badge`, parent: card, order: (co = keyBetween(co, null)), components: { [T]: rowText(query, badge, { 'font-size': 'small', color: 'mutedForeground' }) } });
    return out;
  }
  if (choice === 'list') {
    out.push({ id: root, parent: 'root', order: rootOrder, components: { [F]: { layout: 'column', gap: 4, ...FACE_AT } } });
    const row = `${root}-row`;
    out.push({ id: row, parent: root, order: next(), components: { [F]: { layout: 'row', justify: 'between', align: 'center', gap: 8, padding: { top: 8, right: 8, bottom: 8, left: 8 }, width: 'fill', each: { query, empty: 'No rows yet' } } } });
    let ro: string | null = null;
    out.push({ id: `${root}-title`, parent: row, order: (ro = keyBetween(ro, null)), components: { [T]: rowText(query, title) } });
    if (value !== undefined && value !== title) out.push({ id: `${root}-value`, parent: row, order: (ro = keyBetween(ro, null)), components: { [T]: rowText(query, value, { tabular: true, color: 'mutedForeground' }) } });
    return out;
  }
  out.push({ id: root, parent: 'root', order: rootOrder, components: { [F]: { layout: 'column', gap: 8, ...FACE_AT, each: { query, empty: 'No rows yet' } } } });
  let to: string | null = null;
  for (const c of columns) out.push({ id: `${root}-col-${colSlug(c.key)}`, parent: root, order: (to = keyBetween(to, null)), components: { [T]: rowText(query, c.key) } });
  return out;
}

/** The binding write, first and always: the table's columns become the row schema; a zero-column brief refuses named. */
export async function bindDatasetToScene(
  deps: Pick<WireLaneDeps, 'orgId' | 'projectId' | 'quiet' | 'history'>, slug: string, dataset: string,
  extras?: { filter?: DatasetWhere[]; orderBy?: { col: string; dir: 'asc' | 'desc' }; rowKey?: { column: string } },
): Promise<{ ok: boolean; columns: Array<{ key: string; display: string; type: 'string' | 'number' | 'boolean' }> }> {
  const brief = await desk.datasetBrief(deps.orgId, dataset, deps.projectId ?? undefined);
  if (brief.columns.length === 0) {
    deps.quiet(`couldn't read ${dataset}'s columns in this project - if it lives in another project, copy it in first`);
    return { ok: false, columns: [] };
  }
  const rowSchema: Record<string, 'string' | 'number' | 'boolean'> = {};
  for (const c of brief.columns) rowSchema[c.key] = c.type;
  const screen = store.screenBySlugOf(slug);
  const revert = screen !== undefined ? store.bornEdge({ from: `ds:${dataset}`, to: screen.nodeId, verb: 'shows' }) : () => undefined;
  const where = extras?.filter !== undefined && extras.filter.length > 0 ? extras.filter : undefined;
  const orderBy = extras?.orderBy !== undefined ? [extras.orderBy] : undefined;
  const res = await desk.humanSetBinding(deps.orgId, slug, {
    name: dataset, kind: 'query', table: dataset, rowSchema,
    ...(where !== undefined || orderBy !== undefined ? { query: { ...(where !== undefined ? { where } : {}), ...(orderBy !== undefined ? { orderBy } : {}) } } : {}),
    ...(extras?.rowKey !== undefined ? { rowKey: extras.rowKey } : {}),
  });
  if (!res.ok) { revert(); deps.quiet(res.error); return { ok: false, columns: [] }; }
  deps.history.pushDoor('binding', async () => { const r = await desk.humanRemoveBinding(deps.orgId, slug, dataset); revert(); return r.ok ? { ok: true } : { ok: false, sentence: r.error }; });
  return { ok: true, columns: brief.columns.map((c) => ({ key: c.key, display: c.display, type: c.type })) };
}

/** The picker's binding arm: the binding first, then the face the answer names (absent = a table). */
export async function landDataWire(deps: Pick<WireLaneDeps, 'orgId' | 'projectId' | 'quiet' | 'history'>, slug: string, dataset: string, payload: PickerPayload): Promise<void> {
  const bound = await bindDatasetToScene(deps, slug, dataset, {
    ...(payload.filter !== undefined ? { filter: payload.filter } : {}),
    ...(payload.orderBy !== undefined ? { orderBy: payload.orderBy } : {}),
    ...(payload.rowKey !== undefined ? { rowKey: payload.rowKey } : {}),
  });
  if (!bound.ok) return;
  const choice = payload.present ?? 'table';
  if (store.documentOf(slug) === null) { deps.quiet('connected - the screen is still loading; add a table from the editor to show it'); return; }
  if (choice === 'existing' && payload.existingNode !== undefined) {
    const el = store.element(slug, payload.existingNode);
    const prim = el !== undefined ? primitiveOfNode(el.node) : null;
    if (el === undefined || prim === null) { deps.quiet(`${dataset} is a query of this screen now - that element is gone`); return; }
    const patch: Record<string, unknown> = prim.name === 'chart' ? { query: dataset } : prim.name === 'frame' ? { each: { query: dataset, empty: 'No rows yet' } } : {};
    if (Object.keys(patch).length === 0) { deps.quiet(`${dataset} is a query of this screen now - but that element takes no rows of its own`); return; }
    await deps.history.transaction(`feed ${dataset}`, () => store.put([{ ...el, node: { ...el.node, components: { ...el.node.components, [prim.ref]: { ...prim.payload, ...patch } } } }], 'user'));
    return;
  }
  const cols: PresentColumn[] = tableColumnsFor(payload.columnDefs, bound.columns);
  const taken = new Set(store.elementsOf(slug).map((e) => e.node.id));
  const rail = store.childrenOf(slug, 'root');
  const last = rail.length > 0 ? store.element(slug, rail[rail.length - 1]!)?.node.order ?? null : null;
  const nodes = presentNodes(choice === 'existing' ? 'table' : choice, dataset, cols, taken, keyBetween(last, null));
  const res = await deps.history.transaction(`show ${dataset}`, () => store.put(nodes.map((n): ElementRecord => ({ typeName: 'element', id: store.elementId(slug, n.id), scene: slug, node: n })), 'user'));
  if (!res.ok) deps.quiet('connected - add a table from the editor to show it');
}

/** The elements of a screen that can take a query: frames and charts, in plain words. */
export function bindableNodesOf(slug: string): Array<{ id: string; word: string }> {
  const rows: Array<{ id: string; word: string }> = [];
  const seen = new Map<string, number>();
  for (const e of store.elementsOf(slug)) {
    const prim = primitiveOfNode(e.node);
    if (prim === null || (prim.name !== 'frame' && prim.name !== 'chart') || e.node.id === 'root') continue;
    const base = prim.name === 'chart' ? 'chart' : 'frame';
    const nth = (seen.get(base) ?? 0) + 1;
    seen.set(base, nth);
    rows.push({ id: e.node.id, word: nth === 1 ? base : `${base} ${nth}` });
  }
  return rows;
}
