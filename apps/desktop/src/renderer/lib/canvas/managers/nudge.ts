import { primitiveOfNode } from '@tent-nocode/core';
import type { Editor } from '../tools/StateNode.js';
import type { ElementRecord } from '../store.js';
import { withScopedValues } from '../../../components/page-edit/panelGroups.js';

// THE NUDGE: the arrow keys move what is selected by one unit (ten with Shift). A card moves its arrangement
// spot; an element whose x/y are live (a layout-none parent, or free: true) moves them; a flow child moves
// nothing - the layout places it and a written x/y would be ignored. One transaction per press.

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** True when the element's own x/y place it: its parent frame lays out 'none', it is free: true itself, or it sits on the canvas document's root. */
export function inFreeParent(editor: Editor, scene: string, elementId: string): boolean {
  const el = editor.store.element(scene, elementId);
  if (el === undefined || el.node.parent === null) return false;
  const canvasDoc = editor.store.canvasDoc.get();
  if (canvasDoc !== null && canvasDoc.slug === scene && el.node.parent === 'root') return true;
  const self = primitiveOfNode(el.node);
  if (self !== null && self.payload['free'] === true) return true;
  const parent = editor.store.element(scene, el.node.parent);
  if (parent === undefined) return false;
  const prim = primitiveOfNode(parent.node);
  return prim !== null && prim.name === 'frame' && (prim.payload['layout'] ?? 'none') === 'none';
}

/** The element's payload with x/y moved by a delta (frame units); the keys land from the fallback when absent.
 *  With an editing breakpoint the keys land in the at.<bp> partial instead of the base (Phase 14A). */
export function movedPayload(el: ElementRecord, dx: number, dy: number, fallback: { x: number; y: number }, bp: string | null = null): ElementRecord {
  const prim = primitiveOfNode(el.node);
  if (prim === null) return el;
  // Scoped: move from the override when it speaks, else from the rendered spot (the fallback shows what the eye sees).
  const scoped = bp !== null ? scopedXY(prim.payload, bp) : null;
  const x = bp !== null ? scoped?.x ?? fallback.x : num(prim.payload['x']) ?? fallback.x;
  const y = bp !== null ? scoped?.y ?? fallback.y : num(prim.payload['y']) ?? fallback.y;
  const patch = { x: Math.round(x + dx), y: Math.round(y + dy) };
  const payload = bp === null
    ? { ...prim.payload, ...patch }
    : withScopedValues(prim.payload, { state: 'default', breakpoint: bp }, patch);
  return { ...el, node: { ...el.node, components: { ...el.node.components, [prim.ref]: payload } } };
}

/** The x/y an at.<bp> partial already holds (a scoped nudge moves from there, not from the base). */
function scopedXY(payload: Record<string, unknown>, bp: string): { x: number | null; y: number | null } | null {
  const at = payload['at'];
  if (at === null || typeof at !== 'object') return null;
  const block = (at as Record<string, unknown>)[bp];
  if (block === null || typeof block !== 'object') return null;
  const b = block as Record<string, unknown>;
  return { x: num(b['x']), y: num(b['y']) };
}

export function nudge(editor: Editor, dx: number, dy: number): void {
  const { store, history } = editor;
  const sel = store.selection.sel;
  if (sel === null) return;
  if (sel.kind === 'element') {
    const ids = [sel.elementId, ...sel.extras];
    const frame = editor.frameOf(sel.screenId);
    const puts: ElementRecord[] = [];
    for (const id of ids) {
      if (!inFreeParent(editor, sel.scene, id)) continue;
      const el = store.element(sel.scene, id);
      if (el === undefined) continue;
      const r = frame?.rects.get(id);
      const parentRect = el.node.parent !== null ? frame?.rects.get(el.node.parent) ?? { x: 0, y: 0 } : { x: 0, y: 0 };
      puts.push(movedPayload(el, dx, dy, { x: (r?.x ?? 0) - parentRect.x, y: (r?.y ?? 0) - parentRect.y }, store.editing.breakpoint));
    }
    if (puts.length === 0) return;
    void history.transaction('nudge', () => store.put(puts, 'user'));
    return;
  }
  if (sel.kind === 'cards') {
    const positions: Record<string, { x: number; y: number }> = {};
    for (const id of sel.ids) {
      const p = store.positionOf(id);
      if (p !== undefined) positions[id] = { x: p.x + dx, y: p.y + dy };
    }
    if (Object.keys(positions).length === 0) return;
    void history.transaction('nudge', () => store.placeNodes(positions, 'user'));
  }
}
