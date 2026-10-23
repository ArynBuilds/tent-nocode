import { useEffect, useState } from 'react';
import type { DeskDelta } from '../../../shared/ipc.js';
import { accumulateDelta } from '../feed/delta.js';

/**
 * FR-180: the renderer's live-typing state — one subscription per mounted caller, a per-run
 * capped text buffer (see delta.ts). Ephemeral by law (D-40): nothing here is ever written
 * anywhere; the persisted turn text wins the moment a run settles (`overlayDeltas` ignores
 * settled narrations, so stale entries are inert — each is ≤4KB and dies with the window).
 */
export function useDeltas(): Map<string, string> {
  const [deltas, setDeltas] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    return window.desk.onDelta((event) => {
      const e = event as DeskDelta;
      if (typeof e?.runId !== 'string' || typeof e?.text !== 'string') return;
      setDeltas((prev) => accumulateDelta(prev, e));
    });
  }, []);
  return deltas;
}
