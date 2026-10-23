import { useSyncExternalStore } from 'react';
import { closeOverlay, openOverlay } from './overlay.js';

/** The project screen's sections; the opener names where it lands. */
export type ProjectSectionId = 'general' | 'publish' | 'export' | 'server' | 'secrets' | 'people';

export interface PublishTakeoverState {
  projectId: string;
  section?: ProjectSectionId;
}

let state: PublishTakeoverState | null = null;
const subscribers = new Set<() => void>();

export function publishTakeoverState(): PublishTakeoverState | null {
  return state;
}

export function openPublishTakeover(next: PublishTakeoverState): void {
  state = next;
  openOverlay();
  for (const notify of subscribers) notify();
}

export function closePublishTakeover(): void {
  if (state === null) return;
  state = null;
  closeOverlay();
  for (const notify of subscribers) notify();
}

/** Subscribe to transitions; returns the unsubscribe (exposed for tests). */
export function subscribePublishTakeover(notify: () => void): () => void {
  subscribers.add(notify);
  return () => subscribers.delete(notify);
}

/** Re-renders the caller on open/close - the useOverlayOpen contract. */
export function usePublishTakeover(): PublishTakeoverState | null {
  return useSyncExternalStore(subscribePublishTakeover, publishTakeoverState);
}
