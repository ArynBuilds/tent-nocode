// Deterministic array stats computed once at registration; NaNs are counted but excluded from all other stats.

export interface ArrayStats {
  min: number;
  max: number;
  mean: number;
  std: number;
  histogram: number[];
  nonzero: number;
  nans: number;
  count: number;
}

export const ARRAY_STATS_BINS = 32;

export type StatsChunk =
  | Float32Array | Float64Array | Int16Array | Int32Array | Uint8Array | Uint16Array;

/** Two-pass fold; `makeChunks` must yield the same element stream on each call. */
export function foldArrayStats(makeChunks: () => Iterable<StatsChunk>): ArrayStats {
  let count = 0, nans = 0, nonzero = 0;
  let min = Number.POSITIVE_INFINITY, max = Number.NEGATIVE_INFINITY;
  let mean = 0, m2 = 0, finite = 0;
  for (const chunk of makeChunks()) {
    for (let i = 0; i < chunk.length; i++) {
      const v = chunk[i]!;
      count++;
      if (Number.isNaN(v)) { nans++; continue; }
      if (v !== 0) nonzero++;
      if (v < min) min = v;
      if (v > max) max = v;
      finite++;
      const delta = v - mean;
      mean += delta / finite;
      m2 += delta * (v - mean);
    }
  }
  if (finite === 0) {
    return { min: 0, max: 0, mean: 0, std: 0, histogram: new Array<number>(ARRAY_STATS_BINS).fill(0), nonzero, nans, count };
  }
  const std = finite > 1 ? Math.sqrt(m2 / finite) : 0;
  const histogram = new Array<number>(ARRAY_STATS_BINS).fill(0);
  const span = max - min;
  for (const chunk of makeChunks()) {
    for (let i = 0; i < chunk.length; i++) {
      const v = chunk[i]!;
      if (Number.isNaN(v)) continue;
      const bin = span === 0 ? 0 : Math.min(ARRAY_STATS_BINS - 1, Math.floor(((v - min) / span) * ARRAY_STATS_BINS));
      histogram[bin]!++;
    }
  }
  return { min, max, mean, std, histogram, nonzero, nans, count };
}

/** One compact summary line, e.g. "mean 412 · range 0..2041 · 12% nonzero". */
export function statsGlance(stats: ArrayStats): string {
  const sig = (n: number): string => {
    if (!Number.isFinite(n)) return String(n);
    if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
    return Number(n.toPrecision(4)).toString();
  };
  const pct = stats.count > 0 ? Math.round((stats.nonzero / stats.count) * 100) : 0;
  return `mean ${sig(stats.mean)} · range ${sig(stats.min)}..${sig(stats.max)} · ${pct}% nonzero`
    + (stats.nans > 0 ? ` · ${stats.nans} NaN` : '');
}
