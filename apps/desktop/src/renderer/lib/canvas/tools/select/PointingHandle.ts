import { primitiveOfNode } from '@nodeloom/core';
import { StateNode, type PointerInfo } from '../StateNode.js';

// SELECT / POINTING HANDLE (tldraw's PointingHandle + DraggingHandle): the spacing handles of a stack
// frame - the space between its children drags the gap, a padding boundary drags the padding. The value
// lands live on the frame's own property, clamped to the 0..64 band; Esc bails.

export class PointingHandle extends StateNode {
  static override id = 'pointingHandle';

  private ctx: { scene: string; screenId: string; id: string; key: 'gap' | 'padding'; edge?: 'left' | 'right' | 'top' | 'bottom'; start: number; axis: 'x' | 'y' } | null = null;

  override onEnter(info: PointerInfo): void {
    const { store, history } = this.editor;
    const t = info.target;
    if (t.kind !== 'spacing') { this.parent.transition('idle'); return; }
    const el = store.element(t.scene, t.id);
    const prim = el !== undefined ? primitiveOfNode(el.node) : null;
    if (prim === null || prim.name !== 'frame') { this.parent.transition('idle'); return; }
    const layout = prim.payload['layout'];
    const axis: 'x' | 'y' = t.key === 'gap'
      ? (layout === 'row' || layout === 'grid' ? 'x' : 'y')
      : (t.edge === 'left' || t.edge === 'right' ? 'x' : 'y');
    const raw = prim.payload[t.key];
    const start = typeof raw === 'number' ? raw : 0;
    this.ctx = { scene: t.scene, screenId: t.screenId, id: t.id, key: t.key, ...(t.edge !== undefined ? { edge: t.edge } : {}), start, axis };
    history.mark(`spacing ${t.key}`);
    store.setGesture({ cursor: axis === 'x' ? 'col-resize' : 'row-resize' });
  }

  override onExit(): void {
    this.editor.store.setGesture({ cursor: null, badge: null });
    this.ctx = null;
  }

  override onPointerMove(): void {
    const { store, inputs } = this.editor;
    const c = this.ctx;
    if (c === null) return;
    const frame = this.editor.frameOf(c.screenId);
    const k = store.camera.zoom * (frame?.scale ?? 1);
    const d = inputs.dragDeltaClient();
    const travel = c.axis === 'x' ? d.x / k : d.y / k;
    const signed = c.key === 'gap' ? travel : c.edge === 'right' || c.edge === 'bottom' ? -travel : travel;
    const value = Math.max(0, Math.min(64, Math.round(c.start + signed)));
    const el = store.element(c.scene, c.id);
    const prim = el !== undefined ? primitiveOfNode(el.node) : null;
    if (el === undefined || prim === null) return;
    const payload = { ...prim.payload, [c.key]: value };
    store.put([{ ...el, node: { ...el.node, components: { ...el.node.components, [prim.ref]: payload } } }], 'user');
    store.setGesture({ badge: `${c.key === 'gap' ? 'space' : 'padding'} ${value}` });
  }

  override onPointerUp(): void { void this.editor.history.complete(); this.parent.transition('idle'); }
  override onComplete(): void { void this.editor.history.complete(); this.parent.transition('idle'); }
  override onCancel(): void { this.editor.history.bail(); this.parent.transition('idle'); }
}
