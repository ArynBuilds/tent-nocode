import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { navigate, teardown } from './browseHost.js';
import {
  acquirePanelLease, handBackPanelLease, panelClick, panelOpen, panelReadPage,
  panelScreenshot, panelScroll, panelType, panelWait, releasePanelLease,
} from './panelDriver.js';
import { renderMintPreviewStored } from '../scenes/mintPreview.js';
import { snapshotSceneForRun } from '../scenes/snapshotHost.js';

// Loopback-only bridge: spawned MCP servers relay browse calls to main, gated by a per-boot bearer token never written to disk.

let server: Server | null = null;
let token = '';
let port = 0;

async function readBody(req: import('node:http').IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

/** Start the loopback channel; returns the URL + token to inject into spawned browse servers. */
export function startBrowseChannel(): Promise<{ url: string; token: string }> {
  return new Promise((resolve, reject) => {
    token = randomBytes(24).toString('hex');
    server = createServer((req, res) => {
      void (async () => {
        try {
          if (req.headers['authorization'] !== `Bearer ${token}`) {
            res.writeHead(401).end('unauthorized');
            return;
          }
          const body = (await readBody(req)) as { runId?: string; url?: string };
          if (req.url === '/navigate' && body.runId && body.url) {
            // The allowlist is the run's registered grant, never a body-supplied set.
            const out = await navigate(body.runId, body.url);
            res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
          } else if (req.url === '/teardown' && body.runId) {
            teardown(body.runId);
            res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
          } else if (req.url === '/scene/snapshot' && body.runId) {
            // Target scene comes from the run's registered grant; an org-wide grant resolves the named slug.
            const bp = (body as { breakpoint?: unknown }).breakpoint;
            const out = await snapshotSceneForRun(body.runId, (body as { sceneSlug?: string }).sceneSlug, bp === 'phone' || bp === 'tablet' ? bp : undefined);
            res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(
              out.ok ? { ok: true, pngBase64: out.png.toString('base64') } : out,
            ));
          } else if (req.url === '/mint/preview' && body.runId) {
            // Renders the caller's own caged definition in main; returns the persisted PNG path.
            const path = await renderMintPreviewStored((body as { definition?: unknown }).definition);
            res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(
              path !== null ? { ok: true, path } : { ok: false, error: 'preview did not render' },
            ));
          } else if (req.url?.startsWith('/panel/') && body.runId) {
            // Visible-browser verbs; the single-holder lease bound to runId is the per-run wall.
            const p = body as {
              runId: string; orgId?: string; task?: string; url?: string; reason?: string;
              selector?: string; index?: number; x?: number; y?: number; text?: string;
              submit?: boolean; dy?: number; ms?: number;
            };
            let out: unknown;
            switch (req.url) {
              case '/panel/acquire': out = acquirePanelLease(p.runId, p.orgId ?? '', p.task ?? ''); break;
              case '/panel/release': releasePanelLease(p.runId); out = { ok: true }; break;
              case '/panel/handback': out = handBackPanelLease(p.runId, p.reason ?? ''); break;
              case '/panel/open': out = await panelOpen(p.runId, p.url ?? ''); break;
              case '/panel/read': out = { page: await panelReadPage(p.runId) }; break;
              case '/panel/screenshot': out = await panelScreenshot(p.runId); break;
              case '/panel/click': out = { result: await panelClick(p.runId, p) }; break;
              case '/panel/type': out = { result: await panelType(p.runId, p, p.text ?? '', p.submit === true) }; break;
              case '/panel/scroll': out = { result: await panelScroll(p.runId, p.dy ?? 0) }; break;
              case '/panel/wait': out = { result: await panelWait(p.runId, p.ms ?? 1000) }; break;
              default: res.writeHead(404).end('not found'); return;
            }
            res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
          } else {
            res.writeHead(404).end('not found');
          }
        } catch (err) {
          res.writeHead(500, { 'content-type': 'application/json' })
            .end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      })();
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server!.address();
      port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, token });
    });
  });
}

export function browseChannelInfo(): { url: string; token: string } | null {
  return server && port ? { url: `http://127.0.0.1:${port}`, token } : null;
}
