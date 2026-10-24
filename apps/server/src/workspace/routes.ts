import type { IncomingMessage, ServerResponse } from 'node:http';
import type postgres from 'postgres';
import { encodeWorkspaceWire } from '@nodeloom/core';
import { buildPackageClosure, projectAssistantName } from '@nodeloom/kernel';
import {
  callProcedure, workspaceRouter, type WorkspaceDeps,
  activeSceneTargets, createLiveDeltas, isPointerEvent, type LiveDeltas, type LivePush,
} from '@nodeloom/kernel';
import { readBodyCapped } from '../visitor.js';
import { resolveWorkspaceIdentity } from './auth.js';

/** THE HTTP ADAPTER over the one router (tRPC's standalone adapter shape): POST /workspace/call {channel, args}
 * resolves the identity, builds the context and calls the procedure; GET /workspace/live is the SSE stream. */

// Scene op batches cap: admits large batch, refuses absurdity named.
const MAX_CALL_BYTES = 8 * 1024 * 1024;
const SIGN_IN = 'sign in to use your workspace - this door answers the account signed in on this computer';

export interface WorkspaceDoorDeps {
  sql: postgres.Sql;
  tokenSecret: string;
  /** What the procedures read from the host: the vault key, the oauth door, the media minter. */
  procedures: WorkspaceDeps;
  publishDoor?: (input: { token: string; appSlug: string; title?: string; envelope: unknown; file: unknown }) =>
    Promise<{ ok: true; url: string; releaseHash: string; alreadyPublished?: boolean } | { ok: false; refusal: string; details?: string[] }>;
  purge?: (slug: string) => void;
}

interface LiveClient {
  orgId: string;
  res: ServerResponse;
}

export interface WorkspaceLiveHub {
  /** A desk_live pointer (fanned out as is) or a computed push (a binding delta, a run's effects). */
  broadcast(event: LivePush): void;
  attach(res: ServerResponse, orgId: string): void;
  close(): void;
}

/** SSE fan-out: one hub per host, org-scoped; 25s comment keepalive holds proxies open. With a workspace
 * pool the hub runs the delta computer: a pointer on a table some open screen's query reads becomes
 * {binding, rows} for that org's clients (the one stream carries both kinds). */
export function createWorkspaceLiveHub(deps: { sql?: postgres.Sql } = {}): WorkspaceLiveHub {
  const clients = new Set<LiveClient>();
  const keepalive = setInterval(() => {
    for (const c of clients) c.res.write(':ka\n\n');
  }, 25_000);
  // Unref so tests and shutdown never hang on keepalive.
  keepalive.unref();
  const send = (orgId: string, msg: LivePush): void => {
    const line = `data: ${JSON.stringify(msg)}\n\n`;
    for (const c of clients) if (c.orgId === orgId) c.res.write(line);
  };
  const hasClients = (orgId: string): boolean => { for (const c of clients) if (c.orgId === orgId) return true; return false; };
  const sql = deps.sql;
  const deltas: LiveDeltas | null = sql !== undefined
    ? createLiveDeltas({
      run: (_orgId, fn) => fn(sql),
      targets: (orgId) => activeSceneTargets(sql, orgId),
      push: (orgId, msg) => send(orgId, msg),
    })
    : null;
  return {
    broadcast(event: LivePush): void {
      if (event.orgId === null) return; // Org-less pointers point at nobody's workspace.
      send(event.orgId, event);
      // The computer runs only for an org with an open stream; the pointer itself already went out.
      if (deltas !== null && isPointerEvent(event) && hasClients(event.orgId)) deltas.onEvent(event);
    },
    attach(res: ServerResponse, orgId: string): void {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(':connected\n\n');
      const client: LiveClient = { orgId, res };
      clients.add(client);
      res.on('close', () => clients.delete(client));
    },
    close(): void {
      clearInterval(keepalive);
      deltas?.stop();
      for (const c of clients) c.res.end();
      clients.clear();
    },
  };
}

/** Assembly + door walk: builds kernel closure, then calls publish door. */
async function assembleAndPublish(
  deps: WorkspaceDoorDeps, orgId: string, bearer: string,
  input: {
    appSlug: string; appTitle: string; sceneSlugs: string[]; inlineDatasets?: string[];
    license?: string; projectId?: string; entrySceneSlug?: string;
  },
): Promise<{ ok: true; url: string; releaseHash: string; alreadyPublished?: boolean } | { ok: false; refusal: string; details?: string[] }> {
  const sql = deps.sql;
  const assistantName = input.projectId !== undefined
    ? await projectAssistantName(sql, orgId, input.projectId)
    : null;
  const built = await buildPackageClosure(sql, {
    orgId,
    ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
    selection: {
      scenes: input.sceneSlugs,
      ...(input.inlineDatasets !== undefined && input.inlineDatasets.length > 0 ? { inlineDatasets: input.inlineDatasets } : {}),
    },
    license: input.license ?? 'All rights reserved',
    provenance: { org: orgId, appVersion: 'desktop', exportedAt: new Date().toISOString() },
    ...(assistantName !== null ? { identity: { assistant: { name: assistantName } } } : {}),
  });
  if (!built.ok) return { ok: false, refusal: `export refused: ${built.errors.join(' · ')}` };
  const kind = input.projectId !== undefined
    ? (await sql<{ kind: 'app' | 'website' | null }[]>`
        select kind from projects where id = ${input.projectId} and org_id = ${orgId}`)[0]?.kind ?? null
    : null;
  const entrySlug = input.entrySceneSlug ?? input.sceneSlugs[0];
  const designSize = entrySlug !== undefined
    ? (await sql<{ target_screen: { w: number; h: number } | null }[]>`
        select target_screen from scenes where org_id = ${orgId} and slug = ${entrySlug}`)[0]?.target_screen ?? null
    : null;
  return deps.publishDoor!({
    token: bearer,
    appSlug: input.appSlug,
    title: input.appTitle,
    envelope: {
      version: '1', publishedAt: new Date().toISOString(), packageHash: built.pkg.packageHash,
      title: input.appTitle,
      ...(kind !== null ? { kind } : {}),
      ...(entrySlug !== undefined ? { entrySceneSlug: entrySlug } : {}),
      ...(designSize !== null ? { designSize } : {}),
      ...(assistantName !== null ? { assistant: { name: assistantName } } : {}),
    },
    file: built.pkg,
  });
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

function bearerOf(req: IncomingMessage): string {
  const auth = (req.headers.authorization ?? '').toString();
  return auth.startsWith('Bearer ') ? auth.slice(7) : '';
}

/** Returns true when the path was a workspace route (handled either way). */
export async function handleWorkspaceRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  deps: WorkspaceDoorDeps,
  live: WorkspaceLiveHub,
): Promise<boolean> {
  if (!path.startsWith('/workspace/')) return false;

  if (req.method === 'POST' && path === '/workspace/call') {
    const identity = await resolveWorkspaceIdentity(deps.sql, bearerOf(req), deps.tokenSecret);
    if (identity === null) { json(res, 401, { ok: false, error: SIGN_IN }); return true; }
    const raw = await readBodyCapped(req, MAX_CALL_BYTES);
    if (raw === null) { json(res, 413, { ok: false, error: 'this call is larger than the 8MB workspace cap' }); return true; }
    let body: { channel?: unknown; args?: unknown };
    try { body = JSON.parse(raw) as typeof body; } catch { json(res, 400, { ok: false, error: 'the call body must be JSON: { channel, args }' }); return true; }
    if (typeof body.channel !== 'string' || body.channel === '') {
      json(res, 400, { ok: false, error: 'the call body must name a channel' });
      return true;
    }
    const args = Array.isArray(body.args) ? body.args : [];
    const out = await callProcedure(workspaceRouter, { sql: deps.sql, identity, deps: deps.procedures }, body.channel, args);
    // The wire law: JSON cannot carry bytes - ArrayBuffers in a result (the sceneProjection class) cross as
    // tagged base64; the client restores them. `kind` tells a mouth whether the answer rides the write envelope.
    json(res, out.ok ? 200 : 422, out.ok ? { ok: true, data: encodeWorkspaceWire(out.data), kind: out.kind } : out);
    return true;
  }

  // Publish: the closure assembles beside its data and walks straight into the publish door.
  if (req.method === 'POST' && path === '/workspace/publishWebsite') {
    const bearer = bearerOf(req);
    const identity = await resolveWorkspaceIdentity(deps.sql, bearer, deps.tokenSecret);
    if (identity === null) { json(res, 401, { ok: false, error: SIGN_IN }); return true; }
    if (deps.publishDoor === undefined) { json(res, 503, { ok: false, error: 'the publish door is not open on this host' }); return true; }
    const raw = await readBodyCapped(req, MAX_CALL_BYTES);
    if (raw === null) { json(res, 413, { ok: false, error: 'this publish is larger than the 8MB workspace cap' }); return true; }
    let body: {
      appSlug?: unknown; appTitle?: unknown; sceneSlugs?: unknown; inlineDatasets?: string[];
      license?: string; projectId?: string; entrySceneSlug?: string;
    };
    try { body = JSON.parse(raw) as typeof body; } catch { json(res, 400, { ok: false, error: 'the body must be JSON' }); return true; }
    if (typeof body.appSlug !== 'string' || typeof body.appTitle !== 'string' || !Array.isArray(body.sceneSlugs)) {
      json(res, 400, { ok: false, error: 'the publish body needs { appSlug, appTitle, sceneSlugs }' });
      return true;
    }
    try {
      const out = await assembleAndPublish(deps, identity.orgId, bearer, {
        appSlug: body.appSlug, appTitle: body.appTitle, sceneSlugs: body.sceneSlugs as string[],
        ...(body.inlineDatasets !== undefined ? { inlineDatasets: body.inlineDatasets } : {}),
        ...(body.license !== undefined ? { license: body.license } : {}),
        ...(body.projectId !== undefined ? { projectId: body.projectId } : {}),
        ...(body.entrySceneSlug !== undefined ? { entrySceneSlug: body.entrySceneSlug } : {}),
      });
      if (out.ok) deps.purge?.(body.appSlug);
      json(res, out.ok ? 200 : 422, out);
    } catch (err) {
      json(res, 422, { ok: false, refusal: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  if (req.method === 'GET' && path === '/workspace/live') {
    const identity = await resolveWorkspaceIdentity(deps.sql, bearerOf(req), deps.tokenSecret);
    if (identity === null) { json(res, 401, { ok: false, error: SIGN_IN }); return true; }
    live.attach(res, identity.orgId);
    return true;
  }

  json(res, 404, { ok: false, error: 'no such workspace route' });
  return true;
}
