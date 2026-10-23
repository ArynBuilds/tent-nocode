import { StateNode, type PointerInfo } from '../StateNode.js';
import { marqueeRect, type Rect } from '../../store.js';

// SELECT / BRUSHING (tldraw's Brushing): the marquee from the press to the hand selects every card it
// touches; started inside a focused screen it selects that screen's elements instead. Shift keeps what
// was selected; a still box clears.

export class Brushing extends StateNode {
  static override id = 'brushing';

  private initialCards: readonly string[] = [];
  private initialElements: { scene: string; screenId: string; ids: string[] } | null = null;
  private additive = false;
  private inScreen: { scene: string; screenId: string } | null = null;

  override onEnter(info: PointerInfo & { additive?: boolean }): void {
    const { store } = this.editor;
    this.additive = info.additive === true;
    const sel = store.selection.sel;
    this.initialCards = sel?.kind === 'cards' ? sel.ids : [];
    this.initialElements = sel?.kind === 'element' ? { scene: sel.scene, screenId: sel.screenId, ids: [sel.elementId, ...sel.extras] } : null;
    const focused = store.focused.get();
    const origin = this.editor.inputs.originWorld;
    this.inScreen = focused !== null && store.innermostAt(origin, undefined, (id) => id === focused.nodeId) !== null && (sel?.kind === 'element' || store.editing.tapped === focused.nodeId)
      ? { scene: focused.slug, screenId: focused.nodeId } : null;
    store.setGesture({ cursor: 'default' });
    this.hitTest();
  }

  override onExit(): void {
    this.editor.store.setGesture({ brush: null });
  }

  override onPointerMove(): void { this.hitTest(); }
  override onKeyDown(): void { this.hitTest(); }
  override onKeyUp(): void { this.hitTest(); }
  override onPointerUp(): void { this.hitTest(); this.parent.transition('idle'); }
  override onComplete(): void { this.parent.transition('idle'); }
  override onCancel(): void {
    const { store } = this.editor;
    if (this.initialElements !== null) store.selectElement(this.initialElements.scene, this.initialElements.screenId, this.initialElements.ids[0]!, this.initialElements.ids.slice(1));
    else store.selectCards(this.initialCards);
    this.parent.transition('idle');
  }

  private hitTest(): void {
    const { store, inputs } = this.editor;
    const brush: Rect = marqueeRect(inputs.originWorld, inputs.currentWorld);
    store.setGesture({ brush });
    if (this.inScreen !== null) {
      const frame = this.editor.frameOf(this.inScreen.screenId);
      const origin = store.positionOf(this.inScreen.screenId);
      if (frame === null || origin === undefined) return;
      const k = frame.scale;
      const local: Rect = { x: (brush.x - origin.x) / k, y: (brush.y - origin.y) / k, w: brush.w / k, h: brush.h / k };
      const hits: string[] = [];
      for (const [id, r] of frame.rects) {
        if (id === 'root') continue;
        if (r.x < local.x + local.w && r.x + r.w > local.x && r.y < local.y + local.h && r.y + r.h > local.y) hits.push(id);
      }
      const ids = this.additive && this.initialElements !== null ? [...new Set([...this.initialElements.ids, ...hits])] : hits;
      if (ids.length === 0) { store.clearSelection(); store.setEditing({ tapped: this.inScreen.screenId }); return; }
      store.selectElement(this.inScreen.scene, this.inScreen.screenId, ids[0]!, ids.slice(1));
      return;
    }
    const hits = brush.w < 4 && brush.h < 4 ? [] : store.nodesInRect(brush);
    const ids = this.additive ? [...new Set([...this.initialCards, ...hits])] : hits;
    const cur = store.selectedCardIds();
    if (cur.size !== ids.length || ids.some((id) => !cur.has(id))) store.selectCards(ids);
  }
}
