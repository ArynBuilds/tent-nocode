import { primitiveOfNode } from '@tent-nocode/core';
import type { VerbDoor } from '@tent-nocode/core';
import { desk } from '../../../desk.js';
import { navigate } from '../../../router.js';
import { NO_DOORS_SENTENCE, pickConnectionDoor, resolveConnectionDoors } from '../../../page-edit/endpointPick.js';
import { StateNode, type KeyInfo, type PointerInfo, type StateNodeCtor } from '../StateNode.js';
import { nudge } from '../../managers/nudge.js';
import { canFold, mintGroup, store, type ElementRecord, type NodeRecord } from '../../store.js';
import { EditingText, copyElements, duplicateElements, pasteElements, copyLook, pasteLook, deleteElements } from './EditingText.js';
import { PointingNode } from './PointingNode.js';
import { Translating } from './Translating.js';
import { Brushing } from './Brushing.js';
import { Resizing } from './Resizing.js';
import { Rotating } from './Rotating.js';
import { PointingHandle } from './PointingHandle.js';
import { PointingWire } from './PointingWire.js';
import { DrawingWire } from './DrawingWire.js';

// SELECT / IDLE (tldraw's Idle): the resting state answers "what does a press here do" for every target,
// the double click law (a card descends, a text edits in place), the right-click menus, and the
// keyboard verbs (delete, nudge, copy, paste, duplicate, the look clipboard, fold, escape).

const ARROWS: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

export class Idle extends StateNode {
  static override id = 'idle';

  private pointingCanvas: { shift: boolean; ctrl: boolean } | null = null;

  override onEnter(): void {
    this.pointingCanvas = null;
    this.editor.store.setGesture({ grabbing: false, cursor: null });
  }

  override onPointerDown(info: PointerInfo): void {
    if (info.button === 1) { this.parent.parent.transition('hand', { temporary: true, from: 'select' }); return; }
    if (info.button !== 0) return;
    const t = info.target;
    switch (t.kind) {
      case 'canvas':
        this.pointingCanvas = { shift: info.shiftKey, ctrl: info.ctrlKey };
        return;
      case 'node':
      case 'element':
      case 'outline':
        this.parent.transition('pointingNode', info);
        return;
      case 'handle':
      case 'screen-edge':
        this.parent.transition('resizing', info);
        return;
      case 'rotate':
        this.parent.transition('rotating', info);
        return;
      case 'spacing':
        this.parent.transition('pointingHandle', info);
        return;
      case 'port':
      case 'element-port':
      case 'emit-port':
        this.parent.transition('drawingWire', info);
        return;
      case 'wire':
        this.parent.transition('pointingWire', info);
        return;
    }
  }

  override onPointerMove(info: PointerInfo): void {
    if (this.pointingCanvas !== null && this.editor.inputs.isDragging) {
      this.parent.transition('brushing', { ...info, additive: this.pointingCanvas.shift });
      return;
    }
    if (!this.editor.inputs.isPointing) this.updateHover(info);
  }

  override onPointerUp(): void {
    if (this.pointingCanvas === null) return;
    const { shift, ctrl } = this.pointingCanvas;
    this.pointingCanvas = null;
    // A still click on empty ground clears (the additive keys keep what stands).
    if (!shift && !ctrl) {
      this.editor.store.clearSelection();
      this.editor.store.setEditing({ tapped: null, pendingRun: null });
    }
  }

  /** The hover record: the innermost element under the hand inside the focused screen, else the card. */
  private updateHover(info: PointerInfo): void {
    const { store } = this.editor;
    const t = info.target;
    if (t.kind === 'element') {
      store.setHover({ node: t.screenId, element: t.id !== null && t.id !== 'root' ? { scene: t.scene, id: t.id } : null, cursor: this.cursorOf(info) });
      return;
    }
    store.setHover({ node: t.kind === 'node' ? t.id : null, element: null, cursor: this.cursorOf(info) });
  }

  private cursorOf(info: PointerInfo): { x: number; y: number } | null {
    const view = this.editor.view();
    return view === null ? null : { x: info.client.x - view.left, y: info.client.y - view.top };
  }

  override onDoubleClick(info: PointerInfo): void {
    const { store, doors } = this.editor;
    const t = info.target;
    if (t.kind === 'node') {
      const n = store.node(t.id);
      if (n !== undefined) doors.nodeOpen(n);
      else if (t.id.startsWith('fold:')) doors.nodeOpen({ typeName: 'node', id: t.id, kind: 'fold', label: '', detail: null, lastActivityAt: null, projectId: null });
      return;
    }
    if ((t.kind === 'element' || t.kind === 'outline') && t.id !== null && t.id !== 'root') {
      const el = store.element(t.scene, t.id);
      const prim = el !== undefined ? primitiveOfNode(el.node) : null;
      if (prim === null || prim.name !== 'text') return;
      if (typeof prim.payload['text'] === 'object' && prim.payload['text'] !== null) { doors.quiet('this text shows live data - edit its formula in Properties'); return; }
      this.parent.transition('editingText', { scene: t.scene, screenId: t.screenId, id: t.id });
    }
  }

  override onRightClick(info: PointerInfo): void {
    const { store, doors } = this.editor;
    const t = info.target;
    if (t.kind === 'node') {
      const n = store.node(t.id);
      if (n !== undefined) doors.nodeContext(n, info.client);
      else if (t.id.startsWith('fold:')) doors.nodeContext({ typeName: 'node', id: t.id, kind: 'fold', label: '', detail: null, lastActivityAt: null, projectId: null }, info.client);
      return;
    }
    if (t.kind === 'element' || t.kind === 'outline') {
      const frame = this.editor.frameOf(t.screenId);
      if (frame !== null) doors.elementContext(t.scene, t.screenId, frame.toFrame(info.client), info.client);
      return;
    }
    if (t.kind === 'canvas') doors.canvasContext(info.world, info.client);
  }

  override onKeyDown(info: KeyInfo): void {
    const { store, history, doors } = this.editor;
    const sel = store.selection.sel;
    const ctrl = info.ctrlKey;
    if (info.key === 'Escape') {
      if (this.escapeStep()) info.preventDefault();
      return;
    }
    // The fold grammar: Ctrl+G folds the selection, Ctrl+Shift+G dissolves a group, plain G folds each screen solo.
    if (info.key.toLowerCase() === 'g' && !info.altKey && sel?.kind === 'cards') {
      info.preventDefault();
      this.foldKey(info.shiftKey, ctrl, sel.ids);
      return;
    }
    const arrow = ARROWS[info.key];
    if (arrow !== undefined && !ctrl && !info.altKey) {
      info.preventDefault();
      const step = info.shiftKey ? 10 : 1;
      nudge(this.editor, arrow[0] * step, arrow[1] * step);
      return;
    }
    if (sel?.kind === 'element') {
      if (ctrl && info.altKey && info.code === 'KeyC') { info.preventDefault(); copyLook(this.editor, sel); return; }
      if (ctrl && info.altKey && info.code === 'KeyV') { info.preventDefault(); void pasteLook(this.editor, sel); return; }
      if (ctrl && !info.altKey && info.key.toLowerCase() === 'c') { info.preventDefault(); copyElements(this.editor, sel); return; }
      if (ctrl && !info.altKey && info.key.toLowerCase() === 'v') { info.preventDefault(); void pasteElements(this.editor, sel); return; }
      if (ctrl && info.key.toLowerCase() === 'd') { info.preventDefault(); void duplicateElements(this.editor, sel); return; }
      if (info.key === 'Delete' || info.key === 'Backspace') { info.preventDefault(); void deleteElements(this.editor, sel); return; }
      if (ctrl && info.key.toLowerCase() === 'a') {
        info.preventDefault();
        const all = store.elementsOf(sel.scene).map((e: ElementRecord) => e.node.id).filter((id) => id !== 'root' && id !== sel.elementId);
        store.selectElement(sel.scene, sel.screenId, sel.elementId, all);
        return;
      }
      return;
    }
    if ((info.key === 'Delete' || info.key === 'Backspace') && sel?.kind === 'cards') {
      info.preventDefault();
      doors.deleteNodes(new Set(sel.ids));
      return;
    }
    if (ctrl && info.key.toLowerCase() === 'a') {
      info.preventDefault();
      store.selectCards(store.folded.get().nodes.map((n: NodeRecord) => n.id));
      return;
    }
    void history;
  }

  /** Esc steps out one level at a time: the run chip, the extras, the element, the wire, the cards; false = nothing to step. */
  private escapeStep(): boolean {
    const { store } = this.editor;
    const ed = store.editing;
    if (ed.pendingRun !== null) { store.setEditing({ pendingRun: null }); return true; }
    const sel = store.selection.sel;
    if (sel?.kind === 'element') {
      if (sel.extras.length > 0) { store.selectElement(sel.scene, sel.screenId, sel.elementId, []); return true; }
      store.clearSelection();
      return true;
    }
    if (sel?.kind === 'wire') { store.clearSelection(); return true; }
    if (sel?.kind === 'cards') { store.clearSelection(); store.setEditing({ tapped: null }); return true; }
    if (ed.tapped !== null) { store.setEditing({ tapped: null }); return true; }
    if (store.mode.picked !== 'select') { store.setMode({ picked: 'select', armed: null }); return true; }
    return false;
  }

  private foldKey(shift: boolean, ctrl: boolean, selected: readonly string[]): void {
    const { store, doors } = this.editor;
    const folds = store.arrangement.folds;
    if (ctrl && shift) {
      const target = selected.find((id) => id.startsWith('fold:'));
      if (target !== undefined) dissolveFold(this.editor, target);
      return;
    }
    if (ctrl) {
      const picked = expandFoldSelection(this.editor, selected);
      const can = canFold(picked);
      if (!can.ok) { doors.quiet(can.sentence); return; }
      const g = mintGroup(picked);
      const at = groupSpot(this.editor, g.members);
      void this.editor.history.transaction('fold', () => {
        store.setFolds([...folds.filter((x) => !selected.includes(x.id)), g], 'user');
        if (at !== null) store.placeNodes({ [g.id]: at }, 'user');
      });
      store.selectCards([g.id]);
      return;
    }
    if (shift) return;
    const screens = selected.map((id) => store.node(id)).filter((n): n is NodeRecord => n !== undefined && (n.kind === 'scene' || n.kind === 'website'));
    if (screens.length === 0) { doors.quiet('select a screen to fold - G folds screens into small cards'); return; }
    const minted = screens.map((n) => mintGroup([n]));
    void this.editor.history.transaction('fold', () => {
      store.setFolds([...folds, ...minted], 'user');
      const positions: Record<string, { x: number; y: number }> = {};
      for (const g of minted) { const at = groupSpot(this.editor, g.members); if (at !== null) positions[g.id] = at; }
      if (Object.keys(positions).length > 0) store.placeNodes(positions, 'user');
    });
    store.selectCards(minted.map((g) => g.id));
  }
}

/** The raw members of a selection: folded cards dissolve flat (no nested folds). */
export function expandFoldSelection(editor: { store: { arrangement: { folds: Array<{ id: string; members: string[] }> }; node: (id: string) => NodeRecord | undefined } }, selected: readonly string[]): NodeRecord[] {
  const ids = new Set(selected.filter((id) => !id.startsWith('fold:')));
  for (const g of editor.store.arrangement.folds) if (selected.includes(g.id)) for (const m of g.members) ids.add(m);
  return [...ids].map((id) => editor.store.node(id)).filter((n): n is NodeRecord => n !== undefined);
}

/** A born group lands at its members' top-left, never on the shelf. */
export function groupSpot(editor: { store: { positionOf: (id: string) => { x: number; y: number } | undefined } }, members: string[]): { x: number; y: number } | null {
  const spots = members.map((m) => editor.store.positionOf(m)).filter((p): p is { x: number; y: number } => p !== undefined);
  if (spots.length === 0) return null;
  return { x: Math.min(...spots.map((s) => s.x)), y: Math.min(...spots.map((s) => s.y)) };
}

/** Unfold = dissolve: the members land free and stay selected. */
export function dissolveFold(editor: { store: import('../../store.js').CanvasStore; history: import('../../history.js').History }, id: string): void {
  const { store, history } = editor;
  const g = store.arrangement.folds.find((x) => x.id === id);
  void history.transaction('unfold', () => store.setFolds(store.arrangement.folds.filter((x) => x.id !== id), 'user'));
  if (g !== undefined) store.selectCards(g.members);
}

/** THE SELECT TOOL: the ten states over the store; Idle is the rest. */
export class SelectTool extends StateNode {
  static override id = 'select';
  static override initial = 'idle';
  static override children(): StateNodeCtor[] {
    return [Idle, PointingNode, Translating, Brushing, Resizing, Rotating, PointingHandle, EditingText, PointingWire, DrawingWire];
  }
  override onExit(): void {
    this.editor.store.setGesture({ brush: null, ghost: null, wire: null, landing: null, badge: null, guides: { x: null, y: null } });
  }
}

// ---- THE DELETION DOORS: Delete/Backspace and the menu's Delete row delete through the kernel's own doors,
// tombstones only, silent; Tables are the one confirmed delete (the caller renders the anchored popover).

export interface DeleteLaneDeps {
  orgId: string;
  projectId: string | null;
  sceneSlugOf: (sceneNodeId: string) => string | null;
}

export interface DeleteConfirm { name: string; rows: number }

const opName = (label: string): string => label.replace(/@\d+$/, '');
export const idTail = (nodeId: string): string => nodeId.slice(nodeId.indexOf(':') + 1);

/** One citizen through its own door (the non-confirmed kinds); role/notes/output are not in the ruled set and no-op. */
export async function deleteMapCitizen(deps: DeleteLaneDeps, n: { id: string; label: string }): Promise<void> {
  const { orgId, projectId, sceneSlugOf } = deps;
  if (n.id.startsWith('scene:')) {
    const slug = sceneSlugOf(n.id);
    if (slug !== null) await desk.humanDeleteScene(orgId, slug);
  } else if (n.id.startsWith('trg:')) {
    await desk.deleteTrigger(orgId, idTail(n.id));
  } else if (n.id.startsWith('chain:')) {
    await desk.revokeReactiveChain(orgId, idTail(n.id));
  } else if (n.id.startsWith('op:')) {
    await desk.humanRetireOperation(orgId, opName(n.label), projectId ?? undefined);
  } else if (n.id.startsWith('intg:')) {
    await desk.integrationsRevoke(orgId, idTail(n.id));
  } else if (n.id.startsWith('fstep:')) {
    // A step deletes through the one flows door; its wires leave with it (fstep:<flowId>:<stepId>).
    const [, flowId, stepId] = n.id.split(':');
    if (flowId !== undefined && stepId !== undefined) await desk.flowsRemoveStep(orgId, flowId, stepId);
  }
}

/** Deletes every non-table citizen, then answers the first selected table's confirm ask; null = nothing to confirm. */
export async function deleteMapSelection(
  deps: DeleteLaneDeps,
  ids: ReadonlySet<string>,
  byId: ReadonlyMap<string, { id: string; label: string }>,
): Promise<DeleteConfirm | null> {
  let confirm: DeleteConfirm | null = null;
  for (const id of ids) {
    const n = byId.get(id);
    if (n === undefined) continue;
    if (n.id.startsWith('ds:')) {
      if (confirm === null) {
        const brief = await desk.datasetBrief(deps.orgId, n.label, deps.projectId ?? undefined).catch(() => null);
        confirm = { name: n.label, rows: brief?.rowCount ?? 0 };
      }
      continue;
    }
    await deleteMapCitizen(deps, n).catch(() => undefined);
  }
  return confirm;
}

// ---- THE VERB DOORS: contract door name -> the desk door or the panel request; the toolbar, the menu and the
// inspector open the same doors (switches on door names alone, never on citizen kinds).

export interface VerbDoorDeps {
  orgId: string;
  /** The caller's quiet sentence lane. */
  say: (sentence: string) => void;
}

export interface VerbSubject {
  kind: string;
  nodeId: string;
  label: string;
  projectId: string | null;
}

export async function openVerbDoor(deps: VerbDoorDeps, sel: VerbSubject, door: VerbDoor): Promise<void> {
  const { orgId, say } = deps;
  if (door === 'run-operation') {
    const res = await desk.humanRunOperation(orgId, opName(sel.label), {});
    say(res.ok ? 'running - the result lands as its own node' : res.error);
    return;
  }
  if (door === 'open-code') {
    const base = sel.projectId !== null ? `/code/${sel.projectId}` : '/code';
    navigate(`${base}?op=${encodeURIComponent(opName(sel.label))}`);
    return;
  }
  if (door === 'open-rows') {
    if (!store.requestDescend({ kind: 'grid', dataset: sel.label })) say('open this project in the Workspace to walk the rows');
    return;
  }
  // edit-visuals focuses the screen's frame on the Workspace (camera + selection in place).
  if (door === 'edit-visuals') {
    if (!store.requestScreenFocus(idTail(sel.nodeId))) say('open this project in the Workspace to edit the screen');
    return;
  }
  if (door === 'revoke-chain') {
    await desk.revokeReactiveChain(orgId, idTail(sel.nodeId));
    say('revoked - it no longer re-runs');
    return;
  }
  if (door === 'open-notes' && sel.projectId !== null) {
    store.requestDescend({ kind: 'notes', projectId: sel.projectId });
    return;
  }
  // Test this step = one partial run up to the target (upstream seeds from the last run).
  if (door === 'test-step') {
    const [, flowId, stepId] = sel.nodeId.split(':');
    if (flowId === undefined || stepId === undefined) return;
    const fired = await desk.flowsStart(orgId, flowId, { step: stepId });
    if (!fired.ok || fired.data === undefined) { say(!fired.ok ? fired.error : 'the run could not be queued'); return; }
    if (!fired.data.ok) { say(fired.data.refusal ?? 'the run refused'); return; }
    const executionId = fired.data.executionId;
    if (executionId === undefined) { say('the run could not be queued'); return; }
    say(`running the flow up to '${sel.label}'...`);
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      // The 50-run window keeps a busy sweep from pushing the tested execution out of sight.
      const runs = await desk.flowsExecutions(orgId, sel.projectId ?? undefined, 50).catch(() => []);
      const run = runs.find((x) => x.id === executionId);
      if (run === undefined || run.status === 'pending' || run.status === 'running' || run.status === 'waiting') continue;
      if (run.status === 'succeeded') {
        const last = sel.projectId !== null ? await desk.flowsLastRun(orgId, sel.projectId).catch(() => []) : [];
        const ports = last.find((l) => l.flowId === flowId)?.stepCounts[stepId];
        const n = ports !== undefined ? Object.values(ports).reduce((a, c) => a + c, 0) : undefined;
        say(n !== undefined ? `ran up to here - ${n === 1 ? '1 item' : `${n} items`}` : 'ran up to here');
      } else {
        say(run.error ?? 'the step failed');
      }
      return;
    }
    say('the step is still running - the record keeps the answer');
    return;
  }
  // Switch off / on: one honest flip of the step's disabled field (disabled steps pass items through untouched).
  if (door === 'toggle-step') {
    const [, flowId, stepId] = sel.nodeId.split(':');
    if (flowId === undefined || stepId === undefined) return;
    const flows = await desk.flowsList(orgId, sel.projectId ?? undefined);
    const doc = flows.find((f) => f.id === flowId)?.doc as { steps?: Record<string, { disabled?: boolean }> } | undefined;
    const step = doc?.steps?.[stepId];
    if (step === undefined) { say('that step is already gone'); return; }
    const next = step.disabled !== true;
    const res = await desk.flowsSetStepDisabled(orgId, flowId, stepId, next);
    say(res.ok ? (next ? 'switched off - items pass through untouched' : 'switched on') : res.error);
    return;
  }
  // The Try chip: pick the door (one answers straight, several ask), fire one real call, speak the answer when it settles.
  if (door === 'try-endpoint') {
    const connectionId = idTail(sel.nodeId);
    const resolved = await resolveConnectionDoors(orgId, sel.projectId, connectionId);
    if (resolved === null) { say(NO_DOORS_SENTENCE); return; }
    pickConnectionDoor({
      resolved, projectId: sel.projectId, say,
      onDoor: (endpoint) => void (async () => {
        const word = resolved.doors.find((d) => d.id === endpoint)?.word ?? endpoint;
        const fired = await desk.integrationsTryEndpoint(orgId, connectionId, endpoint);
        if (!fired.ok || fired.data === undefined) { say(!fired.ok ? fired.error : 'the call could not be queued'); return; }
        if (!fired.data.ok) { say(fired.data.refusal ?? 'the call refused'); return; }
        const executionId = fired.data.executionId;
        if (executionId === undefined) { say('the call could not be queued'); return; }
        say(`trying '${word}'...`);
        for (let i = 0; i < 20; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          const res = await desk.integrationsExecutionResult(orgId, executionId).catch(() => null);
          if (res === null || res.status === 'pending' || res.status === 'running') continue;
          if (res.status === 'succeeded') {
            const bits = typeof res.result === 'object' && res.result !== null
              ? Object.entries(res.result as Record<string, unknown>).slice(0, 3).map(([k, v]) => `${k}: ${String(v).slice(0, 40)}`).join(' · ')
              : '';
            say(bits !== '' ? `'${word}' answered - ${bits}` : `'${word}' answered`);
          } else {
            say(res.error ?? `'${word}' failed`);
          }
          return;
        }
        say(`'${word}' is still running - the record keeps the answer`);
      })(),
    });
  }
}
