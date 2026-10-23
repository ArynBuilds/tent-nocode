import type { WireKindName } from '@tent-nocode/core';
import type { Placed } from '../../lib/canvas/store.js';
import type { EngineEdge } from './CanvasEngine.js';
import type { ChromeWire } from './CanvasChrome.js';
import styles from './canvas.module.css';

// THE WIRES (Phase 12, row 12.16): one geometry for the landed wires and the chrome that rides them (parallel
// lanes for same-pair wires, the fan into a focused screen's reader), the SVG that draws them with the
// wire-kind line grammar, the wire in flight, the element wire overlay in screen space, and the refusal
// sentence at a drop point.

export interface WireEndsGeom { x1: number; y1: number; x2: number; y2: number; mid: number; /** +1: leaves a right edge into a left edge; -1 the mirror. */ dir?: 1 | -1 }
export interface EdgeAnchor { left: number; right: number; y: number }

/** A tall end (a screen's frame) takes the wire at the height nearest the other end, not at its middle. */
const TALL = 240;
const along = (y: number, top: number, h: number): number => Math.min(top + h - 32, Math.max(top + 32, y));

/** Wires leave the facing edges of the two cards (each end its own width); a tall end meets the wire where it arrives. */
export function wireEnds(a: Placed, b: Placed, ha: number, hb: number, wa: number, wb: number): WireEndsGeom {
  const leftToRight = a.x + wa / 2 <= b.x + wb / 2;
  const x1 = leftToRight ? a.x + wa : a.x;
  const x2 = leftToRight ? b.x : b.x + wb;
  const ca = a.y + ha / 2;
  const cb = b.y + hb / 2;
  const y1 = ha > TALL ? along(cb, a.y, ha) : ca;
  const y2 = hb > TALL ? along(y1, b.y, hb) : cb;
  return { x1, y1, x2, y2, mid: (x1 + x2) / 2, dir: leftToRight ? 1 : -1 };
}
/** Horizontal tangents leaving the output side and entering the input side, reaching far enough that a short hop,
 * a stacked pair or a wire running backwards still curves softly instead of folding into the cards. */
export const wirePath = (e: WireEndsGeom): string => {
  const out = e.dir ?? (e.x2 >= e.x1 ? 1 : -1);
  // Running backwards (the input sits behind the output): swing out, cross through the gap between the cards, swing in.
  if (out * (e.x2 - e.x1) < 24 && Math.abs(e.y2 - e.y1) > 40) {
    const r = 44;
    const ym = (e.y1 + e.y2) / 2;
    return `M ${e.x1} ${e.y1} C ${e.x1 + out * r * 1.4} ${e.y1}, ${e.x1 + out * r * 1.4} ${ym}, ${e.x1} ${ym} L ${e.x2} ${ym} C ${e.x2 - out * r * 1.4} ${ym}, ${e.x2 - out * r * 1.4} ${e.y2}, ${e.x2} ${e.y2}`;
  }
  const reach = Math.max(56, Math.abs(e.x2 - e.x1) / 2, Math.abs(e.y2 - e.y1) / 3);
  return `M ${e.x1} ${e.y1} C ${e.x1 + out * reach} ${e.y1}, ${e.x2 - out * reach} ${e.y2}, ${e.x2} ${e.y2}`;
};
const spreadWireEnds = (e: WireEndsGeom, dy: number): WireEndsGeom => (dy === 0 ? e : { ...e, y1: e.y1 + dy, y2: e.y2 + dy });
/** The end fans to the reader inside the target frame (entering from whichever side the wire arrives). */
function anchorWireEnd(ends: WireEndsGeom, target: Placed, anchor: EdgeAnchor): WireEndsGeom {
  const enteringLeft = ends.x2 === target.x;
  const x2 = target.x + (enteringLeft ? anchor.left : anchor.right);
  return { ...ends, x2, y2: target.y + anchor.y, mid: (ends.x1 + x2) / 2, dir: enteringLeft ? 1 : -1 };
}

export interface LandedWire {
  from: string;
  to: string;
  hue: string;
  wireKind: WireKindName;
  live?: boolean;
  toAnchor?: EdgeAnchor;
  /** The parallel-lane offset for same-pair wires. */
  spread?: number;
  /** The last run's item-count word at the midpoint. */
  countWord?: string;
}

/** The one positioning for the layer and the chrome: same-pair wires spread into lanes 14 units apart. */
export function engineWireGeometry(
  edges: EngineEdge[], pos: ReadonlyMap<string, Placed>, hFor: (id: string) => number, wFor: (id: string) => number,
): { landed: LandedWire[]; chromeWires: ChromeWire[] } {
  const pairCount = new Map<string, number>();
  for (const e of edges) pairCount.set(`${e.from}>${e.to}`, (pairCount.get(`${e.from}>${e.to}`) ?? 0) + 1);
  const pairSeen = new Map<string, number>();
  const spreadOf = edges.map((e) => {
    const k = `${e.from}>${e.to}`;
    const n = pairCount.get(k) ?? 1;
    const i = pairSeen.get(k) ?? 0;
    pairSeen.set(k, i + 1);
    return n === 1 ? 0 : (i - (n - 1) / 2) * 14;
  });
  const landed: LandedWire[] = edges.map((e, i) => ({
    from: e.from, to: e.to, hue: e.hue, wireKind: e.wireKind ?? 'data', live: e.live,
    ...(spreadOf[i] !== 0 ? { spread: spreadOf[i] } : {}),
    ...(e.toAnchor !== undefined ? { toAnchor: e.toAnchor } : {}),
    ...(e.countWord !== undefined ? { countWord: e.countWord } : {}),
  }));
  const chromeWires: ChromeWire[] = edges.flatMap((e, i) => {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    if (!a || !b) return [];
    const ends = spreadWireEnds(wireEnds(a, b, hFor(e.from), hFor(e.to), wFor(e.from), wFor(e.to)), spreadOf[i] ?? 0);
    return [{ index: i, ends: e.toAnchor !== undefined ? anchorWireEnd(ends, b, e.toAnchor) : ends, onSplice: e.onSplice, onRemove: e.onRemove }];
  });
  return { landed, chromeWires };
}

function kindClass(kind: WireKindName, live: boolean): string {
  const base = (live ? styles.edgeLive : styles.edge) ?? '';
  if (kind === 'watch') return `${base} ${styles.edgeWatch}`;
  if (kind === 'permission') return `${base} ${styles.edgePermission}`;
  if (kind === 'flow') return `${base} ${styles.edgeFlow}`;
  return base;
}

/** A spark of light rides each wire from its source, so a connection always shows which way it runs. */
const SPARKS = typeof window === 'undefined' || !window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function LandedWires({ wires, pos, hFor, wFor, bounds, selected = null, onSelect }: {
  wires: LandedWire[];
  pos: ReadonlyMap<string, Placed>;
  hFor: (id: string) => number;
  wFor: (id: string) => number;
  bounds: { w: number; h: number };
  /** The selected wire's index: it brightens and thickens so it reads as picked. */
  selected?: number | null;
  onSelect?: (index: number) => void;
}) {
  return (
    <svg className={styles.edges} width={bounds.w} height={bounds.h}>
      <defs>
        <marker id="wireArrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 8 4 L 0 8 z" fill="var(--t2)" />
        </marker>
      </defs>
      {wires.map((w, i) => {
        const a = pos.get(w.from);
        const b = pos.get(w.to);
        if (!a || !b) return null;
        const ends = spreadWireEnds(wireEnds(a, b, hFor(w.from), hFor(w.to), wFor(w.from), wFor(w.to)), w.spread ?? 0);
        const geom = w.toAnchor !== undefined ? anchorWireEnd(ends, b, w.toAnchor) : ends;
        const d = wirePath(geom);
        return (
          <g key={i}>
            {selected === i ? <path className={styles.edgeHalo} d={d} vectorEffect="non-scaling-stroke" /> : null}
            <path className={`${kindClass(w.wireKind, w.live === true)} ${selected === i ? styles.edgeSelected : ''}`} style={{ stroke: selected === i ? 'var(--select)' : w.hue }} d={d} vectorEffect="non-scaling-stroke" />
            <circle className={styles.wireCap} cx={geom.x1} cy={geom.y1} style={{ fill: w.hue }} />
            <circle className={styles.wireCap} cx={geom.x2} cy={geom.y2} style={{ fill: w.hue }} />
            {SPARKS ? (
              <circle className={styles.wireSpark}>
                <animateMotion dur={w.live === true ? '1.4s' : '3.6s'} begin={`${(i * 0.53) % 3.6}s`} repeatCount="indefinite" path={d} />
              </circle>
            ) : null}
            {w.countWord !== undefined ? (
              <text className={styles.wireCount} x={(geom.x1 + geom.x2) / 2} y={(geom.y1 + geom.y2) / 2 - 6} textAnchor="middle">{w.countWord}</text>
            ) : null}
            <path className={styles.edgeHit} d={d} vectorEffect="non-scaling-stroke" onPointerDown={(e) => e.stopPropagation()} onClick={onSelect !== undefined ? () => onSelect(i) : undefined} />
          </g>
        );
      })}
    </svg>
  );
}

/** The wire in flight, world units. */
export function WireLayer({ from, to }: { from: Placed; to: Placed }) {
  const d = wirePath({ x1: from.x, y1: from.y, x2: to.x, y2: to.y, mid: (from.x + to.x) / 2, dir: 1 });
  return (
    <svg className={styles.edges} width={Math.max(from.x, to.x) + 40} height={Math.max(from.y, to.y) + 40}>
      <path className={styles.wireDrag} d={d} vectorEffect="non-scaling-stroke" />
      <circle className={styles.wireCap} cx={from.x} cy={from.y} style={{ fill: 'var(--select)' }} />
      <circle className={styles.wireDragEnd} cx={to.x} cy={to.y} />
    </svg>
  );
}

/** An element's wire in flight, screen px over the whole canvas. */
export function ElementWireOverlay({ drag }: { drag: { from: Placed; to: Placed } | null }) {
  if (drag === null) return null;
  const mid = (drag.from.x + drag.to.x) / 2;
  return (
    <svg className={styles.elWireOverlay}>
      <path d={`M ${drag.from.x} ${drag.from.y} C ${mid} ${drag.from.y}, ${mid} ${drag.to.y}, ${drag.to.x} ${drag.to.y}`} />
    </svg>
  );
}

/** The quiet refusal at a drop point. */
export function DropRefusal({ at, sentence }: { at: Placed; sentence: string }) {
  return <div className={styles.dropRefusal} style={{ left: at.x, top: at.y }}>{sentence}</div>;
}
