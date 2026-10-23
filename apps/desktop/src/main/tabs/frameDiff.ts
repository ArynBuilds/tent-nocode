import type { CapturedFrame } from './frameVariance.js';

// Block-wise luminance diff between two captured frames; different sizes diff as fully changed.

const GRID = 16; // 16x16 sample blocks
const BLOCK_LUMA_DELTA = 8; // mean-luminance delta that marks a block changed

export interface FrameDiff {
  /** Fraction (0..1) of sample blocks whose mean luminance moved. */
  changedFraction: number;
  /** Bounding box of changed blocks (pixels), null when nothing moved. */
  region: { x: number; y: number; w: number; h: number } | null;
}

function blockLuma(frame: CapturedFrame, gx: number, gy: number): number {
  const { width, height } = frame.getSize();
  const bmp = frame.getBitmap();
  const x0 = Math.floor((gx * width) / GRID);
  const x1 = Math.floor(((gx + 1) * width) / GRID);
  const y0 = Math.floor((gy * height) / GRID);
  const y1 = Math.floor(((gy + 1) * height) / GRID);
  let sum = 0;
  let n = 0;
  const stepX = Math.max(1, Math.floor((x1 - x0) / 8));
  const stepY = Math.max(1, Math.floor((y1 - y0) / 8));
  for (let y = y0; y < y1; y += stepY) {
    for (let x = x0; x < x1; x += stepX) {
      const i = (y * width + x) * 4; // BGRA
      sum += 0.114 * bmp[i]! + 0.587 * bmp[i + 1]! + 0.299 * bmp[i + 2]!;
      n++;
    }
  }
  return n === 0 ? 0 : sum / n;
}

export function diffFrames(before: CapturedFrame, after: CapturedFrame): FrameDiff {
  const a = before.getSize();
  const b = after.getSize();
  if (a.width !== b.width || a.height !== b.height) {
    return { changedFraction: 1, region: { x: 0, y: 0, w: b.width, h: b.height } };
  }
  let changed = 0;
  let minX = GRID; let minY = GRID; let maxX = -1; let maxY = -1;
  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      const delta = Math.abs(blockLuma(before, gx, gy) - blockLuma(after, gx, gy));
      if (delta <= BLOCK_LUMA_DELTA) continue;
      changed++;
      if (gx < minX) minX = gx;
      if (gy < minY) minY = gy;
      if (gx > maxX) maxX = gx;
      if (gy > maxY) maxY = gy;
    }
  }
  if (changed === 0) return { changedFraction: 0, region: null };
  const px = (g: number, span: number): number => Math.floor((g * span) / GRID);
  return {
    changedFraction: changed / (GRID * GRID),
    region: {
      x: px(minX, b.width),
      y: px(minY, b.height),
      w: px(maxX + 1, b.width) - px(minX, b.width),
      h: px(maxY + 1, b.height) - px(minY, b.height),
    },
  };
}
