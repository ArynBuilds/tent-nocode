import { keyBetween, primitiveOfNode, propertiesOf, SHARED_GROUPS } from '@tent-nocode/core';
import type { SceneNode } from '@tent-nocode/core';
import { StateNode, type Editor, type PointerInfo } from '../StateNode.js';
import type { ElementRecord } from '../../store.js';
import { orderedByRail, withPlace } from './Translating.js';
import { inFreeParent } from '../../managers/nudge.js';

// SELECT / EDITING TEXT (tldraw's EditingShape): a double-clicked text edits in place through the mount's
// contenteditable; Enter or a click away commits the words (rich blocks come back as blocks), Esc cancels.
// The element verbs the keyboard speaks live here too: delete, copy, paste, duplicate, the look clipboard.

interface EditInfo { scene: string; screenId: string; id: string }

export class EditingText extends StateNode {
  static override id = 'editingText';

  private ctx: EditInfo | null = null;
  private off: (() => void) | null = null;

  override onEnter(info: EditInfo): void {
    const { store } = this.editor;
    const frame = this.editor.frameOf(info.screenId);
    if (frame === null) { this.parent.transition('idle'); return; }
    this.ctx = info;
    store.setEditing({ text: { scene: info.scene, elementId: info.id } });
    store.selectElement(info.scene, info.screenId, info.id, []);
    frame.editText(info.id);
  }

  override onExit(): void {
    this.off?.();
    this.off = null;
    this.editor.store.setEditing({ text: null });
    this.ctx = null;
  }

  /** The mount reports the edit's end (the face forwards it here). */
  endEdit(result: { text?: string; blocks?: unknown[]; cancel?: boolean }): void {
    const { store, history } = this.editor;
    const c = this.ctx;
    if (c === null) return;
    if (result.cancel !== true) {
      const el = store.element(c.scene, c.id);
      const prim = el !== undefined ? primitiveOfNode(el.node) : null;
      if (el !== undefined && prim !== null && prim.name === 'text') {
        const payload = { ...prim.payload };
        if (result.blocks !== undefined) { payload['blocks'] = result.blocks; delete payload['text']; }
        else if (result.text !== undefined && result.text !== prim.payload['text']) { payload['text'] = result.text; delete payload['blocks']; }
        if (JSON.stringify(payload) !== JSON.stringify(prim.payload)) {
          void history.transaction('edit text', () => store.put([{ ...el, node: { ...el.node, components: { ...el.node.components, [prim.ref]: payload } } }], 'user'));
        }
      }
    }
    if (this.getIsActive()) this.parent.transition('idle');
  }

  override onPointerDown(info: PointerInfo): void {
    const t = info.target;
    if ((t.kind === 'element' || t.kind === 'outline') && this.ctx !== null && t.id === this.ctx.id) return;
    // A press elsewhere ends the edit (the mount's focusout commits) and lands as a fresh press.
    this.parent.transition('idle');
    this.parent.getCurrent()?.handleEvent(info);
  }

  override onCancel(): void { this.parent.transition('idle'); }
  override onComplete(): void { this.parent.transition('idle'); }
}

// ---------------------------------------------------------------------------
// The element verbs: delete, copy, paste, duplicate, the look clipboard.
// ---------------------------------------------------------------------------

interface ElementSel { scene: string; screenId: string; elementId: string; extras: readonly string[] }

let clipboard: { nodes: SceneNode[]; roots: string[] } | null = null;
let pastes = 0;
let lookClip: Record<string, unknown> | null = null;

/** The subtree of an element as nodes (parents first). */
function subtreeOf(editor: Editor, scene: string, id: string): SceneNode[] {
  const out: SceneNode[] = [];
  const walk = (nid: string): void => {
    const el = editor.store.element(scene, nid);
    if (el === undefined) return;
    out.push(el.node);
    for (const c of editor.store.childrenOf(scene, nid)) walk(c);
  };
  walk(id);
  return out;
}

export async function deleteElements(editor: Editor, sel: ElementSel): Promise<void> {
  const { store, history } = editor;
  const ids = [sel.elementId, ...sel.extras].filter((id) => id !== 'root');
  const gone: string[] = [];
  for (const id of ids) for (const n of subtreeOf(editor, sel.scene, id)) gone.push(store.elementId(sel.scene, n.id));
  if (gone.length === 0) return;
  store.clearSelection();
  store.setEditing({ tapped: sel.screenId });
  await history.transaction('delete', () => store.remove([...new Set(gone)], 'user'));
}

export function copyElements(editor: Editor, sel: ElementSel): void {
  const ids = orderedByRail(editor.store, sel.scene, [sel.elementId, ...sel.extras].filter((id) => id !== 'root'));
  const nodes: SceneNode[] = [];
  for (const id of ids) nodes.push(...subtreeOf(editor, sel.scene, id));
  clipboard = { nodes, roots: ids };
  pastes = 0;
}

/** Fresh ids for a copied subtree; refs inside it re-target, screen refs stay literal. */
function withFreshIds(nodes: SceneNode[], suffix: string): SceneNode[] {
  const map = new Map(nodes.map((n) => [n.id, `${n.id.slice(0, 56)}-${suffix}`.toLowerCase()]));
  return nodes.map((n) => ({
    ...n,
    id: map.get(n.id)!,
    parent: n.parent !== null && map.has(n.parent) ? map.get(n.parent)! : n.parent,
    ...(n.refs !== undefined ? { refs: Object.fromEntries(Object.entries(n.refs).flatMap(([k, v]) => (map.has(v) ? [[k, map.get(v)!]] : v.startsWith('scene:') ? [[k, v]] : []))) } : {}),
  }));
}

/** Pastes the clipboard beside the selection (into its parent), each paste one step further. */
export async function pasteElements(editor: Editor, sel: ElementSel): Promise<void> {
  const { store, history } = editor;
  if (clipboard === null) return;
  const anchor = store.element(sel.scene, sel.elementId);
  const parent = anchor?.node.parent ?? 'root';
  const suffix = Math.random().toString(36).slice(2, 6);
  const fresh = withFreshIds(clipboard.nodes, suffix);
  const roots = clipboard.roots.map((r) => `${r.slice(0, 56)}-${suffix}`.toLowerCase());
  const rail = store.childrenOf(sel.scene, parent);
  let lo = rail.length > 0 ? store.element(sel.scene, rail[rail.length - 1]!)?.node.order ?? null : null;
  const step = 16 * ++pastes;
  const free = inFreeParent(editor, sel.scene, sel.elementId);
  const puts: ElementRecord[] = fresh.map((n) => {
    const isRoot = roots.includes(n.id);
    const order = isRoot ? (lo = keyBetween(lo, null)) : n.order;
    const rec: ElementRecord = { typeName: 'element', id: store.elementId(sel.scene, n.id), scene: sel.scene, node: { ...n, parent: isRoot ? parent : n.parent, order } };
    if (!isRoot || !free) return rec;
    const prim = primitiveOfNode(n);
    const x = typeof prim?.payload['x'] === 'number' ? prim.payload['x'] : 0;
    const y = typeof prim?.payload['y'] === 'number' ? prim.payload['y'] : 0;
    // A pasted element is born: its landing spot writes the base, whatever breakpoint the panel views.
    return withPlace(rec, { x: x + step, y: y + step }, null);
  });
  await history.transaction('paste', () => store.put(puts, 'user'));
  const first = roots[0];
  if (first !== undefined) store.selectElement(sel.scene, sel.screenId, first, roots.slice(1));
}

/** Ctrl+D: the copy lands beside its source, a free child offset by 16. */
export async function duplicateElements(editor: Editor, sel: ElementSel): Promise<void> {
  copyElements(editor, sel);
  await pasteElements(editor, sel);
}

/** The look of an element: its shared groups (fill, stroke, effects) and the text's typography, never its structure. */
const LOOK_GROUPS = ['fill', 'stroke', 'effects', 'visibility'] as const;
function lookKeys(name: 'frame' | 'text' | 'field' | 'chart' | 'instance'): Set<string> {
  const keys = new Set<string>();
  for (const g of LOOK_GROUPS) for (const k of Object.keys(SHARED_GROUPS[g].properties)) keys.add(k);
  if (name === 'text') for (const k of Object.keys(propertiesOf('text'))) if (k.startsWith('font-') || k.startsWith('text-') || k === 'color' || k === 'letter-spacing' || k === 'line-height') keys.add(k);
  return keys;
}

export function copyLook(editor: Editor, sel: ElementSel): void {
  const el = editor.store.element(sel.scene, sel.elementId);
  const prim = el !== undefined ? primitiveOfNode(el.node) : null;
  if (prim === null) return;
  const keys = lookKeys(prim.name);
  const look: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(prim.payload)) if (keys.has(k)) look[k] = v;
  if (typeof prim.payload['states'] === 'object' && prim.payload['states'] !== null) look['states'] = prim.payload['states'];
  lookClip = look;
}

export async function pasteLook(editor: Editor, sel: ElementSel): Promise<void> {
  const { store, history } = editor;
  if (lookClip === null) return;
  const clip = lookClip;
  const puts: ElementRecord[] = [];
  for (const id of [sel.elementId, ...sel.extras]) {
    const el = store.element(sel.scene, id);
    const prim = el !== undefined ? primitiveOfNode(el.node) : null;
    if (el === undefined || prim === null) continue;
    const keys = lookKeys(prim.name);
    const payload = { ...prim.payload };
    for (const k of keys) delete payload[k];
    for (const [k, v] of Object.entries(clip)) if (keys.has(k) || k === 'states') payload[k] = v;
    puts.push({ ...el, node: { ...el.node, components: { ...el.node.components, [prim.ref]: payload } } });
  }
  if (puts.length > 0) await history.transaction('paste look', () => store.put(puts, 'user'));
}
