import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BrowserWindow } from 'electron';
import { frameVariance, BLANK_VARIANCE_FLOOR } from './frameVariance.js';
import { diffFrames } from './frameDiff.js';
import { stashDraftFrame } from '../scenes/draftFrameStash.js';
import { workspaceCall } from '../workspaceClient.js';

// Before/after scene screenshots around a build run; a capture failure never affects the run.
// The page is the real tab:// scene route over the tentkit build; the feed lands through the
// engine's own door (Tentkit.feedScene), never an inline handshake script.

const CAPTURE_W = 1024;
const CAPTURE_H = 640;
const PAINT_SETTLE_MS = 500;

export interface StashedFrame { png: Buffer; size: { width: number; height: number }; bitmap: Buffer }

/** The feed a capture lands: the served document, its binding results, and the design size the reflow reads. */
export interface SceneFeed {
  document: unknown;
  results: Array<{ binding: string; rows: unknown[]; text: string | null; error: string | null }>;
  targetScreen?: { w: number; h: number } | null;
}

/** Workspace touches behind one seam: the host feed and the record emit. */
export type SceneFeedFn = (orgId: string, sceneId: string) => Promise<SceneFeed>;
export interface SceneEyesDeps {
  feed: SceneFeedFn;
  emit(orgId: string, payload: Record<string, unknown>): Promise<void>;
}

/** The deps over the local server's workspace door. */
export function workspaceSceneEyesDeps(): SceneEyesDeps {
  return {
    feed: async (orgId, sceneId) => await workspaceCall('sceneData', [orgId, sceneId]) as SceneFeed,
    emit: async (_orgId, payload) => { await workspaceCall('recordSceneEyes', [payload]); },
  };
}

/** The in-page feed call: the engine applies the document and the results and resolves after two paints. */
export function feedSceneScript(feed: SceneFeed): string {
  const payload = JSON.stringify({
    document: feed.document,
    results: feed.results.map((r) => ({ binding: r.binding, rows: r.rows, text: r.text, error: r.error })),
    ...(feed.targetScreen != null ? { targetScreen: feed.targetScreen } : {}),
  });
  return `(typeof Tentkit !== 'undefined' && Tentkit.feedScene) ? Tentkit.feedScene(${payload}) : Promise.resolve(false)`;
}

const beforeFrames = new Map<string, StashedFrame>();

/** Loads the scene page offscreen, feeds it like the real host, and captures a frame; width narrows to a device (phone 390, tablet 810). */
export async function captureScene(
  feed: SceneFeedFn, orgId: string, sceneId: string, width?: number,
): Promise<StashedFrame | null> {
  const captureW = width ?? CAPTURE_W;
  const win = new BrowserWindow({
    show: false, width: captureW, height: CAPTURE_H,
    webPreferences: { offscreen: true, sandbox: true, backgroundThrottling: false },
  });
  try {
    await win.loadURL(`tab://local/scene/${sceneId}`);
    // A feed failure degrades to the bare-page capture; the frame then honestly reads blank.
    try {
      const data = await feed(orgId, sceneId);
      await win.webContents.executeJavaScript(feedSceneScript(data), true);
    } catch (err) {
      console.error('scene eyes feed skipped:', err instanceof Error ? err.message : String(err));
    }
    await new Promise((r) => setTimeout(r, PAINT_SETTLE_MS));
    // Grow to the page's full content height (capped) so the whole page is captured.
    try {
      const ch = await win.webContents.executeJavaScript(
        'Math.ceil(Math.max(document.body ? document.body.getBoundingClientRect().height : 0, document.documentElement ? document.documentElement.scrollHeight : 0))', true);
      if (typeof ch === 'number' && Number.isFinite(ch) && ch > CAPTURE_H) {
        win.setSize(captureW, Math.min(Math.round(ch), 4000));
        await new Promise((r) => setTimeout(r, 250));
      }
    } catch { /* the viewport capture stands */ }
    const img = await win.webContents.capturePage();
    return { png: img.toPNG(), size: img.getSize(), bitmap: img.getBitmap() };
  } catch (err) {
    console.error('scene capture failed:', err instanceof Error ? err.message : String(err));
    return null;
  } finally {
    win.destroy();
  }
}

/** Runner hook: 'before' stashes the pre-frame; 'after' diffs, persists, and emits one event. */
export function makeSceneEyesHook(deps: SceneEyesDeps, workspaceRoot: string) {
  return async function captureSceneEyes(input: {
    orgId: string; sceneId: string; runId: string; phase: 'before' | 'after';
  }): Promise<void> {
    try {
      const frame = await captureScene(deps.feed, input.orgId, input.sceneId);
      if (frame === null) return;
      stashDraftFrame(input.orgId, input.sceneId, frame.png);
      const dir = join(workspaceRoot, 'tab-screens');
      await mkdir(dir, { recursive: true });
      const file = join(dir, `${input.runId}-${input.phase}.png`);
      await writeFile(file, frame.png);
      if (input.phase === 'before') {
        beforeFrames.set(input.runId, frame);
        return;
      }
      const before = beforeFrames.get(input.runId) ?? null;
      beforeFrames.delete(input.runId);
      const toCaptured = (f: StashedFrame) => ({ getSize: () => f.size, getBitmap: () => f.bitmap });
      const afterCap = toCaptured(frame);
      const diff = before === null ? null : diffFrames(toCaptured(before), afterCap);
      await deps.emit(input.orgId, {
        sceneId: input.sceneId, runId: input.runId,
        beforePath: before === null ? null : join(dir, `${input.runId}-before.png`),
        afterPath: file,
        blank: frameVariance(afterCap) <= BLANK_VARIANCE_FLOOR,
        ...(diff === null ? {} : { changedFraction: diff.changedFraction, region: diff.region }),
      });
    } catch (err) {
      // A capture hiccup is a console line, never an outcome.
      console.error('scene eyes skipped:', err instanceof Error ? err.message : String(err));
    }
  };
}

/** Orphan hygiene: a run that died between phases leaves no stash behind. */
export function dropSceneEyesStash(runId: string): void {
  beforeFrames.delete(runId);
}
