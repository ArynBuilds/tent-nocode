import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type postgres from 'postgres';
import {
  FONT_ALLOWLIST, ROOM_LIVE_ROUTE, ROOM_SCENE_CSP, buildTokensCss, readTentkitBuild, serveTentkitBuild,
} from '@nodeloom/kernel';
import { AI_DOOR_PATH, aiDoorSeam } from './aiDoor.js';
import { roomAction, roomExecutionResult } from './actions.js';
import { roomSceneData } from './data.js';
import { createRoomLiveHub, type RoomLiveHub } from './live.js';
import { PILL_CSS, PILL_JS } from './pill.js';
import { roomSceneProjection } from './projection.js';
import { BUSY, GONE, NOT_HERE, PAUSED, serveAppPage, type RoomResponse } from './scene.js';
import { sessionCookieValue, sessionFromCookieHeader, verifySessionCode, type AppSession } from './session.js';
import { createHostResolver, withTenant, type HostResolver } from './tenancy.js';

// Transport-agnostic handler: resolve host → suspend → rate limit → serve.

export interface RoomRequest {
  method: string;
  host: string;
  path: string;
  query: Record<string, string>;
  body?: unknown;
  /** Raw Cookie header. */
  cookie?: string;
}

// assetBase '' → root-relative /assets/fonts/... URLs (the kernel composer's grammar).
const ROOM_TOKENS_CSS = buildTokensCss('');
const STATIC_HEADERS = { 'cache-control': 'public, max-age=31536000, immutable' };

/** In-process token bucket per org (origin layer; edge limits are provider config). */
function createBuckets(ratePerSec: number, burst: number) {
  const buckets = new Map<string, { tokens: number; at: number }>();
  return (key: string): boolean => {
    const now = Date.now();
    const b = buckets.get(key) ?? { tokens: burst, at: now };
    b.tokens = Math.min(burst, b.tokens + ((now - b.at) / 1000) * ratePerSec);
    b.at = now;
    if (b.tokens < 1) {
      buckets.set(key, b);
      return false;
    }
    b.tokens -= 1;
    buckets.set(key, b);
    return true;
  };
}

export interface RoomRouter {
  handle(req: RoomRequest): Promise<RoomResponse>;
  resolver: HostResolver;
  /** The push route's hub: pages attach at ROOM_LIVE_ROUTE; in-process writers announce here. */
  live: RoomLiveHub;
}

export function createRoomRouter(deps: {
  /** pooled room_runtime connection — every tenant statement rides withTenant. */
  sql: postgres.Sql;
  baseDomain: string;
  enginesDir: string;
  fontsDir: string;
  lookupTtlMs?: number;
  rate?: { perSec: number; burst: number };
  /** Enables served-app session lane; hosts without it serve anonymous-only. */
  appTokenSecret?: string;
}): RoomRouter {
  const resolver = createHostResolver({ sql: deps.sql, baseDomain: deps.baseDomain, ttlMs: deps.lookupTtlMs ?? 60_000 });
  const live = createRoomLiveHub({ sql: deps.sql });
  const allow = createBuckets(deps.rate?.perSec ?? 20, deps.rate?.burst ?? 60);
  // Listing visibility cache.
  const json = (status: number, body: unknown): RoomResponse => ({
    status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, body: JSON.stringify(body),
  });

  return {
    resolver,
    live,
    async handle(req: RoomRequest): Promise<RoomResponse> {
      // ---- tenantless static routes ----
      const engineMatch = /^\/engines\/([a-z0-9-]+\.js)$/.exec(req.path);
      if (engineMatch?.[1]) {
        const bytes = await serveTentkitBuild(deps.enginesDir, engineMatch[1]);
        if (!bytes) return NOT_HERE();
        return { status: 200, headers: { ...STATIC_HEADERS, 'content-type': 'text/javascript; charset=utf-8', 'content-security-policy': ROOM_SCENE_CSP }, body: bytes };
      }
      if (req.path === '/assets/tokens.css') {
        return { status: 200, headers: { ...STATIC_HEADERS, 'content-type': 'text/css; charset=utf-8' }, body: ROOM_TOKENS_CSS };
      }
      // Web pill shell: immutable static constants.
      if (req.path === '/assets/pill.css') {
        return { status: 200, headers: { ...STATIC_HEADERS, 'content-type': 'text/css; charset=utf-8' }, body: PILL_CSS };
      }
      if (req.path === '/assets/pill.js') {
        return { status: 200, headers: { ...STATIC_HEADERS, 'content-type': 'text/javascript; charset=utf-8' }, body: PILL_JS };
      }
      const fontMatch = /^\/assets\/fonts\/([A-Za-z0-9.-]+)$/.exec(req.path);
      if (fontMatch?.[1] && FONT_ALLOWLIST.has(fontMatch[1])) {
        try {
          const body = await readFile(join(deps.fontsDir, fontMatch[1]));
          return { status: 200, headers: { ...STATIC_HEADERS, 'content-type': 'font/woff2' }, body };
        } catch {
          return NOT_HERE();
        }
      }

      // Reserved AI door: Nodeloom never supplies inference keys.
      if (req.path === AI_DOOR_PATH) {
        const seam = aiDoorSeam();
        return { status: seam.status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, body: seam.body };
      }

      // ---- tenant routes: ONE wall order ----
      const isData = req.path === '/api/data';
      // The push route: one open stream per page, fed by the delta computer.
      const isLive = req.path === ROOM_LIVE_ROUTE && req.method === 'GET';
      const isAction = req.path === '/api/action' && req.method === 'POST';
      // Projection lane: array data requests.
      const isProjection = req.path === '/api/projection' && req.method === 'POST';
      // The checkout embed's result lane: the page short-polls its own queued call.
      const isExecution = req.path === '/api/execution' && req.method === 'POST';
      // Per-scene page routes with optional row key; /api/* reserved.
      // The live route is not a page even though its shape matches one.
      const pageMatch = req.method === 'GET' && !isLive && !req.path.startsWith('/api/')
        ? /^\/([a-z0-9][a-z0-9-]{0,120})(?:\/([^/]{1,120}))?$/.exec(req.path)
        : null;
      const sceneSlug = pageMatch?.[1] ?? null;
      const rowKey = pageMatch?.[2] !== undefined ? decodeURIComponent(pageMatch[2]) : undefined;
      const isPage = req.path === '/' || req.path === '' || sceneSlug !== null;
      if (!isData && !isAction && !isPage && !isProjection && !isExecution && !isLive) return NOT_HERE();

      // API routes carry ?app= query parameter; host parameter takes precedence.
      const fromHost = await resolver.resolve(req.host);
      const app = fromHost ?? (req.query['app'] ? await resolver.resolve(`${req.query['app']}.${deps.baseDomain}`) : null);
      if (!app) return isPage ? GONE(deps.baseDomain) : json(404, { ok: false, failures: ["there's no app at this address"] });
      // Unpublished apps (visibility 'off') return GONE; only suspension returns PAUSED.
      if (app.visibility === 'off') {
        return isPage ? GONE(deps.baseDomain) : json(404, { ok: false, failures: ["there's no app at this address"] });
      }
      if (app.roomStatus === 'suspended') {
        return isPage ? PAUSED() : json(503, { ok: false, failures: ['this app is paused'] });
      }

      // Session exchange: ?tsession= → HttpOnly cookie.
      let session: AppSession | null = null;
      if (deps.appTokenSecret !== undefined) {
        const exchange = isPage ? req.query['tsession'] : undefined;
        if (exchange !== undefined && exchange !== '') {
          const minted = verifySessionCode(deps.appTokenSecret, exchange);
          if (minted !== null && minted.appSlug === app.appSlug) {
            const maxAge = Math.max(60, Math.floor((minted.exp - Date.now()) / 1000));
            return {
              status: 302,
              headers: {
                location: req.path === '' ? '/' : req.path,
                'set-cookie': sessionCookieValue(exchange, true, maxAge),
                'cache-control': 'no-store',
              },
              body: '',
            };
          }
        }
        session = sessionFromCookieHeader(deps.appTokenSecret, req.cookie, app.appSlug);
      }

      if (!allow(app.orgId)) {
        return isPage ? BUSY() : json(429, { ok: false, failures: ['too many requests - slow down a little'] });
      }

      const endUserId = session?.appUserId ?? null;
      // End-user tracking via visit row.
      if (isPage) return serveAppPage(deps.sql, app, sceneSlug ?? undefined, rowKey, endUserId, await readTentkitBuild(deps.enginesDir));
      if (isLive) {
        const watch = { ...(req.query['scene'] !== undefined ? { scene: req.query['scene'] } : {}), ...(req.query['key'] !== undefined && req.query['key'] !== '' ? { key: req.query['key'] } : {}), endUserId };
        return {
          status: 200,
          headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' },
          body: '',
          stream: (sink) => live.attach(app, watch, sink),
        };
      }
      if (isData) {
        // The page passes its row key back so the feed serves the one row.
        const feed = await roomSceneData(deps.sql, app, req.query['scene'], req.query['key'], endUserId);
        return feed === null ? json(404, { ok: false }) : json(200, feed);
      }
      if (isExecution) {
        const p = (req.body ?? {}) as { id?: unknown };
        if (typeof p.id !== 'string') return json(400, { ok: false, failures: ['the result call named no execution'] });
        const verdict = await roomExecutionResult(deps.sql, app, p.id);
        return verdict === null ? json(404, { ok: false }) : json(200, { ok: true, ...verdict });
      }
      if (isProjection) {
        const p = (req.body ?? {}) as { scene?: unknown; binding?: unknown; request?: unknown; key?: unknown };
        if (typeof p.binding !== 'string') return json(400, { ok: false, failures: ['the projection call named no binding'] });
        const proj = await roomSceneProjection(deps.sql, app, {
          binding: p.binding,
          request: p.request ?? {},
          ...(typeof p.scene === 'string' ? { scene: p.scene } : {}),
          ...(typeof p.key === 'string' ? { key: p.key } : {}),
        }, endUserId);
        return proj === null ? json(404, { ok: false }) : json(200, proj);
      }
      const body = (req.body ?? {}) as { name?: unknown; values?: unknown };
      if (typeof body.name !== 'string') return json(400, { ok: false, failures: ['the action call named no action'] });
      const result = await roomAction(deps.sql, app, {
        name: body.name,
        values: (typeof body.values === 'object' && body.values !== null ? body.values : {}) as Record<string, unknown>,
      }, endUserId, (a) => live.announce(a));
      return json(result.ok ? 200 : 422, result);
    },
  };
}
