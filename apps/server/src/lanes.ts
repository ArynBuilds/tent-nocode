import type postgres from 'postgres';
// Zero-model wall: imports runner's OPS subpath only, never the model driver.
import { processPendingOperationExecutions, type OpsExecutorConfig } from '@nodeloom/runner/ops';
import {
  evaluateTriggers, processPendingIntegrationExecutions, sweepDueImports, sweepDueMirrors,
  sweepFlowExecutions, triggerSweepDueOrgs,
  type IntegrationExecutorConfig,
} from '@nodeloom/kernel';

/** Server's whole runtime loop: executor sweep + idle cadence trigger sweep (pure kernel, zero-LLM). */

export interface LanesConfig {
  sql: postgres.Sql;
  ops: OpsExecutorConfig;
  integrations?: IntegrationExecutorConfig;
  /** Sleep between idle sweeps (ms). */
  idleMs?: number;
  /** Trigger sweep runs every Nth idle tick (they are condition checks, not clocks). */
  triggerEveryTicks?: number;
}

export interface LanesHandle {
  stop(): Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function startHeadlessLanes(cfg: LanesConfig): Promise<LanesHandle> {
  const idleMs = cfg.idleMs ?? 1000;
  const triggerEvery = cfg.triggerEveryTicks ?? 5;
  let stopped = false;

  let tick = 0;
  let lastMirrorSweep = 0;
  const loop = (async (): Promise<void> => {
    while (!stopped) {
      let ran: 'ran' | 'idle' = 'idle';
      try {
        ran = await processPendingOperationExecutions(cfg.sql, cfg.ops);
      } catch (err) {
        console.error('[lanes] executor sweep failed:', err instanceof Error ? err.message : String(err));
      }
      if (cfg.integrations && ran === 'idle') {
        try {
          ran = await processPendingIntegrationExecutions(cfg.sql, cfg.integrations);
        } catch (err) {
          console.error('[lanes] integrations sweep failed:', err instanceof Error ? err.message : String(err));
        }
        // Mirror sync: due-cadence check rides same lane, once a minute.
        if (Date.now() - lastMirrorSweep > 60_000) {
          lastMirrorSweep = Date.now();
          try {
            await sweepDueMirrors(cfg.sql);
          } catch (err) {
            console.error('[lanes] mirror sweep failed:', err instanceof Error ? err.message : String(err));
          }
          // Import doors: advance one page per tick, same cadence.
          try {
            await sweepDueImports(cfg.sql);
          } catch (err) {
            console.error('[lanes] import sweep failed:', err instanceof Error ? err.message : String(err));
          }
        }
      }
      // Flow sweep: pending runs + ripened waits on same clock (also in host.ts).
      try {
        if (await sweepFlowExecutions(cfg.sql) > 0) ran = 'ran';
      } catch (err) {
        console.error('[lanes] flow sweep failed:', err instanceof Error ? err.message : String(err));
      }
      if (ran === 'ran') continue; // drain the queue back-to-back
      tick += 1;
      if (tick % triggerEvery === 0) {
        try {
          for (const orgId of await triggerSweepDueOrgs(cfg.sql)) {
            await evaluateTriggers(cfg.sql, orgId);
          }
        } catch (err) {
          console.error('[lanes] trigger sweep failed:', err instanceof Error ? err.message : String(err));
        }
      }
      await sleep(idleMs);
    }
  })();

  return {
    stop: async (): Promise<void> => {
      stopped = true;
      await loop;
    },
  };
}
