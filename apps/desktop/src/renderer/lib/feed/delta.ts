import { stripLiveWindow } from './fences.js';
import type { FeedItem } from './feed.js';

/**
 * FR-180 (D-40): token-level typing deltas — EPHEMERAL by design. They ride IPC straight from
 * the driver hook, are held only in renderer memory, and are dropped the moment the run's
 * persisted text takes over. The cap is a MEMORY GUARD far above any real reply, never a
 * mid-reply slicer: the old 4000 cap was a real-reply size, and its head-slice made streamed
 * bubbles visibly un-write themselves and cut fence openings off the window so raw machinery
 * JSON rendered (live finding 2026-07-13, the website thread — a Law 6 violation).
 */

const DELTA_CAP = 65536;

export function accumulateDelta(state: Map<string, string>, e: { runId: string; text: string }): Map<string, string> {
  const next = new Map(state);
  const merged = (next.get(e.runId) ?? '') + e.text;
  next.set(e.runId, merged.length > DELTA_CAP ? merged.slice(-DELTA_CAP) : merged);
  return next;
}

export function dropDelta(state: Map<string, string>, runId: string): Map<string, string> {
  if (!state.has(runId)) return state;
  const next = new Map(state);
  next.delete(runId);
  return next;
}

/** Live narration prefers the delta stream (fresher than heartbeat-cadence tail refetches);
 * settled items never touch deltas — the persisted text is byte-authoritative. The longer-than
 * comparison runs on the STRIPPED delta: fence JSON is bulk, not prose, and must never let a
 * shorter visible reply beat the persisted tail (Law 6 companion to the stripLiveWindow fix). */
export function overlayDeltas(items: FeedItem[], deltas: Map<string, string>): FeedItem[] {
  if (deltas.size === 0) return items;
  return items.map((item) => {
    if (item.kind !== 'narration' || !item.live) return item;
    const delta = deltas.get(item.runId);
    if (delta === undefined) return item;
    const stripped = stripLiveWindow(delta);
    if (stripped.length <= item.text.length) return item;
    return { ...item, text: stripped };
  });
}
