import type postgres from 'postgres';
import { sceneActionsSchema } from '@nodeloom/core';
import {
  ROOM_LIVE_ROUTE, ROOM_SCENE_CSP, buildThemeCss, composeSceneHostPage, getSceneForServe, recordVisit, requireScene,
  type TentkitBuild,
} from '@nodeloom/kernel';
import type { HostLookup } from '@nodeloom/kernel';
import { resolveReleaseScene } from './data.js';
import { pillMountHtml } from './pill.js';
import { withTenant } from './tenancy.js';

// Serves the published app page: the kernel's host page over the tentkit build, with no inline script.
// The script tag carries the room lane's facts (app, scene, key, the changed-fired actions, the live
// route); the engine fetches its feed, subscribes to the live route and posts its actions itself.

export interface RoomResponse {
  status: number;
  headers: Record<string, string>;
  body: string | Buffer;
  /** A streaming answer (the live route): the host writes the head, then hands the sink here; the return detaches. */
  stream?: (sink: { write(chunk: string): void }) => () => void;
}

const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': ROOM_SCENE_CSP,
  'cache-control': 'public, max-age=60',
};

function quietPage(sentence: string, status: number): RoomResponse {
  const html = '<!doctype html><html><head><link rel="stylesheet" href="/assets/tokens.css">'
    + '<title>Nodeloom</title></head>'
    + `<body><p style="padding:16px;color:var(--t2);font-size:13px;">${sentence}</p></body></html>`;
  return { status, headers: { ...PAGE_HEADERS, 'cache-control': 'no-store' }, body: html };
}

export const NOT_HERE = (): RoomResponse => quietPage("There's no app at this address.", 404);
// Dead addresses redirect to the site 404; page requests only.
export const GONE = (baseDomain: string): RoomResponse => ({
  status: 302,
  headers: { location: `https://${baseDomain}/404`, 'cache-control': 'no-store' },
  body: '',
});
export const PAUSED = (): RoomResponse => quietPage('This app is paused.', 503);
export const BUSY = (): RoomResponse => quietPage('This app is getting too many requests - try again in a moment.', 429);

/** A changed-fired action's serialized face. */
export interface ChangedAction { name: string; node?: string }

/** Composes the app-page HTML both the fleet and installed hosts serve; inputs are resolved facts, resolution is the caller's. */
export function composeServedAppPage(
  scene: Parameters<typeof composeSceneHostPage>[0],
  opts: {
    appSlug: string; sceneSlug: string; title?: string; hasAssistant: boolean; rowKey?: string;
    /** The tentkit build the host's engines dir carries. */
    build: Pick<TentkitBuild, 'file'> | null;
    /** Changed-fired actions the engine listens for; absent/empty emits nothing. */
    changed?: ChangedAction[];
  },
): string {
  const page = composeSceneHostPage(scene, {
    assetBase: '',
    build: opts.build,
    mode: 'serve',
    themeCss: buildThemeCss(scene.theme ?? null),
    // The room lane's facts ride the script tag as data attributes; the engine's boot reads them.
    scriptData: {
      app: opts.appSlug,
      scene: opts.sceneSlug,
      live: ROOM_LIVE_ROUTE,
      ...(opts.rowKey !== undefined && opts.rowKey !== '' ? { key: opts.rowKey } : {}),
      ...(opts.changed !== undefined && opts.changed.length > 0 ? { changed: JSON.stringify(opts.changed) } : {}),
    },
    extraBodyHtml: opts.hasAssistant ? pillMountHtml(opts.appSlug) : '',
    ...(opts.title !== undefined ? { title: opts.title } : {}),
  });
  return page.ok ? page.html : page.refusalHtml;
}

/** Serves an app page for a resolved host; suspend/visibility/quota walls belong to the router. */
export async function serveAppPage(
  sql: postgres.Sql, app: HostLookup, sceneSlug?: string,
  /** Row key from /<scene>/<key>; rides the engine's feed and live subscription. */
  rowKey?: string,
  /** Opaque signed-in end-user id; null when anonymous. */
  endUserId?: string | null,
  /** The tentkit build the room's engines dir carries (readTentkitBuild). */
  build: Pick<TentkitBuild, 'file'> | null = null,
): Promise<RoomResponse> {
  if (app.currentReleaseId === null) return NOT_HERE();
  const served = await withTenant(sql, { orgId: app.orgId }, async (tx) => {
    const [release] = await tx<{ envelope: Record<string, unknown> }[]>`
      select envelope from room_releases where id = ${app.currentReleaseId}`;
    if (!release) return null;
    const target = await resolveReleaseScene(tx, app, sceneSlug);
    if (!target) return null;
    const found = await requireScene(tx, app.orgId, target.slug).catch(() => null);
    if (!found) return null;
    const [proj] = await tx<{ project_id: string | null; actions: unknown }[]>`
      select project_id, actions from scenes where id = ${found.id}`;
    const scene = await getSceneForServe(tx, { orgId: app.orgId, sceneId: found.id });
    if (!scene) return null;
    // A non-parsing actions blob serves the page with zero changed-fires.
    const parsed = sceneActionsSchema.safeParse(proj?.actions ?? []);
    const changed: ChangedAction[] = parsed.success
      ? parsed.data
        .filter((a) => a.fires?.on === 'changed')
        .map((a) => ({ name: a.name, ...(a.fires?.node !== undefined ? { node: a.fires.node } : {}) }))
      : [];
    const envTitle = release.envelope?.['title'];
    // The pill mounts only when the release declares an assistant.
    const assistant = release.envelope?.['assistant'];
    const hasAssistant = assistant !== null && typeof assistant === 'object';
    return {
      scene, slug: target.slug, hasAssistant, projectId: proj?.project_id ?? null, changed,
      ...(typeof envTitle === 'string' ? { title: envTitle } : {}),
    };
  });
  if (!served) return NOT_HERE();
  // Visit recorded in its own transaction: a failed count never fails a page serve.
  await withTenant(sql, { orgId: app.orgId }, (tx) =>
    recordVisit(tx, { orgId: app.orgId, projectId: served.projectId, who: endUserId ?? null, screen: served.slug, source: 'website' }),
  ).catch(() => undefined);
  const body = composeServedAppPage(served.scene, {
    appSlug: app.appSlug, sceneSlug: served.slug, hasAssistant: served.hasAssistant, build,
    changed: served.changed,
    ...(served.title !== undefined ? { title: served.title } : {}),
    ...(rowKey !== undefined ? { rowKey } : {}),
  });
  return { status: 200, headers: PAGE_HEADERS, body };
}
