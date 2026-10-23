import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { net, protocol } from 'electron';
import {
  buildThemeCss, composeSceneHostPage, FONT_ALLOWLIST, readTentkitBuild, serveTentkitBuild,
  TAB_CSP, TAB_TOKENS_CSS, type ProjectTheme,
} from '@tent-nocode/kernel';
import { randomUUID } from 'node:crypto';
import { identityReady } from '../identity.js';
import { mintPreviewPage } from '../scenes/mintPreview.js';

// The per-tab media token map: opaque tokens are the only bridge from tab:// media URLs to real paths.

const mediaByToken = new Map<string, string[]>();
const mediaTokenByTab = new Map<string, string>();

export function registerMediaMount(tabId: string, absPaths: string[]): string {
  const old = mediaTokenByTab.get(tabId);
  if (old !== undefined) mediaByToken.delete(old);
  const token = randomUUID();
  mediaByToken.set(token, [...absPaths]);
  mediaTokenByTab.set(tabId, token);
  return token;
}

export function resolveMediaPath(token: string, index: number): string | null {
  const paths = mediaByToken.get(token);
  if (!paths || !Number.isInteger(index) || index < 0 || index >= paths.length) return null;
  return paths[index] ?? null;
}

// The tab:// protocol handler: routes scheme requests to kernel-composed pages, the tentkit build and assets.

/** Must run at module top level, before app ready (Electron requirement). */
export function registerTabSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: 'tab', privileges: { standard: true, secure: true } }]);
}

function notFound(): Response {
  return new Response('not found', { status: 404, headers: { 'content-security-policy': TAB_CSP } });
}

/** The one injected scene read; callers supply their own backing fetch. */
export type SceneServeSource = (
  orgId: string, sceneId: string,
) => Promise<{ orgId: string; slug: string; title: string; theme?: ProjectTheme | null } | null>;

/** The exact-match router - six routes, everything else 404. Call inside app.whenReady(). */
export function registerTabProtocol(getScene: SceneServeSource, fontsDir: string, enginesDir: string, screensDir: string): void {
  protocol.handle('tab', async (req) => {
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      return notFound();
    }
    // Scene host page: kernel-authored over the build, served for the local identity's org.
    const sceneMatch = /^\/scene\/([0-9a-f-]{36})$/i.exec(url.pathname);
    if (sceneMatch?.[1]) {
      const orgId = (await identityReady()).orgId;
      const scene = await getScene(orgId, sceneMatch[1]);
      if (!scene) return notFound();
      const page = composeSceneHostPage(scene, {
        assetBase: 'tab://local',
        build: await readTentkitBuild(enginesDir),
        themeCss: buildThemeCss(scene.theme ?? null),
        // The editor mount asks for edit mode; ordinary serves stay byte-identical.
        mode: url.searchParams.get('editor') === '1' ? 'edit' : 'serve',
        // Bare serves paint the workspace ground color: the sandboxed frame's backing is opaque.
        ...((): { bareGround?: string } => {
          if (url.searchParams.get('bare') !== '1') return {};
          const g = url.searchParams.get('ground') ?? '';
          return { bareGround: /^[0-9a-f]{6}$/i.test(g) ? `#${g}` : '#141414' };
        })(),
      });
      return new Response(page.ok ? page.html : page.refusalHtml, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': TAB_CSP },
      });
    }
    // Mint-preview lanes: the capture host page and the persisted preview PNG.
    const mintPngMatch = /^\/mint-preview\/(mint-[0-9a-f-]{36}\.png)$/i.exec(url.pathname);
    if (mintPngMatch?.[1]) {
      try {
        const body = await readFile(join(screensDir, mintPngMatch[1]));
        return new Response(new Uint8Array(body), {
          headers: { 'content-type': 'image/png', 'content-security-policy': TAB_CSP },
        });
      } catch {
        return notFound();
      }
    }
    const mintPageMatch = /^\/mint-preview\/([0-9a-f-]{36})$/i.exec(url.pathname);
    if (mintPageMatch?.[1]) {
      const html = mintPreviewPage(mintPageMatch[1]);
      if (html === null) return notFound();
      return new Response(html, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': TAB_CSP },
      });
    }
    // The engine build, by content hash: the manifest names it and the bytes must still hash to it.
    const engineMatch = /^\/engines\/([a-z0-9-]+\.js)$/.exec(url.pathname);
    if (engineMatch?.[1]) {
      const bytes = await serveTentkitBuild(enginesDir, engineMatch[1]);
      if (!bytes) return notFound();
      return new Response(new Uint8Array(bytes), {
        headers: { 'content-type': 'text/javascript; charset=utf-8', 'content-security-policy': TAB_CSP },
      });
    }
    // Media streaming via opaque per-mount tokens; net.fetch keeps Range support.
    const mediaMatch = /^\/media\/([0-9a-f-]{36})\/(\d{1,4})$/i.exec(url.pathname);
    if (mediaMatch?.[1] && mediaMatch[2] !== undefined) {
      const abs = resolveMediaPath(mediaMatch[1], Number(mediaMatch[2]));
      if (!abs) return notFound();
      return net.fetch(pathToFileURL(abs).toString(), { headers: req.headers });
    }
    if (url.pathname === '/assets/tokens.css') {
      return new Response(TAB_TOKENS_CSS, {
        headers: { 'content-type': 'text/css; charset=utf-8', 'content-security-policy': TAB_CSP },
      });
    }
    const fontMatch = /^\/assets\/fonts\/([A-Za-z0-9.-]+)$/.exec(url.pathname);
    if (fontMatch?.[1] && FONT_ALLOWLIST.has(fontMatch[1])) {
      try {
        const body = await readFile(join(fontsDir, fontMatch[1]));
        return new Response(new Uint8Array(body), {
          headers: { 'content-type': 'font/woff2', 'content-security-policy': TAB_CSP },
        });
      } catch {
        return notFound();
      }
    }
    return notFound();
  });
}
