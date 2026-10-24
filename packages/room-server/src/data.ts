import type postgres from 'postgres';
import { expandInstanceNodes, instanceRefsIn, isSystemQueryTable, sceneBindingsSchema, type SceneBindingFeed } from '@nodeloom/core';
import { executeSceneBinding, getSceneForHost, libraryItemsFor, requireScene, stampIconGlyphs } from '@nodeloom/kernel';
import type { HostLookup, LiveTarget } from '@nodeloom/kernel';
import { withTenant } from './tenancy.js';

// Room data plane: the first feed of a published screen through the one executor under tenant context; the
// deltas after it ride the live route (live.ts) through the same executor. Queries over the project's tables,
// array assets and the clock serve; the system tables and folder assets are desktop facts.

const NOT_SERVED_NOTE = 'this feed shows desktop activity and is not served on the web';

/** Resolve a requested slug against the current release's landed screens; anything else is a 404. Runs inside tenant context. */
export async function resolveReleaseScene(
  tx: postgres.Sql, app: HostLookup, requested?: string,
): Promise<{ slug: string } | null> {
  if (app.currentReleaseId === null) return null;
  const [release] = await tx<{ entry_scene_slug: string | null; landed: Record<string, unknown> | null; package_hash: string }[]>`
    select entry_scene_slug, landed, package_hash from room_releases where id = ${app.currentReleaseId}`;
  if (!release?.entry_scene_slug) return null;
  if (requested === undefined || requested === release.entry_scene_slug) return { slug: release.entry_scene_slug };
  let scenes = Array.isArray(release.landed?.['scenes'])
    ? (release.landed['scenes'] as unknown[]).filter((s): s is string => typeof s === 'string')
    : [];
  if (scenes.length === 0) {
    const [ev] = await tx<{ payload: { landed?: { scenes?: string[] } } }[]>`
      select payload from events where org_id = ${app.orgId} and type = 'package.imported'
        and payload->>'packageHash' = ${release.package_hash} order by id desc limit 1`;
    scenes = ev?.payload.landed?.scenes ?? [];
  }
  return scenes.includes(requested) ? { slug: requested } : null;
}

/** True when the room serves this binding; the rest answer the not-served note. */
export function roomServes(binding: LiveTarget['bindings'][number]): boolean {
  if (binding.kind === 'query') return !isSystemQueryTable(binding.table);
  if (binding.kind === 'asset') return binding.asset === 'array';
  return true;
}

/** The screen a room client watches: its bindings narrowed to the served ones, under the client's key and user. Runs inside tenant context. */
export async function roomLiveTarget(
  tx: postgres.Sql, app: HostLookup, sceneSlug: string | undefined, rowKey: string | undefined, endUserId: string | null,
): Promise<LiveTarget | null> {
  const target = await resolveReleaseScene(tx, app, sceneSlug);
  if (!target) return null;
  const found = await requireScene(tx, app.orgId, target.slug).catch(() => null);
  if (!found) return null;
  const [row] = await tx<{ project_id: string | null; bindings: unknown }[]>`select project_id, bindings from scenes where id = ${found.id}`;
  const parsed = sceneBindingsSchema.safeParse(row?.bindings ?? []);
  return {
    sceneId: found.id, slug: target.slug, projectId: row?.project_id ?? null,
    bindings: parsed.success ? parsed.data.filter(roomServes) : [],
    ...(rowKey !== undefined ? { rowKey } : {}),
    endUserId,
  };
}

export interface RoomFeedResult {
  scene: { slug: string; title: string };
  document: unknown;
  results: SceneBindingFeed[];
  /** The design size the document was authored at; the engine's reflow reads its width. */
  targetScreen: { w: number; h: number } | null;
}

export async function roomSceneData(
  sql: postgres.Sql, app: HostLookup, sceneSlug?: string,
  /** rowKey-declaring query bindings gain one eq predicate. */
  rowKey?: string,
  /** Opaque end-user id; RLS narrows table rows to the user's slice. */
  endUserId?: string | null,
): Promise<RoomFeedResult | null> {
  if (app.currentReleaseId === null) return null;
  return withTenant(sql, { orgId: app.orgId, endUserId: endUserId ?? null }, async (tx) => {
    // Any release screen may fetch its own feed, same guard as the page routes.
    const target = await resolveReleaseScene(tx, app, sceneSlug);
    if (!target) return null;
    const found = await requireScene(tx, app.orgId, target.slug).catch(() => null);
    if (!found) return null;
    const host = await getSceneForHost(tx, { orgId: app.orgId, sceneId: found.id });
    if (!host) return null;
    const projectId = host.scene.projectId ?? null;
    // The served document is the expanded tree with glyph shapes stamped; the stored document stays untouched.
    const document = stampIconGlyphs(expandInstanceNodes(host.document, await libraryItemsFor(tx, app.orgId, projectId, instanceRefsIn(host.document))).doc);
    const parsed = sceneBindingsSchema.safeParse(host.bindings);
    const bindings = parsed.success ? parsed.data : [];
    const results: SceneBindingFeed[] = [];
    for (const binding of bindings) {
      if (!roomServes(binding)) {
        results.push({ binding: binding.name, kind: binding.kind, rows: [], text: NOT_SERVED_NOTE, error: null });
        continue;
      }
      try {
        const r = await executeSceneBinding(tx, app.orgId, binding, projectId, { rowKey });
        results.push({ binding: r.binding, kind: r.kind, rows: r.rows, text: r.text, error: null, ...(r.tick !== undefined ? { tick: r.tick } : {}) });
      } catch (err) {
        results.push({ binding: binding.name, kind: binding.kind, rows: [], text: null, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { scene: { slug: host.scene.slug, title: host.scene.title }, document, results, targetScreen: host.targetScreen };
  });
}
