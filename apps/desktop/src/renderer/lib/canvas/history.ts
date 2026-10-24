import { desk } from '../desk.js';
import {
  emptyDiff, isDiffEmpty, reverseDiff, squashInto, store,
  type ArrangementRecord, type CanvasStore, type ElementRecord, type RecordsDiff, type ScreenRecord,
} from './store.js';
import type { SceneNode } from '@nodeloom/core';

// HISTORY AS DIFFS (Phase 12, row 12.14; tldraw's HistoryManager shape). Every user change to the store
// lands in the pending diff through one interceptor; a gesture marks a stop when it starts and completes
// when it ends; undo reverses the diff and applies it, redo applies it again. The kernel receives the
// diff compiled to the eleven ops through the one sceneApplyOps door (the arrangement and a screen's
// design size through theirs); a refused write reverses the diff locally and speaks the sentence. No
// gesture declares an inverse. A door that minted a standing row (a trigger, a chain, a binding) is a
// revert-only entry: undo runs its door, redo never re-mints.

export type HistoryEntry =
  | { type: 'diff'; diff: RecordsDiff }
  | { type: 'stop'; id: string }
  | { type: 'door'; label: string; revert: () => Promise<{ ok: boolean; sentence?: string }> };

export type SceneOpLike = { op: string; [k: string]: unknown };

export interface CompiledDiff {
  scenes: Map<string, SceneOpLike[]>;
  arrangement: boolean;
  screenSizes: Array<{ slug: string; size: { w: number; h: number } }>;
}

const parentOfEl = (e: ElementRecord): string | null => e.node.parent;

/** The diff as the kernel's ops, per scene; `after` reads the store as it stands after the diff. */
export function compileDiff(after: CanvasStore, diff: RecordsDiff): CompiledDiff {
  const scenes = new Map<string, SceneOpLike[]>();
  const opsFor = (slug: string): SceneOpLike[] => {
    let list = scenes.get(slug);
    if (list === undefined) { list = []; scenes.set(slug, list); }
    return list;
  };
  let arrangement = false;
  const screenSizes: CompiledDiff['screenSizes'] = [];

  const added: ElementRecord[] = [];
  const removed: ElementRecord[] = [];
  const updated: Array<[ElementRecord, ElementRecord]> = [];
  for (const r of Object.values(diff.added)) if (r.typeName === 'element') added.push(r);
  for (const r of Object.values(diff.removed)) if (r.typeName === 'element') removed.push(r);
  for (const [from, to] of Object.values(diff.updated)) {
    if (from.typeName === 'element' && to.typeName === 'element') updated.push([from, to]);
    if (from.typeName === 'arrangement' || to.typeName === 'arrangement') arrangement = true;
    if (from.typeName === 'screen' && to.typeName === 'screen' && (from.size.w !== to.size.w || from.size.h !== to.size.h)) {
      screenSizes.push({ slug: to.slug, size: to.size });
    }
  }
  if (Object.values(diff.added).some((r) => r.typeName === 'arrangement')) arrangement = true;

  // Removes: the topmost of a removed subtree alone (the kernel cascades).
  const removedIds = new Set(removed.map((e) => e.id));
  for (const e of removed) {
    let cur = parentOfEl(e);
    let covered = false;
    while (cur !== null) {
      if (removedIds.has(after.elementId(e.scene, cur))) { covered = true; break; }
      const p = removed.find((x) => x.scene === e.scene && x.node.id === cur) ?? after.element(e.scene, cur);
      cur = p !== undefined ? parentOfEl(p) : null;
    }
    if (!covered) opsFor(e.scene).push({ op: 'remove_node', id: e.node.id });
  }

  // The anchor a node lands at among its siblings in the target document: before the next sibling that already
  // exists at that step, else the end (created siblings after it land at the end too, in order).
  const addedIds = new Set(added.map((e) => e.id));
  const anchorFor = (scene: string, node: SceneNode, createdSoFar: ReadonlySet<string>): { anchor: 'before' | 'after'; ref: string } | { anchor: 'end' } => {
    if (node.parent === null) return { anchor: 'end' };
    const rail = after.childrenOf(scene, node.parent);
    const idx = rail.indexOf(node.id);
    for (let i = idx + 1; i < rail.length; i++) {
      const sib = rail[i]!;
      const sibId = after.elementId(scene, sib);
      if (!addedIds.has(sibId) || createdSoFar.has(sibId)) return { anchor: 'before', ref: sib };
    }
    return { anchor: 'end' };
  };

  // Creates: parents before children, siblings in rail order.
  const depthOf = (e: ElementRecord): number => {
    let d = 0;
    let cur = parentOfEl(e);
    while (cur !== null && d < 64) { d += 1; const p = after.element(e.scene, cur); cur = p !== undefined ? parentOfEl(p) : null; }
    return d;
  };
  const ordered = [...added].sort((a, b) => depthOf(a) - depthOf(b) || (a.node.order < b.node.order ? -1 : a.node.order > b.node.order ? 1 : 0));
  const created = new Set<string>();
  for (const e of ordered) {
    const n = e.node;
    opsFor(e.scene).push({
      op: 'create_node', id: n.id, parent: n.parent ?? 'root', position: anchorFor(e.scene, n, created),
      ...(n.slot !== undefined ? { slot: n.slot } : {}),
      ...(n.variantOf !== undefined ? { variantOf: { set: n.variantOf.set, option: n.variantOf.option } } : {}),
      ...(Object.keys(n.components).length > 0 ? { components: n.components } : {}),
    });
    created.add(e.id);
    for (const [set, decl] of Object.entries(n.variants ?? {})) {
      opsFor(e.scene).push({ op: 'declare_variant_set', node: n.id, set, options: decl.options, default: decl.default });
      if (decl.selection !== undefined) opsFor(e.scene).push({ op: 'set_variant', node: n.id, set, selection: decl.selection });
    }
    for (const [key, target] of Object.entries(n.refs ?? {})) opsFor(e.scene).push({ op: 'set_ref', node: n.id, key, target });
  }

  // Updates: a move, the components (per key, or the whole payload when a key left), the refs, the variants.
  for (const [from, to] of updated) {
    const a = from.node;
    const b = to.node;
    const ops = opsFor(to.scene);
    if (a.parent !== b.parent || a.order !== b.order) {
      ops.push({ op: 'move_node', node: b.id, parent: b.parent ?? 'root', position: anchorFor(to.scene, b, new Set()) });
    }
    for (const [ref, payload] of Object.entries(b.components)) {
      const before = a.components[ref];
      if (before === undefined) { ops.push({ op: 'set_component', node: b.id, component: ref, value: payload }); continue; }
      const gone = Object.keys(before).some((k) => !(k in payload));
      if (gone) { ops.push({ op: 'set_component', node: b.id, component: ref, value: payload }); continue; }
      for (const [key, value] of Object.entries(payload)) {
        if (JSON.stringify(before[key]) !== JSON.stringify(value)) ops.push({ op: 'set_property', node: b.id, component: ref, key, value });
      }
    }
    for (const ref of Object.keys(a.components)) if (!(ref in b.components)) ops.push({ op: 'remove_component', node: b.id, component: ref });
    const refsA = a.refs ?? {};
    const refsB = b.refs ?? {};
    for (const [key, target] of Object.entries(refsB)) if (refsA[key] !== target) ops.push({ op: 'set_ref', node: b.id, key, target });
    for (const key of Object.keys(refsA)) if (!(key in refsB)) ops.push({ op: 'remove_ref', node: b.id, key });
    const varA = a.variants ?? {};
    const varB = b.variants ?? {};
    for (const [set, decl] of Object.entries(varB)) {
      const prev = varA[set];
      if (prev === undefined || prev.default !== decl.default || JSON.stringify(prev.options) !== JSON.stringify(decl.options)) {
        ops.push({ op: 'declare_variant_set', node: b.id, set, options: decl.options, default: decl.default });
      }
      if (decl.selection !== undefined && decl.selection !== prev?.selection) ops.push({ op: 'set_variant', node: b.id, set, selection: decl.selection });
      if (decl.selection === undefined && prev?.selection !== undefined) ops.push({ op: 'set_variant', node: b.id, set, selection: decl.default });
    }
    for (const set of Object.keys(varA)) if (!(set in varB)) ops.push({ op: 'remove_variant_set', node: b.id, set });
  }
  for (const [slug, ops] of scenes) if (ops.length === 0) scenes.delete(slug);
  return { scenes, arrangement, screenSizes };
}

export type CommitResult = { ok: true } | { ok: false; sentence: string };

/** The diff reaches the kernel: every scene's ops through sceneApplyOps, the arrangement's debounced write, a screen's size door. */
export async function commitCompiled(orgId: string, compiled: CompiledDiff): Promise<CommitResult> {
  for (const [slug, ops] of compiled.scenes) {
    const res = await desk.sceneApplyOps(orgId, slug, ops).catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : 'the edit did not reach the kernel' }));
    if (!res.ok) return { ok: false, sentence: res.error };
    if (res.data !== undefined && !res.data.ok) return { ok: false, sentence: res.data.errors.join(' · ') };
  }
  for (const s of compiled.screenSizes) {
    const res = await desk.humanSetTargetScreen(orgId, s.slug, s.size).catch(() => ({ ok: false as const, error: 'the size did not reach the kernel' }));
    if (!res.ok) return { ok: false, sentence: res.error };
  }
  if (compiled.arrangement) store.scheduleArrangementWrite();
  return { ok: true };
}

export class History {
  private undos: HistoryEntry[] = [];
  private redos: HistoryEntry[] = [];
  private pending: RecordsDiff = emptyDiff();
  private paused = false;
  private tick = 0;
  private readonly subs = new Set<() => void>();
  readonly dispose: () => void;

  constructor(private readonly s: CanvasStore, private readonly io: { orgId: () => string | null; quiet: (sentence: string) => void }) {
    this.dispose = s.listen((diff, source) => {
      if (source !== 'user' || this.paused) return;
      squashInto(this.pending, diff);
      if (this.redos.length > 0) this.redos = [];
      this.notify();
    });
  }

  onChange(fn: () => void): () => void {
    this.subs.add(fn);
    return () => { this.subs.delete(fn); };
  }
  private notify(): void { this.tick += 1; for (const fn of this.subs) fn(); }

  canUndo(): boolean { return !isDiffEmpty(this.pending) || this.undos.some((e) => e.type !== 'stop'); }
  canRedo(): boolean { return this.redos.length > 0; }
  version(): number { return this.tick; }

  private flushPending(): RecordsDiff | null {
    if (isDiffEmpty(this.pending)) return null;
    const diff = this.pending;
    this.pending = emptyDiff();
    this.undos.push({ type: 'diff', diff });
    return diff;
  }

  /** A gesture starts: everything before it settles into the stack, the stop names the gesture. */
  mark(id: string): string {
    this.flushPending();
    this.undos.push({ type: 'stop', id });
    this.notify();
    return id;
  }

  /** A gesture ends: the pending diff settles and reaches the kernel; a refusal reverses it and speaks. */
  async complete(): Promise<CommitResult> {
    const diff = this.flushPending();
    if (diff === null) return { ok: true };
    const res = await this.send(diff);
    if (!res.ok) {
      this.undos.pop();
      this.paused = true;
      try { this.s.apply(reverseDiff(diff), 'remote'); } finally { this.paused = false; }
      this.io.quiet(res.sentence);
    }
    this.notify();
    return res;
  }

  /** One edit as one entry: mark, run, complete. */
  async transaction(label: string, fn: () => void): Promise<CommitResult> {
    this.mark(label);
    this.s.atomic(fn, 'user');
    return this.complete();
  }

  /** Drops what the running gesture changed since its mark (Esc); nothing reaches the kernel. */
  bail(): void {
    const diff = this.pending;
    this.pending = emptyDiff();
    const toUndo = reverseDiff(diff);
    while (this.undos.length > 0 && this.undos[this.undos.length - 1]!.type !== 'stop') {
      const e = this.undos.pop()!;
      if (e.type === 'diff') squashInto(toUndo, reverseDiff(e.diff));
    }
    if (this.undos[this.undos.length - 1]?.type === 'stop') this.undos.pop();
    this.paused = true;
    try { this.s.apply(toUndo, 'remote'); } finally { this.paused = false; }
    this.notify();
  }

  /** A door that minted a standing row: undo runs its revert; there is no redo. */
  pushDoor(label: string, revert: () => Promise<{ ok: boolean; sentence?: string }>): void {
    this.flushPending();
    this.undos.push({ type: 'door', label, revert });
    this.redos = [];
    this.notify();
  }

  async undo(): Promise<void> {
    const pending = this.pending;
    this.pending = emptyDiff();
    const diffToUndo = reverseDiff(pending);
    const moved: HistoryEntry[] = [];
    if (!isDiffEmpty(pending)) moved.push({ type: 'diff', diff: pending });
    let sawDiff = !isDiffEmpty(pending);
    while (this.undos.length > 0) {
      const top = this.undos[this.undos.length - 1]!;
      if (top.type === 'stop') { this.undos.pop(); moved.push(top); if (sawDiff) break; continue; }
      if (top.type === 'door') {
        if (sawDiff) break;
        this.undos.pop();
        const res = await top.revert();
        if (!res.ok) { this.io.quiet(res.sentence ?? 'that would not come out'); this.undos.push(top); }
        this.notify();
        return;
      }
      this.undos.pop();
      moved.push(top);
      squashInto(diffToUndo, reverseDiff(top.diff));
      sawDiff = true;
    }
    if (isDiffEmpty(diffToUndo)) { this.notify(); return; }
    this.paused = true;
    try { this.s.apply(diffToUndo, 'remote'); } finally { this.paused = false; }
    for (let i = moved.length - 1; i >= 0; i--) this.redos.push(moved[i]!);
    const res = await this.send(diffToUndo);
    if (!res.ok) {
      this.paused = true;
      try { this.s.apply(reverseDiff(diffToUndo), 'remote'); } finally { this.paused = false; }
      for (let i = moved.length - 1; i >= 0; i--) { this.redos.pop(); }
      for (const e of moved.reverse()) this.undos.push(e);
      this.io.quiet(res.sentence);
    }
    this.notify();
  }

  async redo(): Promise<void> {
    this.flushPending();
    if (this.redos.length === 0) return;
    const diffToRedo = emptyDiff();
    const moved: HistoryEntry[] = [];
    while (this.redos.length > 0) {
      const top = this.redos[this.redos.length - 1]!;
      this.redos.pop();
      moved.push(top);
      if (top.type === 'diff') squashInto(diffToRedo, top.diff);
      else if (top.type === 'stop' && moved.some((e) => e.type === 'diff')) break;
    }
    if (isDiffEmpty(diffToRedo)) { for (const e of moved) this.undos.push(e); this.notify(); return; }
    this.paused = true;
    try { this.s.apply(diffToRedo, 'remote'); } finally { this.paused = false; }
    for (const e of moved) this.undos.push(e);
    const res = await this.send(diffToRedo);
    if (!res.ok) {
      this.paused = true;
      try { this.s.apply(reverseDiff(diffToRedo), 'remote'); } finally { this.paused = false; }
      for (let i = 0; i < moved.length; i++) this.undos.pop();
      for (let i = moved.length - 1; i >= 0; i--) this.redos.push(moved[i]!);
      this.io.quiet(res.sentence);
    }
    this.notify();
  }

  private async send(diff: RecordsDiff): Promise<CommitResult> {
    const orgId = this.io.orgId();
    if (orgId === null) return { ok: true };
    return commitCompiled(orgId, compileDiff(this.s, diff));
  }
}

/** The screen a diff touched (the face re-reads its rects after a commit). */
export function scenesTouched(diff: RecordsDiff): Set<string> {
  const out = new Set<string>();
  const each = (r: { typeName: string }): void => { if (r.typeName === 'element') out.add((r as ElementRecord).scene); if (r.typeName === 'screen') out.add((r as ScreenRecord).slug); };
  for (const r of Object.values(diff.added)) each(r);
  for (const r of Object.values(diff.removed)) each(r);
  for (const [, to] of Object.values(diff.updated)) each(to);
  return out;
}

export type { ArrangementRecord };
