import { StateNode, type PointerInfo } from '../StateNode.js';

// SELECT / POINTING NODE (tldraw's PointingShape): a press on a card or an element. Plain selects now,
// Shift or Ctrl adds (toggles on the up), a press inside the selection keeps it whole; a drag past the
// threshold hands over to Translating; the up on an already selected thing narrows to it.

export class PointingNode extends StateNode {
  static override id = 'pointingNode';

  private info: PointerInfo = {} as PointerInfo;
  private selectedOnEnter = false;

  override onEnter(info: PointerInfo): void {
    this.info = info;
    this.selectedOnEnter = false;
    const { store } = this.editor;
    const t = info.target;
    const additive = info.shiftKey || info.ctrlKey;
    if (t.kind === 'node') {
      const selected = store.selectedCardIds();
      if (selected.has(t.id)) return;
      if (additive) { store.selectCards([...selected, t.id]); this.selectedOnEnter = true; return; }
      store.selectCards([t.id]);
      store.setEditing({ tapped: null, pendingRun: null });
      this.selectedOnEnter = true;
      return;
    }
    if (t.kind !== 'element') return;
    // An element hit: root or nothing clears the element selection but keeps the screen focused (tapped).
    const hit = t.id !== null && t.id !== 'root' ? t.id : null;
    const sel = store.selectedElement();
    if (hit === null) {
      if (!additive) { store.clearSelection(); store.setEditing({ tapped: t.screenId, pendingRun: null }); }
      return;
    }
    if (info.shiftKey && sel !== null && sel.screenId === t.screenId && sel.elementId !== hit) {
      const extras = sel.extras.includes(hit) ? sel.extras.filter((x) => x !== hit) : [...sel.extras, hit];
      store.selectElement(sel.scene, sel.screenId, sel.elementId, extras);
      this.selectedOnEnter = true;
      return;
    }
    if (sel !== null && sel.screenId === t.screenId && (sel.elementId === hit || sel.extras.includes(hit))) return;
    store.selectElement(t.scene, t.screenId, hit, []);
    store.setEditing({ tapped: t.screenId, pendingRun: null });
    this.selectedOnEnter = true;
  }

  override onPointerMove(info: PointerInfo): void {
    if (!this.editor.inputs.isDragging) return;
    if (this.info.ctrlKey && this.info.target.kind === 'node') { this.parent.transition('brushing', { ...info, additive: true }); return; }
    this.parent.transition('translating', this.info);
  }

  override onPointerUp(info: PointerInfo): void {
    const { store } = this.editor;
    const t = this.info.target;
    // The screen's door (user-ruled): a still click on the artboard's title label or its empty ground
    // opens the inspector on the screen - the Screen section plus the root frame's ruled rows.
    if (!info.shiftKey && !info.ctrlKey) {
      const openRoot = (screenId: string): void => {
        const s = store.screenOf(screenId);
        if (s !== undefined) store.openInspector({ sceneId: s.sceneId, sceneSlug: s.slug, sceneTitle: s.title, nodeId: 'root' });
      };
      if (t.kind === 'node' && t.name === true && store.screenOf(t.id) !== undefined) openRoot(t.id);
      else if (t.kind === 'element' && (t.id === null || t.id === 'root')) openRoot(t.screenId);
    }
    if (!this.selectedOnEnter) {
      if (t.kind === 'node') {
        const selected = store.selectedCardIds();
        if (info.shiftKey || info.ctrlKey) store.selectCards([...selected].filter((id) => id !== t.id));
        else store.selectCards([t.id]);
      } else if (t.kind === 'element' || t.kind === 'outline') {
        // A still click on the chrome re-resolves to the innermost element under the hand.
        const frame = this.editor.frameOf(t.screenId);
        const hit = t.kind === 'outline' ? frame?.hitTest(info.client) ?? t.id : t.id;
        const sel = store.selectedElement();
        if (hit !== null && hit !== 'root') {
          if (info.shiftKey && sel !== null && sel.elementId !== hit) {
            const extras = sel.extras.includes(hit) ? sel.extras.filter((x) => x !== hit) : [...sel.extras, hit];
            store.selectElement(sel.scene, sel.screenId, sel.elementId, extras);
          } else if (sel === null || sel.elementId !== hit || sel.extras.length > 0) {
            store.selectElement(t.scene, t.screenId, hit, []);
          }
        }
      }
    }
    this.parent.transition('idle', info);
  }

  override onCancel(): void { this.parent.transition('idle'); }
  override onComplete(): void { this.parent.transition('idle'); }
}
