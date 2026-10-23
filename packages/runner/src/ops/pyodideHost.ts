import { Worker } from 'node:worker_threads';

// Boots the sealed Pyodide ops worker and drives its per-execution message loop.
// The host owns the clock and the two-stage kill (interrupt buffer, then terminate).
// Recycle policy lives in workerPool.ts; this module is one worker's protocol only.

export interface OpsWorkerResult {
  ok: boolean;
  error?: string;
  stdio?: string;
  loadMs: number;
  durationMs: number;
  /** RSS the worker reported after this execution (the pool's recycle signal). */
  rssMb?: number;
  /** True when the host killed or lost the worker; a broken worker is never reused. */
  broken: boolean;
}

const BOOT_TIMEOUT_MS = 120_000;
const KILL_GRACE_MS = 2_000;
export const OPS_MEMORY_CAP_MB = 2_048;

type WorkerMsg =
  | { kind: 'booted'; loadMs: number; rssMb: number }
  | { kind: 'boot_failed'; error: string }
  | { kind: 'done'; execId: number; rssMb: number; stdio?: string }
  | { kind: 'failed'; execId: number; error: string; stdio?: string };

export interface OpsWorkerHandle {
  worker: Worker;
  flag: Uint8Array;
  loadMs: number;
  /** Post-boot RSS — the baseline the pool's growth guard compares against. */
  baselineRssMb: number;
  execCount: number;
  lastUsedAt: number;
  broken: boolean;
  nextExecId: number;
}

/** Boot one sealed worker (interpreter loaded, nothing mounted, nothing run). */
export async function bootOpsWorker(cfg: { workerFile: string; pyodideDir: string; onnxDir?: string }): Promise<OpsWorkerHandle> {
  const interruptBuffer = new SharedArrayBuffer(1);
  const flag = new Uint8Array(interruptBuffer);
  const worker = new Worker(cfg.workerFile, {
    workerData: {
      pyodideJs: `${cfg.pyodideDir}/pyodide.js`,
      indexURL: cfg.pyodideDir,
      interruptBuffer,
      // The worker lazy-loads ort from here only when an execution carries a model.
      ...(cfg.onnxDir !== undefined ? { onnxDir: cfg.onnxDir } : {}),
    },
    resourceLimits: { maxOldGenerationSizeMb: OPS_MEMORY_CAP_MB },
  });
  return new Promise<OpsWorkerHandle>((resolvePromise, rejectPromise) => {
    let settled = false;
    const bootTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      rejectPromise(new Error(`operation runtime failed to boot within ${BOOT_TIMEOUT_MS / 1000}s`));
    }, BOOT_TIMEOUT_MS);
    worker.once('message', (m: WorkerMsg) => {
      if (settled) return;
      settled = true;
      clearTimeout(bootTimer);
      if (m.kind !== 'booted') {
        void worker.terminate();
        rejectPromise(new Error(m.kind === 'boot_failed' ? m.error : 'operation worker sent an unexpected boot message'));
        return;
      }
      // An IDLE warm worker must never hold the daemon's process open — unref while
      // idle; execOnOpsWorker refs for the duration of each execution.
      worker.unref();
      resolvePromise({
        worker, flag, loadMs: m.loadMs, baselineRssMb: m.rssMb,
        execCount: 0, lastUsedAt: Date.now(), broken: false, nextExecId: 1,
      });
    });
    worker.once('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(bootTimer);
      rejectPromise(new Error(`operation worker boot error: ${e.message}`));
    });
  });
}

export interface OpsExecInput {
  workspaceDir: string;
  code: string;
  inputs: Record<string, string | number | boolean>;
  /** Compute budget for THIS execution (the boot had its own ceiling). */
  timeoutMs: number;
  /** Hash-pinned model asset; the worker re-verifies the bytes before any session. */
  model?: { path: string; sha256: string };
}

/** Run one execution on a booted worker. Marks the handle `broken` on any kill, worker
 * error, or exit — the pool must terminate a broken handle, never reuse it. */
export async function execOnOpsWorker(handle: OpsWorkerHandle, input: OpsExecInput): Promise<OpsWorkerResult> {
  const started = Date.now();
  const execId = handle.nextExecId++;
  handle.execCount += 1;
  handle.lastUsedAt = started;
  handle.worker.ref();
  let killTimer: NodeJS.Timeout | null = null;
  let graceTimer: NodeJS.Timeout | null = null;
  let interruptFired = false;
  let result: OpsWorkerResult | null = null;
  try {
    result = await new Promise<OpsWorkerResult>((resolvePromise) => {
      let settled = false;
      const settle = (r: Omit<OpsWorkerResult, 'durationMs' | 'loadMs'>): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolvePromise({ ...r, loadMs: handle.loadMs, durationMs: Date.now() - started });
      };
      const onMessage = (m: WorkerMsg): void => {
        if (m.kind === 'done' && m.execId === execId) {
          settle({ ok: true, rssMb: m.rssMb, broken: false, ...(m.stdio ? { stdio: m.stdio } : {}) });
          return;
        }
        if (m.kind === 'failed' && m.execId === execId) {
          // A timeout-fired interrupt surfaces as a KeyboardInterrupt failure;
          // map it to the honest timeout message.
          settle({
            ok: false, broken: interruptFired,
            error: interruptFired ? `operation timed out after ${input.timeoutMs}ms` : m.error,
            ...(m.stdio ? { stdio: m.stdio } : {}),
          });
        }
      };
      const onError = (e: Error): void => {
        settle({ ok: false, broken: true, error: interruptFired ? `operation timed out after ${input.timeoutMs}ms` : `operation worker error: ${e.message}` });
      };
      const onExit = (code: number): void => {
        settle({ ok: false, broken: true, error: `operation worker exited (${code}) before reporting` });
      };
      const cleanup = (): void => {
        if (killTimer !== null) clearTimeout(killTimer);
        if (graceTimer !== null) clearTimeout(graceTimer);
        handle.worker.off('message', onMessage);
        handle.worker.off('error', onError);
        handle.worker.off('exit', onExit);
      };
      handle.worker.on('message', onMessage);
      handle.worker.on('error', onError);
      handle.worker.on('exit', onExit);
      killTimer = setTimeout(() => {
        interruptFired = true;
        handle.flag[0] = 2; // stage 1: SIGINT through the shared interrupt buffer
        graceTimer = setTimeout(() => {
          settle({ ok: false, broken: true, error: `operation timed out after ${input.timeoutMs}ms (killed)` });
        }, KILL_GRACE_MS);
      }, input.timeoutMs);
      handle.worker.postMessage({
        kind: 'exec', execId,
        workspaceDir: input.workspaceDir, code: input.code, inputs: input.inputs,
        ...(input.model !== undefined ? { model: input.model } : {}),
      });
    });
    return result;
  } finally {
    if (interruptFired || result === null || result.broken) handle.broken = true;
    handle.lastUsedAt = Date.now();
    if (handle.broken) {
      await handle.worker.terminate(); // stage 2 — always reclaims the thread
    } else {
      handle.worker.unref(); // idle again: never hold the process open
    }
  }
}

/** Mark + reclaim (idempotent) — the pool's one disposal door. */
export async function terminateOpsWorker(handle: OpsWorkerHandle): Promise<void> {
  handle.broken = true;
  await handle.worker.terminate();
}
