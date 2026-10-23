import type { LiveEvent } from '../../shared/ipc.js';
import { desk } from './desk.js';

/**
 * Renderer-side half of the Realtime replacement (FR-53, desktop form): a thin wrapper over
 * `window.desk.onLive` (via the typed `desk.onLive` client) so components/hooks never touch
 * the raw IPC bridge directly — mirroring the `desk.ts` convention for every other channel.
 *
 * Task 9's data hooks call this to invalidate/refetch the specific query a notify names (e.g.
 * a `{ table: 'runs', ... }` event refetches `getConversation`/`getThread`, never the row
 * payload itself — the notify is a pointer, not data; see the migration + kernel `live.ts`).
 */
export function subscribeLive(handler: (event: LiveEvent) => void): () => void {
  return desk.onLive(handler);
}
