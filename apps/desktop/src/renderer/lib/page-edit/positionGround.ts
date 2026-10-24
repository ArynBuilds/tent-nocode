import { keyBetween, primitiveOfNode, primitiveRef } from '@nodeloom/core';
import type { SceneNode } from '@nodeloom/core';
import type { ElementRecord, Rect } from '../canvas/store.js';

// The position ground over the five: a free child carries its own x/y and sizes on the shared groups.
// Pure math over measured rects - align and distribute a set of free siblings, tidy them into a flow
// frame, read a payload's x/y - and pure node builders; the store writes and the history record them.

export type AlignMode = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The x/y and size a payload stores (frame units); a flow child's x/y are derived and may be absent. */
export function offsetsOf(payload: Record<string, unknown>): { x: number | null; y: number | null; width: number | null; height: number | null } {
  return { x: num(payload['x']), y: num(payload['y']), width: num(payload['width']), height: num(payload['height']) };
}

/** A container-relative rect from a drawn rect; sizes floored at 8; x/y may go negative (off-edge is legal). */
export function relativeRect(drawn: Rect, container: { x: number; y: number }): { x: number; y: number; width: number; height: number } {
  return { x: Math.round(drawn.x - container.x), y: Math.round(drawn.y - container.y), width: Math.max(8, Math.round(drawn.w)), height: Math.max(8, Math.round(drawn.h)) };
}

/** Align the rects inside their shared bounds - pure math. */
export function alignRects(rects: Record<string, Rect>, mode: AlignMode): Record<string, Rect> {
  const list = Object.values(rects);
  if (list.length < 2) return { ...rects };
  const left = Math.min(...list.map((r) => r.x));
  const right = Math.max(...list.map((r) => r.x + r.w));
  const top = Math.min(...list.map((r) => r.y));
  const bottom = Math.max(...list.map((r) => r.y + r.h));
  const out: Record<string, Rect> = {};
  for (const [id, r] of Object.entries(rects)) {
    out[id] = {
      ...r,
      ...(mode === 'left' ? { x: left } : mode === 'right' ? { x: right - r.w } : mode === 'center' ? { x: Math.round(left + (right - left - r.w) / 2) } : {}),
      ...(mode === 'top' ? { y: top } : mode === 'bottom' ? { y: bottom - r.h } : mode === 'middle' ? { y: Math.round(top + (bottom - top - r.h) / 2) } : {}),
    };
  }
  return out;
}

/** Distribute three or more rects with equal gaps along one axis (the ends stay put). */
export function distributeRects(rects: Record<string, Rect>, axis: 'x' | 'y'): Record<string, Rect> {
  const size = axis === 'x' ? 'w' : 'h';
  const entries = Object.entries(rects).sort((a, b) => a[1][axis] - b[1][axis]);
  if (entries.length < 3) return { ...rects };
  const first = entries[0]![1];
  const last = entries[entries.length - 1]![1];
  const span = (last[axis] + last[size]) - first[axis];
  const total = entries.reduce((s, [, r]) => s + r[size], 0);
  const gap = (span - total) / (entries.length - 1);
  const out: Record<string, Rect> = {};
  let cursor = first[axis];
  for (const [id, r] of entries) { out[id] = { ...r, [axis]: Math.round(cursor) }; cursor += r[size] + gap; }
  return out;
}

/** The element with its x/y set from a container-relative rect (a free child). */
export function placedElement(el: ElementRecord, rect: { x: number; y: number; width?: number; height?: number }): ElementRecord {
  const prim = primitiveOfNode(el.node);
  if (prim === null) return el;
  const payload: Record<string, unknown> = { ...prim.payload, x: rect.x, y: rect.y };
  if (rect.width !== undefined && payload['width'] === undefined) payload['width'] = rect.width;
  if (rect.height !== undefined && payload['height'] === undefined) payload['height'] = rect.height;
  return { ...el, node: { ...el.node, components: { ...el.node.components, [prim.ref]: payload } } };
}

/** The elements aligned or distributed: one put per member (the aligned rect wins its axis). */
export function alignElements(
  members: ReadonlyArray<{ el: ElementRecord; rect: Rect }>, parentRect: Rect,
  verb: { kind: 'align'; mode: AlignMode } | { kind: 'distribute'; axis: 'x' | 'y' },
): ElementRecord[] {
  const rel: Record<string, Rect> = {};
  for (const m of members) rel[m.el.node.id] = { x: m.rect.x - parentRect.x, y: m.rect.y - parentRect.y, w: m.rect.w, h: m.rect.h };
  const moved = verb.kind === 'align' ? alignRects(rel, verb.mode) : distributeRects(rel, verb.axis);
  return members.map((m) => { const to = moved[m.el.node.id]!; return placedElement(m.el, { x: Math.round(to.x), y: Math.round(to.y) }); });
}

/** The visual order, the axis the rects separate along, and the gap the hand already left (the median). */
export function tidyPlan(members: ReadonlyArray<{ id: string; rect: Rect }>): { direction: 'row' | 'column'; order: string[]; gap: number; bounds: Rect } {
  const apart = (axis: 'x' | 'y'): number => {
    const size = axis === 'x' ? 'w' : 'h';
    const s = [...members].sort((a, b) => a.rect[axis] - b.rect[axis]);
    let n = 0;
    for (let i = 1; i < s.length; i++) if (s[i]!.rect[axis] >= s[i - 1]!.rect[axis] + s[i - 1]!.rect[size] - 1) n += 1;
    return n;
  };
  const direction: 'row' | 'column' = apart('x') > apart('y') ? 'row' : 'column';
  const [axis, size] = direction === 'row' ? (['x', 'w'] as const) : (['y', 'h'] as const);
  const cross = direction === 'row' ? ('y' as const) : ('x' as const);
  const sorted = [...members].sort((a, b) => a.rect[axis] - b.rect[axis] || a.rect[cross] - b.rect[cross]);
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i]!.rect[axis] - (sorted[i - 1]!.rect[axis] + sorted[i - 1]!.rect[size]));
  gaps.sort((a, b) => a - b);
  const median = gaps.length > 0 ? gaps[Math.floor(gaps.length / 2)]! : 8;
  const left = Math.min(...members.map((m) => m.rect.x));
  const top = Math.min(...members.map((m) => m.rect.y));
  const right = Math.max(...members.map((m) => m.rect.x + m.rect.w));
  const bottom = Math.max(...members.map((m) => m.rect.y + m.rect.h));
  return { direction, order: sorted.map((m) => m.id), gap: Math.min(64, Math.max(0, Math.round(median))), bounds: { x: left, y: top, w: right - left, h: bottom - top } };
}

/** Tidy into a flow: a new row or column frame at the members' bounds, the members moved inside in visual order. */
export function tidyIntoStack(input: {
  scene: string;
  parentId: string;
  parentRect: Rect;
  members: ReadonlyArray<{ el: ElementRecord; rect: Rect }>;
  frameId: string;
  frameOrder: string;
  elementId: (scene: string, nodeId: string) => string;
}): ElementRecord[] {
  const plan = tidyPlan(input.members.map((m) => ({ id: m.el.node.id, rect: m.rect })));
  const rel = relativeRect(plan.bounds, input.parentRect);
  const frame: SceneNode = {
    id: input.frameId, parent: input.parentId, order: input.frameOrder,
    components: { [primitiveRef('frame')]: { layout: plan.direction, gap: plan.gap, x: rel.x, y: rel.y, width: rel.width } },
  };
  const out: ElementRecord[] = [{ typeName: 'element', id: input.elementId(input.scene, frame.id), scene: input.scene, node: frame }];
  let lo: string | null = null;
  for (const id of plan.order) {
    const m = input.members.find((x) => x.el.node.id === id)!;
    const prim = primitiveOfNode(m.el.node);
    const payload = prim !== null ? { ...prim.payload } : null;
    if (payload !== null) delete payload['free'];
    lo = keyBetween(lo, null);
    out.push({ ...m.el, node: { ...m.el.node, parent: frame.id, order: lo, components: prim !== null && payload !== null ? { ...m.el.node.components, [prim.ref]: payload } : m.el.node.components } });
  }
  return out;
}
