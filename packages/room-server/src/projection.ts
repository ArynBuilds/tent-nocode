import type postgres from 'postgres';
import { requireScene, serveSceneProjection } from '@tent-nocode/kernel';
import type { HostLookup } from '@tent-nocode/kernel';
import { resolveReleaseScene } from './data.js';
import { withTenant } from './tenancy.js';

// Visitor array-projection lane: delegates to serveSceneProjection under tenant context; bytes cross as base64.

export interface RoomProjectionResult {
  binding: string;
  key: string;
  dtype: string | null;
  shape: number[];
  data: string | null;
  error: string | null;
}

export async function roomSceneProjection(
  sql: postgres.Sql, app: HostLookup,
  input: { scene?: string; binding: string; request: unknown; key?: string },
  /** Opaque end-user id; RLS narrows dataset rows to the user's slice. */
  endUserId?: string | null,
): Promise<RoomProjectionResult | null> {
  if (app.currentReleaseId === null) return null;
  return withTenant(sql, { orgId: app.orgId, endUserId: endUserId ?? null }, async (tx) => {
    const target = await resolveReleaseScene(tx, app, input.scene);
    if (!target) return null;
    const found = await requireScene(tx, app.orgId, target.slug).catch(() => null);
    if (!found) return null;
    const r = await serveSceneProjection(tx, app.orgId, found.id, input.binding, input.request);
    return {
      binding: r.binding,
      key: input.key ?? '',
      dtype: r.dtype,
      shape: r.shape,
      data: r.data !== null ? Buffer.from(new Uint8Array(r.data)).toString('base64') : null,
      error: r.error,
    };
  });
}
