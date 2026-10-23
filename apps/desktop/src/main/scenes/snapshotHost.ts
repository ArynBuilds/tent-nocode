import { stashDraftFrame } from './draftFrameStash.js';
import { captureScene, workspaceSceneEyesDeps, type SceneFeedFn } from '../tabs/sceneEyes.js';
import { workspaceCall } from '../workspaceClient.js';

// Renders a run's granted scene to a PNG mid-run through the real tab:// route over the tentkit build;
// the run sees pixels, never the DOM.

const SNAPSHOT_TIMEOUT_MS = 15_000;

// sceneSlug '*' means an org-wide grant; a slug-bound grant ignores the request's slug.
interface SnapshotGrant { orgId: string; sceneSlug: string }

/** The host's two workspace touches. */
export interface SnapshotHostDeps {
  resolveScene(orgId: string, sceneSlug: string): Promise<{ id: string }>;
  feed: SceneFeedFn;
}

export function workspaceSnapshotHostDeps(): SnapshotHostDeps {
  return {
    resolveScene: async (orgId, sceneSlug) => {
      const hit = await workspaceCall('sceneBySlug', [orgId, sceneSlug]) as { id: string } | null;
      if (hit === null) throw new Error(`no screen named ${sceneSlug}`);
      return hit;
    },
    feed: workspaceSceneEyesDeps().feed,
  };
}

let hostDeps: SnapshotHostDeps | null = null;
const grants = new Map<string, SnapshotGrant>();
// One capture at a time; a timed-out capture frees the queue instead of deadlocking it.
let queueTail: Promise<unknown> = Promise.resolve();

/** Called once at lane start (main). */
export function initSceneSnapshotHost(deps: SnapshotHostDeps): void {
  hostDeps = deps;
}

/** Registers a run's snapshot grant. */
export function setSceneSnapshotGrant(runId: string, grant: SnapshotGrant): void {
  grants.set(runId, grant);
}

/** Releases a run's grant when the run settles. */
export function releaseSceneSnapshotGrant(runId: string): void {
  grants.delete(runId);
}

export type SnapshotResult = { ok: true; png: Buffer } | { ok: false; error: string };

/** Resolves the capture target: a slug-bound grant wins; an org-wide grant needs a requested slug. */
export function resolveSnapshotTarget(
  grant: SnapshotGrant, requestedSlug: string | undefined,
): { ok: true; sceneSlug: string } | { ok: false; error: string } {
  if (grant.sceneSlug !== '*') return { ok: true, sceneSlug: grant.sceneSlug };
  if (typeof requestedSlug === 'string' && requestedSlug.length > 0) return { ok: true, sceneSlug: requestedSlug };
  return { ok: false, error: 'snapshot refused: name the scene (sceneSlug) - this run holds an org-wide snapshot grant' };
}

/** The device widths the breakpoint param maps to (Phase 14A: phone 390, tablet 810). */
const BREAKPOINT_WIDTHS: Readonly<Record<'phone' | 'tablet', number>> = { phone: 390, tablet: 810 };

/** Snapshots a scene for a run; refuses without a grant, serializes captures. */
export async function snapshotSceneForRun(runId: string, requestedSlug?: string, breakpoint?: 'phone' | 'tablet'): Promise<SnapshotResult> {
  const grant = grants.get(runId);
  if (!grant) return { ok: false, error: 'snapshot refused: this run has no registered scene-snapshot grant' };
  const target = resolveSnapshotTarget(grant, requestedSlug);
  if (!target.ok) return target;
  const deps = hostDeps;
  if (deps === null) return { ok: false, error: 'snapshot unavailable: the host is not initialized' };
  const width = breakpoint !== undefined ? BREAKPOINT_WIDTHS[breakpoint] : undefined;
  const job = queueTail.then(() => captureWithTimeout(deps, { orgId: grant.orgId, sceneSlug: target.sceneSlug }, width));
  queueTail = job.then(() => undefined, () => undefined);
  return job;
}

async function captureWithTimeout(deps: SnapshotHostDeps, grant: SnapshotGrant, width?: number): Promise<SnapshotResult> {
  try {
    const scene = await deps.resolveScene(grant.orgId, grant.sceneSlug);
    let timer: NodeJS.Timeout | undefined;
    // Back-to-back tab:// loads can fail transiently: one fresh-window retry, then error.
    const capture = async (): Promise<Awaited<ReturnType<typeof captureScene>>> => {
      const first = await captureScene(deps.feed, grant.orgId, scene.id, width);
      if (first !== null) return first;
      await new Promise((r) => setTimeout(r, 400));
      return captureScene(deps.feed, grant.orgId, scene.id, width);
    };
    const frame = await Promise.race([
      capture(),
      new Promise<'timeout'>((r) => { timer = setTimeout(() => r('timeout'), SNAPSHOT_TIMEOUT_MS); }),
    ]);
    clearTimeout(timer);
    if (frame === 'timeout') return { ok: false, error: `snapshot timed out after ${SNAPSHOT_TIMEOUT_MS / 1000}s` };
    if (frame === null) return { ok: false, error: 'snapshot failed: the scene page did not render' };
    // Every successful draft also feeds the draft-frame stash.
    stashDraftFrame(grant.orgId, scene.id, frame.png);
    return { ok: true, png: frame.png };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
