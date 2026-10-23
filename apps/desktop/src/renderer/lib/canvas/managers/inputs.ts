import type { Placed } from '../store.js';
import type { Editor, PointerInfo, PointerTarget } from '../tools/StateNode.js';

// THE INPUTS (tldraw's InputsManager + ClickManager): the pointer's origin and current point in client and
// world units, the modifiers, whether the press became a drag, and the double click. A pointer down
// installs the window listeners that carry the move and the up wherever the hand goes (the drag shield);
// every event walks into the root state machine as one PointerInfo.

const DRAG_THRESHOLD_PX = 4;
const DOUBLE_CLICK_MS = 400;
const DOUBLE_CLICK_PX = 8;

export class Inputs {
  origin: Placed = { x: 0, y: 0 };
  originWorld: Placed = { x: 0, y: 0 };
  current: Placed = { x: 0, y: 0 };
  currentWorld: Placed = { x: 0, y: 0 };
  previous: Placed = { x: 0, y: 0 };
  isPointing = false;
  isDragging = false;
  button = 0;
  shiftKey = false;
  ctrlKey = false;
  altKey = false;
  spaceKey = false;
  target: PointerTarget = { kind: 'canvas' };
  private lastDown: { at: number; client: Placed; target: string } | null = null;
  private offWindow: (() => void) | null = null;

  constructor(private readonly editor: () => Editor) {}

  /** The world point under the pointer right now (the camera as it stands). */
  worldOf(client: Placed): Placed { return this.editor().toWorld(client); }

  private info(name: PointerInfo['name'], e: { clientX: number; clientY: number; button?: number; shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }, target: PointerTarget): PointerInfo {
    const client = { x: e.clientX, y: e.clientY };
    return {
      type: 'pointer', name, target, button: e.button ?? this.button,
      shiftKey: e.shiftKey, ctrlKey: e.ctrlKey || e.metaKey, altKey: e.altKey,
      client, world: this.worldOf(client),
    };
  }

  private modifiers(e: { shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }): void {
    this.shiftKey = e.shiftKey;
    this.ctrlKey = e.ctrlKey || e.metaKey;
    this.altKey = e.altKey;
  }

  /** A press on a target: the machine hears pointer_down (a second press within the window hears double_click too). */
  pointerDown(e: PointerEvent | React.PointerEvent, target: PointerTarget): void {
    if (this.isPointing) return;
    this.modifiers(e);
    this.button = e.button;
    this.origin = { x: e.clientX, y: e.clientY };
    this.originWorld = this.worldOf(this.origin);
    this.current = this.origin;
    this.currentWorld = this.originWorld;
    this.previous = this.origin;
    this.isPointing = true;
    this.isDragging = false;
    this.target = target;
    const now = Date.now();
    const key = JSON.stringify(target);
    const dbl = this.lastDown !== null && now - this.lastDown.at < DOUBLE_CLICK_MS && this.lastDown.target === key
      && Math.hypot(this.lastDown.client.x - e.clientX, this.lastDown.client.y - e.clientY) < DOUBLE_CLICK_PX;
    this.lastDown = dbl ? null : { at: now, client: this.origin, target: key };
    const root = this.editor().root;
    const onMove = (ev: PointerEvent): void => this.pointerMove(ev);
    const onUp = (ev: PointerEvent): void => this.pointerUp(ev);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    this.offWindow = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    root.handleEvent(this.info('pointer_down', e, target));
    if (dbl) root.handleEvent(this.info('double_click', e, target));
  }

  /** A move (the window carries it while pointing; the canvas reports hover moves when not). */
  pointerMove(e: PointerEvent | React.PointerEvent, target?: PointerTarget): void {
    this.modifiers(e);
    this.previous = this.current;
    this.current = { x: e.clientX, y: e.clientY };
    this.currentWorld = this.worldOf(this.current);
    if (this.isPointing && !this.isDragging && Math.hypot(this.current.x - this.origin.x, this.current.y - this.origin.y) >= DRAG_THRESHOLD_PX) this.isDragging = true;
    this.editor().root.handleEvent(this.info('pointer_move', e, this.isPointing ? this.target : target ?? { kind: 'canvas' }));
  }

  pointerUp(e: PointerEvent | React.PointerEvent): void {
    if (!this.isPointing) return;
    this.modifiers(e);
    this.current = { x: e.clientX, y: e.clientY };
    this.currentWorld = this.worldOf(this.current);
    this.offWindow?.();
    this.offWindow = null;
    const info = this.info('pointer_up', e, this.target);
    this.isPointing = false;
    this.editor().root.handleEvent(info);
    this.isDragging = false;
  }

  rightClick(e: React.MouseEvent, target: PointerTarget): void {
    this.modifiers(e);
    this.editor().root.handleEvent(this.info('right_click', { ...e, button: 2 }, target));
  }

  /** The world delta of the drag so far. */
  dragDelta(): Placed {
    return { x: this.currentWorld.x - this.originWorld.x, y: this.currentWorld.y - this.originWorld.y };
  }

  /** The client delta of the drag so far. */
  dragDeltaClient(): Placed {
    return { x: this.current.x - this.origin.x, y: this.current.y - this.origin.y };
  }

  keyDown(e: KeyboardEvent): void {
    this.shiftKey = e.shiftKey;
    this.ctrlKey = e.ctrlKey || e.metaKey;
    this.altKey = e.altKey;
    if (e.code === 'Space') this.spaceKey = true;
    this.editor().root.handleEvent({ type: 'key', name: 'key_down', key: e.key, code: e.code, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey || e.metaKey, altKey: e.altKey, preventDefault: () => e.preventDefault() });
  }

  keyUp(e: KeyboardEvent): void {
    this.shiftKey = e.shiftKey;
    this.ctrlKey = e.ctrlKey || e.metaKey;
    this.altKey = e.altKey;
    if (e.code === 'Space') this.spaceKey = false;
    this.editor().root.handleEvent({ type: 'key', name: 'key_up', key: e.key, code: e.code, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey || e.metaKey, altKey: e.altKey, preventDefault: () => e.preventDefault() });
  }

  /** Drops a press mid-way (a window blur, a tool switch). */
  interrupt(): void {
    if (!this.isPointing) return;
    this.offWindow?.();
    this.offWindow = null;
    this.isPointing = false;
    this.isDragging = false;
    this.editor().root.handleEvent({ type: 'cancel' });
  }

  /** True when a key lands in a typing surface, never on the canvas. */
  static inField(e: KeyboardEvent): boolean {
    const el = e.target as HTMLElement | null;
    const tag = el?.tagName ?? '';
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable === true;
  }
}
