import type { OpsKernelPort } from '@nodeloom/runner';
import { processPendingOperationExecutions, type OpsExecutorConfig } from '@nodeloom/runner/ops';

// Ops loop: claims pending operation executions over the workspace wall and runs them locally.

const DEFAULT_POLL_MS = 3_000;

export interface OpsLoopConfig {
  port: OpsKernelPort;
  ops: OpsExecutorConfig;
  pollMs?: number;
  log?: (line: string) => void;
  /** False while the app is locked: the pass waits instead of failing against the door. */
  ready?: () => boolean;
  /** Test seam; production runs the real executor pass. */
  processFn?: typeof processPendingOperationExecutions;
}

export interface OpsLoopHandle {
  stop: () => Promise<void>;
}

export function startOpsLoop(cfg: OpsLoopConfig): OpsLoopHandle {
  const pollMs = cfg.pollMs ?? DEFAULT_POLL_MS;
  const log = cfg.log ?? ((line: string) => console.error(line));
  const processFn = cfg.processFn ?? processPendingOperationExecutions;
  let stopped = false;
  let wake: (() => void) | null = null;

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
    wake = resolve;
    setTimeout(resolve, ms);
  });

  const loop = (async () => {
    while (!stopped) {
      let outcome: 'ran' | 'idle' = 'idle';
      try {
        if (cfg.ready === undefined || cfg.ready()) outcome = await processFn(cfg.port, cfg.ops);
      } catch (err) {
        // A failed pass never kills the loop; it retries next tick.
        log(`[ops] executor pass failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      // After running work, loop again immediately; only idle waits.
      if (!stopped && outcome === 'idle') await sleep(pollMs);
    }
  })();

  return {
    stop: async () => {
      stopped = true;
      wake?.();
      await loop;
    },
  };
}
