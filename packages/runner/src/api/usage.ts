import type { RunUsage } from '@nodeloom/core';

// Maps AI SDK usage onto the effective-token weighting shared with the CLI lane.
// SDK inputTokens is the TOTAL prompt count; the CLI's is uncached input - normalize first.

/** Duck-typed AI SDK usage shape; absent fields map to null, never a guess. */
export interface LoopUsageLike {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  inputTokenDetails?: {
    noCacheTokens?: number | undefined;
    cacheReadTokens?: number | undefined;
    cacheWriteTokens?: number | undefined;
  } | undefined;
}

const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** AI SDK usage to the four raw CLI-shaped components; null when nothing arrived. */
export function componentsFromLoopUsage(usage: LoopUsageLike | null | undefined): RunUsage | null {
  if (usage === null || usage === undefined) return null;
  const total = n(usage.inputTokens);
  const cacheRead = n(usage.inputTokenDetails?.cacheReadTokens);
  const cacheWrite = n(usage.inputTokenDetails?.cacheWriteTokens);
  const noCache = n(usage.inputTokenDetails?.noCacheTokens);
  const output = n(usage.outputTokens);
  // Uncached input: the detail when reported, else total minus cache components, floored at 0.
  const input = noCache !== null
    ? noCache
    : total !== null ? Math.max(0, total - (cacheRead ?? 0) - (cacheWrite ?? 0)) : null;
  if (input === null && output === null && cacheRead === null && cacheWrite === null) return null;
  return { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite };
}

/** Effective tokens: the standing weighting, identical to the CLI lane's. */
export function effectiveTokens(usage: RunUsage | null): number | null {
  if (usage === null) return null;
  return Math.round(
    (usage.inputTokens ?? 0)
    + 1.25 * (usage.cacheWriteTokens ?? 0)
    + 0.1 * (usage.cacheReadTokens ?? 0)
    + 5 * (usage.outputTokens ?? 0),
  );
}

/** Default per-turn ceiling; 0 or negative means the ceiling is off. */
export const DEFAULT_TURN_EFFECTIVE_TOKEN_CEILING = 400_000;

/** The honest sentence spoken exactly once when the ceiling stops a turn. */
export function turnCeilingSentence(spentEffective: number, ceiling: number): string {
  return `Stopped here: this turn spent its token ceiling (${spentEffective.toLocaleString('en-US')} of ${ceiling.toLocaleString('en-US')} effective tokens). Send a follow-up message to continue.`;
}
