import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type postgres from 'postgres';
import { primitiveCatalogBlock } from '@nodeloom/core';
import {
  BRIDGE_PROMPT, compose, renderBriefText, renderThemeBlock,
  resolveModel, resolveCliEngine,
} from '@nodeloom/kernel';
import { compileCliInvocation } from './claudeDriver.js';
import type { SpawnedRun } from '@nodeloom/kernel';
import { toKernelPort, type KernelPort } from './kernelPort.js';
import { resolveEngineCredential, type ResolvedEngineCredential } from './engineCredential.js';
import { scrubSecretValues } from './scrub.js';
import type { DriverHooks, DriverResult, PreparedContinuation } from '@nodeloom/core';
import type { ExecutionDriver } from './driver.js';
import type { ApiDriver } from './api/driver.js';
import { ActivitySink } from './activitySink.js';
import { snapshotWorkspace, type WorkspaceSnapshot } from './workspaceDiff.js';
import { ensureRepo, checkpoint, headSha, worktreeAdd } from './workspaceGit.js';
import { mountRunServers } from './mount.js';
import { settleDriverResult } from './settle.js';

// THE LOOP KERNEL's execute half: one spawned run = one awaited invocation to
// completion in THIS process. No claims, no polling, no retries - the record
// (runs rows + events) is how anyone follows the process.
export { settleDriverResult } from './settle.js';
export { timeBoxedDriver } from './sweeps.js';
export { mountRunServers } from './mount.js';

/** The credential-proxy contract a host may inject; no in-repo implementation exists (machinery deleted). */
export interface CredentialProxy {
  /** The loopback base URL the child env gets (http://127.0.0.1:<port>). */
  url: string;
  /** Mint (or replace) the live token for a run. Returns the opaque token value. */
  mint(runId: string, credential: ResolvedEngineCredential): string;
  /** Kill the run's token at settle - a dead token 401s forever after. */
  kill(runId: string): void;
  /** Test seam: is this token value currently live? */
  hasLiveToken(token: string): boolean;
  close(): Promise<void>;
}

export interface RunnerConfig {
  maxConcurrent: number;
  heartbeatMs: number;
  workspaceRoot: string;
  maxTurns?: number;
  model?: string;
  /** OS-resolved shell folders, appended to desk turn context so paths are never guessed. */
  knownFolders?: { desktop: string; documents: string; downloads: string };
  /** Command+args that launch the tools.ts roster MCP server; unset = the roster not mounted on CLI-lane runs. */
  toolsMcpCommand?: string[];
  /** Sealed operation worker + vendored Pyodide dir; either unset = the ops lane is off. */
  opsWorkerFile?: string;
  pyodideDir?: string;
  /** Vendored ONNX Runtime wasm dir; unset = model-carrying operations fail with a named error. */
  onnxDir?: string;
  /** Command+args for the nodeloom-browser MCP server, mounted only on browse-scoped work runs. */
  browserMcpCommand?: string[];
  /** Main-process loopback browse channel (url + per-boot token); absent = browsing off. */
  browseChannel?: { url: string; token: string };
  /** Resolves a vault secret to plaintext for connector-env injection only, never a prompt. */
  resolveSecret?: (orgId: string, name: string) => Promise<string | null>;
  /** Credential proxy: the child env gets a per-run opaque token, never the real credential. */
  credentialProxy?: CredentialProxy;
  /** Register/release a run's authoritative browse allowlist with the main-process host. */
  registerBrowseGrant?: (runId: string, domains: string[]) => void;
  releaseBrowse?: (runId: string) => void;
  /** Command+args for the visible-browser MCP server; unset = the visible lane is off. */
  panelBrowserMcpCommand?: string[];
  /** Settle hook: a run's panel lease never outlives the run. */
  releasePanelLease?: (runId: string) => void;
  /** Captures the mounted scene before/after a scene-build run; unset = no capture. */
  captureSceneEyes?: (input: { orgId: string; sceneId: string; runId: string; phase: 'before' | 'after' }) => Promise<void>;
  /** Register/release a scene-build run's draft-render grant with the snapshot host. */
  registerSceneSnapshotGrant?: (runId: string, grant: { orgId: string; sceneSlug: string }) => void;
  releaseSceneSnapshot?: (runId: string) => void;
  /** Live text deltas forwarded to the host; ephemeral, never persisted. */
  onTextDelta?: (runId: string, text: string) => void;
  /** API-lane driver: chat runs with a vaulted vendor key run in-process; work runs stay CLI. */
  apiDriver?: ApiDriver;
}

export type RunOutcome = 'idle' | 'ran' | 'denied' | 'failed';

/** Per-key promise chains: one chat turn at a time per thread; worktree mounts serialize per folder. */
const keyChains = new Map<string, Promise<void>>();
function enqueueChain(key: string, fn: () => Promise<void>): Promise<void> {
  const prev = keyChains.get(key) ?? Promise.resolve();
  const next = prev.then(fn);
  const guarded = next.catch(() => { /* the chain must survive a failed link */ });
  keyChains.set(key, guarded);
  void guarded.then(() => { if (keyChains.get(key) === guarded) keyChains.delete(key); });
  return next;
}

/**
 * The spawn entry the host registers with the kernel: loads the run row and
 * executes it here. Chat turns serialize per thread (the promise chain IS the
 * queue - the Bolt/Cline shape); work runs execute detached in parallel,
 * folder exclusivity already decided at spawn (worktree isolation).
 */
export async function executeSpawnedRun(
  db: postgres.Sql | KernelPort, driver: ExecutionDriver, cfg: RunnerConfig,
  orgId: string, runId: string, opts: { signal?: AbortSignal } = {},
): Promise<RunOutcome> {
  const port = toKernelPort(db);
  const run = await port.loadSpawnedRun(orgId, runId);
  if (run === null) return 'idle'; // cancelled or settled before we got here
  if (run.kind === 'chat' && run.threadId !== null) {
    let outcome: RunOutcome = 'idle';
    await enqueueChain(`thread:${run.threadId}`, async () => {
      // The row may have been cancelled while queued behind a sibling turn.
      const fresh = await port.loadSpawnedRun(orgId, runId);
      if (fresh === null) return;
      outcome = await executeRun(port, driver, cfg, fresh, opts);
    });
    return outcome;
  }
  return executeRun(port, driver, cfg, run, opts);
}

/** Everything from a spawned run row to a settled record: gate, compile, execute, record, settle. */
export async function executeRun(
  db: postgres.Sql | KernelPort, driver: ExecutionDriver, cfg: RunnerConfig, claim: SpawnedRun,
  opts: { signal?: AbortSignal } = {},
): Promise<RunOutcome> {
  const port = toKernelPort(db);
  // The run gate reads the run's own ruleset (walls 1-2).
  const decision = await port.gateRun({
    orgId: claim.orgId, agentId: claim.agentId, runId: claim.runId, rules: claim.permissionRules,
  });
  if (!decision.allowed) {
    await port.failRun({ runId: claim.runId, error: decision.reason });
    return 'denied';
  }

  // One org-config read serves the whole run (model pin, warm chain, the bridge summary).
  // Never-fail: config trouble degrades each consumer to its default posture.
  let orgCfg: Awaited<ReturnType<KernelPort['getOrgConfig']>> | null = null;
  try { orgCfg = await port.getOrgConfig(claim.orgId); } catch { orgCfg = null; }

  // A chat turn's context is rebuilt fresh, never persisted.
  let chatView: Awaited<ReturnType<KernelPort['buildTurnView']>> | undefined;
  if (claim.kind === 'chat' && claim.threadId) {
    // Window step fires before the view is built; a windowing hiccup never costs a turn.
    try {
      const step = await port.windowStepIfDue({ orgId: claim.orgId, threadId: claim.threadId });
      // SUMMARY-BRIDGE: one cheap model call rewrites the deterministic bridge into a
      // structured paragraph of the trimmed messages; the kernel stays zero-model.
      if (step.stepped && step.trimmedText !== undefined && cfg.apiDriver !== undefined) {
        const pin = orgCfg !== null ? resolveModel(orgCfg, 'chat') : null;
        const lane = await cfg.apiDriver.resolveLane(claim.orgId, pin).catch(() => null);
        if (lane !== null && lane.route === 'api') {
          const sum = await cfg.apiDriver.execute({
            argv: [], cwd: cfg.workspaceRoot, env: {},
            systemPrompt: BRIDGE_PROMPT,
            promptText: step.trimmedText,
            apiTurn: {
              orgId: claim.orgId, runId: claim.runId, threadId: null, projectId: null,
              kind: 'chat', modelId: lane.model.id, permissionRules: [],
            },
          });
          const para = sum.status === 'succeeded' ? (sum.output ?? '').trim() : '';
          if (para.length > 0) {
            await port.setWindowBridge({
              orgId: claim.orgId, threadId: claim.threadId,
              bridge: `Earlier in this thread (${step.trimmed} messages summarized): ${para}`,
            });
          }
        }
      }
    } catch (err) {
      console.error('windowStepIfDue skipped:', err instanceof Error ? err.message : String(err));
    }
    // A settle-review wake compiles the review context, never the full console.
    const isReviewWake = typeof claim.input['loopWake'] === 'string';
    chatView = await port.buildTurnView({
      orgId: claim.orgId, threadId: claim.threadId,
      ...(isReviewWake ? { review: true } : {}),
    });
    // The one clock in the turn lives here so buildTurnView stays byte-deterministic.
    const now = new Date();
    const envTail = '\n\nenvironment: ' + JSON.stringify({
      date: now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
      'time-zone': Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    chatView = {
      ...chatView,
      contextText: chatView.contextText + envTail,
      volatileText: chatView.volatileText + envTail,
    };
  }
  // Known-folders block rides the system prompt; byte-stable, no clocks.
  let envFacts: string | undefined;
  if (claim.kind === 'chat' && cfg.knownFolders) {
    envFacts = 'ENVIRONMENT (trusted facts resolved by the operating system - byte-stable):'
      + '\nknown-folders: ' + JSON.stringify({
        desktop: cfg.knownFolders.desktop,
        documents: cfg.knownFolders.documents,
        downloads: cfg.knownFolders.downloads,
      })
      + '\nUse these EXACT paths - never guess a path, never derive one from the username.';
  }

  // Chat turns share one stable dir per thread (cwd feeds the prompt cache); work runs get per-run scratch.
  let workspaceDir = claim.workspacePath
    ?? (claim.kind === 'chat' && claim.threadId
      ? join(cfg.workspaceRoot, 'chat', claim.threadId)
      : join(cfg.workspaceRoot, claim.runId));
  await mkdir(workspaceDir, { recursive: true });

  // An isolated run executes in its own git worktree; the user's folder is never touched mid-run.
  let isolationCtx: { realDir: string; wtDir: string; branch: string } | null = null;
  if (claim.isolation === 'worktree' && claim.kind === 'work' && claim.workspacePath !== null) {
    const realDir = claim.workspacePath;
    const wtDir = join(cfg.workspaceRoot, 'wt', claim.runId);
    const branch = `agent/${claim.runId}`;
    try {
      // Mounts serialize per real folder: concurrent mounts race on .git's index lock.
      await enqueueChain(`mount:${realDir.replace(/[\\/]+$/, '').toLowerCase()}`, async () => {
        await ensureRepo(realDir);
        await worktreeAdd(realDir, wtDir, branch);
      });
      workspaceDir = wtDir;
      isolationCtx = { realDir, wtDir, branch };
      // Swap real-folder paths in the brief and permission rules to the worktree so absolute-path writes cannot tunnel past isolation.
      const fwd = (s: string): string => s.split(realDir).join(wtDir)
        .split(realDir.replace(/\\/g, '/')).join(wtDir);
      const swapDeep = (v: unknown): unknown =>
        typeof v === 'string' ? fwd(v)
          : Array.isArray(v) ? v.map(swapDeep)
            : v !== null && typeof v === 'object'
              ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, swapDeep(x)]))
              : v;
      claim.permissionRules = claim.permissionRules.map((r) => ({ ...r, pattern: fwd(r.pattern) }));
      claim.input = swapDeep(claim.input) as Record<string, unknown>;
      await port.persistRunPermissionRules(claim.runId, claim.permissionRules);
    } catch (err) {
      // Folder cannot be isolated: a free folder runs direct; an owned folder fails honestly (no queue to wait in).
      console.error('worktree mount failed for run', claim.runId, err instanceof Error ? err.message : String(err));
      if (!(await port.hasRunningFolderOwner(claim.runId, realDir))) {
        await port.clearRunIsolation(claim.runId);
        claim.isolation = null;
      } else {
        await port.failRun({
          runId: claim.runId,
          error: `the folder ${realDir} is held by another live run and could not be isolated - retry when it settles`,
        });
        return 'failed';
      }
    }
  }

  // Pre-run git checkpoint for project folders; a git hiccup degrades to an uncheckpointed run.
  let projectCtx: { projectId: string; verifyCommand: string | null; preSha: string | null } | null = null;
  if (claim.kind === 'work' && claim.workspacePath !== null) {
    try {
      const project = await port.findProjectForPath(claim.orgId, claim.workspacePath);
      if (project) {
        await ensureRepo(workspaceDir);
        const goalish = [claim.input['goal'], claim.input['task']].find((v) => typeof v === 'string') as string | undefined;
        const goal60 = (goalish ?? claim.slug).slice(0, 60);
        // A clean tree commits nothing — HEAD is then the honest pre-state a failure resets to.
        const cp = await checkpoint(workspaceDir, `pre ${claim.runId.slice(0, 8)} ${goal60}`);
        const preSha = cp.sha ?? await headSha(workspaceDir);
        projectCtx = { projectId: project.id, verifyCommand: project.verifyCommand, preSha };
        await port.emitEvent({
          orgId: claim.orgId, actor: 'kernel.runner', type: 'project.checkpoint',
          payload: { runId: claim.runId, projectId: project.id, phase: 'pre', sha: preSha },
        });
      }
    } catch (err) {
      console.error('project checkpoint skipped for run', claim.runId, err instanceof Error ? err.message : String(err));
    }
  }
  /** Failure settle: no half-edited project folders, ever. */
  const revertProjectOnFailure = async (): Promise<void> => {
    if (projectCtx?.preSha == null) return;
    try {
      const { resetTo } = await import('./workspaceGit.js');
      await resetTo(workspaceDir, projectCtx.preSha);
      await port.emitEvent({
        orgId: claim.orgId, actor: 'kernel.runner', type: 'project.reverted',
        payload: { runId: claim.runId, projectId: projectCtx.projectId, sha: projectCtx.preSha },
      });
    } catch (err) {
      console.error('project revert failed for run', claim.runId, err instanceof Error ? err.message : String(err));
    }
  };
  // Resolve the run's model from the org pin, falling back to the config default.
  let runModel = cfg.model;
  if (orgCfg !== null) {
    const pinned = resolveModel(orgCfg, claim.kind);
    if (pinned !== null) runModel = pinned;
  }
  try {
    await port.stampRunModel(claim.runId, runModel ?? null);
  } catch { /* recording is best-effort; the run itself must proceed */ }

  // Lane pick: a chat run routes to the API driver when its vendor key is vaulted; else the base driver.
  let laneDriver: ExecutionDriver = driver;
  let apiModelId: string | null = null;
  if (claim.kind === 'chat' && cfg.apiDriver !== undefined) {
    const lane = await cfg.apiDriver.resolveLane(claim.orgId, runModel ?? null).catch(() => null);
    if (lane !== null && lane.route === 'missing-key') {
      await port.failRun({ runId: claim.runId, error: lane.reason });
      return 'failed';
    }
    if (lane !== null && lane.route === 'api') {
      laneDriver = cfg.apiDriver;
      apiModelId = lane.model.id;
    }
  }

  // The whole MCP mount lives in mount.ts; never-fail inside.
  const mount = await mountRunServers(port, cfg, claim, workspaceDir);

  // Scene-editing runs read the project's theme in the compose tail: the theme block (names and values) and the stored brief.
  let themeTail: string | undefined;
  if (claim.input?.['sceneBuild'] !== undefined && mount.notesProjectId !== null) {
    try {
      const t = await port.readProjectTheme(claim.orgId, mount.notesProjectId);
      if (t !== null) {
        themeTail = 'THE THEME (this app\'s design tokens - a color on a node is one of these names or values; stay inside it):\n'
          + renderThemeBlock(t)
          + (t.brief !== undefined ? '\n' + renderBriefText(t.brief) : '');
      }
    } catch { themeTail = undefined; }
  }

  // Per-run settings file lives in a temp dir outside the workspace; written after compile.
  let settingsOwnDir: string | null = null;
  if (mount.mcpConfigDir === null) {
    settingsOwnDir = await mkdtemp(join(tmpdir(), 'nodeloom-settings-'));
  }
  const settingsPath = join(mount.mcpConfigDir ?? settingsOwnDir!, 'settings.json');

  // Warm continuation when the engine supports it; any miss falls back to the one-block cold path.
  let continuation: PreparedContinuation | null = null;
  if (chatView !== undefined && chatView.history.length > 0
    && claim.threadId !== null && laneDriver.prepareContinuation !== undefined) {
    try {
      continuation = await laneDriver.prepareContinuation({
        key: claim.threadId, cwd: workspaceDir, history: chatView.history,
      });
    } catch { continuation = null; }
  }
  const chatContext = chatView === undefined
    ? undefined
    : continuation !== null ? chatView.volatileText : chatView.contextText;

  // Work-lane warm chain; any miss = cold. Isolated runs never warm-resume: a real-folder session's paths would tunnel past the worktree.
  let warmResume: string[] | null = null;
  if (claim.kind === 'work' && claim.workspacePath !== null
    && claim.isolation === null
    && driver.resumeArgs !== undefined && orgCfg !== null) {
    try {
      const ref = await port.findWarmChainRef({
        orgId: claim.orgId, workspacePath: claim.workspacePath,
        maxAgeMin: orgCfg.domain.warmChainMaxAgeMin, maxRuns: orgCfg.domain.warmChainMaxRuns,
      });
      if (ref !== null) warmResume = driver.resumeArgs(ref);
    } catch { warmResume = null; }
  }

  // Prompt-cache matching is byte-prefix, so stable input bytes must come first on chat turns.
  const { threadId: stableThreadId, ...volatileInput } = claim.input as Record<string, unknown>;
  // Invocation assembly is a function of the context so the resume-failure fallback can recompile the same run cold.
  const buildInv = (ctx: string | undefined, warm: boolean): ReturnType<typeof compileCliInvocation> => {
    const orderedInput = claim.kind === 'chat' && ctx !== undefined
      ? {
          ...(stableThreadId !== undefined ? { threadId: stableThreadId } : {}),
          context: ctx,
          ...volatileInput,
        }
      : {
          ...claim.input,
          ...(ctx !== undefined ? { context: ctx } : {}),
        };
    // The one charter composes the system prompt for chat turns and dispatched runs alike; the
    // first-message block rides a fresh thread (no prior desk reply in the view), the glue mounts with its lanes.
    const systemPrompt = compose({
      catalog: primitiveCatalogBlock(),
      model: runModel, envFacts,
      ...(claim.kind === 'chat' && chatView !== undefined && !chatView.history.some((e) => e.role === 'assistant') ? { firstMessage: true } : {}),
      ...(mount.browseToolsMounted ? { browse: true } : {}),
      ...(mount.externalMcpMounted.length > 0 ? { services: mount.externalMcpMounted } : {}),
      // A consented user folder gets the folder glue: edit discipline plus the files-are-data wall.
      ...(claim.workspacePath !== null ? { pinnedFolder: true } : {}),
      // The theme rides the tail so a scene-editing run knows the app's tokens and brief.
      ...(themeTail !== undefined ? { theme: themeTail } : {}),
    });
    const compiled = compileCliInvocation({
      systemPrompt,
      input: orderedInput,
      permissionRules: claim.permissionRules,
      settingsPath,
      workspaceDir, maxTurns: cfg.maxTurns, model: runModel,
      ...(mount.toolsMounted ? { surfaceTools: true } : {}),
      ...(mount.browseToolsMounted ? { browseTools: true } : {}),
      // Acquire is deliberately excluded from the allow-list; consent rides the permission wall.
      ...(mount.panelBrowserMounted ? { panelBrowserTools: true } : {}),
      ...(mount.mcpConfigFile !== null ? { mcpConfigPath: mount.mcpConfigFile } : {}),
    });
    // Continuation argv appends after compile; warm=false means no continuation of any kind.
    if (warm) {
      if (continuation !== null) compiled.argv.push(...continuation.argvExtra);
      else if (warmResume !== null) compiled.argv.push(...warmResume);
    }
    // An API-lane turn carries its context on the invocation; the CLI driver never reads it.
    if (apiModelId !== null) {
      compiled.apiTurn = {
        orgId: claim.orgId, runId: claim.runId, threadId: claim.threadId,
        projectId: mount.notesProjectId, kind: claim.kind, modelId: apiModelId,
        permissionRules: claim.permissionRules,
        ...(mount.sceneSnapshotMounted && cfg.browseChannel !== undefined
          ? { snapshot: { url: cfg.browseChannel.url, token: cfg.browseChannel.token } }
          : {}),
      };
    }
    return compiled;
  };
  const inv = buildInv(chatContext, true);
  // The settings file is the CLI's permission surface — written before spawn, cleaned with the
  // temp dir below. A tool-less compile (settingsJson null) needs no file.
  if (inv.settingsJson !== null) {
    await writeFile(settingsPath, inv.settingsJson, 'utf8');
  }

  // Scene-build pre-frame capture lands before the builder touches anything; never-fail.
  const eyesSceneId = (claim.input?.['sceneBuild'] as { sceneId?: unknown } | undefined)?.sceneId;
  if (typeof eyesSceneId === 'string' && cfg.captureSceneEyes !== undefined) {
    await cfg.captureSceneEyes({ orgId: claim.orgId, sceneId: eyesSceneId, runId: claim.runId, phase: 'before' })
      .catch(() => { /* a view, never a gate */ });
  }

  // Snapshot every work run's workspace before it runs for the post-run diff; never-fail.
  let workspaceBefore: WorkspaceSnapshot | null = null;
  if (claim.kind === 'work') {
    try { workspaceBefore = await snapshotWorkspace(workspaceDir); } catch { workspaceBefore = null; }
  }

  // Secret values go into the child env only; a missing one is a name-only error.
  const missingSecrets = inv.requiredSecrets.filter((n) => !process.env[`TENT_SECRET_${n}`]);
  if (missingSecrets.length > 0) {
    await port.failRun({ runId: claim.runId, error: `missing secrets: ${missingSecrets.join(', ')}` });
    return 'denied';
  }
  for (const n of inv.requiredSecrets) inv.env[n] = process.env[`TENT_SECRET_${n}`] ?? '';

  // The engine credential never enters the child env; the proxy holds it and mints a per-run token.
  const engineCred = cfg.credentialProxy !== undefined
    ? await resolveEngineCredential(cfg.resolveSecret, claim.orgId)
    : null;
  // Values that must never reach the record: the real credential and this run's proxy token.
  const engineScrubValues: string[] = [];
  const injectEngineCredential = (env: Record<string, string>): void => {
    if (engineCred === null || cfg.credentialProxy === undefined) return;
    const engine = resolveCliEngine(engineCred.engineId);
    if (engine === null) return;
    const runToken = cfg.credentialProxy.mint(claim.runId, engineCred);
    env[engineCred.envVar] = runToken;
    env[engine.baseUrlEnvVar] = cfg.credentialProxy.url;
    if (!engineScrubValues.includes(engineCred.value)) engineScrubValues.push(engineCred.value);
    if (!engineScrubValues.includes(runToken)) engineScrubValues.push(runToken);
  };
  // The API lane's key never rides an env; proxy-token injection serves the CLI lane alone.
  if (apiModelId === null) injectEngineCredential(inv.env);

  // Bounded rolling tail of driver output, refreshed each heartbeat tick; never the output of record.
  let tail = '';
  const appendTail = (c: string): void => { tail = (tail + c).slice(-2000); };
  // The heartbeat doubles as the cancel watchdog: a run no longer 'running' aborts the driver.
  const runCtl = new AbortController();
  let runGone = false;
  const onOuterAbort = (): void => runCtl.abort();
  opts.signal?.addEventListener('abort', onOuterAbort, { once: true });
  const hb = setInterval(() => {
    // Scrub the full accumulated tail so a value split across chunks still dies before it persists.
    void port.heartbeatRun(claim.runId, tail ? scrubSecretValues(tail, engineScrubValues) : undefined).then((r) => {
      if (!r.alive && !runGone) {
        runGone = true;
        runCtl.abort();
      }
    }).catch((e: unknown) => {
      console.error('heartbeat failed for run', claim.runId, e instanceof Error ? e.message : String(e));
    });
  }, cfg.heartbeatMs);
  // Batched, capped persistence of narrated steps; the sink never throws.
  const sink = new ActivitySink(async (steps) => {
    await port.emitEvent({
      orgId: claim.orgId, actor: 'runner', type: 'run.activity',
      payload: { runId: claim.runId, steps },
    });
  });
  let result: DriverResult;
  try {
    const driverHooks: DriverHooks = {
      // onOutput is the tail's one writer; a second writer doubles prose in the live bubble.
      onOutput: appendTail,
      onEvent: (step) => { sink.push(step); },
      ...(cfg.onTextDelta !== undefined ? { onTextDelta: (t: string) => cfg.onTextDelta?.(claim.runId, t) } : {}),
      signal: runCtl.signal,
    };
    result = await laneDriver.execute(inv, driverHooks);
    // A runtime resume rejection degrades to one cold re-execute in the same invocation, never a dead turn.
    if ((continuation !== null || warmResume !== null)
      && result.status === 'failed' && /no conversation found/i.test(result.errorMessage ?? '')) {
      console.error('continuation resume rejected — re-executing cold:', claim.runId);
      const coldInv = buildInv(chatView !== undefined ? chatView.contextText : chatContext, false);
      if (coldInv.settingsJson !== null) await writeFile(settingsPath, coldInv.settingsJson, 'utf8');
      for (const n of coldInv.requiredSecrets) coldInv.env[n] = process.env[`TENT_SECRET_${n}`] ?? '';
      if (apiModelId === null) injectEngineCredential(coldInv.env);
      result = await laneDriver.execute(coldInv, driverHooks);
    }
  } catch (err) {
    // Our own cancel-watchdog abort: the record already says cancelled; stand down.
    if (runGone) {
      return 'idle';
    }
    // A driver that THROWS (bug, unmodeled crash) must not leave the run stuck
    // or kill the daemon — record it honestly; there are no retries.
    const message = err instanceof Error ? err.message : String(err);
    await revertProjectOnFailure();
    await port.failRun({ runId: claim.runId, error: `driver threw: ${message}` });
    return 'failed';
  } finally {
    clearInterval(hb);
    opts.signal?.removeEventListener('abort', onOuterAbort);
    // The run's proxy token dies with the run on every settle path.
    cfg.credentialProxy?.kill(claim.runId);
    // Final activity flush on every settle path.
    await sink.stop();
    if (mount.mcpConfigDir !== null) {
      // Remove the whole temp dir — it held secrets, never leave it behind.
      await rm(mount.mcpConfigDir, { recursive: true, force: true }).catch(() => { /* never fail the run over cleanup */ });
    }
    if (settingsOwnDir !== null) {
      await rm(settingsOwnDir, { recursive: true, force: true }).catch(() => { /* never fail the run over cleanup */ });
    }
    // Release the run's browse grant, panel lease, and snapshot grant with it.
    if (mount.browseToolsMounted) cfg.releaseBrowse?.(claim.runId);
    if (mount.panelBrowserMounted) cfg.releasePanelLease?.(claim.runId);
    if (mount.sceneSnapshotMounted) cfg.releaseSceneSnapshot?.(claim.runId);
    // Flush the tail before the run leaves 'running' so a fast driver never loses it to interval timing.
    if (tail) {
      await port.heartbeatRun(claim.runId, scrubSecretValues(tail, engineScrubValues)).catch((e: unknown) => {
        console.error('final heartbeat flush failed for run', claim.runId, e instanceof Error ? e.message : String(e));
      });
    }
    // Scene-eyes after-frame lands on every terminal path.
    if (typeof eyesSceneId === 'string' && cfg.captureSceneEyes !== undefined) {
      await cfg.captureSceneEyes({ orgId: claim.orgId, sceneId: eyesSceneId, runId: claim.runId, phase: 'after' })
        .catch(() => { /* a view, never a gate */ });
    }
  }

  // Cancelled under us: the driver result is not settle-able; stand down.
  if (runGone) {
    return 'idle';
  }

  // An engine-compacted session is an anomaly; record it, never a failure.
  if (result.compactedAnomaly === true) {
    await port.emitEvent({
      orgId: claim.orgId, actor: 'kernel.runner', type: 'session.compacted_anomaly',
      payload: { runId: claim.runId, kind: claim.kind },
    }).catch(() => { /* forensic event only — never fail the settle over it */ });
  }

  // Everything from driver result to run outcome lives in settle.ts.
  return settleDriverResult(port, result, {
    cfg, claim, workspaceDir, workspaceBefore, projectCtx, revertProjectOnFailure,
    isolationCtx,
    scrubValues: engineScrubValues,
  });
}
