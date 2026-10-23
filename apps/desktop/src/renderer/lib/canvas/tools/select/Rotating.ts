import { primitiveOfNode } from '@tent-nocode/core';
import { StateNode, type PointerInfo } from '../StateNode.js';
import type { Rect } from '../../store.js';

// SELECT / ROTATING (tldraw's Rotating): the rotate handle turns the selected element around its center;
// the angle lands on the effects group's transform.rotate (Shift snaps to 15 degrees). Esc bails.

export class Rotating extends StateNode {
  static override id = 'rotating';

  private ctx: { scene: string; screenId: string; id: string; center: { x: number; y: number }; startAngle: number; startRotation: number } | null = null;

  override onEnter(info: PointerInfo): void {
    const { store, history } = this.editor;
    const t = info.target;
    if (t.kind !== 'rotate') { this.parent.transition('idle'); return; }
    const frame = this.editor.frameOf(t.screenId);
    const r = frame?.rects.get(t.id);
    const el = store.element(t.scene, t.id);
    if (frame === null || r === undefined || el === undefined) { this.parent.transition('idle'); return; }
    const rect: Rect = { x: r.x, y: r.y, w: r.w, h: r.h };
    const center = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
    const p = frame.toFrame(info.client);
    const prim = primitiveOfNode(el.node);
    const transform = prim !== null && typeof prim.payload['transform'] === 'object' && prim.payload['transform'] !== null ? prim.payload['transform'] as Record<string, unknown> : {};
    const rotation = typeof transform['rotate'] === 'number' ? transform['rotate'] : 0;
    this.ctx = { scene: t.scene, screenId: t.screenId, id: t.id, center, startAngle: Math.atan2(p.y - center.y, p.x - center.x), startRotation: rotation };
    history.mark('rotating');
    store.setGesture({ cursor: 'grabbing' });
  }

  override onExit(): void {
    this.editor.store.setGesture({ cursor: null, badge: null });
    this.ctx = null;
  }

  override onPointerMove(info: PointerInfo): void {
    const { store, inputs } = this.editor;
    const c = this.ctx;
    if (c === null) return;
    const frame = this.editor.frameOf(c.screenId);
    if (frame === null) return;
    const p = frame.toFrame(info.client);
    const angle = Math.atan2(p.y - c.center.y, p.x - c.center.x);
    let deg = c.startRotation + ((angle - c.startAngle) * 180) / Math.PI;
    if (inputs.shiftKey) deg = Math.round(deg / 15) * 15;
    deg = Math.round(((deg + 180) % 360 + 360) % 360 - 180);
    const el = store.element(c.scene, c.id);
    const prim = el !== undefined ? primitiveOfNode(el.node) : null;
    if (el === undefined || prim === null) return;
    const transform = typeof prim.payload['transform'] === 'object' && prim.payload['transform'] !== null ? { ...(prim.payload['transform'] as Record<string, unknown>) } : {};
    if (deg === 0) delete transform['rotate']; else transform['rotate'] = deg;
    const payload = { ...prim.payload };
    if (Object.keys(transform).length === 0) delete payload['transform']; else payload['transform'] = transform;
    store.put([{ ...el, node: { ...el.node, components: { ...el.node.components, [prim.ref]: payload } } }], 'user');
    store.setGesture({ badge: `${deg} deg` });
  }

  override onPointerUp(): void { void this.editor.history.complete(); this.parent.transition('idle'); }
  override onComplete(): void { void this.editor.history.complete(); this.parent.transition('idle'); }
  override onCancel(): void { this.editor.history.bail(); this.parent.transition('idle'); }
}
