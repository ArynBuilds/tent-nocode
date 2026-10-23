import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import postgres from 'postgres';
import { applyRoomsLineage, createPublishDoor, createRoomRouter, type RoomRouter } from '@tent-nocode/room-server';
import {
  evaluateTriggers, handleOauthCallback, processPendingIntegrationExecutions, receiveWebhook,
  runMigrations, startLiveWatcher, sweepDueImports, sweepDueMirrors, sweepFlowExecutions, triggerSweepDueOrgs,
  type LiveWatcherHandle, type WorkspaceDeps,
} from '@tent-nocode/kernel';
import { verifyAccountToken } from './accountToken.js';
import { armServingRoles, ensureHostDatabases, withDatabase, type HostDatabaseUrls } from './hostDatabases.js';
import { readBodyCapped } from './visitor.js';
import { createWorkspaceLiveHub, handleWorkspaceRoutes, type WorkspaceLiveHub } from './workspace/routes.js';
import { startAuthoringRunner, type AuthoringRunnerHandle } from './workspace/authoringRunner.js';

/** THE HOST: one person's workspace door, the publish door and the published apps, on one machine.
 * The desktop starts it in-process over its bundled Postgres; `npm run server -- host` runs it headless. */

// Publish cap admits manifest + chunked data + envelope slack.
const MAX_PUBLISH_BYTES = 232 * 1024 * 1024;
const MAX_ACTION_BYTES = 32 * 1024;

export interface HostConfig {
  /** Superuser connection to the one Postgres; the host makes the two databases and arms the serving roles. */
  superUrl: string;
  /** Signs and verifies the account tokens the desktop mints. */
  tokenSecret: string;
  /** Published apps answer at <slug>.<baseDomain>:<port>. */
  baseDomain: string;
  port: number;
  /** The origin integrations call back to (OAuth redirects, webhooks). */
  publicOrigin: string;
  enginesDir: string;
  fontsDir: string;
  roomsMigrationsDir: string;
  workspaceMigrationsDir: string;
  vaultMasterKey: Buffer | null;
  authoringRoot: string;
  /** Claude Code found on the machine: the tools child it mounts. */
  claudeCode?: { toolsMcpCommand: string[] };
}

/** TENT_OAUTH_<clientEnv>_ID/_SECRET: the person's own registration per vendor; absent = the entry answers its upcoming sentence. */
function oauthClientsFromEnv(clientEnv: string): { id: string; secret: string } | null {
  const id = process.env[`TENT_OAUTH_${clientEnv}_ID`];
  const secret = process.env[`TENT_OAUTH_${clientEnv}_SECRET`];
  return id !== undefined && id !== '' && secret !== undefined && secret !== '' ? { id, secret } : null;
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

const bearerOf = (req: IncomingMessage): string => {
  const auth = (req.headers.authorization ?? '').toString();
  return auth.startsWith('Bearer ') ? auth.slice(7) : '';
};

interface HostDeps {
  cfg: HostConfig;
  urls: HostDatabaseUrls;
  runtime: postgres.Sql;
  workspace: { sql: postgres.Sql; liveHub: WorkspaceLiveHub; procedures: WorkspaceDeps };
}

function createHostServer({ cfg, urls, runtime, workspace }: HostDeps): { server: Server; router: RoomRouter } {
  const router = createRoomRouter({
    sql: runtime,
    baseDomain: cfg.baseDomain,
    enginesDir: cfg.enginesDir,
    fontsDir: cfg.fontsDir,
    appTokenSecret: cfg.tokenSecret,
  });
  const door = createPublishDoor({
    connect: () => postgres(urls.publishUrl, { max: 1, onnotice: () => {} }),
    verifyToken: async (token) => verifyAccountToken(token, cfg.tokenSecret),
    appUrl: (appSlug) => `http://${appSlug}.${cfg.baseDomain}:${cfg.port}`,
    enginesDir: cfg.enginesDir,
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://host');
    const path = url.pathname;
    const host = (req.headers.host ?? '').toString();

    if (req.method === 'GET' && path === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('ok');
      return;
    }

    // OAUTH callback: state verified, code exchanged server-side, tokens sealed per connection.
    if (req.method === 'GET' && path === '/oauth/callback') {
      const code = url.searchParams.get('code') ?? '';
      const state = url.searchParams.get('state') ?? '';
      if (code === '' || state === '') {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('this sign-in link is not whole - start again from the app');
        return;
      }
      const verdict = await handleOauthCallback(workspace.sql, {
        masterKey: cfg.vaultMasterKey,
        appTokenSecret: cfg.tokenSecret,
        redirectUri: `${cfg.publicOrigin}/oauth/callback`,
        clients: oauthClientsFromEnv,
      }, { code, state });
      res.writeHead(verdict.ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(`<!doctype html><meta charset="utf-8"><title>Tent NoCode</title><body style="font-family:system-ui;background:#141414;color:#ececec;display:grid;place-items:center;height:100vh;margin:0"><p>${verdict.sentence}</p></body>`);
      return;
    }

    // Webhook door: POST /hook/<token>, HMAC-verified, events fire the webhook_in trigger.
    if (req.method === 'POST' && path.startsWith('/hook/')) {
      const token = path.slice('/hook/'.length);
      const raw = await readBodyCapped(req, 262144).catch(() => null);
      if (raw === null) {
        res.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('the payload is too large');
        return;
      }
      // Signature headers for scheme dispatch (Node lowercases names) plus content-type for urlencoded parse.
      const sigHeaders: Record<string, string> = {};
      for (const name of [
        'x-tent-nocode-signature', 'x-signature', 'stripe-signature', 'paddle-signature',
        'x-slack-signature', 'x-slack-request-timestamp', 'linear-signature',
        'x-gitlab-token', 'calendly-webhook-signature', 'x-telegram-bot-api-secret-token',
        'box-signature-primary', 'box-signature-secondary', 'box-delivery-timestamp',
        'content-type',
      ]) {
        const value = req.headers[name];
        if (typeof value === 'string') sigHeaders[name] = value;
      }
      const verdict = await receiveWebhook(workspace.sql, cfg.vaultMasterKey, { token, rawBody: raw, headers: sigHeaders });
      if (verdict.status === 204) {
        res.writeHead(204);
        res.end();
      } else if (verdict.status === 200 || verdict.status === 201) {
        // The slack url_verification echo and the caller answer ride a JSON body.
        res.writeHead(verdict.status, { 'content-type': 'application/json; charset=utf-8' });
        res.end(verdict.body ?? '{}');
      } else {
        res.writeHead(verdict.status, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(verdict.sentence ?? 'no');
      }
      return;
    }

    if (path.startsWith('/workspace/')) {
      await handleWorkspaceRoutes(req, res, path, {
        sql: workspace.sql, tokenSecret: cfg.tokenSecret, procedures: workspace.procedures,
        publishDoor: (i) => door.publish(i),
        purge: (slug) => router.resolver.purge(slug),
      }, workspace.liveHub);
      return;
    }

    if (req.method === 'POST' && (path === '/publish' || path === '/unpublish')) {
      const raw = await readBodyCapped(req, path === '/publish' ? MAX_PUBLISH_BYTES : MAX_ACTION_BYTES);
      if (raw === null) {
        json(res, 413, { ok: false, refusal: `this upload is larger than the ${Math.floor(MAX_PUBLISH_BYTES / (1024 * 1024))}MB publish cap` });
        return;
      }
      let body: { appSlug?: unknown; title?: unknown; envelope?: unknown; file?: unknown };
      try { body = raw === '' ? {} : JSON.parse(raw) as typeof body; } catch { json(res, 400, { ok: false, refusal: 'the body must be JSON' }); return; }
      if (typeof body.appSlug !== 'string') { json(res, 400, { ok: false, refusal: 'the body named no appSlug' }); return; }
      const result = path === '/publish'
        ? await door.publish({
          token: bearerOf(req), appSlug: body.appSlug,
          ...(typeof body.title === 'string' ? { title: body.title } : {}),
          envelope: body.envelope, file: body.file,
        })
        : await door.unpublish({ token: bearerOf(req), appSlug: body.appSlug });
      if (result.ok) router.resolver.purge(body.appSlug);
      json(res, result.ok ? 200 : result.refusal.startsWith('sign in') ? 401 : 422, result);
      return;
    }

    // Everything else is the room router's ONE wall order (the published apps).
    let body: unknown;
    if (req.method === 'POST') {
      const raw = await readBodyCapped(req, MAX_ACTION_BYTES);
      if (raw === null) { json(res, 413, { ok: false, failures: ['request too large'] }); return; }
      try { body = raw === '' ? {} : JSON.parse(raw); } catch { json(res, 400, { ok: false, failures: ['body must be JSON'] }); return; }
    }
    const query: Record<string, string> = {};
    url.searchParams.forEach((v, k) => { query[k] = v; });
    const cookie = (req.headers.cookie ?? '').toString();
    const out = await router.handle({
      method: req.method ?? 'GET', host, path, query,
      ...(body !== undefined ? { body } : {}),
      ...(cookie !== '' ? { cookie } : {}),
    });
    res.writeHead(out.status, out.headers);
    if (out.stream !== undefined) {
      // The push route: the socket stays open; the router's hub writes frames until the client goes.
      res.write(out.body);
      const detach = out.stream({ write: (chunk) => { res.write(chunk); } });
      res.on('close', detach);
      return;
    }
    res.end(out.body);
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      if (!res.headersSent) json(res, 500, { ok: false, refusal: err instanceof Error ? err.message : String(err) });
      else res.end();
    });
  });
  return { server, router };
}

/** One background clock: pending work drains back-to-back; triggers check every 5th idle second. */
function startSweeps(label: string, work: () => Promise<boolean>, triggers: () => Promise<void>): () => Promise<void> {
  let stopped = false;
  const say = (what: string, err: unknown): void => console.error(`[${label}] ${what} failed:`, err instanceof Error ? err.message : String(err));
  const loop = (async (): Promise<void> => {
    let tick = 0;
    while (!stopped) {
      const ran = await work().catch((err: unknown) => { say('sweep', err); return false; });
      if (ran) continue;
      tick += 1;
      if (tick % 5 === 0) await triggers().catch((err: unknown) => say('trigger sweep', err));
      await new Promise((r) => setTimeout(r, 1000));
    }
  })();
  return async () => { stopped = true; await loop.catch(() => undefined); };
}

/** Boot: both lineages migrate, the serving roles get this boot's passwords, then the door listens. */
export async function startHost(cfg: HostConfig): Promise<{ server: Server; stop: () => Promise<void> }> {
  await ensureHostDatabases(cfg.superUrl);
  const admin = postgres(withDatabase(cfg.superUrl, 'rooms'), { max: 1, onnotice: () => {} });
  try {
    await applyRoomsLineage(admin, cfg.roomsMigrationsDir);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const urls = await armServingRoles(cfg.superUrl);
  const migrated = await runMigrations(urls.workspaceUrl, cfg.workspaceMigrationsDir);
  console.log(`[host] workspace migrations applied: ${migrated.applied.length}, skipped: ${migrated.skipped.length}`);

  const runtime = postgres(urls.runtimeUrl, { max: 5, onnotice: () => {} });
  const workspaceSql = postgres(urls.workspaceUrl, { max: 8, onnotice: () => {} });
  const procedures: WorkspaceDeps = {
    vaultMasterKey: cfg.vaultMasterKey,
    oauth: { appTokenSecret: cfg.tokenSecret, redirectUri: `${cfg.publicOrigin}/oauth/callback`, clients: oauthClientsFromEnv },
    // Media params resolve to no URL until a blob store lands on the host.
    mintMediaUrls: (_mountKey, absPaths) => absPaths.map(() => ''),
  };
  // The hub carries the pointer stream and the delta computer over the same pool.
  const liveHub = createWorkspaceLiveHub({ sql: workspaceSql });
  const watcher: LiveWatcherHandle = await startLiveWatcher(urls.workspaceUrl, (event) => liveHub.broadcast(event));
  const authoring: AuthoringRunnerHandle = startAuthoringRunner({
    workspaceUrl: urls.workspaceUrl, vaultMasterKey: cfg.vaultMasterKey, workspaceRoot: cfg.authoringRoot,
    ...(cfg.claudeCode !== undefined ? { claudeCode: cfg.claudeCode } : {}),
  });
  const { server, router } = createHostServer({ cfg, urls, runtime, workspace: { sql: workspaceSql, liveHub, procedures } });

  // The workspace clock: integrations, mirrors and imports ride beside the flow and trigger sweeps.
  let lastMirrorSweep = 0;
  const stopWorkspaceSweeps = startSweeps('workspace', async () => {
    let ran = await processPendingIntegrationExecutions(workspaceSql, { masterKey: cfg.vaultMasterKey, oauthClients: oauthClientsFromEnv }) === 'ran';
    if (Date.now() - lastMirrorSweep > 60_000) {
      lastMirrorSweep = Date.now();
      await sweepDueMirrors(workspaceSql);
      await sweepDueImports(workspaceSql);
    }
    if (await sweepFlowExecutions(workspaceSql) > 0) ran = true;
    return ran;
  }, async () => {
    for (const orgId of await triggerSweepDueOrgs(workspaceSql)) await evaluateTriggers(workspaceSql, orgId);
  });
  // The published apps' clock: FORCE RLS hides every row from a context-less session, so each org sweeps on its own pinned connection.
  const withRoomsOrg = async <T>(orgId: string, fn: (orgSql: postgres.Sql) => Promise<T>): Promise<T> => {
    const orgSql = postgres(urls.runtimeUrl, { max: 1, onnotice: () => {} });
    try {
      await orgSql`select set_config('app.org_id', ${orgId}, false), set_config('app.project_id', '', false)`;
      return await fn(orgSql);
    } finally {
      await orgSql.end({ timeout: 5 }).catch(() => undefined);
    }
  };
  const stopRoomsSweeps = startSweeps('rooms', async () => {
    let ran = false;
    for (const { org } of await runtime<{ org: string }[]>`select org from flow_sweep_due_orgs() as t(org)`) {
      if (await withRoomsOrg(org, (orgSql) => sweepFlowExecutions(orgSql)) > 0) { ran = true; router.live.announce({ orgId: org, all: true }); }
    }
    return ran;
  }, async () => {
    for (const { org } of await runtime<{ org: string }[]>`select org from trigger_sweep_due_orgs() as t(org)`) {
      await withRoomsOrg(org, (orgSql) => evaluateTriggers(orgSql, org));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  console.log(`[host] listening on ${cfg.publicOrigin} - published apps at http://<slug>.${cfg.baseDomain}:${cfg.port}`);
  return {
    server,
    stop: async (): Promise<void> => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await authoring.stop().catch(() => undefined);
      await stopWorkspaceSweeps();
      await stopRoomsSweeps();
      await watcher.stop().catch(() => undefined);
      liveHub.close();
      await workspaceSql.end({ timeout: 5 }).catch(() => undefined);
      await runtime.end({ timeout: 5 }).catch(() => undefined);
    },
  };
}
