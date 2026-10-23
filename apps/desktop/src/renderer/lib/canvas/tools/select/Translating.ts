import { keyBetween, primitiveOfNode, primitiveRef } from '@tent-nocode/core';
import type { SceneNode } from '@tent-nocode/core';
import { StateNode, type Editor, type PointerInfo } from '../StateNode.js';
import { inFreeParent } from '../../managers/nudge.js';
import { withScopedValues } from '../../../../components/page-edit/panelGroups.js';
import { SCREEN_VIEW_SCALE, type ElementRecord, type Placed, type Rect } from '../../store.js';

// SELECT / TRANSLATING (tldraw's Translating): the drag moves what is selected. Cards move their arrangement
// spots with snapping against the other cards. An element whose x/y are live (a layout-none parent, or
// free: true) moves them with snapping against its siblings; dragged out of its screen it ejects to the
// canvas document or into another screen (the subtree travels, numbers stay page units). A flow child of a
// row, column or grid drags a ghost and lands in the gap under its center: a reorder among its siblings or
// a re-parent. Every move is a store write the history records; Esc bails; the up completes and commits.

interface CardSnapshot { ids: string[]; origins: Map<string, Placed> }
interface ElementSnapshot {
  scene: string; screenId: string; ids: string[];
  rects: Map<string, Rect>;
  parentRects: Map<string, Rect>;
  free: boolean;
  primary: string;
}

export interface GapHit {
  parent: string;
  before: string | null;
  axis: 'x' | 'y';
  line: Rect;
}

export class Translating extends StateNode {
  static override id = 'translating';

  private cards: CardSnapshot | null = null;
  private elements: ElementSnapshot | null = null;
  private landing: GapHit | null = null;
  private lastGhost: Rect | null = null;

  override onEnter(info: PointerInfo): void {
    const { store, history } = this.editor;
    this.cards = null;
    this.elements = null;
    this.landing = null;
    this.lastGhost = null;
    const t = info.target;
    if (t.kind === 'node') {
      const selected = store.selectedCardIds();
      const ids = selected.has(t.id) && selected.size > 1 ? [...selected] : [t.id];
      const origins = new Map<string, Placed>();
      for (const id of ids) { const p = store.positionOf(id); if (p !== undefined) origins.set(id, p); }
      this.cards = { ids, origins };
    } else if (t.kind === 'element' || t.kind === 'outline') {
      const sel = store.selectedElement();
      const primary = t.kind === 'outline' ? t.id : t.id;
      if (sel === null || primary === null || primary === 'root') { this.parent.transition('idle'); return; }
      const ids = sel.elementId === primary || sel.extras.includes(primary) ? [sel.elementId, ...sel.extras] : [primary];
      const frame = this.editor.frameOf(sel.screenId);
      if (frame === null) { this.parent.transition('idle'); return; }
      const rects = new Map<string, Rect>();
      const parentRects = new Map<string, Rect>();
      for (const id of ids) {
        const r = frame.rects.get(id);
        if (r !== undefined) rects.set(id, { x: r.x, y: r.y, w: r.w, h: r.h });
        const el = store.element(sel.scene, id);
        const pid = el?.node.parent ?? null;
        if (pid !== null) parentRects.set(id, pid === 'root' ? { x: 0, y: 0, w: frame.rects.get('root')?.w ?? 0, h: frame.rects.get('root')?.h ?? 0 } : frame.rects.get(pid) ?? { x: 0, y: 0, w: 0, h: 0 });
      }
      this.elements = { scene: sel.scene, screenId: sel.screenId, ids, rects, parentRects, free: inFreeParent(this.editor, sel.scene, primary), primary };
    } else { this.parent.transition('idle'); return; }
    history.mark('translating');
    store.setGesture({ grabbing: true, cursor: 'grabbing' });
    store.setCamera(store.camera, true);
  }

  override onExit(): void {
    this.editor.store.setGesture({ grabbing: false, cursor: null, ghost: null, guides: { x: null, y: null }, landing: null, badge: null });
    this.editor.snaps.clearIndicators();
    this.cards = null;
    this.elements = null;
    this.landing = null;
  }

  override onPointerMove(): void {
    if (this.cards !== null) this.moveCards();
    else if (this.elements !== null) this.moveElements();
  }

  override onKeyDown(): void { this.onPointerMove(); }
  override onKeyUp(): void { this.onPointerMove(); }
  override onPointerUp(): void { this.complete(); }
  override onComplete(): void { this.complete(); }
  override onCancel(): void { this.editor.history.bail(); this.parent.transition('idle'); }

  private moveCards(): void {
    const { store, inputs, snaps } = this.editor;
    const snap = this.cards!;
    const d = inputs.dragDelta();
    const positions: Record<string, Placed> = {};
    const primaryId = snap.ids[0]!;
    const origin = snap.origins.get(primaryId);
    let dx = d.x; let dy = d.y;
    if (origin !== undefined && !inputs.ctrlKey) {
      const size = store.sizeOf(primaryId);
      const others: Rect[] = [];
      for (const [id, p] of store.layout.get()) if (!snap.ids.includes(id)) { const s = store.sizeOf(id); others.push({ x: p.x, y: p.y, w: s.w, h: s.h }); }
      const snapped = snaps.snapRect({ x: origin.x + d.x, y: origin.y + d.y, w: size.w, h: size.h }, snaps.candidates(others), 6 / store.camera.zoom);
      dx = snapped.x - origin.x; dy = snapped.y - origin.y;
      store.setGesture({ guides: { x: snapped.guideX, y: snapped.guideY } });
    } else store.setGesture({ guides: { x: null, y: null } });
    for (const [id, o] of snap.origins) positions[id] = { x: o.x + dx, y: o.y + dy };
    store.placeNodes(positions, 'user');
  }

  private moveElements(): void {
    const { store, inputs, snaps } = this.editor;
    const s = this.elements!;
    const frame = this.editor.frameOf(s.screenId);
    if (frame === null) return;
    const dc = inputs.dragDeltaClient();
    const k = store.camera.zoom * frame.scale;
    const d = { x: dc.x / k, y: dc.y / k };
    const primary = s.rects.get(s.primary);
    if (primary === undefined) return;
    const moving = { x: primary.x + d.x, y: primary.y + d.y, w: primary.w, h: primary.h };
    // The landing tests the ghost's center: inside its own parent a free child moves, elsewhere it re-parents.
    const land = gapAt(this.editor, s.scene, s.screenId, { x: moving.x + moving.w / 2, y: moving.y + moving.h / 2 }, new Set(s.ids));
    const ownParent = store.element(s.scene, s.primary)?.node.parent ?? null;
    const outside = isOutsideScreen(this.editor, s.screenId, moving);
    if (s.free && (land === null || land.parent === ownParent) && !outside) {
      // A free move: the x/y land live, snapped against the siblings.
      const siblings = store.childrenOf(s.scene, ownParent ?? 'root').filter((id) => !s.ids.includes(id));
      const others = siblings.map((id) => frame.rects.get(id)).filter((r): r is Rect & { r?: string } => r !== undefined);
      const snapped = inputs.ctrlKey ? { x: moving.x, y: moving.y, guideX: null, guideY: null } : snaps.snapRect(moving, snaps.candidates(others), 6 / k);
      const sdx = snapped.x - primary.x; const sdy = snapped.y - primary.y;
      const puts: ElementRecord[] = [];
      for (const id of s.ids) {
        const el = store.element(s.scene, id);
        const r0 = s.rects.get(id);
        const pr = s.parentRects.get(id) ?? { x: 0, y: 0 };
        if (el === undefined || r0 === undefined) continue;
        // A move under a laid-out parent is a free child holding its spot: the flag rides with the x/y.
        const laidOut = !isFreeContainer(this.editor, s.scene, el.node.parent ?? 'root');
        puts.push(withPlace(el, { x: Math.round(r0.x - pr.x + sdx), y: Math.round(r0.y - pr.y + sdy) }, store.editing.breakpoint, { free: laidOut }));
      }
      store.put(puts, 'user');
      this.landing = null;
      this.lastGhost = null;
      store.setGesture({ ghost: null, landing: null, guides: { x: snapped.guideX, y: snapped.guideY }, badge: null });
      return;
    }
    // A flow child, or a free child leaving its parent: the ghost and the landing.
    this.landing = land !== null && land.parent !== ownParent || (land !== null && !s.free) ? land : null;
    this.lastGhost = moving;
    store.setGesture({
      ghost: moving,
      landing: this.landing !== null ? { scene: s.scene, parent: this.landing.parent, line: this.landing.line, axis: this.landing.axis } : null,
      guides: { x: null, y: null },
      badge: outside ? 'out of the screen' : null,
    });
  }

  private complete(): void {
    const { store, history } = this.editor;
    if (this.elements !== null) this.landElements();
    void history.complete();
    if (this.cards !== null) store.scheduleArrangementWrite();
    this.parent.transition('idle');
  }

  /** The drop of a ghosted element: the gap (a reorder or a re-parent), the eject, or the adopt into another screen. */
  private landElements(): void {
    const { store } = this.editor;
    const s = this.elements!;
    const ghost = this.lastGhost;
    if (ghost === null) return;
    const outside = isOutsideScreen(this.editor, s.screenId, ghost);
    if (outside) { this.eject(ghost); return; }
    const land = this.landing;
    if (land === null) return;
    const puts: ElementRecord[] = [];
    const rail = store.childrenOf(s.scene, land.parent).filter((id) => !s.ids.includes(id));
    const beforeIdx = land.before !== null ? rail.indexOf(land.before) : rail.length;
    const prevId = beforeIdx > 0 ? rail[beforeIdx - 1] ?? null : null;
    const nextId = land.before;
    let lo = prevId !== null ? store.element(s.scene, prevId)?.node.order ?? null : null;
    const hi = nextId !== null ? store.element(s.scene, nextId)?.node.order ?? null : null;
    const targetFree = isFreeContainer(this.editor, s.scene, land.parent);
    const parentRect = this.editor.frameOf(s.screenId)?.rects.get(land.parent) ?? { x: 0, y: 0, w: 0, h: 0 };
    for (const id of orderedByRail(store, s.scene, s.ids)) {
      const el = store.element(s.scene, id);
      if (el === undefined) continue;
      const order = keyBetween(lo, hi);
      lo = order;
      let next: ElementRecord = { ...el, node: { ...el.node, parent: land.parent, order } };
      if (targetFree) {
        const r0 = s.rects.get(id);
        // A re-parent is structural: the landing spot writes the base, whatever breakpoint the panel views.
        if (r0 !== undefined) next = withPlace(next, { x: Math.round(r0.x + (ghost.x - (s.rects.get(s.primary)?.x ?? 0)) - parentRect.x), y: Math.round(r0.y + (ghost.y - (s.rects.get(s.primary)?.y ?? 0)) - parentRect.y) }, null);
      }
      puts.push(next);
    }
    store.put(puts, 'user');
  }

  /** Dropped past the screen's edge: into the screen under the ghost, else onto the canvas document. */
  private eject(ghost: Rect): void {
    const { store, doors } = this.editor;
    const s = this.elements!;
    const from = store.screenOf(s.screenId);
    const origin = store.positionOf(s.screenId);
    if (from === undefined || origin === undefined) return;
    const world: Rect = { x: origin.x + ghost.x * SCREEN_VIEW_SCALE, y: origin.y + ghost.y * SCREEN_VIEW_SCALE, w: ghost.w, h: ghost.h };
    const center = { x: world.x + ghost.w * SCREEN_VIEW_SCALE / 2, y: world.y + ghost.h * SCREEN_VIEW_SCALE / 2 };
    const hit = store.screenAt(center);
    const canvasDoc = store.canvasDoc.get();
    const target = hit !== null && hit.screen.id !== from.id
      ? { scene: hit.screen.slug, at: { x: Math.round((world.x - hit.origin.x) / SCREEN_VIEW_SCALE), y: Math.round((world.y - hit.origin.y) / SCREEN_VIEW_SCALE) } }
      : canvasDoc !== null && canvasDoc.slug !== s.scene ? { scene: canvasDoc.slug, at: { x: Math.round(world.x), y: Math.round(world.y) } } : null;
    if (target === null) { doors.quiet('the canvas is still waking up - try again in a beat'); return; }
    transferSubtree(this.editor, s.scene, target.scene, s.primary, target.at);
    store.clearSelection();
    store.setEditing({ tapped: null });
  }
}

/** The element placed at its own x/y; free: true rides along only when the parent is laid out (row/column/grid).
 *  With an editing breakpoint the keys land in the at.<bp> partial instead of the base (Phase 14A). */
export function withPlace(el: ElementRecord, at: { x: number; y: number }, bp: string | null = null, opts?: { free?: boolean }): ElementRecord {
  const prim = primitiveOfNode(el.node);
  if (prim === null) return el;
  const patch: Record<string, unknown> = { x: at.x, y: at.y };
  if (opts?.free === true) patch['free'] = true;
  const payload = bp === null
    ? { ...prim.payload, ...patch }
    : withScopedValues(prim.payload, { state: 'default', breakpoint: bp }, patch);
  return { ...el, node: { ...el.node, components: { ...el.node.components, [prim.ref]: payload } } };
}

/** True when the container places its children at their own x/y (layout 'none'), or is the canvas document's root. */
export function isFreeContainer(editor: Editor, scene: string, id: string): boolean {
  const canvasDoc = editor.store.canvasDoc.get();
  if (id === 'root' && canvasDoc !== null && canvasDoc.slug === scene) return true;
  const el = editor.store.element(scene, id);
  if (el === undefined) return false;
  const prim = primitiveOfNode(el.node);
  return prim !== null && prim.name === 'frame' && (prim.payload['layout'] ?? 'none') === 'none';
}

/** A container takes children: the root, and any frame. */
function isContainer(node: SceneNode): boolean {
  if (node.id === 'root') return true;
  const prim = primitiveOfNode(node);
  return prim !== null && prim.name === 'frame';
}

const contains = (r: Rect, p: Placed): boolean => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;

/** The gap under a frame-unit point: the deepest container whose rect holds it, and the slot among its children. */
export function gapAt(editor: Editor, scene: string, screenId: string, point: Placed, exclude: ReadonlySet<string> = new Set()): GapHit | null {
  const { store } = editor;
  const frame = editor.frameOf(screenId);
  if (frame === null) return null;
  const rectOf = (id: string): Rect | null => {
    const r = frame.rects.get(id);
    if (r !== undefined) return r;
    if (id === 'root') { const s = store.screenOf(screenId); return s !== undefined ? { x: 0, y: 0, w: s.size.w, h: Math.max(s.size.h, s.contentH ?? 0) } : null; }
    return null;
  };
  const dead = new Set<string>();
  const walk = (id: string): void => { dead.add(id); for (const c of store.childrenOf(scene, id)) walk(c); };
  for (const id of exclude) walk(id);
  const depthOf = (id: string): number => { let d = 0; let cur = store.element(scene, id)?.node.parent ?? null; while (cur !== null && d < 64) { d += 1; cur = store.element(scene, cur)?.node.parent ?? null; } return d; };
  let parent: string | null = null;
  let parentDepth = -1;
  for (const e of store.elementsOf(scene)) {
    if (dead.has(e.node.id) || !isContainer(e.node)) continue;
    const r = rectOf(e.node.id);
    if (r === null || !contains(r, point)) continue;
    const d = depthOf(e.node.id);
    if (d > parentDepth) { parent = e.node.id; parentDepth = d; }
  }
  if (parent === null) return null;
  const pr = rectOf(parent)!;
  const rail = store.childrenOf(scene, parent).filter((c) => !dead.has(c)).map((id) => ({ id, r: frame.rects.get(id) })).filter((x): x is { id: string; r: Rect & { r?: string } } => x.r !== undefined);
  if (rail.length === 0) {
    const y = Math.min(Math.max(point.y, pr.y + 8), pr.y + pr.h - 8);
    return { parent, before: null, axis: 'y', line: { x: pr.x + 8, y, w: Math.max(0, pr.w - 16), h: 0 } };
  }
  const separation = (axis: 'x' | 'y'): number => {
    const size = axis === 'x' ? 'w' : 'h';
    const sorted = [...rail].sort((a, b) => a.r[axis] - b.r[axis]);
    let apart = 0;
    for (let i = 1; i < sorted.length; i++) if (sorted[i]!.r[axis] >= sorted[i - 1]!.r[axis] + sorted[i - 1]!.r[size] - 1) apart += 1;
    return apart;
  };
  const axis: 'x' | 'y' = separation('x') > separation('y') ? 'x' : 'y';
  const size = axis === 'x' ? 'w' : 'h';
  const sorted = [...rail].sort((a, b) => (a.r[axis] + a.r[size] / 2) - (b.r[axis] + b.r[size] / 2));
  let index = 0;
  while (index < sorted.length && point[axis] > sorted[index]!.r[axis] + sorted[index]!.r[size] / 2) index += 1;
  const before = index > 0 ? sorted[index - 1]! : null;
  const after = index < sorted.length ? sorted[index]! : null;
  const mid = before !== null && after !== null ? ((before.r[axis] + before.r[size]) + after.r[axis]) / 2 : before !== null ? before.r[axis] + before.r[size] + 4 : after!.r[axis] - 4;
  const line: Rect = axis === 'y' ? { x: pr.x + 8, y: mid, w: Math.max(0, pr.w - 16), h: 0 } : { x: mid, y: pr.y + 8, w: 0, h: Math.max(0, pr.h - 16) };
  return { parent, before: after?.id ?? null, axis, line };
}

/** True when a frame-unit rect's center sits past the screen's design box. */
export function isOutsideScreen(editor: Editor, screenId: string, r: Rect): boolean {
  const s = editor.store.screenOf(screenId);
  const canvasDoc = editor.store.canvasDoc.get();
  if (s === undefined || (canvasDoc !== null && s.slug === canvasDoc.slug)) return false;
  const cx = r.x + r.w / 2; const cy = r.y + r.h / 2;
  return cx < 0 || cx > s.size.w || cy < 0 || cy > Math.max(s.size.h, s.contentH ?? 0);
}

/** The ids in their shared rail's order (visual order travels whole). */
export function orderedByRail(store: Editor['store'], scene: string, ids: readonly string[]): string[] {
  const byOrder = ids.map((id) => ({ id, order: store.element(scene, id)?.node.order ?? '' }));
  return byOrder.sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0)).map((x) => x.id);
}

/** A subtree crosses a document boundary: it leaves `from` and lands at the end of `to`'s root at the given x/y. */
export function transferSubtree(editor: Editor, from: string, to: string, id: string, at: { x: number; y: number }): void {
  const { store } = editor;
  const root = store.element(from, id);
  if (root === undefined) return;
  const puts: ElementRecord[] = [];
  const gone: string[] = [];
  const rail = store.childrenOf(to, 'root');
  const lastOrder = rail.length > 0 ? store.element(to, rail[rail.length - 1]!)?.node.order ?? null : null;
  const walk = (el: ElementRecord, parent: string | null, order: string | null): void => {
    gone.push(el.id);
    const node: SceneNode = { ...el.node, parent, order: order ?? el.node.order };
    puts.push({ typeName: 'element', id: store.elementId(to, node.id), scene: to, node });
    for (const c of store.childrenOf(from, el.node.id)) { const child = store.element(from, c); if (child !== undefined) walk(child, node.id, null); }
  };
  // A cross-document transfer is structural: the landing spot writes the base.
  walk(withPlace(root, { x: at.x, y: at.y }, null), 'root', keyBetween(lastOrder, null));
  store.atomic(() => { store.remove(gone); store.put(puts); }, 'user');
  void primitiveRef;
}
