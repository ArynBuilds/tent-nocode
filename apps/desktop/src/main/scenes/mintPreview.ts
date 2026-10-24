import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BrowserWindow } from 'electron';
import { libraryItemSchema, type LibraryItem } from '@nodeloom/core';
import { buildThemeCss, composeSceneHostPage, readTentkitBuild, registerMintPreviewRenderer } from '@nodeloom/kernel';
import { feedSceneScript } from '../tabs/sceneEyes.js';

// Renders an unpublished library item candidate to a preview PNG through the tentkit build; any failure
// means no preview, never an error.

const CAPTURE_W = 800;
const CAPTURE_H = 500;
const PAINT_SETTLE_MS = 500;

/** Token-keyed in-memory host pages served by the tab:// route; deleted after capture. */
const pages = new Map<string, string>();

export function mintPreviewPage(token: string): string | null {
  return pages.get(token) ?? null;
}

/** The feed a candidate renders from: the item's own document, no bindings. */
export function buildMintPreviewFeed(item: LibraryItem): { document: unknown; results: [] } {
  return { document: item.document, results: [] };
}

/** Renders the candidate offscreen and persists the PNG; null on any failure. */
export async function renderMintPreview(screensDir: string, enginesDir: string, definition: unknown): Promise<string | null> {
  const parsed = libraryItemSchema.safeParse(definition);
  if (!parsed.success) return null;
  const item = parsed.data;
  const page = composeSceneHostPage(
    { title: `Mint preview - ${item.title}` },
    // A candidate has no project: the tokens block alone (no theme).
    { assetBase: 'tab://local', build: await readTentkitBuild(enginesDir), mode: 'serve', themeCss: buildThemeCss(null) },
  );
  if (!page.ok) return null;
  const token = randomUUID();
  pages.set(token, page.html);
  const win = new BrowserWindow({
    show: false, width: CAPTURE_W, height: CAPTURE_H,
    webPreferences: { offscreen: true, sandbox: true, backgroundThrottling: false },
  });
  try {
    await win.loadURL(`tab://local/mint-preview/${token}`);
    await win.webContents.executeJavaScript(feedSceneScript(buildMintPreviewFeed(item)), true);
    await new Promise((r) => setTimeout(r, PAINT_SETTLE_MS));
    const img = await win.webContents.capturePage();
    await mkdir(screensDir, { recursive: true });
    const file = join(screensDir, `mint-${token}.png`);
    await writeFile(file, img.toPNG());
    return file;
  } catch (err) {
    console.error('mint preview failed:', err instanceof Error ? err.message : String(err));
    return null;
  } finally {
    win.destroy();
    pages.delete(token);
  }
}

let stored: { screensDir: string; enginesDir: string } | null = null;

/** Loopback-route entry; refuses before init. */
export async function renderMintPreviewStored(definition: unknown): Promise<string | null> {
  if (stored === null) return null;
  return renderMintPreview(stored.screensDir, stored.enginesDir, definition);
}

/** Called once at start: stores the dirs and registers the kernel's mint-preview hook. */
export function initMintPreview(workspaceRoot: string, enginesDir: string): void {
  stored = { screensDir: join(workspaceRoot, 'tab-screens'), enginesDir };
  const dirs = stored;
  registerMintPreviewRenderer(async ({ definition }) => renderMintPreview(dirs.screensDir, dirs.enginesDir, definition));
}
