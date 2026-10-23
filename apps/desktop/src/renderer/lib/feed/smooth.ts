/**
 * Tier 35 polish (user-asked 2026-07-20): the live-voice reveal pacer. The engine streams
 * output in block-sized bursts (2–15 words at once) — this paces the VISIBLE prefix of the
 * true text at reading speed, accelerating with backlog so it never trails the stream by
 * more than about a second. Lawful under D-39/D-40: streaming is a view, never a truth
 * channel — the pacer touches only what is shown mid-stream; settle renders the verbatim
 * record (live=false snaps to the full text instantly).
 *
 * Pure and deterministic (elapsed injected) so the pacing law is testable without timers.
 */

/** Advance the displayed prefix toward the target by `elapsedMs` worth of reveal. */
export function advanceReveal(displayed: string, target: string, elapsedMs: number): string {
  if (target === displayed) return displayed;
  // The live window slid or the text rewrote (the tail cap drops the head) — never animate
  // a rewrite, snap to truth.
  if (!target.startsWith(displayed)) return target;
  const backlog = target.length - displayed.length;
  // ~70 chars/s reads as fluent typing; the backlog term is the catch-up governor.
  const rate = 70 + backlog * 1.5;
  const n = Math.max(1, Math.round((elapsedMs / 1000) * rate));
  return target.slice(0, displayed.length + n);
}
