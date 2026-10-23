import { atom, computed, type Atom, type Computed } from '@tldraw/state';
import type { NodeRecord, Placed, Rect } from '../store.js';
import type { CanvasStore } from '../store.js';
import type { History } from '../history.js';
import type { Inputs } from '../managers/inputs.js';
import type { Snaps } from '../managers/snap.js';
import type { Ticker } from '../managers/tick.js';
import type { WireLaneDeps } from './select/DrawingWire.js';

// TOOLS AS STATE MACHINES (Phase 12, row 12.15; tldraw's StateNode shape). A node is a branch with
// children and an initial child, or a leaf; events walk from the root down the active path; a state
// transitions its siblings through its parent. The editor context every state reads is one object:
// the store, the history, the inputs, the snaps, the ticker, the frames' geometry, and the mount's
// doors (the kernel writes a gesture ends in).

export type PointerTarget =
  | { kind: 'canvas' }
  | { kind: 'node'; id: string; name?: boolean }
  | { kind: 'element'; scene: string; screenId: string; id: string | null }
  | { kind: 'outline'; scene: string; screenId: string; id: string }
  | { kind: 'handle'; scene: string; screenId: string; id: string; sx: -1 | 1; sy: -1 | 1; cursor: string }
  | { kind: 'rotate'; scene: string; screenId: string; id: string }
  | { kind: 'spacing'; scene: string; screenId: string; id: string; key: 'gap' | 'padding'; edge?: 'left' | 'right' | 'top' | 'bottom' }
  | { kind: 'screen-edge'; screenId: string; edge: 'e' | 's' }
  | { kind: 'port'; id: string; port?: string }
  | { kind: 'element-port'; scene: string; screenId: string; id: string; cls: 'nav' | 'action' | 'display' }
  | { kind: 'emit-port'; scene: string; screenId: string; id: string; emit: string; emitType: string }
  | { kind: 'wire'; index: number };

export interface PointerInfo {
  type: 'pointer';
  name: 'pointer_down' | 'pointer_move' | 'pointer_up' | 'double_click' | 'right_click';
  target: PointerTarget;
  button: number;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  client: Placed;
  world: Placed;
}
export interface KeyInfo {
  type: 'key';
  name: 'key_down' | 'key_up';
  key: string;
  code: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  preventDefault: () => void;
}
export type EventInfo =
  | PointerInfo
  | KeyInfo
  | { type: 'cancel' }
  | { type: 'complete' }
  | { type: 'tick'; elapsed: number };

/** What a frame face registers so the tools read real geometry: the mount's measure and hit test in frame units. */
export interface FrameGeometry {
  screenId: string;
  scene: string;
  /** Frame units per world unit (the miniature scale) and the frame's world origin. */
  scale: number;
  /** Elements' rects in frame units, refreshed by the face's report. */
  rects: ReadonlyMap<string, Rect & { r?: string }>;
  hitTest: (client: Placed) => string | null;
  editText: (id: string) => void;
  editCommand: (cmd: string, link?: string) => void;
  fire: (id: string) => void;
  /** The face's own conversion: client px -> frame units. */
  toFrame: (client: Placed) => Placed;
}

/** The mount's doors: what a gesture ends in beyond the store (the kernel's citizen doors, the panels, the words). */
export interface Doors {
  quiet: (sentence: string) => void;
  speakRefusal: (at: Placed, sentence: string) => void;
  /** A citizen wire drop: the contract's verdict routes to the picker or the doors (DrawingWire owns the lane). */
  wireEmpty: (from: NodeRecord, at: Placed) => void;
  /** Double-click on a card: the contract's inside descends. */
  nodeOpen: (node: NodeRecord) => void;
  nodeContext: (node: NodeRecord, client: Placed) => void;
  canvasContext: (at: Placed, client: Placed) => void;
  elementContext: (scene: string, screenId: string, point: Placed, client: Placed) => void;
  deleteNodes: (ids: ReadonlySet<string>) => void;
  /** The create tool's landing: a drawn rect in world units, the screen under it with the rect in frame units. */
  createLand: (gesture: { rect: Rect; client: Placed; frame: { screenId: string; scene: string; rel: Rect } | null }) => void;
  /** An element wired out onto a citizen or empty space. */
  elementWireOut: (source: { scene: string; screenId: string; id: string; cls: 'nav' | 'action' | 'display' }, target: NodeRecord | null, client: Placed) => void;
  /** An emit port dropped on an element (or nothing). */
  channelDrop: (scene: string, fromEl: string, emit: string, emitType: string, toEl: string | null) => void;
  /** A citizen dropped onto an element inside a screen; true = the element took it. */
  dropOnElement: (source: NodeRecord, scene: string, screenId: string, elementId: string) => Promise<boolean>;
  /** A citizen wire dropped on another citizen. */
  wireDrop: (from: NodeRecord, to: NodeRecord, at: Placed, port?: string) => void;
  /** The wire lane's own needs: the picker, the trigger card, the step placement. */
  lane: WireLaneDeps;
}

export interface Editor {
  store: CanvasStore;
  history: History;
  inputs: Inputs;
  snaps: Snaps;
  ticker: Ticker;
  doors: Doors;
  /** The canvas viewport in client px. */
  view: () => DOMRect | null;
  toWorld: (client: Placed) => Placed;
  frames: Map<string, FrameGeometry>;
  framesVersion: Atom<number>;
  frameOf: (screenId: string) => FrameGeometry | null;
  /** The world rect of an element inside a screen (frame units through the miniature scale and the screen's origin). */
  elementWorldRect: (screenId: string, elementId: string) => Rect | null;
  root: RootState;
  currentPath: Computed<string>;
}

export interface StateNodeCtor {
  new (editor: Editor, parent?: StateNode): StateNode;
  id: string;
  initial?: string;
  children?(): StateNodeCtor[];
}

export abstract class StateNode {
  static id: string;
  static initial?: string;
  static children?: () => StateNodeCtor[];

  readonly id: string;
  readonly type: 'branch' | 'leaf' | 'root';
  readonly initial?: string;
  readonly children?: Record<string, StateNode>;
  readonly parent: StateNode;
  private readonly current: Atom<StateNode | undefined>;
  private readonly active: Atom<boolean>;
  readonly path: Computed<string>;

  constructor(public editor: Editor, parent?: StateNode) {
    const ctor = this.constructor as StateNodeCtor;
    this.id = ctor.id;
    this.active = atom(`state.active.${this.id}`, false);
    this.current = atom<StateNode | undefined>(`state.current.${this.id}`, undefined);
    this.path = computed(`state.path.${this.id}`, () => {
      const cur = this.current.get();
      return this.id + (cur !== undefined ? `.${cur.path.get()}` : '');
    });
    this.parent = parent ?? (this as StateNode);
    if (ctor.children !== undefined && ctor.initial !== undefined) {
      this.type = parent === undefined ? 'root' : 'branch';
      this.initial = ctor.initial;
      this.children = Object.fromEntries(ctor.children().map((C) => [C.id, new C(editor, this)]));
      this.current.set(this.children[this.initial]);
    } else {
      this.type = parent === undefined ? 'root' : 'leaf';
    }
  }

  getCurrent(): StateNode | undefined { return this.current.get(); }
  getIsActive(): boolean { return this.active.get(); }

  /** Transition to a child state by id (a dotted path walks deeper); info reaches onExit and onEnter. */
  transition(id: string, info: unknown = {}): this {
    const path = id.split('.');
    let cur: StateNode = this;
    for (const step of path) {
      const prev = cur.current.get();
      const next = cur.children?.[step];
      if (next === undefined) throw new Error(`${cur.id} - no child state '${step}'`);
      if (prev?.id !== next.id) {
        if (prev?.getIsActive() === true) prev.exit(info, step);
        cur.current.set(next);
        next.enter(info, prev?.id ?? 'initial');
        if (!next.getIsActive()) break;
      }
      cur = next;
    }
    return this;
  }

  handleEvent(info: EventInfo): void {
    const child = this.current.get();
    this.dispatch(info);
    if (this.active.get() && child !== undefined && child === this.current.get()) child.handleEvent(info);
  }

  private dispatch(info: EventInfo): void {
    switch (info.type) {
      case 'pointer':
        if (info.name === 'pointer_down') this.onPointerDown?.(info);
        else if (info.name === 'pointer_move') this.onPointerMove?.(info);
        else if (info.name === 'pointer_up') this.onPointerUp?.(info);
        else if (info.name === 'double_click') this.onDoubleClick?.(info);
        else this.onRightClick?.(info);
        return;
      case 'key':
        if (info.name === 'key_down') this.onKeyDown?.(info); else this.onKeyUp?.(info);
        return;
      case 'cancel': this.onCancel?.(); return;
      case 'complete': this.onComplete?.(); return;
      case 'tick': this.onTick?.(info.elapsed); return;
    }
  }

  enter(info: unknown, from: string): void {
    const before = this.current.get();
    this.active.set(true);
    this.onEnter?.(info, from);
    if (this.children !== undefined && this.initial !== undefined && this.active.get() && this.current.get() === before) {
      const initial = this.children[this.initial]!;
      this.current.set(initial);
      initial.enter(info, from);
    }
  }

  exit(info: unknown, to: string): void {
    this.active.set(false);
    this.onExit?.(info, to);
    if (!this.active.get()) this.current.get()?.exit(info, to);
  }

  onEnter?(info: unknown, from: string): void;
  onExit?(info: unknown, to: string): void;
  onPointerDown?(info: PointerInfo): void;
  onPointerMove?(info: PointerInfo): void;
  onPointerUp?(info: PointerInfo): void;
  onDoubleClick?(info: PointerInfo): void;
  onRightClick?(info: PointerInfo): void;
  onKeyDown?(info: KeyInfo): void;
  onKeyUp?(info: KeyInfo): void;
  onCancel?(): void;
  onComplete?(): void;
  onTick?(elapsed: number): void;
}

/** The root: one child per mouse mode; the store's mode record picks the active tool. */
export class RootState extends StateNode {
  static override id = 'root';
  static override initial = 'select';
  static override children(): StateNodeCtor[] { return rootChildren(); }

  setTool(id: 'select' | 'create' | 'hand'): void {
    if (this.getCurrent()?.id === id) return;
    this.transition(id);
  }
}

let rootChildren: () => StateNodeCtor[] = () => [];
/** The tools register once (the import cycle root -> tools -> root closes here). */
export function registerTools(fn: () => StateNodeCtor[]): void { rootChildren = fn; }

/** The screen id (scene:<id>) of a pointer target inside a frame, or null. */
export function screenIdOf(t: PointerTarget): string | null {
  return 'screenId' in t ? t.screenId : null;
}

/** True when the target is the selection's own chrome (outline, handles) - a drag moves or resizes what is selected. */
export function isChromeTarget(t: PointerTarget): boolean {
  return t.kind === 'outline' || t.kind === 'handle' || t.kind === 'rotate' || t.kind === 'spacing' || t.kind === 'screen-edge';
}
