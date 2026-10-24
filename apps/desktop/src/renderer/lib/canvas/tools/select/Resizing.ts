import { primitiveOfNode } from '@nodeloom/core';
import { StateNode, type PointerInfo } from '../StateNode.js';
import { inFreeParent } from '../../managers/nudge.js';
import { withScopedValues } from '../../../../components/page-edit/panelGroups.js';
import type { ElementRecord, Rect, ScreenRecord } from '../../store.js';

// SELECT / RESIZING (tldraw's Resizing): a corner handle resizes the selected element - width and height
// land on its size group; a free child keeps the opposite corner fixed and moves its x/y; a flow child
// keeps its top-left (the layout places it). A screen's edge grip resizes its design size through the
// screen record. The badge speaks the honest pixels; Esc bails; the up completes and commits.

interface ElementSize { scene: string; screenId: string; id: string; rect: Rect; parentRect: Rect; free: boolean; sx: -1 | 1; sy: -1 | 1 }
interface ScreenSize { screen: ScreenRecord; edge: 'e' | 's'; start: { w: number; h: number } }

export class Resizing extends StateNode {
  static override id = 'resizing';

  private el: ElementSize | null = null;
  private screen: ScreenSize | null = null;

  override onEnter(info: PointerInfo): void {
    const { store, history } = this.editor;
    this.el = null;
    this.screen = null;
    const t = info.target;
    if (t.kind === 'handle') {
      const frame = this.editor.frameOf(t.screenId);
      const r = frame?.rects.get(t.id);
      const el = store.element(t.scene, t.id);
      if (frame === null || r === undefined || el === undefined) { this.parent.transition('idle'); return; }
      const pid = el.node.parent;
      const parentRect = pid === null ? { x: 0, y: 0, w: 0, h: 0 } : frame.rects.get(pid) ?? { x: 0, y: 0, w: 0, h: 0 };
      this.el = { scene: t.scene, screenId: t.screenId, id: t.id, rect: { x: r.x, y: r.y, w: r.w, h: r.h }, parentRect, free: inFreeParent(this.editor, t.scene, t.id), sx: t.sx, sy: t.sy };
      store.setGesture({ cursor: t.cursor });
    } else if (t.kind === 'screen-edge') {
      const screen = store.screenOf(t.screenId);
      if (screen === undefined) { this.parent.transition('idle'); return; }
      this.screen = { screen, edge: t.edge, start: screen.size };
      store.setGesture({ cursor: t.edge === 'e' ? 'ew-resize' : 'ns-resize' });
    } else { this.parent.transition('idle'); return; }
    history.mark('resizing');
  }

  override onExit(): void {
    this.editor.store.setGesture({ cursor: null, ghost: null, badge: null, guides: { x: null, y: null } });
    this.el = null;
    this.screen = null;
  }

  override onPointerMove(): void {
    if (this.el !== null) this.resizeElement();
    else if (this.screen !== null) this.resizeScreen();
  }
  override onKeyDown(): void { this.onPointerMove(); }
  override onPointerUp(): void { this.complete(); }
  override onComplete(): void { this.complete(); }
  override onCancel(): void { this.editor.history.bail(); this.parent.transition('idle'); }

  private resizeElement(): void {
    const { store, inputs, snaps } = this.editor;
    const s = this.el!;
    const frame = this.editor.frameOf(s.screenId);
    if (frame === null) return;
    const k = store.camera.zoom * frame.scale;
    const dc = inputs.dragDeltaClient();
    const dw = (s.sx * dc.x) / k;
    const dh = (s.sy * dc.y) / k;
    let w = Math.max(8, Math.round(s.rect.w + dw));
    let h = Math.max(8, Math.round(s.rect.h + dh));
    // The moving edges snap against the siblings' edges.
    const siblings = store.childrenOf(s.scene, store.element(s.scene, s.id)?.node.parent ?? 'root').filter((id) => id !== s.id);
    const cands = snaps.candidates(siblings.map((id) => frame.rects.get(id)).filter((r): r is Rect & { r?: string } => r !== undefined));
    let guideX: number | null = null; let guideY: number | null = null;
    if (!inputs.ctrlKey) {
      const ex = s.sx === 1 ? s.rect.x + w : s.rect.x + s.rect.w - w;
      const sx = snaps.snapEdge(ex, 'x', cands, 6 / k);
      if (sx.guide !== null) { w = Math.max(8, Math.round(s.sx === 1 ? sx.value - s.rect.x : s.rect.x + s.rect.w - sx.value)); guideX = sx.guide; }
      const ey = s.sy === 1 ? s.rect.y + h : s.rect.y + s.rect.h - h;
      const sy = snaps.snapEdge(ey, 'y', cands, 6 / k);
      if (sy.guide !== null) { h = Math.max(8, Math.round(s.sy === 1 ? sy.value - s.rect.y : s.rect.y + s.rect.h - sy.value)); guideY = sy.guide; }
    }
    if (inputs.shiftKey && s.rect.w > 0 && s.rect.h > 0) {
      const ratio = s.rect.w / s.rect.h;
      if (Math.abs(dw) > Math.abs(dh)) h = Math.max(8, Math.round(w / ratio)); else w = Math.max(8, Math.round(h * ratio));
    }
    const x = s.free && s.sx === -1 ? s.rect.x + s.rect.w - w : s.rect.x;
    const y = s.free && s.sy === -1 ? s.rect.y + s.rect.h - h : s.rect.y;
    const el = store.element(s.scene, s.id);
    if (el === undefined) return;
    store.put([withSize(el, { w, h }, s.free ? { x: Math.round(x - s.parentRect.x), y: Math.round(y - s.parentRect.y) } : null, store.editing.breakpoint)], 'user');
    store.setGesture({ badge: `${w} x ${h}`, guides: { x: guideX, y: guideY } });
  }

  private resizeScreen(): void {
    const { store, inputs } = this.editor;
    const s = this.screen!;
    const frame = this.editor.frameOf(s.screen.nodeId);
    const k = store.camera.zoom * (frame?.scale ?? 1);
    const dc = inputs.dragDeltaClient();
    const size = {
      w: Math.max(200, Math.round(s.start.w + (s.edge === 'e' ? dc.x / k : 0))),
      h: Math.max(200, Math.round(s.start.h + (s.edge === 's' ? dc.y / k : 0))),
    };
    const cur = store.screenOf(s.screen.nodeId);
    if (cur === undefined) return;
    store.put([{ ...cur, size }], 'user');
    store.setGesture({ badge: `${size.w} x ${size.h}` });
  }

  private complete(): void {
    void this.editor.history.complete();
    this.parent.transition('idle');
  }
}

/** The element with width/height (px) on its size group, and its x/y when it is a free child.
 *  With an editing breakpoint the keys land in the at.<bp> partial instead of the base (Phase 14A). */
export function withSize(el: ElementRecord, size: { w: number; h: number }, at: { x: number; y: number } | null, bp: string | null = null): ElementRecord {
  const prim = primitiveOfNode(el.node);
  if (prim === null) return el;
  const patch: Record<string, unknown> = { width: size.w, height: size.h };
  if (at !== null) { patch['x'] = at.x; patch['y'] = at.y; }
  const payload = bp === null
    ? { ...prim.payload, ...patch }
    : withScopedValues(prim.payload, { state: 'default', breakpoint: bp }, patch);
  return { ...el, node: { ...el.node, components: { ...el.node.components, [prim.ref]: payload } } };
}
