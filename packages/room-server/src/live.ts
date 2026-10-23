import type postgres from 'postgres';
import { createLiveDeltas, type BindingDelta, type EffectsPush, type HostLookup, type LiveTarget } from '@tent-nocode/kernel';
import { roomLiveTarget } from './data.js';
import { withTenant } from './tenancy.js';

// THE ROOM'S PUSH ROUTE (Phase 12, ruling 8): one SSE stream per open page at ROOM_LIVE_ROUTE. The rooms
// database has no NOTIFY, so the writers in this process announce what they changed (the action door, the
// flow sweep) and the kernel's delta computer executes each page's affected bindings under that page's
// own tenant and user and pushes {binding, rows} (A2UI's updateDataModel shape). Effects of a run that
// settled after its answer push the same way.

const KEEPALIVE_MS = 25_000;

interface RoomLiveClient {
  app: HostLookup;
  sceneSlug: string | undefined;
  rowKey: string | undefined;
  endUserId: string | null;
  write(chunk: string): void;
  /** The target resolved at attach; re-resolved when the release changes. */
  target: LiveTarget | null;
  releaseId: string | null;
}

export interface RoomLiveHub {
  /** Attaches one page; the sink receives SSE frames; the return detaches. */
  attach(app: HostLookup, watch: { scene?: string; key?: string; endUserId: string | null }, sink: { write(chunk: string): void }): () => void;
  /** An in-process writer announces what changed for an org. */
  announce(a: { orgId: string; tables?: string[]; all?: boolean; executions?: string[] }): void;
  /** Open streams, for the record. */
  size(): number;
  close(): void;
}

function frame(msg: BindingDelta | EffectsPush): string {
  return `event: ${msg.kind}\ndata: ${JSON.stringify(msg)}\n\n`;
}

export function createRoomLiveHub(deps: { sql: postgres.Sql }): RoomLiveHub {
  const clients = new Set<RoomLiveClient>();
  const byTarget = new WeakMap<LiveTarget, RoomLiveClient>();
  const keepalive = setInterval(() => { for (const c of clients) c.write(':ka\n\n'); }, KEEPALIVE_MS);
  keepalive.unref();

  const resolveTarget = async (c: RoomLiveClient): Promise<LiveTarget | null> => {
    if (c.target !== null && c.releaseId === c.app.currentReleaseId) return c.target;
    const target = await withTenant(deps.sql, { orgId: c.app.orgId, endUserId: c.endUserId }, (tx) =>
      roomLiveTarget(tx, c.app, c.sceneSlug, c.rowKey, c.endUserId));
    c.target = target;
    c.releaseId = c.app.currentReleaseId;
    if (target !== null) byTarget.set(target, c);
    return target;
  };

  const deltas = createLiveDeltas({
    run: (orgId, fn, ctx) => withTenant(deps.sql, { orgId, endUserId: ctx?.endUserId ?? null }, fn),
    targets: async (orgId) => {
      const out: LiveTarget[] = [];
      for (const c of clients) {
        if (c.app.orgId !== orgId) continue;
        const t = await resolveTarget(c).catch(() => null);
        if (t !== null) out.push(t);
      }
      return out;
    },
    push: (orgId, msg, target) => {
      const one = target !== null ? byTarget.get(target) : undefined;
      if (one !== undefined) { one.write(frame(msg)); return; }
      // No target named the watcher: every page of the org on that screen hears it.
      for (const c of clients) {
        if (c.app.orgId !== orgId) continue;
        if (msg.kind === 'effects' && c.target !== null && c.target.slug !== msg.scene) continue;
        c.write(frame(msg));
      }
    },
  });

  return {
    attach(app, watch, sink) {
      const client: RoomLiveClient = {
        app, sceneSlug: watch.scene, rowKey: watch.key, endUserId: watch.endUserId,
        write: (chunk) => { try { sink.write(chunk); } catch { /* a closed socket drops its frame */ } },
        target: null, releaseId: null,
      };
      clients.add(client);
      client.write(':connected\n\n');
      void resolveTarget(client).catch(() => undefined);
      return () => { clients.delete(client); };
    },
    announce: (a) => deltas.announce(a),
    size: () => clients.size,
    close() {
      clearInterval(keepalive);
      deltas.stop();
      clients.clear();
    },
  };
}
