import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type postgres from 'postgres';
import type { CompiledInvocation, DriverHooks, DriverResult, ExecutionDriver } from '@nodeloom/core';
import { toKernelPort, type KernelPort } from './kernelPort.js';
import { sweepScratchWorkspaces } from './scratchGc.js';
import { sweepClaudeSessions } from './continuationClaude.js';
import { worktreeRemove } from './workspaceGit.js';
import type { RunnerConfig, RunOutcome } from './runner.js';

/**
 * TIER 25 E1: the SWEEP half of the runner, extracted from the megafile (500-line law) — the
 * two lanes (responsiveness every tick, housekeeping truly-idle only), their org-discovery
 * queries, and the time-boxed driver they share.
 */

/** FR-150(e): idle-tick LLM calls get a 2-minute box, never a worker's 15-minute budget — a
 * stuck housekeeping call is aborted (the driver kills its child) and retried on a later tick.
 * Live failure this hardens against: one 9-minute extraction call deafened the whole app. */
export const SWEEP_DRIVER_TIMEOUT_MS = 2 * 60_000;

/** Wrap a driver so every execute() races a timeout that fires the abort hook. An outer abort
 * (daemon quit) propagates through immediately; the inner driver's own settle result is returned
 * either way (ClaudeCodeDriver resolves `failed/aborted` when its signal fires). */
export function timeBoxedDriver(inner: ExecutionDriver, ms: number): ExecutionDriver {
  return {
    name: `${inner.name}(timeboxed)`,
    async execute(inv: CompiledInvocation, hooks?: DriverHooks): Promise<DriverResult> {
      const ctl = new AbortController();
      const onOuter = (): void => ctl.abort();
      hooks?.signal?.addEventListener('abort', onOuter, { once: true });
      const timer = setTimeout(() => ctl.abort(), ms);
      try {
        return await inner.execute(inv, { ...(hooks ?? {}), signal: ctl.signal });
      } finally {
        clearTimeout(timer);
        hooks?.signal?.removeEventListener('abort', onOuter);
      }
    },
  };
}

export interface SweepState { lastSweepMs: number; lastSweptOrgId: string | undefined; }

/**
 * Which sweep lanes a tick kicks. RESPONSIVENESS (a human is waiting: job
 * planning, mission rescues) kicks on EVERY tick; HOUSEKEEPING stays idle-only
 * so background LLM spend never competes with workers. "Idle" means TRULY idle:
 * no claim this tick AND zero runs in flight (`inFlight`).
 */
export function sweepLanes(outcome: RunOutcome, inFlight = 0): { responsiveness: boolean; housekeeping: boolean } {
  return { responsiveness: true, housekeeping: outcome === 'idle' && inFlight === 0 };
}

/** The responsiveness lane (proving-pass F1): a human answered a card or submitted work and is
 * WAITING — these run on every tick, busy or not. Each stage keeps the never-fail posture. */
export async function runResponsivenessSweeps(db: postgres.Sql | KernelPort, driver: ExecutionDriver): Promise<void> {
  const port = toKernelPort(db);
  void driver;
  // Crash reconciliation: a 'running' row with a stale heartbeat has no living process; settle it honestly.
  try {
    await port.failStaleRuns({ staleMs: 120_000 });
  } catch (err) {
    console.error('failStaleRuns error:', err instanceof Error ? err.message : String(err));
  }
  // The stalled-loop rescue — zero-LLM SQL detection of missions orphaned by a
  // failed wake; each hit gets ONE tank-braked re-wake. Bounded (limit 3).
  try {
    await port.rescueStalledIntents({ limit: 3 });
  } catch (err) {
    console.error('rescueStalledIntents error:', err instanceof Error ? err.message : String(err));
  }
}

/**
 * The host lanes: our server IS the daemon. No claims and no queue - spawned
 * runs execute where they were spawned; this interval only reconciles crashes,
 * rescues stalled missions, drives the sealed-operation executor, and keeps house.
 */
export function startHostLanes(
  db: postgres.Sql | KernelPort, driver: ExecutionDriver, cfg: RunnerConfig,
  opts: { signal?: AbortSignal; tickMs?: number } = {},
): { stop: () => Promise<void> } {
  const port = toKernelPort(db);
  const tickMs = opts.tickMs ?? 3_000;
  const sweepDriver = timeBoxedDriver(driver, SWEEP_DRIVER_TIMEOUT_MS);
  const state: SweepState = { lastSweepMs: 0, lastSweptOrgId: undefined };
  let responsivenessInFlight: Promise<void> | null = null;
  let housekeepingInFlight: Promise<void> | null = null;
  const opsInFlight = new Set<Promise<void>>();
  let lastHousekeepingMs = 0;
  const timer = setInterval(() => {
    if (opts.signal?.aborted) return;
    if (responsivenessInFlight === null) {
      responsivenessInFlight = runResponsivenessSweeps(port, sweepDriver)
        .catch((err: unknown) => {
          console.error('responsiveness sweep error:', err instanceof Error ? err.message : String(err));
        })
        .finally(() => { responsivenessInFlight = null; });
    }
    if (opsInFlight.size < 2 && cfg.opsWorkerFile !== undefined && cfg.pyodideDir !== undefined) {
      const opsCfg = {
        workerFile: cfg.opsWorkerFile, pyodideDir: cfg.pyodideDir, workspaceRoot: cfg.workspaceRoot,
        ...(cfg.onnxDir !== undefined ? { onnxDir: cfg.onnxDir } : {}),
      };
      const pass: Promise<void> = (async () => {
        const { processPendingOperationExecutions } = await import('./ops/opExecutor.js');
        await processPendingOperationExecutions(port, opsCfg);
      })()
        .catch((err: unknown) => {
          console.error('operation executor error:', err instanceof Error ? err.message : String(err));
        })
        .finally(() => { opsInFlight.delete(pass); });
      opsInFlight.add(pass);
    }
    // Housekeeping breathes on a slower cadence; single-flight.
    if (housekeepingInFlight === null && Date.now() - lastHousekeepingMs > 60_000) {
      lastHousekeepingMs = Date.now();
      housekeepingInFlight = runIdleSweeps(port, sweepDriver, cfg, state)
        .catch((err: unknown) => {
          console.error('idle sweep error:', err instanceof Error ? err.message : String(err));
        })
        .finally(() => { housekeepingInFlight = null; });
    }
  }, tickMs);
  return {
    stop: async () => {
      clearInterval(timer);
      if (responsivenessInFlight !== null) await responsivenessInFlight;
      if (housekeepingInFlight !== null) await housekeepingInFlight;
      if (opsInFlight.size > 0) await Promise.allSettled([...opsInFlight]);
    },
  };
}

/** The idle-tick housekeeping block, extracted from the loop so it can run in the background
 * (FR-150e). Every stage keeps its own never-fail posture — one stage's error never blocks the
 * next, and nothing here can reject except through the caller's catch. */
export async function runIdleSweeps(
  db: postgres.Sql | KernelPort, driver: ExecutionDriver, cfg: RunnerConfig, state: SweepState,
): Promise<void> {
  const port = toKernelPort(db);
  // THE SPEED DEMOLITION (2026-07-29, D-x1 item 5): the knowledge-hygiene apparatus died —
  // catch-up folds, clustering, orphan-entity retirement, operational-node retirement, and
  // the D-102 corpus self-import (python subprocess) all left this lane. What remains is
  // exactly the keep-list: session GC, scratch GC, worktree GC, trigger evaluation.
  void driver;
  // FR-224 (Tier 14): delete OLD scratch run workspaces — the window is the shortest
  // configured across orgs (they share one scratch root; dirs aren't org-labeled on disk).
  // Structurally unable to touch pinned/project folders (see sweepScratchWorkspaces).
  try {
    const orgIds = await port.listOrgIds();
    let days = Number.POSITIVE_INFINITY;
    for (const orgId of orgIds) {
      const config = await port.getOrgConfig(orgId);
      days = Math.min(days, config.domain.scratchGcDays);
    }
    await sweepScratchWorkspaces(cfg.workspaceRoot, { olderThanDays: Number.isFinite(days) ? days : 7 });
    // Tier 28 E4 (FR-315): the engine session files those scratch runs left behind live in the
    // engine's own projects dir — swept on the same window, walled to OUR workspaceRoot slugs.
    await sweepClaudeSessions(cfg.workspaceRoot, { olderThanDays: Number.isFinite(days) ? days : 7 });
  } catch (err) {
    console.error('sweepScratchWorkspaces error:', err instanceof Error ? err.message : String(err));
  }
  // Tier 32 (FR-344, D-133): orphaned worktrees from crashed/killed runs — runId-named dirs
  // under <workspaceRoot>/wt whose run is no longer live. Discard fully (a conflict-kept
  // branch has no worktree dir by then, so kept work is never GC'd). Never-fail.
  try {
    await sweepWorktreeOrphans(port, cfg.workspaceRoot);
  } catch (err) {
    console.error('sweepWorktreeOrphans error:', err instanceof Error ? err.message : String(err));
  }
  // Tier 46 (FR-420, D-171): evaluate event-condition triggers — PURE kernel code, zero
  // LLM, edge-fired, skip-while-active. Idle-lane cadence is the honest v1 (the plan's
  // ruling; a notify fast-path is the recorded nicety). Bounded per-org discovery,
  // never-fail per the lane's law; claims-preempt-housekeeping holds by placement.
  try {
    const triggerOrgIds = await port.triggerSweepDueOrgs();
    for (const orgId of triggerOrgIds) {
      await port.evaluateTriggers(orgId);
    }
  } catch (err) {
    console.error('evaluateTriggers error:', err instanceof Error ? err.message : String(err));
  }
  // THE TRASH PURGE (containment+cleanup spec §5, 2026-08-03): the scratch-GC sibling —
  // tombstones past each org's cleanup.trashDays window lose their FLESH (dataset rows ·
  // scene revisions · note bodies · thread messages/run bodies); skeleton rows + the
  // event record survive forever (THE STRUCTURE LAW). Pure SQL, zero driver; per-org
  // window from the same config read idiom as scratch GC; never-fail per the lane's law.
  try {
    const orgIds = await port.listOrgIds();
    for (const orgId of orgIds) {
      const config = await port.getOrgConfig(orgId);
      await port.purgeExpiredTrash(orgId, config.cleanup.trashDays);
    }
  } catch (err) {
    console.error('purgeExpiredTrash error:', err instanceof Error ? err.message : String(err));
  }
  // Tier 25 G3: the evolve sweep died with the evolution machinery (D-98) — roles improve
  // through MEMORY, never LLM instruction rewrites.
  void state;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Tier 32 (D-133): the worktree orphan GC — the idle lane's backstop for crashed runs. */
export async function sweepWorktreeOrphans(db: postgres.Sql | KernelPort, workspaceRoot: string): Promise<void> {
  const port = toKernelPort(db);
  const wtRoot = join(workspaceRoot, 'wt');
  let entries: string[] = [];
  try {
    entries = await readdir(wtRoot);
  } catch {
    return; // no worktree root yet — nothing to sweep
  }
  for (const name of entries) {
    const dir = join(wtRoot, name);
    if (!UUID_RE.test(name)) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      continue;
    }
    const row = await port.getRunWorkspace(name);
    if (row !== null && (row.status === 'running' || row.status === 'queued')) continue;
    if (row?.workspacePath != null) {
      try {
        await worktreeRemove(row.workspacePath, dir, `agent/${name}`);
      } catch { /* the rm below is the fallback */ }
    }
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
