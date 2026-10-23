import {
  bootOpsWorker, execOnOpsWorker, terminateOpsWorker,
  type OpsExecInput, type OpsWorkerHandle, type OpsWorkerResult,
} from './pyodideHost.js';

// Warm Pyodide worker pool: workers survive between executions and recycle on
// max executions, idle minutes, abnormal RSS growth, or any kill/error.
// A warm worker's outputs must stay byte-identical to a cold worker's.

export const OPS_EXECUTOR_SLOTS = 2;
export const OPS_WORKER_MAX_EXECUTIONS = 20;
export const OPS_WORKER_IDLE_RECYCLE_MIN = 10;
/** Recycle when post-exec RSS exceeds this multiple of the worker's post-boot baseline. */
export const OPS_WORKER_RSS_RECYCLE_MULTIPLE = 3;

export interface OpsPoolConfig {
  workerFile: string;
  pyodideDir: string;
  /** Vendored inference runtime dir, when this env carries it. */
  onnxDir?: string;
  maxWorkers?: number;
  maxExecutions?: number;
  idleRecycleMin?: number;
  rssRecycleMultiple?: number;
}

export interface OpsPoolStats {
  booted: number;
  recycled: number;
  idle: number;
  active: number;
}

export class OpsWorkerPool {
  private idleWorkers: OpsWorkerHandle[] = [];
  private activeCount = 0;
  private bootedCount = 0;
  private recycledCount = 0;
  constructor(private cfg: OpsPoolConfig) {}

  stats(): OpsPoolStats {
    return { booted: this.bootedCount, recycled: this.recycledCount, idle: this.idleWorkers.length, active: this.activeCount };
  }

  private get maxWorkers(): number { return this.cfg.maxWorkers ?? OPS_EXECUTOR_SLOTS; }
  private get maxExecutions(): number { return this.cfg.maxExecutions ?? OPS_WORKER_MAX_EXECUTIONS; }
  private get idleRecycleMs(): number { return (this.cfg.idleRecycleMin ?? OPS_WORKER_IDLE_RECYCLE_MIN) * 60_000; }
  private get rssMultiple(): number { return this.cfg.rssRecycleMultiple ?? OPS_WORKER_RSS_RECYCLE_MULTIPLE; }

  /** Run one execution on a warm worker (or boot one); never runs past maxWorkers. */
  async run(input: OpsExecInput): Promise<OpsWorkerResult> {
    this.activeCount += 1;
    try {
      while (this.activeCount > this.maxWorkers) {
        await new Promise((r) => setTimeout(r, 250));
      }
      let handle = this.idleWorkers.pop();
      if (!handle) {
        handle = await bootOpsWorker(this.cfg);
        this.bootedCount += 1;
      }
      try {
        const result = await execOnOpsWorker(handle, input);
        await this.release(handle, result);
        return result;
      } catch (err) {
        // A throw here is host plumbing; dispose the worker, never reuse unknown state.
        this.recycledCount += 1;
        await terminateOpsWorker(handle);
        throw err;
      }
    } finally {
      this.activeCount -= 1;
    }
  }

  private async release(handle: OpsWorkerHandle, result: OpsWorkerResult): Promise<void> {
    const rssGrew = result.rssMb !== undefined && handle.baselineRssMb > 0
      && result.rssMb > handle.baselineRssMb * this.rssMultiple;
    const spent = handle.execCount >= this.maxExecutions;
    // Recycle on broken, failed execution, or any rule; reuse-after-doubt costs correctness.
    if (handle.broken || !result.ok || spent || rssGrew) {
      this.recycledCount += 1;
      await terminateOpsWorker(handle);
      return;
    }
    this.idleWorkers.push(handle);
  }

  /** Terminate workers idle past the recycle window. */
  async sweepIdle(now = Date.now()): Promise<void> {
    const keep: OpsWorkerHandle[] = [];
    for (const handle of this.idleWorkers) {
      if (now - handle.lastUsedAt > this.idleRecycleMs) {
        this.recycledCount += 1;
        await terminateOpsWorker(handle);
      } else {
        keep.push(handle);
      }
    }
    this.idleWorkers = keep;
  }

  /** Drain everything (tests + daemon shutdown). */
  async shutdown(): Promise<void> {
    const all = this.idleWorkers;
    this.idleWorkers = [];
    for (const handle of all) await terminateOpsWorker(handle);
  }
}

// One pool per config key; the daemon has exactly one, tests get their own.
const pools = new Map<string, OpsWorkerPool>();

export function getOpsPool(cfg: OpsPoolConfig): OpsWorkerPool {
  const key = `${cfg.workerFile}::${cfg.pyodideDir}::${cfg.onnxDir ?? ''}::${cfg.maxExecutions ?? ''}::${cfg.maxWorkers ?? ''}`;
  let pool = pools.get(key);
  if (!pool) {
    pool = new OpsWorkerPool(cfg);
    pools.set(key, pool);
  }
  return pool;
}

export async function shutdownOpsPools(): Promise<void> {
  for (const pool of pools.values()) await pool.shutdown();
  pools.clear();
}
