import { useMemo, useSyncExternalStore } from 'react';
import { atom, computed, react, transact, unsafe__withoutCapture, type Atom, type Computed } from '@tldraw/state';
import {
  Bot, Braces, CircleOff, Ellipsis, Eye, FolderOpen, Group, Monitor, PackageOpen, Pencil, Play, Plug, Plus, Power, RefreshCw, Rows3, StickyNote,
  Table2, Trash2, Ungroup, Workflow, Wrench, Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import {
  CONDITION_OPS, EDGE_VERB_SENTENCES, NODE_CONTRACTS, SCENE_ROOT_ID, citizenWord, conditionSchema, elementLegalTargets, elementPortRule, legalTargets,
  primitiveOfNode, sceneDocumentSchema,
} from '@nodeloom/core';
import type { CitizenKind, ConditionOp, ElementClass, FlowCondition, LibraryItem, NodeContract, Pill, SceneDocument, SceneNode, VerbDoor } from '@nodeloom/core';
import { desk } from '../desk.js';
import { subscribeLive } from '../live.js';
import { paramWord } from '../page-edit/flowWires.js';
import type { LiveEvent, SceneCatalogEntry } from '../../../shared/ipc.js';

// THE STORE (Phase 12, row 12.13; the 500-line law is waived - one system, one file). Everything the
// editor knows is a record here, reactive on @tldraw/state: the map's citizens and wires, the screens
// and their documents' elements, the camera, the selection, the hover, the arrangement, the editing
// frame, the mouse mode, the gesture in flight, and the panels' subjects. One put/remove/apply(diff)
// door; every user change is a RecordsDiff the history (history.ts) records and reverses. The graph
// and the documents arrive by the live channel's push (a pointer re-reads, never a timer).

// ---------------------------------------------------------------------------
// Records.
// ---------------------------------------------------------------------------

export interface Placed { x: number; y: number }
export interface Rect { x: number; y: number; w: number; h: number }
export interface Camera { x: number; y: number; zoom: number }

/** A citizen on the map; the id is the graph's own (ds:, op:, scene:, trg:, chain:, intg:, fstep:, role:, notes:, out:). */
export interface NodeRecord {
  typeName: 'node';
  id: string;
  kind: string;
  label: string;
  word?: string;
  detail: string | null;
  lastActivityAt: string | null;
  projectId: string | null;
  face?: { kind: 'grid'; cols: number; rows: number } | { kind: 'value'; value: string };
  service?: string;
  sockets?: string[];
  grow?: Array<{ k: string; v: string }>;
}

/** A landed wire between two citizens; the whole address is the identity. */
export interface EdgeRecord {
  typeName: 'edge';
  id: string;
  from: string;
  to: string;
  verb: string;
  action?: string;
  rule?: number;
  param?: string;
  port?: string;
  slot?: string;
  via?: string;
}

/** A screen on the canvas: the tab's scene, its design size, its measured content height, its head revision. */
export interface ScreenRecord {
  typeName: 'screen';
  /** screen:<sceneId> */
  id: string;
  sceneId: string;
  /** The map node id (scene:<sceneId>) the citizen record carries. */
  nodeId: string;
  slug: string;
  title: string;
  size: { w: number; h: number };
  /** The engine's measured content height, frame units; null until measured. */
  contentH: number | null;
  revision: number;
  loaded: boolean;
}

/** One node of a screen's document, as the kernel stores it (never instance-expanded). */
export interface ElementRecord {
  typeName: 'element';
  /** el:<slug>:<nodeId> */
  id: string;
  scene: string;
  node: SceneNode;
}

export type SelectionState =
  | { kind: 'cards'; ids: readonly string[] }
  | { kind: 'element'; scene: string; screenId: string; elementId: string; extras: readonly string[] }
  | { kind: 'wire'; address: WireAddress }
  | null;

export interface WireAddress { from: string; to: string; action?: string; rule?: number; param?: string; port?: string; slot?: string }

export interface SelectionRecord { typeName: 'selection'; id: 'selection'; sel: SelectionState }
export interface CameraRecord extends Camera { typeName: 'camera'; id: 'camera'; fitLive: boolean }
export interface HoverRecord {
  typeName: 'hover';
  id: 'hover';
  node: string | null;
  element: { scene: string; id: string } | null;
  /** The cursor in screen px over the canvas viewport; null off the canvas. */
  cursor: Placed | null;
}

export interface FoldGroup { id: string; kind: string; label: string; members: string[]; open: boolean }

/** The arrangement record: where every card sits, the fold groups, the auto-fold markers - project data. */
export interface ArrangementRecord {
  typeName: 'arrangement';
  id: 'arrangement';
  positions: Record<string, Placed>;
  folds: FoldGroup[];
  seeded: string[];
  seededComposites: string[];
  hydrated: boolean;
}

export type CanvasMode = 'select' | 'create' | 'hand';
export type CreateArm =
  | { kind: 'screen'; label: string }
  | { kind: 'primitive'; label: string; name: 'frame' | 'text' | 'field' | 'chart' | 'instance'; prefill: Record<string, unknown> }
  | { kind: 'item'; label: string; ref: string; item: LibraryItem }
  | { kind: 'stamp'; label: string; land: (at: Placed, client: Placed) => void };

export interface ModeRecord { typeName: 'mode'; id: 'mode'; picked: CanvasMode; spaceHeld: boolean; armed: CreateArm | null }

/** The editing frame: the focused screen (the sole-selected or element-tapped one) and the text edit in flight. */
export interface EditingRecord {
  typeName: 'editing';
  id: 'editing';
  /** The tapped screen's node id (an element tap focuses without selecting). */
  tapped: string | null;
  text: { scene: string; elementId: string } | null;
  /** The panel's state switch: what the face previews on the selected element. */
  previewState: 'default' | 'hover' | 'focus' | 'pressed' | 'disabled';
  breakpoint: string | null;
  /** The armed run chip on an action element. */
  pendingRun: { scene: string; elementId: string; name: string | null } | null;
  /** The one plain sentence under a sole-selected card whose action wire speaks (read on selection). */
  sentence: string | null;
}

/** The flowsLastRun wire row: counts only, item arrays never reach the renderer. */
export interface FlowLastRun {
  flowId: string;
  executionId: string;
  status: string;
  error: string | null;
  createdAt: string;
  ran: string[];
  stepCounts: Record<string, Record<string, number>>;
}

/** A step's authoring state off its flow doc: the pin and the last touch; `alias` = a fused run-tool step's Tool card. */
export interface StepAuthorState { flowId: string; stepId: string; pinned: boolean; touchedAt?: string; alias?: string }

/** The run record: the last runs and the step states (fed by the live push), the out ports, the replay walking on the tick. */
export interface RunsRecord {
  typeName: 'runs';
  id: 'runs';
  runs: FlowLastRun[];
  states: StepAuthorState[];
  outPorts: Record<string, string[]>;
  replay: { seq: string[]; i: number; elapsed: number; settling: boolean } | null;
}

/** What a gesture draws while it runs: the brush, the ghost, the guides, the wire in flight, the landing. */
export interface GestureRecord {
  typeName: 'gesture';
  id: 'gesture';
  brush: Rect | null;
  ghost: Rect | null;
  guides: { x: number | null; y: number | null };
  wire: { fromId: string; from: Placed; to: Placed; element?: { scene: string; id: string; cls: string } } | null;
  landing: { scene: string; parent: string; line: Rect; axis: 'x' | 'y' } | null;
  badge: string | null;
  cursor: string | null;
  createGhost: Rect | null;
  grabbing: boolean;
}

/** The panels' subjects: the inspector, the node browser, the armed selections. */
export interface InspectorSelection { sceneId: string; sceneSlug: string; sceneTitle: string; nodeId: string; extraIds?: string[] }
export interface CitizenSelection { citizen: true; kind: string; nodeId: string; label: string; projectId: string | null }
export interface WireSelection {
  wire: true;
  sentence: string;
  binding?: { sceneSlug: string; dataset: string; projectId: string | null };
  actionWire?: { sceneSlug: string; action: string; rule: number; param?: string; projectId: string | null };
}
export type InspectorSubject = InspectorSelection | WireSelection;

export interface NodeBrowseContext {
  mode: 'wire' | 'catalog';
  headline?: string;
  source?: { id: string; kind: string; label: string };
  between?: { fromKind: string; toKind: string; fromLabel: string; toLabel: string };
  element?: { cls: 'nav' | 'action' | 'display'; label: string };
  doors?: Array<{ id: string; word: string; klass: 'read' | 'write' | 'send' }>;
  /** The browser opens with this create row's name entry already open (the palette's named births). */
  naming?: AddKind;
  onPick?: (choice: NodeBrowserPick, context: NodeBrowseContext) => void;
  projectId: string | null;
}
export type NodeBrowserPick =
  | { pick: 'node'; id: string; kind: string; label: string }
  /** A named insert carries the kebab name and the words as typed; the unnamed kinds carry the kind alone. */
  | { pick: 'insert'; kind: AddKind; name?: string; typed?: string }
  | { pick: 'door'; id: string; word: string };
export type CatalogAdd =
  | { kind: AddKind; name?: string; typed?: string }
  | { primitive: 'frame' | 'text' | 'field' | 'chart' }
  | { item: string }
  | { integration: string }
  | { step: string }
  | { door: { service: string; endpoint: string } }
  | { trigger: { service: string; id: string } };
export type WorkshopDescend = { kind: 'grid'; dataset: string } | { kind: 'notes'; projectId: string };
export interface CodeSelection { subject: string; fromLine: number; toLine: number; text: string }

/** A request is a record with a nonce: the mounted surface that answers it reacts to the nonce. */
export interface PanelRecord {
  typeName: 'panel';
  id: 'panel';
  inspector: InspectorSubject | null;
  inspectorNonce: number;
  browser: NodeBrowseContext | null;
  browserNonce: number;
  file: { path: string; nonce: number } | null;
  focusScene: { slug: string; nonce: number } | null;
  descend: { target: WorkshopDescend; nonce: number } | null;
  screenFocus: { sceneId: string; nonce: number } | null;
  /** A node's properties asked for from outside the canvas (the node browser); the workspace answers. */
  nodeProps: { nodeId: string; nonce: number } | null;
  catalogAdd: { add: CatalogAdd; nonce: number } | null;
  armed: InspectorSelection | null;
  armedCode: CodeSelection | null;
  /** Which surfaces are mounted to answer: absent = the request has no home. */
  hosts: { inspector: boolean; browser: boolean; file: boolean; focus: boolean; workspace: boolean };
}

export type CanvasRecord =
  | NodeRecord | EdgeRecord | ScreenRecord | ElementRecord
  | SelectionRecord | CameraRecord | HoverRecord | ArrangementRecord | ModeRecord | EditingRecord | GestureRecord | PanelRecord | RunsRecord;

// ---------------------------------------------------------------------------
// The diff (tldraw's RecordsDiff shape: added, updated [from, to], removed) and its algebra.
// ---------------------------------------------------------------------------

export interface RecordsDiff {
  added: Record<string, CanvasRecord>;
  updated: Record<string, [from: CanvasRecord, to: CanvasRecord]>;
  removed: Record<string, CanvasRecord>;
}

export const emptyDiff = (): RecordsDiff => ({ added: {}, updated: {}, removed: {} });

export function isDiffEmpty(d: RecordsDiff): boolean {
  for (const _ in d.added) return false;
  for (const _ in d.updated) return false;
  for (const _ in d.removed) return false;
  return true;
}

export function reverseDiff(d: RecordsDiff): RecordsDiff {
  const out: RecordsDiff = { added: { ...d.removed }, removed: { ...d.added }, updated: {} };
  for (const [id, [from, to]] of Object.entries(d.updated)) out.updated[id] = [to, from];
  return out;
}

/** Squashes `next` into `target` in place: an add then an update is an add with the final state; an add then a remove cancels. */
export function squashInto(target: RecordsDiff, next: RecordsDiff): void {
  for (const [id, value] of Object.entries(next.added)) {
    const removed = target.removed[id];
    if (removed !== undefined) {
      delete target.removed[id];
      if (removed !== value) target.updated[id] = [removed, value];
    } else target.added[id] = value;
  }
  for (const [id, [from, to]] of Object.entries(next.updated)) {
    if (target.added[id] !== undefined) { target.added[id] = to; continue; }
    const existing = target.updated[id];
    if (existing !== undefined) { existing[1] = to; continue; }
    target.updated[id] = [from, to];
  }
  for (const [id, value] of Object.entries(next.removed)) {
    if (target.added[id] !== undefined) { delete target.added[id]; continue; }
    const upd = target.updated[id];
    if (upd !== undefined) { target.removed[id] = upd[0]; delete target.updated[id]; continue; }
    target.removed[id] = value;
  }
}

export function squashDiffs(diffs: RecordsDiff[]): RecordsDiff {
  const out = emptyDiff();
  for (const d of diffs) squashInto(out, d);
  return out;
}

const isEqual = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------------------
// The store.
// ---------------------------------------------------------------------------

export type ChangeSource = 'user' | 'remote';
export type StoreListener = (diff: RecordsDiff, source: ChangeSource) => void;

const NONE_SET: ReadonlySet<string> = new Set();

export class CanvasStore {
  private readonly atoms = new Map<string, Atom<CanvasRecord | undefined>>();
  private readonly ids = atom<ReadonlySet<string>>('store.ids', new Set());
  // Membership per record type and per screen: a camera move or one screen's edit invalidates only its own readers.
  private readonly byType = new Map<string, Atom<ReadonlySet<string>>>();
  private readonly byScene = new Map<string, Atom<ReadonlySet<string>>>();
  private readonly listeners = new Set<StoreListener>();
  private pending: RecordsDiff | null = null;
  private source: ChangeSource = 'user';
  private depth = 0;

  constructor() {
    this.put([
      { typeName: 'selection', id: 'selection', sel: null },
      { typeName: 'camera', id: 'camera', x: 0, y: 0, zoom: 1, fitLive: false },
      { typeName: 'hover', id: 'hover', node: null, element: null, cursor: null },
      { typeName: 'arrangement', id: 'arrangement', positions: {}, folds: [], seeded: [], seededComposites: [], hydrated: false },
      { typeName: 'mode', id: 'mode', picked: 'select', spaceHeld: false, armed: null },
      { typeName: 'editing', id: 'editing', tapped: null, text: null, previewState: 'default', breakpoint: null, pendingRun: null, sentence: null },
      { typeName: 'gesture', id: 'gesture', brush: null, ghost: null, guides: { x: null, y: null }, wire: null, landing: null, badge: null, cursor: null, createGhost: null, grabbing: false },
      { typeName: 'runs', id: 'runs', runs: [], states: [], outPorts: {}, replay: null },
      {
        typeName: 'panel', id: 'panel', inspector: null, inspectorNonce: 0, browser: null, browserNonce: 0, file: null, focusScene: null,
        descend: null, screenFocus: null, nodeProps: null, catalogAdd: null, armed: null, armedCode: null,
        hosts: { inspector: false, browser: false, file: false, focus: false, workspace: false },
      },
    ], 'remote');
  }

  // ---- the record doors ----------------------------------------------------

  get<T extends CanvasRecord = CanvasRecord>(id: string): T | undefined {
    return this.atoms.get(id)?.get() as T | undefined;
  }

  /** A read that captures nothing: the gestures read this way inside their own writes. */
  peek<T extends CanvasRecord = CanvasRecord>(id: string): T | undefined {
    const a = this.atoms.get(id);
    return a === undefined ? undefined : (unsafe__withoutCapture(() => a.get()) as T | undefined);
  }

  has(id: string): boolean {
    return this.ids.get().has(id);
  }

  allIds(): ReadonlySet<string> {
    return this.ids.get();
  }

  /** Every record of one type, capturing that type's set and its records alone; the derived views below ride this. */
  ofType<T extends CanvasRecord>(typeName: T['typeName']): T[] {
    return this.recordsOf<T>(this.indexAtom(this.byType, typeName).get());
  }

  private recordsOf<T extends CanvasRecord>(ids: ReadonlySet<string>): T[] {
    const out: T[] = [];
    for (const id of ids) {
      const r = this.atoms.get(id)?.get();
      if (r !== undefined) out.push(r as T);
    }
    return out;
  }

  put(records: CanvasRecord[], source?: ChangeSource): void {
    this.atomic(() => {
      const diff = emptyDiff();
      let changed = false;
      const joined: CanvasRecord[] = [];
      for (const r of records) {
        const existing = this.atoms.get(r.id);
        if (existing !== undefined) {
          const before = unsafe__withoutCapture(() => existing.get());
          if (before !== undefined) {
            if (isEqual(before, r)) continue;
            existing.set(r);
            diff.updated[r.id] = [before, r];
            changed = true;
            continue;
          }
          existing.set(r);
        } else {
          this.atoms.set(r.id, atom(`rec:${r.id}`, r as CanvasRecord | undefined));
        }
        joined.push(r);
        diff.added[r.id] = r;
        changed = true;
      }
      if (!changed) return;
      if (joined.length > 0) this.reindex(joined, []);
      this.record(diff);
    }, source);
  }

  remove(ids: string[], source?: ChangeSource): void {
    this.atomic(() => {
      const diff = emptyDiff();
      const left: CanvasRecord[] = [];
      for (const id of ids) {
        const a = this.atoms.get(id);
        if (a === undefined) continue;
        const before = unsafe__withoutCapture(() => a.get());
        if (before === undefined) continue;
        a.set(undefined);
        diff.removed[id] = before;
        left.push(before);
      }
      if (left.length === 0) return;
      this.reindex([], left);
      this.record(diff);
    }, source);
  }

  /** Membership moves: the whole set, the type sets and the screen sets change only when a record joins or leaves. */
  private reindex(joined: CanvasRecord[], left: CanvasRecord[]): void {
    const all = new Set(unsafe__withoutCapture(() => this.ids.get()));
    const touched = new Map<Atom<ReadonlySet<string>>, Set<string>>();
    const setOf = (index: Map<string, Atom<ReadonlySet<string>>>, key: string): Set<string> => {
      const a = this.indexAtom(index, key);
      let s2 = touched.get(a);
      if (s2 === undefined) { s2 = new Set(unsafe__withoutCapture(() => a.get())); touched.set(a, s2); }
      return s2;
    };
    for (const r of joined) {
      all.add(r.id);
      setOf(this.byType, r.typeName).add(r.id);
      if (r.typeName === 'element') setOf(this.byScene, r.scene).add(r.id);
    }
    for (const r of left) {
      all.delete(r.id);
      setOf(this.byType, r.typeName).delete(r.id);
      if (r.typeName === 'element') setOf(this.byScene, r.scene).delete(r.id);
    }
    this.ids.set(all);
    for (const [a, next] of touched) a.set(next);
  }

  private indexAtom(index: Map<string, Atom<ReadonlySet<string>>>, key: string): Atom<ReadonlySet<string>> {
    let a = index.get(key);
    if (a === undefined) { a = atom(`store.index:${key}`, NONE_SET); index.set(key, a); }
    return a;
  }

  /** Applies a diff whole: undo applies the reversed one, a remote merge the server's. */
  apply(diff: RecordsDiff, source?: ChangeSource): void {
    this.atomic(() => {
      const puts: CanvasRecord[] = [...Object.values(diff.added), ...Object.values(diff.updated).map(([, to]) => to)];
      if (puts.length > 0) this.put(puts);
      const gone = Object.keys(diff.removed);
      if (gone.length > 0) this.remove(gone);
    }, source);
  }

  /** Runs `fn` as one change: nested calls squash into the outer; listeners hear one diff at the end. */
  atomic<T>(fn: () => T, source?: ChangeSource): T {
    if (this.depth > 0) return transact(fn);
    this.depth = 1;
    const previousSource = this.source;
    if (source !== undefined) this.source = source;
    this.pending = emptyDiff();
    try {
      return transact(fn);
    } finally {
      const diff = this.pending;
      const src = this.source;
      this.pending = null;
      this.depth = 0;
      this.source = previousSource;
      if (diff !== null && !isDiffEmpty(diff)) for (const fn2 of this.listeners) fn2(diff, src);
    }
  }

  /** Runs `fn` and answers the diff it made (the history records it; a refused write reverses it). */
  extractingChanges(fn: () => void, source?: ChangeSource): RecordsDiff {
    const seen: RecordsDiff[] = [];
    const off = this.listen((d) => { seen.push(d); });
    try { this.atomic(fn, source); } finally { off(); }
    return squashDiffs(seen);
  }

  listen(fn: StoreListener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private record(diff: RecordsDiff): void {
    if (this.pending !== null) squashInto(this.pending, diff);
    else for (const fn of this.listeners) fn(diff, this.source);
  }

  update<T extends CanvasRecord>(id: string, fn: (r: T) => T, source?: ChangeSource): void {
    const cur = this.peek<T>(id);
    if (cur === undefined) return;
    this.put([fn(cur)], source);
  }

  // ---- the singletons ------------------------------------------------------

  get selection(): SelectionRecord { return this.get<SelectionRecord>('selection')!; }
  get camera(): CameraRecord { return this.get<CameraRecord>('camera')!; }
  get hover(): HoverRecord { return this.get<HoverRecord>('hover')!; }
  get arrangement(): ArrangementRecord { return this.get<ArrangementRecord>('arrangement')!; }
  get mode(): ModeRecord { return this.get<ModeRecord>('mode')!; }
  get editing(): EditingRecord { return this.get<EditingRecord>('editing')!; }
  get gesture(): GestureRecord { return this.get<GestureRecord>('gesture')!; }
  get panel(): PanelRecord { return this.get<PanelRecord>('panel')!; }
  get runs(): RunsRecord { return this.get<RunsRecord>('runs')!; }

  setSelection(sel: SelectionState): void {
    this.update<SelectionRecord>('selection', (r) => ({ ...r, sel }), 'remote');
  }
  selectCards(ids: Iterable<string>): void {
    const list = [...ids];
    this.setSelection(list.length > 0 ? { kind: 'cards', ids: list } : null);
  }
  selectElement(scene: string, screenId: string, elementId: string, extras: string[] = []): void {
    this.setSelection({ kind: 'element', scene, screenId, elementId, extras });
  }
  selectWire(address: WireAddress): void { this.setSelection({ kind: 'wire', address }); }
  clearSelection(): void { this.setSelection(null); }
  /** The selected cards as a set (empty when an element or a wire holds the selection). */
  selectedCardIds(): ReadonlySet<string> {
    const s = this.selection.sel;
    return s?.kind === 'cards' ? new Set(s.ids) : NONE_SET;
  }
  selectedElement(): { scene: string; screenId: string; elementId: string; extras: readonly string[] } | null {
    const s = this.selection.sel;
    return s?.kind === 'element' ? s : null;
  }
  selectedWire(): WireAddress | null {
    const s = this.selection.sel;
    return s?.kind === 'wire' ? s.address : null;
  }

  setCamera(cam: Camera, endFit = true): void {
    this.update<CameraRecord>('camera', (r) => ({ ...r, ...cam, fitLive: endFit ? false : r.fitLive }), 'remote');
  }
  setHover(patch: Partial<Omit<HoverRecord, 'typeName' | 'id'>>): void {
    this.update<HoverRecord>('hover', (r) => ({ ...r, ...patch }), 'remote');
  }
  setGesture(patch: Partial<Omit<GestureRecord, 'typeName' | 'id'>>): void {
    this.update<GestureRecord>('gesture', (r) => ({ ...r, ...patch }), 'remote');
  }
  setMode(patch: Partial<Omit<ModeRecord, 'typeName' | 'id'>>): void {
    this.update<ModeRecord>('mode', (r) => ({ ...r, ...patch }), 'remote');
  }
  setEditing(patch: Partial<Omit<EditingRecord, 'typeName' | 'id'>>): void {
    this.update<EditingRecord>('editing', (r) => ({ ...r, ...patch }), 'remote');
  }
  /** The effective mouse mode: Space held = hand, whatever the picked one. */
  effectiveMode(): CanvasMode {
    const m = this.mode;
    return m.spaceHeld ? 'hand' : m.picked;
  }

  // ---- the map: nodes, edges, screens ---------------------------------------

  readonly nodes: Computed<NodeRecord[]> = computed('store.nodes', () => this.ofType<NodeRecord>('node'));
  readonly edges: Computed<EdgeRecord[]> = computed('store.edges', () => this.ofType<EdgeRecord>('edge'));
  readonly screens: Computed<ScreenRecord[]> = computed('store.screens', () => this.ofType<ScreenRecord>('screen'));
  readonly nodeById: Computed<ReadonlyMap<string, NodeRecord>> = computed('store.nodeById', () => new Map(this.nodes.get().map((n) => [n.id, n])));
  readonly screenByNodeId: Computed<ReadonlyMap<string, ScreenRecord>> = computed('store.screenByNodeId', () => new Map(this.screens.get().map((s) => [s.nodeId, s])));
  readonly screenBySlug: Computed<ReadonlyMap<string, ScreenRecord>> = computed('store.screenBySlug', () => new Map(this.screens.get().map((s) => [s.slug, s])));

  node(id: string): NodeRecord | undefined { return this.nodeById.get().get(id); }
  screenOf(nodeId: string): ScreenRecord | undefined { return this.screenByNodeId.get().get(nodeId); }
  screenBySlugOf(slug: string): ScreenRecord | undefined { return this.screenBySlug.get().get(slug); }
  /** The scene slug for a `scene:<id>` node, never the tab slug. */
  sceneSlugOf(nodeId: string): string | null { return this.screenOf(nodeId)?.slug ?? null; }

  // ---- the documents: elements per screen ---------------------------------

  private readonly docCache = new Map<string, Computed<SceneDocument | null>>();
  private readonly elementsCache = new Map<string, Computed<ElementRecord[]>>();

  elementId(scene: string, nodeId: string): string { return `el:${scene}:${nodeId}`; }

  element(scene: string, nodeId: string): ElementRecord | undefined {
    return this.get<ElementRecord>(this.elementId(scene, nodeId));
  }

  /** Every element of one screen (captures the set and each record). */
  elementsOf(scene: string): ElementRecord[] {
    let c = this.elementsCache.get(scene);
    if (c === undefined) {
      c = computed(`store.elements:${scene}`, () => this.recordsOf<ElementRecord>(this.indexAtom(this.byScene, scene).get()));
      this.elementsCache.set(scene, c);
    }
    return c.get();
  }

  /** The screen's document composed from its element records; null until the read landed. */
  documentOf(scene: string): SceneDocument | null {
    let c = this.docCache.get(scene);
    if (c === undefined) {
      c = computed(`store.doc:${scene}`, () => {
        const els = this.elementsOf(scene);
        if (els.length === 0) return null;
        const nodes: Record<string, SceneNode> = {};
        for (const e of els) nodes[e.node.id] = e.node;
        const screen = this.screenBySlug.get().get(scene);
        return { schemaVersion: 1, revision: screen?.revision ?? 0, nodes };
      });
      this.docCache.set(scene, c);
    }
    return c.get();
  }

  /** Composed child ids of a parent in order (the document's own rail). */
  childrenOf(scene: string, parentId: string): string[] {
    return this.elementsOf(scene)
      .filter((e) => e.node.parent === parentId)
      .sort((a, b) => (a.node.order < b.node.order ? -1 : a.node.order > b.node.order ? 1 : 0))
      .map((e) => e.node.id);
  }

  /** Replaces a screen's elements with the server's document (a remote merge - the history never hears it). */
  landDocument(scene: string, doc: SceneDocument, revision: number): void {
    this.atomic(() => {
      const keep = new Set<string>();
      const puts: CanvasRecord[] = [];
      for (const node of Object.values(doc.nodes)) {
        const id = this.elementId(scene, node.id);
        keep.add(id);
        puts.push({ typeName: 'element', id, scene, node });
      }
      const gone = this.ofType<ElementRecord>('element').filter((e) => e.scene === scene && !keep.has(e.id)).map((e) => e.id);
      if (puts.length > 0) this.put(puts);
      if (gone.length > 0) this.remove(gone);
      const screen = this.screenBySlug.get().get(scene);
      if (screen !== undefined && (screen.revision !== revision || !screen.loaded)) this.put([{ ...screen, revision, loaded: true }]);
    }, 'remote');
  }

  // ---- the layout: positions, sizes, bounds ---------------------------------

  /** The card size per node: the tile, the folded app card, or the screen's design size at the view scale. */
  sizeOf(id: string): { w: number; h: number } {
    const screen = this.screenOf(id);
    if (screen !== undefined) {
      return { w: screen.size.w * SCREEN_VIEW_SCALE, h: Math.max(screen.size.h, screen.contentH ?? 0) * SCREEN_VIEW_SCALE };
    }
    const kind = this.node(id)?.kind ?? (id.startsWith('fold:') ? 'fold' : '');
    if (id.startsWith('fold:')) return { w: FOLD_W, h: LIVE_FRAME_H };
    return { w: kindWidth(kind), h: kindHeight(kind) };
  }

  /** The displayed nodes after the folds, with the edges re-aimed. */
  readonly folded: Computed<{ nodes: NodeRecord[]; edges: EdgeRecord[]; groups: FoldGroup[] }> = computed('store.folded', () => {
    const present = new Set(this.nodes.get().map((n) => n.id));
    const groups = pruneGroups(this.arrangement.folds, present);
    return { ...applyFolds(this.nodes.get(), this.edges.get(), groups), groups };
  });

  /** Every displayed card's position: the saved spot, else the cluster layout's default. */
  readonly layout: Computed<ReadonlyMap<string, Placed>> = computed('store.layout', () => {
    const { nodes, edges } = this.folded.get();
    const saved = this.arrangement.positions;
    const wired = new Set<string>();
    for (const e of edges) { wired.add(e.from); wired.add(e.to); }
    const clusters = computeClusters(nodes.filter((n) => wired.has(n.id)), edges);
    return computeLayout(nodes, clusters, saved, (id) => this.sizeOf(id));
  });

  readonly bounds: Computed<Rect> = computed('store.bounds', () => contentBounds(this.layout.get(), (id) => this.sizeOf(id)));

  positionOf(id: string): Placed | undefined { return this.layout.get().get(id); }
  rectOf(id: string): Rect | undefined {
    const p = this.positionOf(id);
    if (p === undefined) return undefined;
    const s = this.sizeOf(id);
    return { x: p.x, y: p.y, w: s.w, h: s.h };
  }

  /** The ids whose cards intersect a world rect. */
  nodesInRect(rect: Rect): string[] {
    const out: string[] = [];
    for (const [id, p] of this.layout.get()) {
      const s = this.sizeOf(id);
      if (p.x < rect.x + rect.w && p.x + s.w > rect.x && p.y < rect.y + rect.h && p.y + s.h > rect.y) out.push(id);
    }
    return out;
  }

  /** The smallest displayed card under a world point, with the point in its own units. */
  innermostAt(at: Placed, exclude?: string, only?: (id: string) => boolean): { id: string; rel: Placed } | null {
    let best: { id: string; rel: Placed; area: number } | null = null;
    for (const [id, q] of this.layout.get()) {
      if (id === exclude || (only !== undefined && !only(id))) continue;
      const s = this.sizeOf(id);
      if (at.x < q.x || at.x > q.x + s.w || at.y < q.y || at.y > q.y + s.h) continue;
      const area = s.w * s.h;
      if (best === null || area < best.area) best = { id, rel: { x: at.x - q.x, y: at.y - q.y }, area };
    }
    return best === null ? null : { id: best.id, rel: best.rel };
  }

  /** The innermost placed screen under a world point, with its origin. */
  screenAt(p: Placed): { screen: ScreenRecord; origin: Placed } | null {
    const hit = this.innermostAt(p, undefined, (id) => this.screenOf(id) !== undefined);
    if (hit === null) return null;
    const screen = this.screenOf(hit.id);
    const origin = this.positionOf(hit.id);
    return screen !== undefined && origin !== undefined ? { screen, origin } : null;
  }

  /** The free spot nearest `at` for a card of this node's size: rings outward until nothing on the canvas is within a gap. */
  freeSpotNear(id: string, at: Placed): Placed {
    const size = this.sizeOf(id);
    const gap = 32;
    const others: Rect[] = [];
    for (const [other, p] of this.layout.get()) if (other !== id) others.push({ x: p.x, y: p.y, ...this.sizeOf(other) });
    const clear = (p: Placed): boolean => !others.some((r) => p.x < r.x + r.w + gap && r.x < p.x + size.w + gap && p.y < r.y + r.h + gap && r.y < p.y + size.h + gap);
    if (clear(at)) return at;
    const step = 48;
    for (let ring = 1; ring < 60; ring++) {
      for (let i = -ring; i <= ring; i++) {
        for (const p of [{ x: at.x + i * step, y: at.y - ring * step }, { x: at.x + i * step, y: at.y + ring * step }, { x: at.x - ring * step, y: at.y + i * step }, { x: at.x + ring * step, y: at.y + i * step }]) {
          if (clear(p)) return p;
        }
      }
    }
    return at;
  }

  /** Writes positions into the arrangement (a user change the history records unless `source` says remote). */
  placeNodes(positions: Record<string, Placed>, source?: ChangeSource): void {
    this.update<ArrangementRecord>('arrangement', (a) => ({ ...a, positions: { ...a.positions, ...positions } }), source);
  }
  setFolds(folds: FoldGroup[], source?: ChangeSource): void {
    this.update<ArrangementRecord>('arrangement', (a) => ({ ...a, folds }), source);
  }

  // ---- the editing frame -----------------------------------------------------

  /** The focused screen: the sole selected screen, else the element selection's screen, else the tapped one. */
  readonly focused: Computed<ScreenRecord | null> = computed('store.focused', () => {
    const sel = this.selection.sel;
    if (sel?.kind === 'cards' && sel.ids.length === 1) return this.screenOf(sel.ids[0]!) ?? null;
    if (sel?.kind === 'element') return this.screenOf(sel.screenId) ?? null;
    const tapped = this.editing.tapped;
    return tapped !== null ? this.screenOf(tapped) ?? null : null;
  });

  // ---- the panels (the bus's records) ---------------------------------------

  private bumpPanel(fn: (p: PanelRecord) => PanelRecord): void {
    this.update<PanelRecord>('panel', fn, 'remote');
  }
  setPanelHosts(hosts: Partial<PanelRecord['hosts']>): void {
    this.bumpPanel((p) => ({ ...p, hosts: { ...p.hosts, ...hosts } }));
  }
  /** Opens the inspector on a subject; false = no inspector panel is mounted to answer. */
  openInspector(subject: InspectorSubject): boolean {
    if (!('wire' in subject)) this.armSelection(subject);
    if (!this.panel.hosts.inspector) return false;
    this.bumpPanel((p) => ({ ...p, inspector: subject, inspectorNonce: p.inspectorNonce + 1 }));
    return true;
  }
  /** Re-aims an open inspector without opening one. */
  retargetInspector(subject: InspectorSubject): void {
    if (!('wire' in subject)) this.armSelection(subject);
    if (this.panel.inspector === null) return;
    this.bumpPanel((p) => ({ ...p, inspector: subject }));
  }
  closeInspector(): void { this.bumpPanel((p) => ({ ...p, inspector: null })); }
  openBrowser(context: NodeBrowseContext): boolean {
    if (!this.panel.hosts.browser) return false;
    this.bumpPanel((p) => ({ ...p, browser: context, browserNonce: p.browserNonce + 1 }));
    return true;
  }
  closeBrowser(): void { this.bumpPanel((p) => ({ ...p, browser: null })); }
  openFile(path: string): boolean {
    if (!this.panel.hosts.file) return false;
    this.bumpPanel((p) => ({ ...p, file: { path, nonce: (p.file?.nonce ?? 0) + 1 } }));
    return true;
  }
  /** Play: the app opens full screen (the focus surface answers). */
  openFocusedScene(slug: string): boolean {
    if (!this.panel.hosts.focus) return false;
    this.bumpPanel((p) => ({ ...p, focusScene: { slug, nonce: (p.focusScene?.nonce ?? 0) + 1 } }));
    return true;
  }
  requestDescend(target: WorkshopDescend): boolean {
    if (!this.panel.hosts.workspace) return false;
    this.bumpPanel((p) => ({ ...p, descend: { target, nonce: (p.descend?.nonce ?? 0) + 1 } }));
    return true;
  }
  requestNodeProps(nodeId: string): boolean {
    if (!this.panel.hosts.workspace) return false;
    this.bumpPanel((p) => ({ ...p, nodeProps: { nodeId, nonce: (p.nodeProps?.nonce ?? 0) + 1 } }));
    return true;
  }
  requestScreenFocus(sceneId: string): boolean {
    if (!this.panel.hosts.workspace) return false;
    this.bumpPanel((p) => ({ ...p, screenFocus: { sceneId, nonce: (p.screenFocus?.nonce ?? 0) + 1 } }));
    return true;
  }
  requestCatalogAdd(add: CatalogAdd): boolean {
    if (!this.panel.hosts.workspace) return false;
    this.bumpPanel((p) => ({ ...p, catalogAdd: { add, nonce: (p.catalogAdd?.nonce ?? 0) + 1 } }));
    return true;
  }
  armSelection(sel: InspectorSelection | null): void { this.bumpPanel((p) => ({ ...p, armed: sel })); }
  armCodeSelection(sel: CodeSelection | null): void { this.bumpPanel((p) => ({ ...p, armedCode: sel })); }

  // ---- the sources: the graph, the tabs, the arrangement, the documents - by the push ----

  private mounted: { orgId: string; projectId: string; off: () => void; stopSentence: () => void } | null = null;
  private gone = new Map<string, number>();
  private born = new Map<string, number>();
  private timers: Record<string, number | undefined> = {};
  private arrangementDirty = false;
  private catalogAtom = atom<SceneCatalogEntry[]>('store.catalog', []);
  private projectsAtom = atom<Array<{ id: string; name: string; kind: 'app' | 'website' }>>('store.projects', []);
  private canvasDocAtom = atom<{ sceneId: string; slug: string } | null>('store.canvasDoc', null);

  readonly catalog: Computed<SceneCatalogEntry[]> = computed('store.catalog.view', () => this.catalogAtom.get());
  readonly libraryItems: Computed<LibraryItem[]> = computed('store.library', () => this.catalogAtom.get().flatMap((e) => (e.kind === 'item' ? [e.item] : [])));
  readonly projects: Computed<Array<{ id: string; name: string; kind: 'app' | 'website' }>> = computed('store.projects.view', () => this.projectsAtom.get());
  readonly canvasDoc: Computed<{ sceneId: string; slug: string } | null> = computed('store.canvasDoc.view', () => this.canvasDocAtom.get());

  get orgId(): string | null { return this.mounted?.orgId ?? null; }
  get projectId(): string | null { return this.mounted?.projectId ?? null; }

  /** Mounts the focused project: reads once, then re-reads on the live channel's pointers alone. */
  mount(orgId: string, projectId: string): () => void {
    this.unmount();
    const off = subscribeLive((event) => this.onLive(event, orgId, projectId));
    // The sentence under a sole-selected card re-reads when the selection or its wires change.
    const stopSentence = react('store.sentence', () => {
      const sel = this.selection.sel;
      const id = sel?.kind === 'cards' && sel.ids.length === 1 ? sel.ids[0]! : null;
      const edge = id === null ? undefined : this.edges.get().find((e) => e.action !== undefined && typeof e.rule === 'number' && (e.from === id || e.to === id) && e.from.startsWith('scene:'));
      unsafe__withoutCapture(() => void this.readSentence(edge));
    });
    this.mounted = { orgId, projectId, off, stopSentence };
    this.setCamera({ x: 0, y: 0, zoom: 1 }, false);
    this.update<CameraRecord>('camera', (c) => ({ ...c, fitLive: true }), 'remote');
    void this.readArrangement();
    void this.readGraph();
    void this.readTabs();
    void this.readCatalog();
    void this.readProjects();
    void this.readCanvasDoc();
    void this.readRuns();
    return () => this.unmount();
  }

  unmount(): void {
    const m = this.mounted;
    if (m === null) return;
    this.flushArrangement();
    m.off();
    m.stopSentence();
    for (const t of Object.values(this.timers)) window.clearTimeout(t);
    this.timers = {};
    this.mounted = null;
    this.atomic(() => {
      this.remove([...this.allIds()].filter((id) => {
        const r = this.peek(id);
        return r !== undefined && (r.typeName === 'node' || r.typeName === 'edge' || r.typeName === 'screen' || r.typeName === 'element');
      }));
      this.put([
        { typeName: 'arrangement', id: 'arrangement', positions: {}, folds: [], seeded: [], seededComposites: [], hydrated: false },
        { typeName: 'runs', id: 'runs', runs: [], states: [], outPorts: {}, replay: null },
      ]);
      this.setSelection(null);
      this.setEditing({ sentence: null });
      // What rides the next message belongs to the project it was picked in.
      this.armSelection(null);
      this.armCodeSelection(null);
    }, 'remote');
    this.canvasDocAtom.set(null);
  }

  private onLive(event: LiveEvent, orgId: string, projectId: string): void {
    if ('kind' in event) return;
    if (event.orgId !== null && event.orgId !== orgId) return;
    if (this.mounted === null || this.mounted.projectId !== projectId) return;
    const t = event.table;
    if (GRAPH_TABLES.has(t)) this.debounce('graph', 150, () => void this.readGraph());
    if (t === 'flow_executions' || t === 'flows') this.debounce('runs', 200, () => void this.readRuns());
    if (t === 'tabs' || t === 'scenes') this.debounce('tabs', 150, () => void this.readTabs());
    if (t === 'scenes' || t === 'scene_revisions') this.debounce('docs', 200, () => void this.readDocs());
    if (t === 'component_definitions') this.debounce('catalog', 300, () => void this.readCatalog());
    if (t === 'projects') this.debounce('projects', 300, () => void this.readProjects());
    // A layout written elsewhere (the AI's canvas block) shows at once; a gesture still settling keeps its own.
    if (t === 'workspace_arrangements' && event.id === projectId && !this.arrangementDirty) {
      this.debounce('arrangement-read', 200, () => { if (!this.arrangementDirty) void this.readArrangement(); });
    }
  }

  private debounce(key: string, ms: number, fn: () => void): void {
    window.clearTimeout(this.timers[key]);
    this.timers[key] = window.setTimeout(fn, ms);
  }

  /** The graph read merges as remote truth; a citizen the hand marked gone stays gone for a beat, a born one stays until the read carries it. */
  async readGraph(): Promise<void> {
    const m = this.mounted;
    if (m === null) return;
    const g = await desk.automationGraph(m.orgId, m.projectId).catch(() => null);
    if (g === null || this.mounted !== m) return;
    const now = Date.now();
    for (const [id, at] of this.gone) if (now - at > GONE_TTL_MS) this.gone.delete(id);
    const serverIds = new Set(g.nodes.map((n) => n.id));
    for (const id of [...this.born.keys()]) if (serverIds.has(id)) this.born.delete(id);
    this.atomic(() => {
      const puts: CanvasRecord[] = [];
      const keepNodes = new Set<string>();
      for (const n of g.nodes) {
        if (this.gone.has(n.id)) continue;
        keepNodes.add(n.id);
        puts.push({
          typeName: 'node', id: n.id, kind: n.kind, label: n.label, ...(n.word !== undefined ? { word: n.word } : {}),
          detail: n.detail, lastActivityAt: n.lastActivityAt, projectId: n.projectId,
          ...(n.face !== undefined ? { face: n.face } : {}), ...(n.service !== undefined ? { service: n.service } : {}),
          ...(n.sockets !== undefined ? { sockets: n.sockets } : {}), ...(n.grow !== undefined ? { grow: n.grow } : {}),
        });
      }
      const keepEdges = new Set<string>();
      for (const e of g.edges) {
        if (this.gone.has(e.from) || this.gone.has(e.to)) continue;
        const id = edgeIdOf(e);
        if (this.gone.has(id)) continue;
        keepEdges.add(id);
        puts.push({ typeName: 'edge', id, ...e });
      }
      const gone: string[] = [];
      for (const n of this.ofType<NodeRecord>('node')) if (!keepNodes.has(n.id) && !this.born.has(n.id)) gone.push(n.id);
      for (const e of this.ofType<EdgeRecord>('edge')) if (!keepEdges.has(e.id) && !this.born.has(e.id)) gone.push(e.id);
      if (puts.length > 0) this.put(puts);
      if (gone.length > 0) this.remove(gone);
    }, 'remote');
    this.seedFolds();
    this.adoptPositions();
  }

  async readTabs(): Promise<void> {
    const m = this.mounted;
    if (m === null) return;
    const tabs = await desk.listTabs(m.orgId).catch(() => null);
    if (tabs === null || this.mounted !== m) return;
    const rows = tabs.filter((t) => t.projectId === m.projectId && t.sceneId !== null && t.sceneSlug !== null);
    const project = this.projectsAtom.get().find((p) => p.id === m.projectId);
    const fallback = defaultSceneSize(project?.kind ?? null);
    const keep = new Set<string>();
    const puts: CanvasRecord[] = [];
    for (const t of rows) {
      const id = `screen:${t.sceneId}`;
      keep.add(id);
      const existing = this.peek<ScreenRecord>(id);
      puts.push(existing !== undefined
        ? { ...existing, title: t.title, slug: t.sceneSlug! }
        : { typeName: 'screen', id, sceneId: t.sceneId!, nodeId: `scene:${t.sceneId}`, slug: t.sceneSlug!, title: t.title, size: fallback, contentH: null, revision: 0, loaded: false });
    }
    const gone = this.ofType<ScreenRecord>('screen').filter((s) => !keep.has(s.id));
    this.atomic(() => {
      if (puts.length > 0) this.put(puts);
      if (gone.length > 0) {
        this.remove(gone.map((s) => s.id));
        this.remove(this.ofType<ElementRecord>('element').filter((e) => gone.some((s) => s.slug === e.scene)).map((e) => e.id));
      }
    }, 'remote');
    await this.readDocs();
  }

  /** Every screen's raw document and design size - one read per screen, on the pointer alone. */
  async readDocs(): Promise<void> {
    const m = this.mounted;
    if (m === null) return;
    const screens = this.ofType<ScreenRecord>('screen');
    const canvas = this.canvasDocAtom.get();
    const slugs = [...screens.map((s) => s.slug), ...(canvas !== null ? [canvas.slug] : [])];
    await Promise.all(slugs.map(async (slug) => {
      const read = await desk.sceneEdit(m.orgId, slug).catch(() => null);
      if (read === null || this.mounted !== m) return;
      const parsed = sceneDocumentSchema.safeParse(read.document);
      if (!parsed.success) return;
      this.atomic(() => {
        const screen = this.screenBySlug.get().get(slug);
        if (screen !== undefined && read.targetScreen !== null && (screen.size.w !== read.targetScreen.w || screen.size.h !== read.targetScreen.h)) {
          this.put([{ ...screen, size: read.targetScreen }]);
        }
        this.landDocument(slug, parsed.data, read.scene.headRevision);
      }, 'remote');
    }));
  }

  async readCatalog(): Promise<void> {
    const m = this.mounted;
    if (m === null) return;
    const rows = await desk.sceneCatalog(m.orgId, m.projectId).catch(() => null);
    if (rows !== null && this.mounted === m) this.catalogAtom.set(rows);
  }

  async readProjects(): Promise<void> {
    const m = this.mounted;
    if (m === null) return;
    const rows = await desk.listProjects(m.orgId).catch(() => null);
    if (rows !== null && this.mounted === m) this.projectsAtom.set(rows.map((p) => ({ id: p.id, name: p.name, kind: p.kind ?? 'app' })));
  }

  /** The canvas document: the project's tabless scene for loose elements (get-or-create through the one door). */
  async readCanvasDoc(): Promise<void> {
    const m = this.mounted;
    if (m === null) return;
    const r = await desk.humanProjectCanvas(m.orgId, m.projectId).catch(() => null);
    if (r === null || !r.ok || r.data === undefined || this.mounted !== m) return;
    this.canvasDocAtom.set(r.data);
    await this.readDocs();
  }

  async readArrangement(): Promise<void> {
    const m = this.mounted;
    if (m === null) return;
    const doc = await desk.projectArrangement(m.orgId, m.projectId).catch(() => null);
    if (this.mounted !== m) return;
    const raw = (doc ?? {}) as Record<string, unknown>;
    const positions = typeof raw['positions'] === 'object' && raw['positions'] !== null ? raw['positions'] as Record<string, Placed> : {};
    const folds = Array.isArray(raw['folds']) ? (raw['folds'] as unknown[]).filter(isFoldGroup) : [];
    const seeded = Array.isArray(raw['folds:auto']) ? (raw['folds:auto'] as unknown[]).filter((x): x is string => typeof x === 'string') : [];
    const seededComposites = Array.isArray(raw['folds:auto-composite']) ? (raw['folds:auto-composite'] as unknown[]).filter((x): x is string => typeof x === 'string') : [];
    this.put([{ typeName: 'arrangement', id: 'arrangement', positions, folds, seeded, seededComposites, hydrated: true }], 'remote');
    this.seedFolds();
    this.adoptPositions();
  }

  /** The arrangement persists one debounced whole-doc write per settled gesture; undo writes again. */
  scheduleArrangementWrite(): void {
    this.arrangementDirty = true;
    this.debounce('arrangement', 400, () => this.flushArrangement());
  }

  flushArrangement(): void {
    const m = this.mounted;
    window.clearTimeout(this.timers['arrangement']);
    if (!this.arrangementDirty || m === null) return;
    this.arrangementDirty = false;
    const a = this.peek<ArrangementRecord>('arrangement')!;
    void desk.humanSetArrangement(m.orgId, m.projectId, {
      positions: a.positions, folds: a.folds, 'folds:auto': a.seeded, 'folds:auto-composite': a.seededComposites,
    }).catch(() => undefined);
  }

  // ---- the hand's echoes: born citizens and gone ones ride the next read ------

  /** A door's OK answer seeds the born citizen and its edges now; the graph read reconciles. */
  bornNode(node: Omit<NodeRecord, 'typeName'>, edges: Array<Omit<EdgeRecord, 'typeName' | 'id'>> = []): void {
    const now = Date.now();
    this.born.set(node.id, now);
    const puts: CanvasRecord[] = [{ typeName: 'node', ...node }];
    for (const e of edges) { const id = edgeIdOf(e); this.born.set(id, now); puts.push({ typeName: 'edge', id, ...e }); }
    this.put(puts, 'remote');
  }
  /** A landed declaration's edge renders now; the closure reverts it (the refused-write lane). */
  bornEdge(e: Omit<EdgeRecord, 'typeName' | 'id'>): () => void {
    const id = edgeIdOf(e);
    this.born.set(id, Date.now());
    this.put([{ typeName: 'edge', id, ...e }], 'remote');
    return () => { this.born.delete(id); this.remove([id], 'remote'); };
  }
  /** Citizens (or edges) leave at the keypress; the read confirms within the TTL. */
  markGone(ids: string[]): void {
    const now = Date.now();
    for (const id of ids) this.gone.set(id, now);
    const edges = this.ofType<EdgeRecord>('edge').filter((e) => ids.includes(e.from) || ids.includes(e.to)).map((e) => e.id);
    this.remove([...ids, ...edges], 'remote');
  }

  // ---- the runs: the last run per flow, the step states, the out ports - by the push; the replay on the tick ----

  /** One read of the three flow records; the live channel's flow pointers re-read, never a timer. */
  async readRuns(): Promise<void> {
    const m = this.mounted;
    if (m === null) return;
    const read = await Promise.all([desk.flowsLastRun(m.orgId, m.projectId), desk.flowsList(m.orgId, m.projectId), desk.flowStepCatalog()]).catch(() => null);
    if (read === null || this.mounted !== m) return;
    const [runs, flows, catalog] = read;
    this.update<RunsRecord>('runs', (r) => ({ ...r, runs, states: stepStatesOf(flows), outPorts: stepOutPortsOf(flows, catalog) }), 'remote');
  }

  /** fstep node id -> its one badge, the cascade applied (error > pinned > dirty > ok). */
  readonly badges: Computed<ReadonlyMap<string, RunBadge>> = computed('store.badges', () => {
    const r = this.runs;
    return runBadgesFor(r.runs, r.states);
  });

  /** The replay's pulse: the reached step and the wire it arrived on. */
  readonly replayActive: Computed<{ node: string; prev: string | null } | null> = computed('store.replay', () => {
    const p = this.runs.replay;
    if (p === null) return null;
    return { node: p.seq[p.i]!, prev: p.i > 0 ? p.seq[p.i - 1]! : null };
  });

  outPortsFor(nodeId: string): string[] | null { return this.runs.outPorts[nodeId] ?? null; }
  countWordFor(edge: { from: string; port?: string }): string | undefined { return edgeCountWordFor(this.runs.runs, edge); }

  /** The grown face's last-run word ("3 items · 21:04"), or nothing. */
  lastRunWordFor(nodeId: string): string | undefined {
    if (!nodeId.startsWith('fstep:')) return undefined;
    const [, flowId, stepId] = nodeId.split(':');
    const run = this.runs.runs.find((r) => r.flowId === flowId);
    const ports = stepId !== undefined ? run?.stepCounts[stepId] : undefined;
    if (run === undefined || ports === undefined) return undefined;
    const n = outCountOf(ports);
    return `${n === 1 ? '1 item' : `${n} items`} · ${run.createdAt.slice(11, 16)}`;
  }

  /** A run badge's click walks the last run's real path in order, one step per REPLAY_STEP_MS on the tick; user-invoked, never ambient. */
  startReplay(nodeId: string): void {
    const [, flowId] = nodeId.split(':');
    const run = this.runs.runs.find((r) => r.flowId === flowId);
    if (run === undefined || run.ran.length === 0) return;
    const seq = run.ran.map((s) => `fstep:${flowId}:${s}`);
    this.update<RunsRecord>('runs', (r) => ({ ...r, replay: { seq, i: 0, elapsed: 0, settling: false } }), 'remote');
  }

  cancelReplay(): void {
    if (this.runs.replay !== null) this.update<RunsRecord>('runs', (r) => ({ ...r, replay: null }), 'remote');
  }

  /** The ticker's beat: the replay advances here; the pulse rests on the last step one beat, then the canvas returns to rest. */
  tick(elapsed: number): void {
    const p = this.runs.replay;
    if (p === null) return;
    const total = p.elapsed + elapsed;
    if (p.settling) {
      if (total >= REPLAY_SETTLE_MS) this.update<RunsRecord>('runs', (r) => ({ ...r, replay: null }), 'remote');
      else this.update<RunsRecord>('runs', (r) => ({ ...r, replay: { ...p, elapsed: total } }), 'remote');
      return;
    }
    if (total < REPLAY_STEP_MS) { this.update<RunsRecord>('runs', (r) => ({ ...r, replay: { ...p, elapsed: total } }), 'remote'); return; }
    const next = p.i + 1;
    if (next >= p.seq.length) this.update<RunsRecord>('runs', (r) => ({ ...r, replay: { ...p, elapsed: 0, settling: true } }), 'remote');
    else this.update<RunsRecord>('runs', (r) => ({ ...r, replay: { ...p, i: next, elapsed: 0 } }), 'remote');
  }

  /** The sentence under a sole-selected card: its action wire's rule spoken plain (the F6 word maps are the source). */
  private async readSentence(edge: EdgeRecord | undefined): Promise<void> {
    const m = this.mounted;
    if (m === null || edge === undefined) { this.setEditing({ sentence: null }); return; }
    const slug = this.sceneSlugOf(edge.from);
    if (slug === null) { this.setEditing({ sentence: null }); return; }
    const key = edgeIdOf(edge);
    const actions = await desk.sceneActions(m.orgId, slug).catch(() => []);
    if (this.mounted !== m) return;
    const still = this.selection.sel;
    if (still?.kind !== 'cards' || still.ids.length !== 1 || (still.ids[0] !== edge.from && still.ids[0] !== edge.to)) return;
    const doc = actions.find((a) => a.name === edge.action);
    const write = doc?.writes[edge.rule!];
    const sentence = doc !== undefined && write !== undefined ? ruleSentence(write, doc.params, undefined) : null;
    void key;
    this.setEditing({ sentence });
  }

  // ---- the auto-folds: resting piles by kind and a connection's inside tables fold once, never re-fought ----

  /** First sight adopts the cluster default as the card's SAVED spot (user-ruled: the map never reflows
   * after). Runs after hydration only, so loaded positions are never overwritten; the cluster layout
   * thereafter computes only for cards it has never seen. */
  private adoptPositions(): void {
    const a = this.arrangement;
    if (!a.hydrated) return;
    const missing: Record<string, Placed> = {};
    for (const [id, p] of this.layout.get()) if (a.positions[id] === undefined) missing[id] = { x: Math.round(p.x), y: Math.round(p.y) };
    if (Object.keys(missing).length === 0) return;
    this.update<ArrangementRecord>('arrangement', (r) => ({ ...r, positions: { ...r.positions, ...missing } }), 'remote');
    this.scheduleArrangementWrite();
  }

  private seedFolds(): void {
    const m = this.mounted;
    const a = this.peek<ArrangementRecord>('arrangement');
    if (m === null || a === undefined || !a.hydrated) return;
    const nodes = this.nodes.get();
    const edges = this.edges.get();
    if (nodes.length === 0) return;
    const wired = new Set<string>();
    for (const e of edges) { wired.add(e.from); wired.add(e.to); }
    const pile = nodes.filter((n) => !n.id.startsWith('fold:') && (!wired.has(n.id) || n.kind === 'scene' || n.kind === 'website'));
    const byKind = new Map<string, NodeRecord[]>();
    for (const n of pile) byKind.set(n.kind, [...(byKind.get(n.kind) ?? []), n]);
    const folds = [...a.folds];
    const seeded = [...a.seeded];
    const seededComposites = [...a.seededComposites];
    const inGroup = new Set(folds.flatMap((g) => g.members));
    let wrote = false;
    for (const [kind, group] of byKind) {
      if (seeded.includes(kind)) continue;
      const free = group.filter((n) => !inGroup.has(n.id));
      if (free.length < seedFoldMin(kind)) continue;
      const g = mintGroup(free);
      folds.push(g);
      for (const id of g.members) inGroup.add(id);
      seeded.push(kind);
      wrote = true;
    }
    // A Connection and its born inside Tables rest as one card wearing the connection's name.
    for (const n of nodes) {
      if (!n.id.startsWith('intg:') || seededComposites.includes(n.id)) continue;
      const members = [n.id, ...edges.filter((e) => e.from === n.id && e.verb === 'updates' && e.to.startsWith('ds:')).map((e) => e.to)];
      if (members.length < 2) continue;
      // A member already grouped elsewhere = the user arranged it; never re-fight.
      if (!members.some((id) => inGroup.has(id))) {
        folds.push({ id: `fold:${Math.random().toString(36).slice(2, 8)}`, kind: 'integration', label: n.label, members, open: false });
        for (const id of members) inGroup.add(id);
      }
      seededComposites.push(n.id);
      wrote = true;
    }
    if (!wrote) return;
    this.put([{ ...a, folds, seeded, seededComposites }], 'remote');
    this.scheduleArrangementWrite();
  }
}

const REPLAY_STEP_MS = 350;
const REPLAY_SETTLE_MS = 900;

// ---------------------------------------------------------------------------
// Geometry: the tile, the fold card, the screen scale, the cluster layout, the bounds.
// ---------------------------------------------------------------------------

export const NODE_W = 112;
export const NODE_H = 112;
export const FOLD_W = 196;
export const LIVE_FRAME_H = 140;
export const ACTIVE_MS = 20_000;
/** Screens render miniature on the canvas: page units x this = world units. */
export const SCREEN_VIEW_SCALE = 0.375;
export const ZOOM_FAR = 0.5;
export const ZOOM_CLOSE = 1.6;
export type ZoomRegime = 'far' | 'rest' | 'close';
/** The canvas viewport in screen px, kept by the engine's resize watch; what is "on screen" reads it. */
export const canvasView = atom<{ w: number; h: number }>('canvas.view', { w: 0, h: 0 });

export function zoomRegimeOf(zoom: number): ZoomRegime {
  return zoom < ZOOM_FAR ? 'far' : zoom > ZOOM_CLOSE ? 'close' : 'rest';
}

const GONE_TTL_MS = 12_000;
const GRAPH_TABLES: ReadonlySet<string> = new Set([
  'datasets', 'dataset_rows', 'operations', 'derived_outputs', 'scenes', 'triggers', 'reactive_chains', 'agent_versions',
  'integration_connections', 'flows', 'flow_executions', 'tabs', 'runs', 'jobs', 'operation_executions',
]);

export function kindHeight(kind: string): number {
  return (NODE_CONTRACTS as Record<string, { face: string }>)[kind]?.face === 'live-frame' ? LIVE_FRAME_H : NODE_H;
}
export function kindWidth(kind: string): number {
  return (NODE_CONTRACTS as Record<string, { face: string }>)[kind]?.face === 'live-frame' ? FOLD_W : NODE_W;
}

export const defaultSceneSize = (kind: string | null | undefined): { w: number; h: number } =>
  (kind === 'website' ? { w: 1920, h: 1080 } : { w: 1440, h: 900 });

export function isActiveAt(lastActivityAt: string | null, now: number): boolean {
  return lastActivityAt !== null && now - new Date(lastActivityAt).getTime() < ACTIVE_MS;
}

export const edgeIdOf = (e: { from: string; to: string; verb: string; action?: string; rule?: number; param?: string; port?: string; slot?: string }): string =>
  `edge:${e.from}>${e.to}>${e.verb}${e.action !== undefined ? `>${e.action}#${e.rule}` : ''}${e.param !== undefined ? `>${e.param}` : ''}${e.port !== undefined ? `>${e.port}@${e.slot}` : ''}`;

export const wireAddressOf = (e: Pick<EdgeRecord, 'from' | 'to' | 'action' | 'rule' | 'param' | 'port' | 'slot'>): WireAddress => ({
  from: e.from, to: e.to,
  ...(e.action !== undefined ? { action: e.action } : {}),
  ...(e.rule !== undefined ? { rule: e.rule } : {}),
  ...(e.param !== undefined ? { param: e.param } : {}),
  ...(e.port !== undefined ? { port: e.port } : {}),
  ...(e.slot !== undefined ? { slot: e.slot } : {}),
});

export const sameWire = (a: WireAddress, b: WireAddress): boolean =>
  a.from === b.from && a.to === b.to && a.action === b.action && a.rule === b.rule
  && a.param === b.param && a.port === b.port && a.slot === b.slot;

const KIND_COL: Record<string, number> = { role: 0, trigger: 0, chain: 0, notes: 0, dataset: 1, operation: 2, output: 3, scene: 4 };

interface ClusterLite { title: string; memberIds: string[] }

/** Union-find over edges and shared projects: layout grouping alone, never membership. */
export function computeClusters(nodes: NodeRecord[], edges: Array<{ from: string; to: string }>): ClusterLite[] {
  const parent = new Map<string, string>();
  const find = (a: string): string => {
    let r = a;
    while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r)!;
    parent.set(a, r);
    return r;
  };
  for (const n of nodes) parent.set(n.id, n.id);
  for (const e of edges) { const ra = find(e.from); const rb = find(e.to); if (ra !== rb) parent.set(ra, rb); }
  const projectRoot = new Map<string, string>();
  for (const n of nodes) {
    const pid = n.projectId;
    if (pid === null) continue;
    const anchor = projectRoot.get(pid);
    if (anchor === undefined) { projectRoot.set(pid, n.id); continue; }
    const ra = find(anchor); const rb = find(n.id);
    if (ra !== rb) parent.set(ra, rb);
  }
  const groups = new Map<string, NodeRecord[]>();
  for (const n of nodes) { const r = find(n.id); groups.set(r, [...(groups.get(r) ?? []), n]); }
  return [...groups.values()].sort((a, b) => b.length - a.length).map((cluster) => {
    const anchor = cluster.find((n) => n.kind === 'scene') ?? cluster.find((n) => n.kind === 'operation') ?? cluster.find((n) => n.kind !== 'notes') ?? cluster[0]!;
    return { title: anchor.label, memberIds: cluster.map((n) => n.id) };
  });
}

/** Cluster placement for unplaced cards: a saved spot always wins; defaults dodge the placed rects and rest on a shelf. */
export function computeLayout(
  nodes: Array<{ id: string; kind: string }>, clusters: ClusterLite[], saved: Record<string, Placed>,
  sizeFor: (id: string, kind: string) => { w: number; h: number },
): Map<string, Placed> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const pos = new Map<string, Placed>();
  const taken: Rect[] = [];
  for (const n of nodes) { const s = saved[n.id]; if (s !== undefined) taken.push({ x: s.x, y: s.y, ...sizeFor(n.id, n.kind) }); }
  const settle = (cand: Placed, size: { w: number; h: number }): Placed => {
    let p = { ...cand };
    let guard = 200;
    while (guard-- > 0) {
      const hit = taken.find((t) => p.x < t.x + t.w + 12 && t.x < p.x + size.w + 12 && p.y < t.y + t.h + 12 && t.y < p.y + size.h + 12);
      if (hit === undefined) break;
      p = { x: p.x, y: hit.y + hit.h + 24 };
    }
    taken.push({ x: p.x, y: p.y, ...size });
    return p;
  };
  let yBase = 48;
  for (const cluster of clusters) {
    const cursors = [0, 0, 0, 0, 0];
    for (const id of cluster.memberIds) {
      const n = byId.get(id);
      if (!n) continue;
      if (saved[n.id]) { pos.set(n.id, saved[n.id]!); continue; }
      const col = KIND_COL[n.kind] ?? 2;
      const size = sizeFor(n.id, n.kind);
      pos.set(n.id, settle({ x: 28 + col * (NODE_W + 54), y: yBase + cursors[col]! }, size));
      cursors[col] = cursors[col]! + size.h + 12;
    }
    yBase += Math.max(NODE_H + 12, ...cursors) + 74;
  }
  for (const n of nodes) if (saved[n.id]) pos.set(n.id, saved[n.id]!);
  let shelfX = 28;
  for (const n of nodes) {
    if (pos.has(n.id)) continue;
    const size = sizeFor(n.id, n.kind);
    pos.set(n.id, settle({ x: shelfX, y: yBase }, size));
    shelfX += size.w + 24;
  }
  return pos;
}

export function contentBounds(pos: ReadonlyMap<string, Placed>, sizeFor: (id: string) => { w: number; h: number }): Rect {
  if (pos.size === 0) return { x: 0, y: 0, w: 120, h: 120 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [id, p] of pos) {
    const s = sizeFor(id);
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x + s.w); maxY = Math.max(maxY, p.y + s.h);
  }
  return { x: minX - 60, y: minY - 60, w: maxX - minX + 120, h: maxY - minY + 120 };
}

export function marqueeRect(anchor: Placed, current: Placed): Rect {
  return { x: Math.min(anchor.x, current.x), y: Math.min(anchor.y, current.y), w: Math.abs(current.x - anchor.x), h: Math.abs(current.y - anchor.y) };
}

export function toggleSelection(selected: ReadonlySet<string>, id: string, additive: boolean): Set<string> {
  if (!additive) return new Set([id]);
  const next = new Set(selected);
  if (next.has(id)) next.delete(id); else next.add(id);
  return next;
}

// ---------------------------------------------------------------------------
// The camera: unbounded pan, cursor-anchored zoom, the fit trio, the world-locked grid.
// ---------------------------------------------------------------------------

export const ZOOM_MIN = 0.05;
export const ZOOM_MAX = 4;
export const ZOOM_STEP = 1.12;
export const GRID = 18;

export function gridSpacing(zoom: number): number {
  let s = GRID * Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom));
  while (s < 14) s *= 2;
  while (s >= 28) s /= 2;
  return s;
}

export function zoomAt(cam: Camera, deltaY: number, cx: number, cy: number): Camera {
  const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, cam.zoom * (deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP)));
  if (next === cam.zoom) return cam;
  const ratio = next / cam.zoom;
  return { x: cx - (cx - cam.x) * ratio, y: cy - (cy - cam.y) * ratio, zoom: next };
}

export function panBy(cam: Camera, dx: number, dy: number): Camera {
  return { ...cam, x: cam.x + dx, y: cam.y + dy };
}

export function fitCameraTo(rect: Rect, view: { w: number; h: number }, pad = 40): Camera {
  if (rect.w <= 0 || rect.h <= 0 || view.w <= 0 || view.h <= 0) return { x: 0, y: 0, zoom: 1 };
  const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.min((view.w - pad * 2) / rect.w, (view.h - pad * 2) / rect.h)));
  return { x: (view.w - rect.w * zoom) / 2 - rect.x * zoom, y: (view.h - rect.h * zoom) / 2 - rect.y * zoom, zoom };
}

export function zoomTo(cam: Camera, zoom: number, at: Placed): Camera {
  const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
  const ratio = next / cam.zoom;
  return { x: at.x - (at.x - cam.x) * ratio, y: at.y - (at.y - cam.y) * ratio, zoom: next };
}

/** Shift+1 fits the content, Shift+2 the selection (empty = null), Shift+0 is 100% at the viewport center. */
export function trioCamera(code: string, ctx: { cam: Camera; view: { w: number; h: number }; bounds: Rect; selection: Rect[] }): Camera | null {
  if (code === 'Digit1') return fitCameraTo(ctx.bounds, ctx.view, 48);
  if (code === 'Digit0') return zoomTo(ctx.cam, 1, { x: ctx.view.w / 2, y: ctx.view.h / 2 });
  if (code !== 'Digit2' || ctx.selection.length === 0) return null;
  const x = Math.min(...ctx.selection.map((r) => r.x));
  const y = Math.min(...ctx.selection.map((r) => r.y));
  return fitCameraTo({ x, y, w: Math.max(...ctx.selection.map((r) => r.x + r.w)) - x, h: Math.max(...ctx.selection.map((r) => r.y + r.h)) - y }, ctx.view, 48);
}

export function toScreen(cam: Camera, p: Placed): Placed {
  return { x: cam.x + p.x * cam.zoom, y: cam.y + p.y * cam.zoom };
}
export function toWorld(cam: Camera, p: Placed): Placed {
  return { x: (p.x - cam.x) / cam.zoom, y: (p.y - cam.y) / cam.zoom };
}

// ---------------------------------------------------------------------------
// The folds: view-state groups over the citizens (data in the arrangement record).
// ---------------------------------------------------------------------------

function isFoldGroup(g: unknown): g is FoldGroup {
  return typeof g === 'object' && g !== null && typeof (g as FoldGroup).id === 'string' && typeof (g as FoldGroup).kind === 'string'
    && typeof (g as FoldGroup).label === 'string' && Array.isArray((g as FoldGroup).members) && typeof (g as FoldGroup).open === 'boolean';
}

export function pruneGroups(groups: FoldGroup[], present: ReadonlySet<string>): FoldGroup[] {
  return groups.map((g) => ({ ...g, members: g.members.filter((m) => present.has(m)) })).filter((g) => g.members.length >= 1);
}

export function canFold(nodes: Array<{ id: string; kind: string }>): { ok: true; kind: string } | { ok: false; sentence: string } {
  if (nodes.length < 2) return { ok: false, sentence: 'select at least two things to fold' };
  const kinds = new Set(nodes.map((n) => n.kind));
  if (kinds.size !== 1) return { ok: false, sentence: 'fold things of one kind together' };
  return { ok: true, kind: [...kinds][0]! };
}

const plural = (word: string): string => (word.endsWith('s') ? word : `${word}s`);

export function mintGroup(nodes: Array<{ id: string; kind: string; label?: string }>): FoldGroup {
  const kind = nodes[0]?.kind ?? '';
  return {
    id: `fold:${Math.random().toString(36).slice(2, 8)}`, kind,
    label: nodes.length === 1 ? nodes[0]!.label ?? citizenWord(kind) : `${nodes.length} ${plural(citizenWord(kind))}`,
    members: nodes.map((n) => n.id), open: false,
  };
}

export const RESTING_FOLD_MIN = 5;
export const SCENE_FOLD_MIN = 2;
export const seedFoldMin = (kind: string): number => (kind === 'scene' || kind === 'website' ? SCENE_FOLD_MIN : RESTING_FOLD_MIN);

/** Group members collapse into one synthetic node; edges re-aim; internal edges drop. */
export function applyFolds(nodes: NodeRecord[], edges: EdgeRecord[], groups: FoldGroup[]): { nodes: NodeRecord[]; edges: EdgeRecord[] } {
  const groupOf = new Map<string, FoldGroup>();
  for (const g of groups) for (const m of g.members) groupOf.set(m, g);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const outNodes: NodeRecord[] = nodes.filter((n) => !groupOf.has(n.id));
  for (const g of groups) {
    const members = g.members.map((m) => byId.get(m)).filter((n): n is NodeRecord => n !== undefined);
    const last = members.map((m) => m.lastActivityAt).filter((t): t is string => t !== null).sort().at(-1) ?? null;
    outNodes.push({
      typeName: 'node', id: g.id, kind: g.kind, label: g.label, detail: `${g.members.length} inside`,
      lastActivityAt: last, projectId: members.find((m) => m.projectId !== null)?.projectId ?? null,
    });
  }
  const seen = new Set<string>();
  const outEdges: EdgeRecord[] = [];
  for (const e of edges) {
    const from = groupOf.get(e.from)?.id ?? e.from;
    const to = groupOf.get(e.to)?.id ?? e.to;
    if (from === to) continue;
    const key = edgeIdOf({ ...e, from, to });
    if (seen.has(key)) continue;
    seen.add(key);
    outEdges.push(from === e.from && to === e.to ? e : { ...e, from, to });
  }
  return { nodes: outNodes, edges: outEdges };
}

// ---------------------------------------------------------------------------
// The one store instance and the React binding.
// ---------------------------------------------------------------------------

export const store = new CanvasStore();

/** A React read of anything derived from the store: re-renders exactly when the read's value changes. */
export function useValue<T>(name: string, fn: () => T, deps: unknown[]): T {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const c = useMemo(() => computed(name, fn), deps);
  return useSyncExternalStore(
    (onChange) => react(`${name}.react`, () => { c.get(); onChange(); }),
    () => c.get(),
    () => c.get(),
  );
}

/** The one element a screen document holds under an id, or null. */
export function primitiveOf(node: SceneNode | undefined): { name: 'frame' | 'text' | 'field' | 'chart' | 'instance'; ref: string; payload: Record<string, unknown> } | null {
  return node === undefined ? null : primitiveOfNode(node);
}

export { SCENE_ROOT_ID };

// ---------------------------------------------------------------------------
// The node data: icon and hue per kind, the verb doors' icons, the creation vocabulary.
// Display words, verb sentences, faces, ports and descent live in the node contract (core).
// ---------------------------------------------------------------------------

export interface NodeCardSpec { hue: string; icon: LucideIcon }

export const NODE_CARDS: Record<string, NodeCardSpec> = {
  dataset: { hue: 'var(--series-2)', icon: Table2 },
  operation: { hue: 'var(--series-1)', icon: Wrench },
  output: { hue: 'var(--series-3)', icon: PackageOpen },
  scene: { hue: 'var(--series-4)', icon: Monitor },
  website: { hue: 'var(--series-4)', icon: Monitor },
  trigger: { hue: 'var(--series-5)', icon: Eye },
  chain: { hue: 'var(--series-5)', icon: RefreshCw },
  role: { hue: 'var(--accent)', icon: Bot },
  notes: { hue: 'var(--t2)', icon: StickyNote },
  project: { hue: 'var(--t1)', icon: FolderOpen },
  integration: { hue: 'var(--series-6)', icon: Plug },
  step: { hue: 'var(--series-3)', icon: Workflow },
};

export function kindWord(kind: string): string { return citizenWord(kind); }
export function kindHue(kind: string): string { return NODE_CARDS[kind]?.hue ?? 'var(--t3)'; }
export function kindIcon(kind: string): LucideIcon { return NODE_CARDS[kind]?.icon ?? PackageOpen; }
export function verbSentence(verb: string): string { return EDGE_VERB_SENTENCES[verb] ?? verb; }

/** The verb doors' icons and words - the toolbar and the menu read the same row. */
export const DOOR_ICONS: Record<VerbDoor, { icon: LucideIcon; label: string }> = {
  'run-operation': { icon: Play, label: 'Run' },
  'open-code': { icon: Braces, label: 'Open the code' },
  'open-rows': { icon: Rows3, label: 'Open the rows' },
  'open-notes': { icon: StickyNote, label: 'Open the notes' },
  'edit-visuals': { icon: Pencil, label: 'Edit the visuals' },
  'revoke-chain': { icon: CircleOff, label: 'Revoke' },
  'try-endpoint': { icon: Zap, label: 'Try it' },
  'toggle-step': { icon: Power, label: 'Switch off or on' },
  'test-step': { icon: Play, label: 'Test this step' },
};
export const foldIcon = Group;
export const unfoldIcon = Ungroup;

/** THE ONE CREATION VOCABULARY: every surface listing placeable citizen kinds renders from this list. */
export type AddKind = 'table' | 'view' | 'tool' | 'watcher' | 'knowledge';
export const INSERT_ROWS: ReadonlyArray<{ kind: AddKind; word: string; citizenKind: string }> = [
  { kind: 'table', word: 'New Table', citizenKind: 'dataset' },
  { kind: 'view', word: 'New Screen', citizenKind: 'scene' },
  { kind: 'tool', word: 'New Tool', citizenKind: 'operation' },
  { kind: 'watcher', word: 'New Trigger', citizenKind: 'trigger' },
  { kind: 'knowledge', word: 'New Notes', citizenKind: 'notes' },
];

/** The kinds a new citizen's name is asked for before it is born; the rest are born or opened straight. */
export const NAMED_INSERTS: ReadonlySet<AddKind> = new Set<AddKind>(['table', 'view', 'tool']);

/** The kernel's kebab law, applied for the human: "Monthly costs" -> monthly-costs. */
export function kebabName(words: string): string {
  return words.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// ---------------------------------------------------------------------------
// The right-click grammar: verbs grouped edit / arrange / lifecycle, shortcuts inline, the word filter.
// ---------------------------------------------------------------------------

export interface MenuRow {
  key: string;
  label: string;
  icon?: LucideIcon;
  /** Inline shortcut label, right-aligned (Ctrl+G, Del). */
  shortcut?: string;
  onAct: () => void;
}
export type MenuGroups = MenuRow[][];

/** The search input renders only past this row count ('auto'); the tiny menus stay bare. */
export const MENU_SEARCH_FLOOR = 3;

/** The word filter: rows whose label carries the query survive; empty groups drop. */
export function filterMenuRows(groups: MenuGroups, query: string): MenuGroups {
  const q = query.trim().toLowerCase();
  if (q === '') return groups.filter((g) => g.length > 0);
  return groups.map((g) => g.filter((r) => r.label.toLowerCase().includes(q))).filter((g) => g.length > 0);
}

export const MENU_GROUP_OF: Record<VerbDoor, 'edit' | 'arrange' | 'lifecycle'> = {
  'run-operation': 'edit', 'open-code': 'edit', 'open-rows': 'edit', 'open-notes': 'edit', 'edit-visuals': 'edit',
  'revoke-chain': 'lifecycle', 'try-endpoint': 'edit', 'toggle-step': 'lifecycle', 'test-step': 'edit',
};

export const MENU_SHORTCUTS = { fold: 'Ctrl+G', unfold: 'Ctrl+Shift+G', delete: 'Del' } as const;

/** The ruled delete set: the kinds the Delete key really deletes on the map; everything else gets no row. */
const DELETABLE_PREFIXES = ['ds:', 'scene:', 'trg:', 'chain:', 'op:', 'intg:', 'fstep:'] as const;
export function deletableOnMap(nodeId: string): boolean { return DELETABLE_PREFIXES.some((p) => nodeId.startsWith(p)); }

/** The node menu: the contract's verbs, Properties, Connect where out ports exist, the fold door, Delete for the ruled set. */
export function nodeMenu(input: {
  nodeId: string;
  kind: string;
  fold: { verb: 'fold' | 'unfold'; act: () => void } | null;
  hasOut: boolean;
  onVerb: (door: VerbDoor) => void;
  onProps: () => void;
  onConnect: () => void;
  onDelete: () => void;
}): MenuGroups {
  const edit: MenuRow[] = [];
  const arrange: MenuRow[] = [];
  const lifecycle: MenuRow[] = [];
  const slot = { edit, arrange, lifecycle } as const;
  // A folded group's only verb is unfold (its members' contract verbs would lie).
  if (input.fold !== null && input.fold.verb === 'unfold') {
    return [[{ key: 'unfold', label: 'Unfold', icon: unfoldIcon, shortcut: MENU_SHORTCUTS.unfold, onAct: input.fold.act }]];
  }
  const contract = (NODE_CONTRACTS as Record<string, NodeContract>)[input.kind];
  for (const v of contract?.verbs ?? []) {
    slot[MENU_GROUP_OF[v.door]].push({ key: v.door, label: v.label, icon: DOOR_ICONS[v.door].icon, onAct: () => input.onVerb(v.door) });
  }
  edit.push({ key: 'props', label: 'Properties', icon: Ellipsis, onAct: input.onProps });
  if (input.hasOut) arrange.push({ key: 'connect', label: 'Connect', icon: Plus, onAct: input.onConnect });
  if (input.fold !== null) arrange.push({ key: 'fold', label: 'Fold into one', icon: foldIcon, shortcut: MENU_SHORTCUTS.fold, onAct: input.fold.act });
  if (deletableOnMap(input.nodeId)) lifecycle.push({ key: 'delete', label: 'Delete', icon: Trash2, shortcut: MENU_SHORTCUTS.delete, onAct: input.onDelete });
  return [edit, arrange, lifecycle];
}

/** The create palette's rows (empty-canvas right-click): the creation vocabulary, then the placeable shelf by name. */
export function createRows(
  viewWord: string,
  onPick: (kind: AddKind) => void,
  integrations: Array<{ name: string; displayName: string }> = [],
  onPickIntegration?: (name: string) => void,
  steps: Array<{ kind: string; displayName: string }> = [],
  onPickStep?: (kind: string) => void,
  doors: Array<{ service: string; endpoint: string; displayName: string }> = [],
  onPickDoor?: (service: string, endpoint: string) => void,
  triggers: Array<{ service: string; trigger: string; displayName: string }> = [],
  onPickTrigger?: (service: string, trigger: string) => void,
): MenuGroups {
  const rows: MenuRow[] = INSERT_ROWS.map((r) => ({
    key: r.kind,
    label: r.kind === 'view' && viewWord === 'Website' ? 'New website page' : r.word,
    icon: r.citizenKind === 'scene' && viewWord === 'Website' ? kindIcon('website') : kindIcon(r.citizenKind),
    onAct: () => onPick(r.kind),
  }));
  const intg: MenuRow[] = onPickIntegration === undefined ? [] : integrations.map((i) => ({ key: `intg-${i.name}`, label: i.displayName, icon: kindIcon('integration'), onAct: () => onPickIntegration(i.name) }));
  const stepRows: MenuRow[] = onPickStep === undefined ? [] : steps.map((s) => ({ key: `step-${s.kind}`, label: s.displayName, icon: kindIcon('step'), onAct: () => onPickStep(s.kind) }));
  const doorRows: MenuRow[] = onPickDoor === undefined ? [] : doors.map((d) => ({ key: `door-${d.service}-${d.endpoint}`, label: d.displayName, icon: kindIcon('step'), onAct: () => onPickDoor(d.service, d.endpoint) }));
  const triggerRows: MenuRow[] = onPickTrigger === undefined ? [] : triggers.map((t) => ({ key: `trg-${t.service}-${t.trigger}`, label: t.displayName, icon: kindIcon('trigger'), onAct: () => onPickTrigger(t.service, t.trigger) }));
  const groups: MenuGroups = [rows];
  if (stepRows.length > 0) groups.push(stepRows);
  if (doorRows.length > 0) groups.push(doorRows);
  if (triggerRows.length > 0) groups.push(triggerRows);
  if (intg.length > 0) groups.push(intg);
  return groups;
}

// ---------------------------------------------------------------------------
// The affordances: chrome in screen px, the port reveal by proximity, the toolbar projected from the contract.
// ---------------------------------------------------------------------------

/** The reveal radius (screen px): ports rest as whispers and step full-bright within this of their owner. */
export const PROXIMITY_RADIUS = 48;

export interface ScreenRect { x: number; y: number; w: number; h: number }

export function nodeScreenRect(cam: Camera, p: Placed, w: number, h: number): ScreenRect {
  const s = toScreen(cam, p);
  return { x: s.x, y: s.y, w: w * cam.zoom, h: h * cam.zoom };
}

/** Distance from a point to a rect - zero inside, edge distance outside. */
export function distToRect(c: Placed, r: ScreenRect): number {
  const dx = Math.max(r.x - c.x, 0, c.x - (r.x + r.w));
  const dy = Math.max(r.y - c.y, 0, c.y - (r.y + r.h));
  return Math.hypot(dx, dy);
}

/** The nearest node within the radius brightens its ports; the innermost (smallest) card wins a tie. */
export function nearestNode(cursor: Placed, nodes: Array<{ id: string; rect: ScreenRect }>, radius: number): string | null {
  let best: string | null = null;
  let bestDist = radius;
  let bestArea = Infinity;
  for (const n of nodes) {
    const d = distToRect(cursor, n.rect);
    const area = n.rect.w * n.rect.h;
    if (d < bestDist || (d === bestDist && (best === null || area < bestArea))) { bestDist = d; bestArea = area; best = n.id; }
  }
  return best;
}

const IN_PORT_KINDS = new Set(Object.values(NODE_CONTRACTS).flatMap((c) => Object.keys(c.ports.out)));

/** An out port exists exactly where the contract declares out rules. */
export function hasOutPort(kind: string): boolean { return legalTargets(kind).length > 0; }
/** An in dot exists exactly where some contract may land. */
export function hasInPort(kind: string): boolean { return IN_PORT_KINDS.has(kind); }

export type ToolbarItem = { act: 'verb'; door: VerbDoor } | { act: 'props' } | { act: 'connect' };

/** The toolbar from the contract: declared verbs in order, the properties door always, connect where out ports exist. */
export function toolbarFor(kind: string): ToolbarItem[] {
  const c = (NODE_CONTRACTS as Record<string, NodeContract>)[kind];
  const items: ToolbarItem[] = (c?.verbs ?? []).map((v) => ({ act: 'verb', door: v.door }));
  items.push({ act: 'props' });
  if (hasOutPort(kind)) items.push({ act: 'connect' });
  return items;
}

export type ElementToolbarItem = { act: 'run' } | { act: 'props' } | { act: 'attach'; target: CitizenKind; word: string } | { act: 'new-view' };

/** The element toolbar from the element-port law: run on the action class, properties always, one attach door per rule word, new view under nav. */
export function elementToolbarFor(cls: ElementClass): ElementToolbarItem[] {
  const items: ElementToolbarItem[] = [];
  if (cls === 'action') items.push({ act: 'run' });
  items.push({ act: 'props' });
  const seen = new Set<string>();
  for (const target of elementLegalTargets(cls)) {
    const rule = elementPortRule(cls, target);
    if (rule === null || seen.has(rule.word)) continue;
    seen.add(rule.word);
    items.push({ act: 'attach', target, word: rule.word });
  }
  if (cls === 'nav') items.push({ act: 'new-view' });
  return items;
}

// ---------------------------------------------------------------------------
// The double-click law: an inside descends per the contract; every other leaf answers nothing, never properties.
// ---------------------------------------------------------------------------

export type DescentTarget = { open: 'notes'; projectId: string } | { open: 'rows' } | { open: 'zoom' } | { open: 'none' };

export function descentFor(kind: string, projectId: string | null): DescentTarget {
  const inside = (NODE_CONTRACTS as Record<string, NodeContract>)[kind]?.inside;
  if (inside === undefined || !inside.descends) return { open: 'none' };
  if (inside.canvas === 'rows') return { open: 'rows' };
  if (inside.canvas === 'editor') return { open: 'zoom' };
  return projectId !== null ? { open: 'notes', projectId } : { open: 'none' };
}

// ---------------------------------------------------------------------------
// The run derivations: badges, out ports and count words off the last runs and the flow docs.
// ---------------------------------------------------------------------------

export interface RunBadge { tone: 'error' | 'ok' | 'issue' | 'pinned' | 'dirty'; text?: string }

const fstepId = (flowId: string, stepId: string): string => `fstep:${flowId}:${stepId}`;
const outCountOf = (ports: Record<string, number>): number => Object.values(ports).reduce((n, c) => n + c, 0);

/** The authoring half off the flow docs: a doc that fails the shape reads as no state, never a throw. */
export function stepStatesOf(flows: Array<{ id: string; doc: unknown }>): StepAuthorState[] {
  const out: StepAuthorState[] = [];
  for (const f of flows) {
    const steps = (f.doc as { steps?: Record<string, { kind?: unknown; params?: Record<string, unknown>; pinned?: unknown; touchedAt?: unknown }> } | null)?.steps;
    if (steps === undefined || steps === null) continue;
    for (const [stepId, s] of Object.entries(steps)) {
      const fused = s.kind === 'run-tool' && s.params?.['fused'] === true && typeof s.params['tool'] === 'string';
      out.push({
        flowId: f.id, stepId, pinned: Array.isArray(s.pinned),
        ...(typeof s.touchedAt === 'string' ? { touchedAt: s.touchedAt } : {}),
        ...(fused ? { alias: `op:${s.params!['tool']}` } : {}),
      });
    }
  }
  return out;
}

/** error = the failed run's last ran entry; pinned silences dirt; dirty = touched after the last run; ok wears the out count. */
export function runBadgesFor(runs: FlowLastRun[], states: StepAuthorState[] = []): Map<string, RunBadge> {
  const badges = new Map<string, RunBadge>();
  const runByFlow = new Map(runs.map((r) => [r.flowId, r]));
  const aliasOf = new Map(states.filter((s) => s.alias !== undefined).map((s) => [fstepId(s.flowId, s.stepId), s.alias!]));
  const key = (flowId: string, stepId: string): string => aliasOf.get(fstepId(flowId, stepId)) ?? fstepId(flowId, stepId);
  for (const run of runs) for (const [stepId, ports] of Object.entries(run.stepCounts)) badges.set(key(run.flowId, stepId), { tone: 'ok', text: String(outCountOf(ports)) });
  for (const s of states) {
    const run = runByFlow.get(s.flowId);
    if (run !== undefined && s.touchedAt !== undefined && s.touchedAt > run.createdAt) badges.set(key(s.flowId, s.stepId), { tone: 'dirty' });
  }
  for (const s of states) if (s.pinned) badges.set(key(s.flowId, s.stepId), { tone: 'pinned' });
  for (const run of runs) {
    const last = run.ran[run.ran.length - 1];
    if (run.status === 'failed' && last !== undefined) badges.set(key(run.flowId, last), { tone: 'error' });
  }
  return badges;
}

/** A step's named out ports off its def; split's come from its rules' own port names; [] = no way out. */
export function stepOutPortsOf(
  flows: Array<{ id: string; doc: unknown }>,
  catalog: Array<{ kind: string; displayName: string; outputs: string[] }>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const f of flows) {
    const steps = (f.doc as { steps?: Record<string, { kind?: string; params?: Record<string, unknown> }> } | null)?.steps;
    if (steps === undefined || steps === null) continue;
    for (const [stepId, s] of Object.entries(steps)) {
      const def = catalog.find((c) => c.kind === s.kind);
      if (def === undefined) continue;
      let ports = def.outputs;
      if (s.kind === 'split-by-rules') {
        const rules = Array.isArray(s.params?.['rules']) ? (s.params['rules'] as Array<{ port?: unknown }>) : [];
        const fallback = typeof s.params?.['fallback'] === 'string' && s.params['fallback'] !== '' ? [s.params['fallback']] : [];
        ports = [...rules.map((r) => (typeof r.port === 'string' ? r.port : '')).filter((p) => p !== ''), ...fallback];
      }
      if (ports.length !== 1) out[fstepId(f.id, stepId)] = ports;
    }
  }
  return out;
}

/** The item-count word for one step wire: stepCounts[from][port], plain words. */
export function edgeCountWordFor(runs: FlowLastRun[], edge: { from: string; port?: string }): string | undefined {
  if (!edge.from.startsWith('fstep:')) return undefined;
  const [, flowId, stepId] = edge.from.split(':');
  if (flowId === undefined || stepId === undefined) return undefined;
  const n = runs.find((r) => r.flowId === flowId)?.stepCounts[stepId]?.[edge.port ?? 'out'];
  if (n === undefined) return undefined;
  return n === 1 ? '1 item' : `${n} items`;
}

// ---------------------------------------------------------------------------
// The action words: a declared action's writes, fires and when clauses spoken plain.
// ---------------------------------------------------------------------------

export type ActWhen = { param: string; check: string; value?: unknown };
export type ActParam = { name: string; type: string; source: string; required: boolean; description: string };
export type ActWrite = { kind: string; dataset?: string; operation?: string; connection?: string; flow?: string; entry?: string; columns?: Record<string, string>; when?: ActWhen };
/** Changed trigger on the wire; absent = button-fired. */
export type ActFires = { on: string; node?: string };
export type ActDoc = { name: string; title: string; params: ActParam[]; writes: ActWrite[]; fires?: ActFires };

const pretty = (id: string): string => id.replace(/-/g, ' ');

export function actionWriteWord(w: ActWrite, names?: { endpoint?: string; connection?: string }): string {
  if (w.kind === 'append_row') return `saves to ${w.dataset ?? 'a table'}`;
  if (w.kind === 'update_row') return `updates ${w.dataset ?? 'a table'}`;
  if (w.kind === 'delete_row') return `removes from ${w.dataset ?? 'a table'}`;
  if (w.kind === 'run_operation') return `runs ${w.operation ?? 'a tool'}`;
  if (w.kind === 'call_integration') return `sends '${names?.endpoint ?? pretty(w.operation ?? 'a message')}' through ${names?.connection ?? 'a connection'}`;
  if (w.kind === 'start_flow') return `starts the flow at ${pretty(w.entry ?? 'its entry step')}`;
  return 'asks the assistant';
}

/** The Changed trigger spoken plain; `noun` resolves a node id to its element noun. */
export function firesWord(fires: ActFires, noun: (node: string) => string): string {
  if (fires.on !== 'changed') return `fires on ${fires.on}`;
  return fires.node !== undefined ? `fires when ${noun(fires.node)} changes` : 'fires when any input changes';
}

export function rowNavSentence(view: string): string { return `clicking a row opens ${view} with that row`; }

export function whenWords(when: ActWhen, params: ActParam[]): string {
  const p = params.find((x) => x.name === when.param);
  const label = p !== undefined && p.description.length > 0 && p.description.length <= 48 ? p.description : paramWord(when.param);
  if (when.check === 'is' && when.value === true) return `'${label}' is ticked`;
  if (when.check === 'is' && when.value === false) return `'${label}' is not ticked`;
  if (when.check === 'is') return `'${label}' is ${String(when.value)}`;
  if (when.check === 'nonempty') return `'${label}' is filled in`;
  if (when.check === 'gte') return `'${label}' is at least ${String(when.value)}`;
  if (when.check === 'lte') return `'${label}' is at most ${String(when.value)}`;
  if (when.check === 'matches') return `'${label}' matches ${String(when.value)}`;
  return `'${label}' includes ${String(when.value)}`;
}

/** The when gating a param asked only by when-carrying writes; null when any ungated write consumes it. */
export function askedOnlyWhen(a: ActDoc, param: string): ActWhen | null {
  const consuming = a.writes.filter((w) => Object.values(w.columns ?? {}).includes(`param:${param}`));
  if (consuming.length === 0 || consuming.some((w) => w.when === undefined)) return null;
  return consuming[0]!.when ?? null;
}

/** The rule sentence: write word + field feeds + when clause. */
export function ruleSentence(w: ActWrite, params: ActParam[], names?: { endpoint?: string; connection?: string }): string {
  const feeds = Object.entries(w.columns ?? {})
    .filter(([, src]) => src.startsWith('param:'))
    .map(([key, src]) => {
      const pname = src.slice('param:'.length);
      const p = params.find((x) => x.name === pname);
      const label = p !== undefined && p.description.length > 0 && p.description.length <= 48 ? p.description : paramWord(pname);
      return `${key} <- ${label}`;
    });
  const base = `When clicked - ${actionWriteWord(w, names)}`;
  const tail = w.when !== undefined ? ` · only when ${whenWords(w.when, params)}` : '';
  return feeds.length > 0 ? `${base} · ${feeds.join(' · ')}${tail}` : `${base}${tail}`;
}

// ---------------------------------------------------------------------------
// The config card's model: a step def's declared params as typed rows, the condition grammar in words.
// ---------------------------------------------------------------------------

export interface StepDefWire {
  kind: string;
  displayName: string;
  blurb: string;
  outputs: string[];
  inputs: { slots: string[]; required: string[] };
  params: Array<{ name: string; type: string; required: boolean; pill: boolean; choices?: string[]; help?: string; showWhen?: { param: string; is: string[] } }>;
}

export type CardControl =
  | { control: 'table'; name: string; value: string }
  | { control: 'text'; name: string; value: string }
  | { control: 'number'; name: string; value: number | null }
  | { control: 'toggle'; name: string; value: boolean }
  | { control: 'enum'; name: string; value: string; choices: string[] }
  | { control: 'condition'; name: string; value: FlowCondition | null }
  | { control: 'pairs'; name: string; value: Array<[string, string]> }
  | { control: 'fieldpick'; name: string; value: string };

const PARAM_WORDS: Record<string, string> = { limit: 'how many', condition: 'where', size: 'batch size', flow: 'flow', tool: 'tool' };
export function cardParamWord(name: string): string { return PARAM_WORDS[name] ?? name.replace(/[-_]+/g, ' '); }

/** Params that name a Table render the picker; params that read an item field render the field dropdown. */
const TABLE_PARAMS = new Set(['table']);
const FIELD_PARAMS = new Set(['field', 'group-by']);

/** The def's declared surface as typed rows; the machine pair (connection/endpoint) never renders. */
export function cardControlsFor(def: StepDefWire, params: Record<string, unknown>): CardControl[] {
  const out: CardControl[] = [];
  for (const p of def.params) {
    if (def.kind === 'call-integration' && (p.name === 'connection' || p.name === 'endpoint')) continue;
    // A gated param renders only while its gate param holds a listed value.
    if (p.showWhen !== undefined) {
      const gate = def.params.find((g) => g.name === p.showWhen!.param);
      const raw = params[p.showWhen.param];
      const current = typeof raw === 'string' ? raw : gate?.choices?.[0] ?? '';
      if (!p.showWhen.is.includes(current)) continue;
    }
    const v = params[p.name];
    if (p.type === 'condition') {
      const parsed = conditionSchema.safeParse(v);
      out.push({ control: 'condition', name: p.name, value: parsed.success ? parsed.data : null });
    } else if (p.type === 'number') out.push({ control: 'number', name: p.name, value: typeof v === 'number' ? v : null });
    else if (p.type === 'boolean') out.push({ control: 'toggle', name: p.name, value: v === true });
    else if (p.type === 'enum') out.push({ control: 'enum', name: p.name, value: typeof v === 'string' ? v : p.choices?.[0] ?? '', choices: p.choices ?? [] });
    else if (p.type === 'string' && TABLE_PARAMS.has(p.name)) out.push({ control: 'table', name: p.name, value: typeof v === 'string' ? v : '' });
    else if (p.type === 'string' && FIELD_PARAMS.has(p.name)) out.push({ control: 'fieldpick', name: p.name, value: typeof v === 'string' ? v : '' });
    else if (p.type === 'string') out.push({ control: 'text', name: p.name, value: typeof v === 'string' ? v : '' });
    else if (p.type === 'json') {
      // Object-map params render as name -> value pair rows; pill values (wire-landed) stay untouched.
      const obj = typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
      out.push({ control: 'pairs', name: p.name, value: Object.entries(obj).filter((e): e is [string, string] => typeof e[1] === 'string') });
    }
  }
  return out;
}

/** A typed edit coerced to the doc's shape (number wells hand back strings). */
export function coerceParam(control: CardControl['control'], raw: string): unknown {
  if (control === 'number') { const n = Number(raw); return raw.trim() !== '' && Number.isFinite(n) ? n : null; }
  return raw;
}

export const CONDITION_WORDS: Record<ConditionOp, string> = {
  'equals': 'is', 'not-equals': 'is not', 'contains': 'contains', 'not-contains': 'does not contain',
  'starts-with': 'starts with', 'ends-with': 'ends with', 'greater': 'is more than', 'at-least': 'is at least',
  'less': 'is less than', 'at-most': 'is at most', 'empty': 'is empty', 'not-empty': 'is not empty',
  'is-true': 'is yes', 'is-false': 'is no', 'before': 'is before', 'after': 'is after',
};

/** The argument-less ops - their value well never renders. */
export const NO_RIGHT_OPS: ReadonlySet<ConditionOp> = new Set(['empty', 'not-empty', 'is-true', 'is-false']);
export const ALL_CONDITION_OPS: readonly ConditionOp[] = CONDITION_OPS;

/** Where a step's items come from: the first incoming edge's source (its table when that source is Get rows). */
export function inputSourceFor(
  doc: { steps?: Record<string, { kind?: string; params?: Record<string, unknown> }>; edges?: Array<{ from: string; to: string; order?: number }> } | null,
  stepId: string,
): { upstream: string | null; table: string | null } {
  const edges = (doc?.edges ?? []).filter((e) => e.to === stepId).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const upstream = edges[0]?.from ?? null;
  const src = upstream !== null ? doc?.steps?.[upstream] : undefined;
  const table = src?.kind === 'get-rows' && typeof src.params?.['table'] === 'string' ? src.params['table'] : null;
  return { upstream, table };
}

/** A field's left pill: the upstream step's item field; no upstream = the trigger's. */
export function leftPillFor(field: string, upstream: string | null): Pill {
  return upstream !== null ? { from: 'step', step: upstream, path: field } : { from: 'trigger', path: field };
}

/** The pill's field word for display (the path is the field). */
export function pillField(p: unknown): string {
  return typeof p === 'object' && p !== null && 'path' in p && typeof (p as { path: unknown }).path === 'string' ? (p as { path: string }).path : '';
}

/** Append one rule on `field`; a null condition seeds fresh. */
export function withRule(cond: FlowCondition | null, field: string, upstream: string | null): FlowCondition {
  const rule = { left: leftPillFor(field, upstream), op: 'equals' as ConditionOp };
  return cond === null ? { combine: 'and', rules: [rule] } : { ...cond, rules: [...cond.rules, rule] };
}

/** Replace rule `i` - field, op and right edits land through this one door. */
export function setRule(cond: FlowCondition, i: number, patch: { field?: string; op?: ConditionOp; right?: string }, upstream: string | null): FlowCondition {
  const rules = cond.rules.map((r, n) => {
    if (n !== i) return r;
    const op = patch.op ?? r.op;
    return {
      left: patch.field !== undefined ? leftPillFor(patch.field, upstream) : r.left,
      op,
      ...(NO_RIGHT_OPS.has(op) ? {} : { right: patch.right !== undefined ? coerceRight(patch.right) : r.right }),
    };
  });
  return { ...cond, rules };
}

/** Rule `i` leaves; the last rule leaving answers null (the param unsets). */
export function dropRule(cond: FlowCondition, i: number): FlowCondition | null {
  const rules = cond.rules.filter((_, n) => n !== i);
  return rules.length === 0 ? null : { ...cond, rules };
}

/** Right values type themselves: numeric words become numbers. */
export function coerceRight(raw: string): string | number {
  const n = Number(raw);
  return raw.trim() !== '' && Number.isFinite(n) ? n : raw;
}

// ---------------------------------------------------------------------------
// The trigger card's model: draft state, the spec and action assembly, the readiness gate, the entry words.
// ---------------------------------------------------------------------------

export const TRIGGER_WHEN_KINDS = ['dataset_threshold', 'output_registered', 'webhook_in', 'schedule', 'cron', 'interval'] as const;
export type TriggerWhenKind = (typeof TRIGGER_WHEN_KINDS)[number];

export const TRIGGER_WHEN_WORDS: Record<TriggerWhenKind, string> = {
  dataset_threshold: 'rows in a table cross a line',
  output_registered: 'a result is registered',
  webhook_in: 'something calls your webhook address',
  schedule: 'a time comes each day',
  cron: 'a cron expression matches',
  interval: 'every few minutes',
};

export interface TriggerDraft {
  kind: TriggerWhenKind;
  dataset: string;
  column: string;
  op: '>' | '>=' | '<' | '<=' | '==';
  value: string;
  outputName: string;
  endpointToken: string;
  time: string;
  cronExpr: string;
  minutes: string;
  actionKind: 'run_operation' | 'call_integration' | 'start_flow';
  operation: string;
  /** The tool's declared dataset inputs and the chosen table per key. */
  feed: Record<string, string>;
  connectionId: string;
  endpointId: string;
  entry: string;
}

export function freshTriggerDraft(prefill?: { dataset?: string; operation?: string }): TriggerDraft {
  return {
    kind: 'dataset_threshold', dataset: prefill?.dataset ?? '', column: '', op: '>', value: '',
    outputName: '', endpointToken: '', time: '09:00', cronExpr: '0 9 * * *', minutes: '30',
    actionKind: 'run_operation', operation: prefill?.operation ?? '', feed: {},
    connectionId: '', endpointId: '', entry: '',
  };
}

/** The edit dress's prefill off a stored row; null = a kind this form does not speak (placed preconfigured). */
export function draftFromRow(row: { kind: string; spec: Record<string, unknown>; action: Record<string, unknown> }): TriggerDraft | null {
  if (!(TRIGGER_WHEN_KINDS as readonly string[]).includes(row.kind)) return null;
  const d = freshTriggerDraft();
  d.kind = row.kind as TriggerWhenKind;
  const s = row.spec;
  if (typeof s['dataset'] === 'string') d.dataset = s['dataset'];
  if (typeof s['column'] === 'string') d.column = s['column'];
  if (typeof s['op'] === 'string') d.op = s['op'] as TriggerDraft['op'];
  if (typeof s['value'] === 'number') d.value = String(s['value']);
  if (typeof s['name'] === 'string') d.outputName = s['name'];
  if (typeof s['endpoint'] === 'string') d.endpointToken = s['endpoint'];
  if (typeof s['time'] === 'string') d.time = s['time'];
  if (typeof s['expr'] === 'string') d.cronExpr = s['expr'];
  if (typeof s['minutes'] === 'number') d.minutes = String(s['minutes']);
  const a = row.action;
  if (a['type'] === 'run_operation') {
    d.actionKind = 'run_operation';
    if (typeof a['operation'] === 'string') d.operation = a['operation'];
    if (typeof a['inputs'] === 'object' && a['inputs'] !== null) {
      d.feed = Object.fromEntries(Object.entries(a['inputs'] as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string'));
    }
  } else if (a['type'] === 'call_integration') {
    d.actionKind = 'call_integration';
    if (typeof a['connection'] === 'string') d.connectionId = a['connection'];
    if (typeof a['endpoint'] === 'string') d.endpointId = a['endpoint'];
  } else if (a['type'] === 'start_flow') {
    d.actionKind = 'start_flow';
    if (typeof a['entry'] === 'string') d.entry = a['entry'];
  } else return null;
  return d;
}

export function specOf(d: TriggerDraft): Record<string, unknown> {
  if (d.kind === 'dataset_threshold') return { dataset: d.dataset, column: d.column, op: d.op, value: Number(d.value) };
  if (d.kind === 'webhook_in') return { endpoint: d.endpointToken };
  if (d.kind === 'schedule') return { time: d.time };
  if (d.kind === 'cron') return { expr: d.cronExpr };
  if (d.kind === 'interval') return { minutes: Number(d.minutes) };
  return d.outputName.trim() === '' ? {} : { name: d.outputName.trim() };
}

/** Each declared dataset input gets its chosen table (the watched one by default). */
export function actionOf(d: TriggerDraft, datasetInputs: string[], datasets: string[]): Record<string, unknown> {
  if (d.actionKind === 'start_flow') return { type: 'start_flow', flow: 'main', entry: d.entry };
  if (d.actionKind === 'call_integration') return { type: 'call_integration', connection: d.connectionId, endpoint: d.endpointId, params: {} };
  const fallback = d.kind === 'dataset_threshold' ? d.dataset : datasets[0] ?? '';
  const inputs = Object.fromEntries(datasetInputs.map((k) => [k, d.feed[k] ?? fallback]).filter(([, v]) => v !== ''));
  return { type: 'run_operation', operation: d.operation, inputs };
}

/** The one verb's gate. */
export function draftReady(d: TriggerDraft): boolean {
  const action = d.actionKind === 'run_operation' ? d.operation !== ''
    : d.actionKind === 'call_integration' ? d.connectionId !== '' && d.endpointId !== ''
      : d.entry !== '';
  const when = (d.kind !== 'webhook_in' || d.endpointToken !== '')
    && (d.kind !== 'interval' || (Number(d.minutes) >= 1 && Number.isFinite(Number(d.minutes))))
    && (d.kind !== 'dataset_threshold' || (d.dataset !== '' && d.column !== '' && d.value.trim() !== '' && Number.isFinite(Number(d.value))));
  return action && when;
}

/** The entry dropdown's plain words: the step's display name, ordinals past the first of a kind. */
export function entryWords(roots: string[], kindOf: (stepId: string) => string | undefined, catalog: Array<{ kind: string; displayName: string }>): Array<{ id: string; word: string }> {
  const seen = new Map<string, number>();
  return roots.map((id) => {
    const base = catalog.find((c) => c.kind === kindOf(id))?.displayName ?? 'Step';
    const nth = (seen.get(base) ?? 0) + 1;
    seen.set(base, nth);
    return { id, word: nth === 1 ? base : `${base} ${nth}` };
  });
}
