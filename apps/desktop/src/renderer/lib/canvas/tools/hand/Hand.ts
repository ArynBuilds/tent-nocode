import { StateNode, type PointerInfo } from '../StateNode.js';
import { panBy } from '../../store.js';

// THE HAND: every drag pans the camera, unbounded; the middle button pans from any tool (the root
// hands over with `temporary` and takes the tool back on the up); Space held is the hand from any mode.

export class Hand extends StateNode {
  static override id = 'hand';

  private panning: { camX: number; camY: number } | null = null;
  private returnTo: 'select' | 'create' | null = null;

  override onEnter(info: { temporary?: boolean; from?: 'select' | 'create' } | PointerInfo): void {
    const { store } = this.editor;
    const temp = 'temporary' in info && info.temporary === true;
    this.returnTo = temp && 'from' in info && info.from !== undefined ? info.from : null;
    store.setGesture({ cursor: 'grab' });
    if (temp) this.begin();
  }

  override onExit(): void {
    this.editor.store.setGesture({ cursor: null, grabbing: false });
    this.panning = null;
  }

  private begin(): void {
    const cam = this.editor.store.camera;
    this.panning = { camX: cam.x, camY: cam.y };
    this.editor.store.setGesture({ grabbing: true, cursor: 'grabbing' });
  }

  override onPointerDown(info: PointerInfo): void {
    if (info.button !== 0 && info.button !== 1) return;
    this.begin();
  }

  override onPointerMove(): void {
    if (this.panning === null) return;
    const d = this.editor.inputs.dragDeltaClient();
    const cam = this.editor.store.camera;
    this.editor.store.setCamera(panBy({ x: this.panning.camX, y: this.panning.camY, zoom: cam.zoom }, d.x, d.y));
  }

  override onPointerUp(): void {
    this.panning = null;
    this.editor.store.setGesture({ grabbing: false, cursor: 'grab' });
    if (this.returnTo !== null) { const to = this.returnTo; this.returnTo = null; this.parent.transition(to); }
  }

  override onCancel(): void { this.panning = null; this.editor.store.setGesture({ grabbing: false }); }
}
