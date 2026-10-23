import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import type postgres from 'postgres';
import { sceneActionsSchema, sceneBindingsSchema, tablesReadBy } from '@tent-nocode/core';
import {
  buildTokensCss, createLiveDeltas, FONT_ALLOWLIST, getSceneForServe, projectHasAssistant, readTentkitBuild, recordVisit, ROOM_LIVE_ROUTE, ROOM_SCENE_CSP,
  getSceneActionExecutionResult, getSceneActionFlowResult, serveSceneData, serveSceneProjection, serveTentkitBuild, startLiveWatcher, submitSceneAction,
  type BindingDelta, type EffectsPush, type LiveTarget, type MediaUrlMinter,
} from '@tent-nocode/kernel';
// ONE COMPOSER, ONE FEEDER, ONE AI DOOR: the installed single-app host renders through the SAME composition
// the desktop's local server serves - composeServedAppPage + the room feeder + the web pill + the AI-door seam live
// in @tent-nocode/room-server; this host owns only what is genuinely single-app (port bind, no host routing, its
// own DB-direct data/action/media transport). The engine is the tentkit build in its resources/engines dir.
import { AI_DOOR_PATH, PILL_CSS, PILL_JS, aiDoorSeam, composeServedAppPage } from '@tent-nocode/room-server';
import { clientKey, createRateLimiter, readBodyCapped, type RateLimiter } from './visitor.js';

const TOKENS_CSS = buildTokensCss('');
// Single-app feeder slug (cosmetic on single-app host).
const APP_SLUG = 'app';
const MAX_ACT_BODY_BYTES = 32 * 1024;

export interface HttpHostDeps {
  sql: postgres.Sql;
  orgId: string;
  visitorUserId: string;
  enginesDir: string;
  fontsDir: string;
  limiter?: RateLimiter;
  /** The LISTEN connection for the push route; absent = the action door's announces alone feed it. */
  dbUrl?: string;
}

export interface HttpHost {
  server: Server;
}

function send(res: ServerResponse, status: number, body: string | Buffer, headers: Record<string, string>): void {
  res.writeHead(status, headers);
  res.end(body);
}

function notFound(res: ServerResponse): void {
  send(res, 404, 'not found', { 'content-type': 'text/plain; charset=utf-8' });
}

function json(res: ServerResponse, status: number, value: unknown): void {
  send(res, status, JSON.stringify(value), { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
}

interface SceneRow { id: string; slug: string; title: string; project_id: string | null }

async function sceneBySlug(sql: postgres.Sql, orgId: string, slug: string): Promise<SceneRow | null> {
  const [row] = await sql<SceneRow[]>`
    select id, slug, title, project_id from scenes where org_id = ${orgId} and slug = ${slug} and status != 'deleted' limit 1`;
  return row ?? null;
}

/** The ENTRY scene (first by creation): the front page and the action-dispatch scene (the fleet mirror). */
async function entryScene(sql: postgres.Sql, orgId: string): Promise<SceneRow | null> {
  const [row] = await sql<SceneRow[]>`
    select id, slug, title, project_id from scenes where org_id = ${orgId} and status != 'deleted'
    order by created_at asc limit 1`;
  return row ?? null;
}

/** Streams a mounted media file with basic Range support (video scrubbing works). */
function streamMedia(res: ServerResponse, req: IncomingMessage, absPath: string): void {
  if (!existsSync(absPath)) { notFound(res); return; }
  const size = statSync(absPath).size;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (range && (range[1] !== '' || range[2] !== '')) {
    const start = range[1] === '' ? Math.max(0, size - Number(range[2])) : Number(range[1]);
    const end = range[2] === '' || range[1] === '' ? size - 1 : Math.min(Number(range[2]), size - 1);
    if (start > end || start >= size) { send(res, 416, '', { 'content-range': `bytes */${size}` }); return; }
    res.writeHead(206, {
      'content-range': `bytes ${start}-${end}/${size}`,
      'accept-ranges': 'bytes',
      'content-length': String(end - start + 1),
    });
    createReadStream(absPath, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { 'content-length': String(size), 'accept-ranges': 'bytes' });
  createReadStream(absPath).pipe(res);
}

export function createHttpHost(deps: HttpHostDeps): HttpHost {
  const limiter = deps.limiter ?? createRateLimiter();

  // Media mount map lives in host instance, not module scope.
  const byToken = new Map<string, string[]>();
  const tokenByKey = new Map<string, string>();
  const mintMediaUrls: MediaUrlMinter = (mountKey, absPaths) => {
    const old = tokenByKey.get(mountKey);
    if (old !== undefined) byToken.delete(old);
    const token = randomUUID();
    byToken.set(token, [...absPaths]);
    tokenByKey.set(mountKey, token);
    return absPaths.map((_, i) => `/media/${token}/${i}`);
  };

  // THE PUSH ROUTE (Phase 13.5): one SSE stream per open page at ROOM_LIVE_ROUTE, fed by the workspace
  // lineage's NOTIFY (this host shares that schema) plus the action door's announces - the desktop hub's
  // shape with the room's per-client keyed targets.
  interface LiveClient { sceneId: string; slug: string; projectId: string | null; rowKey: string | undefined; write(chunk: string): void; target: LiveTarget | null }
  const liveClients = new Set<LiveClient>();
  const liveKeepalive = setInterval(() => { for (const c of liveClients) c.write(':ka\n\n'); }, 25_000);
  liveKeepalive.unref();
  const liveFrame = (msg: BindingDelta | EffectsPush): string => `event: ${msg.kind}\ndata: ${JSON.stringify(msg)}\n\n`;
  const resolveLiveTarget = async (c: LiveClient): Promise<LiveTarget | null> => {
    if (c.target !== null) return c.target;
    const [row] = await deps.sql<{ bindings: unknown }[]>`select bindings from scenes where id = ${c.sceneId}`;
    const parsed = sceneBindingsSchema.safeParse(row?.bindings ?? []);
    if (!parsed.success || tablesReadBy(parsed.data).length === 0) return null;
    c.target = { sceneId: c.sceneId, slug: c.slug, projectId: c.projectId, bindings: parsed.data, ...(c.rowKey !== undefined ? { rowKey: c.rowKey } : {}) };
    return c.target;
  };
  const liveDeltas = createLiveDeltas({
    run: (_orgId, fn) => fn(deps.sql),
    targets: async () => {
      const out: LiveTarget[] = [];
      for (const c of liveClients) { const t = await resolveLiveTarget(c).catch(() => null); if (t !== null) out.push(t); }
      return out;
    },
    push: (_orgId, msg, target) => {
      for (const c of liveClients) {
        if (target !== null && c.target !== target) continue;
        if (target === null && msg.kind === 'effects' && c.slug !== msg.scene) continue;
        c.write(liveFrame(msg));
      }
    },
  });
  let watcherStarted = false;
  const ensureLiveWatcher = (): void => {
    if (watcherStarted || deps.dbUrl === undefined) return;
    watcherStarted = true;
    void startLiveWatcher(deps.dbUrl, (ev) => { if (ev.orgId === deps.orgId) liveDeltas.onEvent(ev); })
      .catch((err) => console.error('[live] watcher failed:', err instanceof Error ? err.message : String(err)));
  };

  const server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      if (!res.headersSent) json(res, 500, { error: err instanceof Error ? err.message : String(err) });
      else res.end();
    });
  });

  /** Serve page with house tokens + the theme; assistant capsule mounts if declared. */
  async function servePage(res: ServerResponse, scene: SceneRow, rowKey?: string): Promise<void> {
    const info = await getSceneForServe(deps.sql, { orgId: deps.orgId, sceneId: scene.id });
    if (!info) { notFound(res); return; }
    const hasAssistant = scene.project_id !== null
      && await projectHasAssistant(deps.sql, deps.orgId, scene.project_id);
    // Changed-list projection: listen list from scene's declared actions (fires.on = 'changed').
    const [actsRow] = await deps.sql<{ actions: unknown }[]>`select actions from scenes where id = ${scene.id}`;
    const parsedActs = sceneActionsSchema.safeParse(actsRow?.actions ?? []);
    const changed = parsedActs.success
      ? parsedActs.data
        .filter((a) => a.fires?.on === 'changed')
        .map((a) => ({ name: a.name, ...(a.fires?.node !== undefined ? { node: a.fires.node } : {}) }))
      : [];
    const html = composeServedAppPage(info, {
      appSlug: APP_SLUG, sceneSlug: scene.slug, hasAssistant, changed,
      build: await readTentkitBuild(deps.enginesDir),
      // Row key in feeder (one grammar, both hosts).
      ...(rowKey !== undefined ? { rowKey } : {}),
    });
    // The serve counts - one row on the app-grain visits Table; the installed host has no end-user session leg.
    await recordVisit(deps.sql, { orgId: deps.orgId, projectId: scene.project_id, who: null, screen: scene.slug, source: 'website' });
    send(res, 200, html, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': ROOM_SCENE_CSP });
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://host');
    const path = url.pathname;

    // Static assets (fleet's exact routes).
    if (req.method === 'GET' && path === '/assets/tokens.css') {
      send(res, 200, TOKENS_CSS, { 'content-type': 'text/css; charset=utf-8' });
      return;
    }
    if (req.method === 'GET' && path === '/assets/pill.css') {
      send(res, 200, PILL_CSS, { 'content-type': 'text/css; charset=utf-8' });
      return;
    }
    if (req.method === 'GET' && path === '/assets/pill.js') {
      send(res, 200, PILL_JS, { 'content-type': 'text/javascript; charset=utf-8' });
      return;
    }
    // The engine build, served by content hash: the manifest names it and the bytes must still hash to it.
    const engineMatch = /^\/engines\/([a-z0-9-]+\.js)$/.exec(path);
    if (req.method === 'GET' && engineMatch?.[1]) {
      const bytes = await serveTentkitBuild(deps.enginesDir, engineMatch[1]);
      if (!bytes) { notFound(res); return; }
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=31536000, immutable', 'content-security-policy': ROOM_SCENE_CSP });
      res.end(bytes);
      return;
    }
    const fontMatch = /^\/assets\/fonts\/([A-Za-z0-9.-]+)$/.exec(path);
    if (req.method === 'GET' && fontMatch?.[1] && FONT_ALLOWLIST.has(fontMatch[1])) {
      try {
        const body = await readFile(join(deps.fontsDir, fontMatch[1]));
        res.writeHead(200, { 'content-type': 'font/woff2' });
        res.end(body);
      } catch {
        notFound(res);
      }
      return;
    }
    const mediaMatch = /^\/media\/([0-9a-f-]{36})\/(\d{1,4})$/i.exec(path);
    if (req.method === 'GET' && mediaMatch?.[1] && mediaMatch[2] !== undefined) {
      const paths = byToken.get(mediaMatch[1]);
      const idx = Number(mediaMatch[2]);
      const abs = paths && Number.isInteger(idx) && idx >= 0 && idx < paths.length ? paths[idx] : undefined;
      if (abs === undefined) { notFound(res); return; }
      streamMedia(res, req, abs);
      return;
    }

    // The push route: one open stream per page; binding deltas and late effects ride it.
    if (req.method === 'GET' && path === ROOM_LIVE_ROUTE) {
      const sceneSlug = url.searchParams.get('scene');
      const scene = sceneSlug !== null && sceneSlug !== '' ? await sceneBySlug(deps.sql, deps.orgId, sceneSlug) : await entryScene(deps.sql, deps.orgId);
      if (!scene) { notFound(res); return; }
      ensureLiveWatcher();
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.write(':connected\n\n');
      const key = url.searchParams.get('key');
      const client: LiveClient = {
        sceneId: scene.id, slug: scene.slug, projectId: scene.project_id,
        rowKey: key !== null && key !== '' ? key : undefined,
        write: (chunk) => { try { res.write(chunk); } catch { /* a closed socket drops its frame */ } },
        target: null,
      };
      liveClients.add(client);
      void resolveLiveTarget(client).catch(() => undefined);
      res.on('close', () => liveClients.delete(client));
      return;
    }

    // Data plane (reads own DB directly).
    if (req.method === 'GET' && path === '/api/data') {
      const sceneSlug = url.searchParams.get('scene');
      const scene = sceneSlug !== null ? await sceneBySlug(deps.sql, deps.orgId, sceneSlug) : await entryScene(deps.sql, deps.orgId);
      if (!scene) { json(res, 404, { error: 'no such scene' }); return; }
      // Feeder's row key composes the one eq predicate (kernel-side).
      const rowKey = url.searchParams.get('key');
      json(res, 200, await serveSceneData(deps.sql, deps.orgId, scene.id, mintMediaUrls, rowKey ?? undefined));
      return;
    }
    if (req.method === 'POST' && path === '/api/projection') {
      const raw = await readBodyCapped(req, MAX_ACT_BODY_BYTES);
      if (raw === null) { json(res, 413, { error: 'request too large' }); return; }
      let body: { scene?: unknown; binding?: unknown; request?: unknown } = {};
      try { body = JSON.parse(raw) as typeof body; } catch { json(res, 400, { error: 'body must be JSON' }); return; }
      if (typeof body.scene !== 'string' || typeof body.binding !== 'string') { json(res, 400, { error: 'body must name a scene and a binding' }); return; }
      const scene = await sceneBySlug(deps.sql, deps.orgId, body.scene);
      if (!scene) { json(res, 404, { error: 'no such scene' }); return; }
      json(res, 200, await serveSceneProjection(deps.sql, deps.orgId, scene.id, body.binding, body.request ?? {}));
      return;
    }

    // AI door: reserved seam; visitor/owner brings their own inference key.
    if (req.method === 'POST' && path === AI_DOOR_PATH) {
      const seam = aiDoorSeam();
      send(res, seam.status, seam.body, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return;
    }

    // Action door: declared actions only (kernel wall).
    if (req.method === 'POST' && path === '/api/action') {
      if (!limiter.allow(clientKey(req))) {
        json(res, 429, { ok: false, failures: ['too many requests from this address - try again in a minute'] });
        return;
      }
      const raw = await readBodyCapped(req, MAX_ACT_BODY_BYTES);
      if (raw === null) { json(res, 413, { ok: false, failures: ['request too large'] }); return; }
      let parsed: { name?: unknown; values?: unknown };
      try { parsed = JSON.parse(raw) as typeof parsed; } catch { json(res, 400, { ok: false, failures: ['body must be JSON: { name, values }'] }); return; }
      if (typeof parsed.name !== 'string') { json(res, 400, { ok: false, failures: ['body must name an action'] }); return; }
      // Fleet mirror: actions dispatch against entry scene (feeder sends no scene).
      const scene = await entryScene(deps.sql, deps.orgId);
      if (!scene) { json(res, 404, { ok: false, failures: ['no such scene'] }); return; }
      const result = await submitSceneAction(deps.sql, {
        orgId: deps.orgId, sceneSlug: scene.slug, action: parsed.name,
        values: (parsed.values ?? {}) as Record<string, unknown>, userId: deps.visitorUserId,
      });
      // The announce feeds the push route even without NOTIFY (a write or a settled flow re-runs the bindings).
      if (result.ok) {
        const executions = 'execution' in result && result.execution !== undefined ? [result.execution.id] : [];
        liveDeltas.announce({ orgId: deps.orgId, all: true, executions });
      }
      json(res, result.ok ? 200 : 400, result);
      return;
    }

    // Execution result lane (page short-polls its own queued call).
    if (req.method === 'POST' && path === '/api/execution') {
      const raw = await readBodyCapped(req, MAX_ACT_BODY_BYTES);
      if (raw === null) { json(res, 413, { ok: false, failures: ['request too large'] }); return; }
      let parsed: { id?: unknown };
      try { parsed = JSON.parse(raw) as typeof parsed; } catch { json(res, 400, { ok: false, failures: ['body must be JSON: { id }'] }); return; }
      if (typeof parsed.id !== 'string') { json(res, 400, { ok: false, failures: ['the result call named no execution'] }); return; }
      const scene = await entryScene(deps.sql, deps.orgId);
      if (!scene) { json(res, 404, { ok: false }); return; }
      const verdict = await getSceneActionExecutionResult(deps.sql, { orgId: deps.orgId, sceneSlug: scene.slug, executionId: parsed.id });
      if (verdict !== null) { json(res, 200, { ok: true, ...verdict }); return; }
      // Integration miss falls through to flow lane (installed host shares one DB).
      const flow = await getSceneActionFlowResult(deps.sql, { orgId: deps.orgId, sceneSlug: scene.slug, executionId: parsed.id });
      if (flow === null) { json(res, 404, { ok: false }); return; }
      json(res, 200, { ok: true, ...flow });
      return;
    }

    // App pages: entry (/) and scenes (/<slug>).
    if (req.method === 'GET' && path === '/') {
      const scene = await entryScene(deps.sql, deps.orgId);
      if (!scene) {
        send(res, 200, '<!doctype html><html><head><meta charset="utf-8"><title>Tent NoCode</title><link rel="stylesheet" href="/assets/tokens.css"></head><body><p style="padding:24px;color:var(--t2);font-size:13px">No app is installed yet.</p></body></html>',
          { 'content-type': 'text/html; charset=utf-8' });
        return;
      }
      await servePage(res, scene);
      return;
    }
    // Optional second segment = row key (/<scene>/<key>).
    const sceneMatch = /^\/([a-z0-9][a-z0-9-]{0,120})(?:\/([^/]{1,120}))?$/.exec(path);
    if (req.method === 'GET' && sceneMatch?.[1]) {
      const scene = await sceneBySlug(deps.sql, deps.orgId, decodeURIComponent(sceneMatch[1]));
      if (!scene) { notFound(res); return; }
      await servePage(res, scene, sceneMatch[2] !== undefined ? decodeURIComponent(sceneMatch[2]) : undefined);
      return;
    }

    notFound(res);
  }

  return { server };
}
