import { useSyncExternalStore } from 'react';

/**
 * D-86 (Tier 23): an open overlay owns the keyboard. One module-level flag, router-style (no
 * context, no prop-drilling): the settings modal flips it, and every window-level key handler
 * that acts on the surface UNDER the overlay (Esc-interrupt FR-178, gate keys FR-189) consults
 * it and yields. Without this, Esc over an open modal cancels a running mission and a stray
 * Enter answers a background consent — the cross-surface keyboard leak class.
 */

let open = false;
const subscribers = new Set<() => void>();

export function isOverlayOpen(): boolean {
  return open;
}

export function openOverlay(): void {
  if (open) return;
  open = true;
  for (const notify of subscribers) notify();
}

export function closeOverlay(): void {
  if (!open) return;
  open = false;
  for (const notify of subscribers) notify();
}

/** Subscribe to transitions; returns the unsubscribe. Exposed for tests and the hook below. */
export function subscribeOverlay(notify: () => void): () => void {
  subscribers.add(notify);
  return () => subscribers.delete(notify);
}

/** Re-renders the calling component on open/close — the same contract as `useRoute()`. */
export function useOverlayOpen(): boolean {
  return useSyncExternalStore(subscribeOverlay, isOverlayOpen);
}
