import { useEffect, useRef } from 'react';
import type { LiveComputed, LiveEvent, LiveTable } from '../../../shared/ipc.js';
import { subscribeLive } from '../live.js';
import { useOrg } from '../OrgContext.js';

// The live channel's two hooks over the one stream (Phase 12, ruling 8): useLive filters the desk_live
// pointers by table for the screens that refetch on a pointer; useLivePush hands the computed pushes
// (a binding's fresh rows, a run's effects) to the screen that reads them. Handlers are read through a
// ref so callers never resubscribe on every render.

/** Pointer events (table, op, id) for this device's org, or org-less rows; pair with useQuery's refetch. */
export function useLive(tables: LiveTable[], onChange: (event: LiveEvent) => void): void {
  const { orgId } = useOrg();
  const handlerRef = useRef(onChange);
  handlerRef.current = onChange;
  const tablesKey = tables.join(',');
  useEffect(() => {
    const relevant = new Set(tablesKey.split(',').filter(Boolean));
    return subscribeLive((event) => {
      if ('kind' in event) return;
      if (!relevant.has(event.table)) return;
      if (event.orgId !== null && event.orgId !== orgId) return;
      handlerRef.current(event);
    });
  }, [orgId, tablesKey]);
}

/** The computed pushes for this device's org: {binding, rows} deltas and settled-run effects. */
export function useLivePush(onPush: (push: LiveComputed) => void): void {
  const { orgId } = useOrg();
  const handlerRef = useRef(onPush);
  handlerRef.current = onPush;
  useEffect(() => subscribeLive((event) => {
    if (!('kind' in event)) return;
    if (event.orgId !== orgId) return;
    handlerRef.current(event);
  }), [orgId]);
}
