import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import postgres from 'postgres';
import type { DriverResult, ExecutionDriver } from '@nodeloom/core';
import { failStaleRuns, registerRunSpawner, resolveSecretValue, startLiveWatcher, type LiveWatcherHandle } from '@nodeloom/kernel';
import { ApiDriver, ClaudeCodeDriver, createDirectKernelPort, executeSpawnedRun, startHostLanes, type RunnerConfig } from '@nodeloom/runner';

/** THE LOOP HOST: the server IS the daemon. A spawned run executes HERE, in this
 * process, the moment the kernel spawns it (no queue, no claims, no polling);
 * chat turns serialize per thread inside executeSpawnedRun's promise chain. */

const NO_ENGINE_SENTENCE =
  'no AI engine on this computer - install Claude Code (claude.com/claude-code) or add an API key in Settings, Engines';

/** The base driver without Claude Code: refuses named (no model calls, no child processes). */
function noEngineDriver(): ExecutionDriver {
  return {
    name: 'no-engine-refuse',
    async execute(): Promise<DriverResult> {
      return {
        status: 'failed', output: null, errorMessage: NO_ENGINE_SENTENCE,
        costUsd: null, durationMs: 0, numTurns: null,
      };
    },
  };
}

export interface AuthoringRunnerConfig {
  workspaceUrl: string;
  vaultMasterKey: Buffer | null;
  workspaceRoot: string;
  maxConcurrent?: number;
  /** Claude Code found on the machine: it runs every run no API key claims, on the person's own login. */
  claudeCode?: { toolsMcpCommand: string[] };
}

export interface AuthoringRunnerHandle {
  stop: () => Promise<void>;
}

export function startAuthoringRunner(cfg: AuthoringRunnerConfig): AuthoringRunnerHandle {
  const sql = postgres(cfg.workspaceUrl, { max: 6, onnotice: () => {} });
  const port = createDirectKernelPort(sql);
  const apiDriver = new ApiDriver({
    sql,
    // Account-scoped BYOK keys open with host master key in-process, die with call.
    resolveSecret: async (orgId, name) =>
      cfg.vaultMasterKey === null
        ? null
        : resolveSecretValue(sql, cfg.vaultMasterKey, { orgId, projectId: null, name }).catch(() => null),
    cliFallback: cfg.claudeCode !== undefined,
  });
  // The tools child reads the workspace from DATABASE_URL (mount.ts passes this process's value on).
  if (cfg.claudeCode !== undefined) process.env['DATABASE_URL'] = cfg.workspaceUrl;
  const controller = new AbortController();
  const runnerCfg: RunnerConfig = {
    maxConcurrent: cfg.maxConcurrent ?? 4,
    heartbeatMs: 1_500,
    workspaceRoot: cfg.workspaceRoot,
    apiDriver,
    ...(cfg.claudeCode !== undefined ? { toolsMcpCommand: cfg.claudeCode.toolsMcpCommand } : {}),
    // Deliberately absent: browse channel, ops lane (the desktop owns authoring ops through the runner.*
    // wall), the credential proxy (Claude Code runs on the person's own login).
  };
  const baseDriver = cfg.claudeCode !== undefined ? new ClaudeCodeDriver() : noEngineDriver();
  // Detached execution with a simple in-flight cap and a per-run dedupe; the record is how anyone follows a run.
  const inFlight = new Set<Promise<void>>();
  const inFlightIds = new Set<string>();
  const spawnHere = async (orgId: string, runId: string): Promise<void> => {
    if (controller.signal.aborted || inFlightIds.has(runId)) return;
    inFlightIds.add(runId);
    while (inFlight.size >= runnerCfg.maxConcurrent) await Promise.race([...inFlight]);
    const task: Promise<void> = executeSpawnedRun(port, baseDriver, runnerCfg, orgId, runId, { signal: controller.signal })
      .then(() => undefined)
      .catch((err: unknown) => {
        console.error('[authoring] executeSpawnedRun error:', err instanceof Error ? err.message : String(err));
      })
      .finally(() => { inFlight.delete(task); inFlightIds.delete(runId); });
    inFlight.add(task);
  };
  registerRunSpawner(async ({ orgId, runId }) => spawnHere(orgId, runId));
  // Runs Claude Code's tools child spawns stand in the table; their INSERT wakes this host.
  let watcher: LiveWatcherHandle | null = null;
  if (cfg.claudeCode !== undefined) {
    void startLiveWatcher(cfg.workspaceUrl, (event) => {
      if (event.table === 'runs' && event.op === 'INSERT' && event.orgId !== null) void spawnHere(event.orgId, event.id);
    }).then((w) => { watcher = w; }).catch((err: unknown) => {
      console.error('[authoring] runs watcher failed:', err instanceof Error ? err.message : String(err));
    });
  }
  console.log(`[authoring] loop host up (maxConcurrent=${runnerCfg.maxConcurrent}, claude code ${cfg.claudeCode !== undefined ? 'found' : 'absent'})`);
  // Boot reconciliation: rows left 'running' by a crashed host settle failed before anything spawns.
  const boot = mkdir(join(cfg.workspaceRoot, 'chat'), { recursive: true })
    .then(() => failStaleRuns(sql, { staleMs: 60_000 }))
    .catch((err: unknown) => {
      console.error('[authoring] boot reconciliation failed:', err instanceof Error ? err.message : String(err));
    });
  const lanes = startHostLanes(port, baseDriver, runnerCfg, { signal: controller.signal });

  return {
    stop: async () => {
      controller.abort();
      registerRunSpawner(null);
      await (watcher as LiveWatcherHandle | null)?.stop().catch(() => undefined);
      await boot;
      await lanes.stop();
      if (inFlight.size > 0) await Promise.race([Promise.allSettled([...inFlight]), new Promise((r) => setTimeout(r, 5_000))]);
      await sql.end({ timeout: 5 }).catch(() => undefined);
    },
  };
}
