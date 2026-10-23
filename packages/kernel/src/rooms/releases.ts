import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import { emitEvent } from '../events.js';

// Room release log: append-only and hash-chained; a republish appends and moves the current pointer.

const ACTOR = 'kernel.rooms';

export interface ReleaseRow {
  id: string; roomAppId: string; orgId: string; packageHash: string;
  envelope: Record<string, unknown>; prevReleaseHash: string | null; releaseHash: string;
  entrySceneSlug: string | null; landed: Record<string, unknown>; publishedAt: string;
}

export async function currentRelease(sql: postgres.Sql, roomAppId: string): Promise<ReleaseRow | null> {
  const [row] = await sql<Array<Record<string, unknown>>>`
    select * from room_releases where room_app_id = ${roomAppId}
    order by published_at desc, id desc limit 1`;
  return row ? toRow(row) : null;
}

export async function findReleaseByPackageHash(
  sql: postgres.Sql, input: { roomAppId: string; packageHash: string },
): Promise<ReleaseRow | null> {
  const [row] = await sql<Array<Record<string, unknown>>>`
    select * from room_releases where room_app_id = ${input.roomAppId} and package_hash = ${input.packageHash}
    order by published_at desc limit 1`;
  return row ? toRow(row) : null;
}

/** Append a room release with a verifiable hash chain and move the app's current pointer. */
export async function appendRoomRelease(
  sql: postgres.Sql,
  input: {
    roomAppId: string; orgId: string; packageHash: string;
    envelope: Record<string, unknown>; entrySceneSlug: string | null;
    landed: Record<string, unknown>;
  },
): Promise<ReleaseRow> {
  const prev = await currentRelease(sql, input.roomAppId);
  const prevHash = prev?.releaseHash ?? null;
  const releaseHash = createHash('sha256').update(`${prevHash ?? ''}:${input.packageHash}`).digest('hex');
  const [row] = await sql<Array<Record<string, unknown>>>`
    insert into room_releases (room_app_id, org_id, package_hash, envelope, prev_release_hash, release_hash, entry_scene_slug, landed)
    values (${input.roomAppId}, ${input.orgId}, ${input.packageHash},
            ${sql.json(input.envelope as never)}, ${prevHash}, ${releaseHash},
            ${input.entrySceneSlug}, ${sql.json(input.landed as never)})
    returning *`;
  if (!row) throw new Error('release insert returned no row');
  await sql`update room_apps set current_release_id = ${row['id'] as string} where id = ${input.roomAppId}`;
  await emitEvent(sql, {
    orgId: input.orgId, actor: ACTOR, type: 'room.release_published',
    payload: { roomAppId: input.roomAppId, packageHash: input.packageHash, releaseHash },
  });
  return toRow(row);
}

function toRow(r: Record<string, unknown>): ReleaseRow {
  return {
    id: r['id'] as string, roomAppId: r['room_app_id'] as string, orgId: r['org_id'] as string,
    packageHash: r['package_hash'] as string, envelope: (r['envelope'] as Record<string, unknown>) ?? {},
    prevReleaseHash: (r['prev_release_hash'] as string | null) ?? null, releaseHash: r['release_hash'] as string,
    entrySceneSlug: (r['entry_scene_slug'] as string | null) ?? null,
    landed: (r['landed'] as Record<string, unknown>) ?? {},
    publishedAt: new Date(r['published_at'] as string).toISOString(),
  };
}
