import type { Rect } from '../store.js';

// THE SNAPS (tldraw's SnapManager, the points half): the edges and centers of the other rects are the
// candidates; a moving or resizing rect snaps whichever of its own edges or center comes within the
// threshold, and the guide that took the snap renders as a hairline. Frame units in, frame units out.

export interface SnapCandidates { xs: number[]; ys: number[] }
export interface SnapResult { x: number; y: number; guideX: number | null; guideY: number | null }

export const SNAP_PX = 6;

export class Snaps {
  private indicators: { x: number | null; y: number | null } = { x: null, y: null };

  candidates(others: readonly Rect[]): SnapCandidates {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const r of others) { xs.push(r.x, r.x + r.w / 2, r.x + r.w); ys.push(r.y, r.y + r.h / 2, r.y + r.h); }
    return { xs, ys };
  }

  /** The moving rect snapped: the first candidate within the threshold on each axis wins. */
  snapRect(moving: Rect, candidates: SnapCandidates, threshold = SNAP_PX): SnapResult {
    let x = moving.x;
    let y = moving.y;
    let guideX: number | null = null;
    let guideY: number | null = null;
    const edgesX = [moving.x, moving.x + moving.w / 2, moving.x + moving.w];
    const edgesY = [moving.y, moving.y + moving.h / 2, moving.y + moving.h];
    let bestX = threshold + 1;
    for (const cx of candidates.xs) {
      for (const ex of edgesX) {
        const d = Math.abs(ex - cx);
        if (d <= threshold && d < bestX) { bestX = d; x = moving.x + (cx - ex); guideX = cx; }
      }
    }
    let bestY = threshold + 1;
    for (const cy of candidates.ys) {
      for (const ey of edgesY) {
        const d = Math.abs(ey - cy);
        if (d <= threshold && d < bestY) { bestY = d; y = moving.y + (cy - ey); guideY = cy; }
      }
    }
    this.indicators = { x: guideX, y: guideY };
    return { x, y, guideX, guideY };
  }

  /** A resize snaps the moving edge alone: the size changes, the fixed corner stays. */
  snapEdge(value: number, axis: 'x' | 'y', candidates: SnapCandidates, threshold = SNAP_PX): { value: number; guide: number | null } {
    const list = axis === 'x' ? candidates.xs : candidates.ys;
    let best = threshold + 1;
    let out = value;
    let guide: number | null = null;
    for (const c of list) {
      const d = Math.abs(c - value);
      if (d <= threshold && d < best) { best = d; out = c; guide = c; }
    }
    return { value: out, guide };
  }

  getIndicators(): { x: number | null; y: number | null } { return this.indicators; }
  clearIndicators(): void { this.indicators = { x: null, y: null }; }
}
