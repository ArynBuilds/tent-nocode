import type postgres from 'postgres';
import { emitEvent } from '../events.js';

// Room registry: rooms/room_apps rows, reserved-slug wall, and the host lookup for routing.

const ACTOR = 'kernel.rooms';

/** Subdomain names an app may never claim. */
export const RESERVED_APP_SLUGS: ReadonlySet<string> = new Set([
  'www', 'api', 'admin', 'tent-nocode', 'mail', 'login', 'auth', 'app', 'apps', 'cdn',
  'static', 'status', 'docs', 'account', 'billing', 'download', 'help', 'support',
]);

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function validateAppSlug(slug: string): { ok: true } | { ok: false; error: string } {
  if (!SLUG_RE.test(slug)) return { ok: false, error: `app slug '${slug}' must be lowercase letters, digits and dashes (max 63 chars)` };
  if (RESERVED_APP_SLUGS.has(slug)) return { ok: false, error: `'${slug}' is a reserved name — pick another slug` };
  return { ok: true };
}

export interface RoomRow { id: string; orgId: string; slug: string; status: 'live' | 'suspended' }

/** Mint-or-return the account's one room. */
export async function ensureRoom(sql: postgres.Sql, input: { orgId: string; slug: string }): Promise<RoomRow> {
  const [existing] = await sql<Array<Record<string, unknown>>>`
    select id, org_id, slug, status from rooms where org_id = ${input.orgId}`;
  if (existing) return roomRow(existing);
  const v = validateAppSlug(input.slug);
  if (!v.ok) throw new Error(v.error);
  const [row] = await sql<Array<Record<string, unknown>>>`
    insert into rooms (org_id, slug) values (${input.orgId}, ${input.slug})
    on conflict (org_id) do update set org_id = excluded.org_id
    returning id, org_id, slug, status`;
  if (!row) throw new Error('room insert returned no row');
  await emitEvent(sql, { orgId: input.orgId, actor: ACTOR, type: 'room.created', payload: { roomId: row['id'], slug: input.slug } });
  return roomRow(row);
}

export interface RoomAppRow {
  id: string; roomId: string; orgId: string; appSlug: string; title: string;
  currentReleaseId: string | null; visibility: 'public' | 'unlisted' | 'off';
}

export async function ensureRoomApp(
  sql: postgres.Sql,
  input: { roomId: string; orgId: string; appSlug: string; title: string },
): Promise<RoomAppRow> {
  const v = validateAppSlug(input.appSlug);
  if (!v.ok) throw new Error(v.error);
  const [existing] = await sql<Array<Record<string, unknown>>>`
    select id, room_id, org_id, app_slug, title, current_release_id, visibility
    from room_apps where app_slug = ${input.appSlug}`;
  if (existing) {
    if (existing['org_id'] !== input.orgId) throw new Error(`app slug '${input.appSlug}' is already taken`);
    return appRow(existing);
  }
  const [row] = await sql<Array<Record<string, unknown>>>`
    insert into room_apps (room_id, org_id, app_slug, title)
    values (${input.roomId}, ${input.orgId}, ${input.appSlug}, ${input.title})
    returning id, room_id, org_id, app_slug, title, current_release_id, visibility`;
  if (!row) throw new Error('room_app insert returned no row');
  await emitEvent(sql, { orgId: input.orgId, actor: ACTOR, type: 'room.app_created', payload: { appId: row['id'], appSlug: input.appSlug } });
  return appRow(row);
}

export interface HostLookup {
  orgId: string; roomId: string; appId: string; appSlug: string;
  currentReleaseId: string | null; visibility: string; roomStatus: string;
}

/** Routing lookup: app slug to account and app; runs outside tenant context since it establishes the tenant. */
export async function lookupApp(sql: postgres.Sql, appSlug: string): Promise<HostLookup | null> {
  const [row] = await sql<Array<Record<string, unknown>>>`
    select a.id as app_id, a.org_id, a.room_id, a.app_slug, a.current_release_id, a.visibility, r.status as room_status
    from room_apps a join rooms r on r.id = a.room_id
    where a.app_slug = ${appSlug}`;
  if (!row) return null;
  return {
    orgId: row['org_id'] as string, roomId: row['room_id'] as string, appId: row['app_id'] as string,
    appSlug: row['app_slug'] as string, currentReleaseId: (row['current_release_id'] as string | null) ?? null,
    visibility: row['visibility'] as string, roomStatus: row['room_status'] as string,
  };
}

/** Suspend or resume a room; routing honors it within its lookup TTL. */
export async function setRoomStatus(
  sql: postgres.Sql, input: { orgId: string; status: 'live' | 'suspended'; reason: string },
): Promise<void> {
  await sql`update rooms set status = ${input.status} where org_id = ${input.orgId}`;
  await emitEvent(sql, {
    orgId: input.orgId, actor: ACTOR,
    type: input.status === 'suspended' ? 'room.suspended' : 'room.resumed',
    payload: { reason: input.reason },
  });
}

export async function setAppVisibility(
  sql: postgres.Sql, input: { orgId: string; appSlug: string; visibility: 'public' | 'unlisted' | 'off' },
): Promise<void> {
  await sql`update room_apps set visibility = ${input.visibility} where org_id = ${input.orgId} and app_slug = ${input.appSlug}`;
  await emitEvent(sql, { orgId: input.orgId, actor: ACTOR, type: 'room.app_visibility', payload: { appSlug: input.appSlug, visibility: input.visibility } });
}

function roomRow(r: Record<string, unknown>): RoomRow {
  return { id: r['id'] as string, orgId: r['org_id'] as string, slug: r['slug'] as string, status: r['status'] as RoomRow['status'] };
}
function appRow(r: Record<string, unknown>): RoomAppRow {
  return {
    id: r['id'] as string, roomId: r['room_id'] as string, orgId: r['org_id'] as string,
    appSlug: r['app_slug'] as string, title: r['title'] as string,
    currentReleaseId: (r['current_release_id'] as string | null) ?? null,
    visibility: r['visibility'] as RoomAppRow['visibility'],
  };
}
