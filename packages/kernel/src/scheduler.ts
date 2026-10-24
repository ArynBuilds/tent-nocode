import type postgres from 'postgres';
import type { IoContract, JobKind, RunUsage } from '@nodeloom/core';
import { emitEvent } from './events.js';
import type { PermissionRule } from './consent.js';

// THE LOOP COLLAPSE: no queue, no claims, no planning. A run is an append-only
// record entity (wall 7) spawned DIRECTLY on the host that raised it; the
// registered spawner executes it in this process. This file is the run-record
// core of the loop kernel: spawn + complete/fail/heartbeat/cancel.

/** One spawned run, loaded for its executor. */
export interface SpawnedRun {
  runId: string; orgId: string; agentId: string; agentVersion: number;
  slug: string; input: Record<string, unknown>;
  instructions: string;
  permissionRules: PermissionRule[];
  ioContract: IoContract;
  kind: JobKind;
  threadId: string | null;
  workspacePath: string | null;
  /** 'worktree' = another live run holds this folder direct; this run works in an isolated worktree. */
  isolation: 'worktree' | null;
}

export interface SpawnRunInput {
  orgId: string;
  agentSlug: string;
  kind: JobKind;
  threadId: string | null;
  workspacePath?: string | null;
  /** The plain ask this run owns; rides the record beside the input. */
  prompt?: string | null;
  input: Record<string, unknown>;
  /** Explicit run permission declaration; every spawner names its rules. */
  permissionRules: PermissionRule[];
}

/** The host-registered executor: runs the spawned run in this process, detached from the caller. */
export type RunSpawner = (run: { orgId: string; runId: string }) => Promise<void>;

let runSpawner: RunSpawner | null = null;

/** The host process (our server IS the daemon) registers how a spawned run executes here. */
export function registerRunSpawner(spawner: RunSpawner | null): void {
  runSpawner = spawner;
}

/**
 * The one spawn door: writes the run row (born running - the record of a
 * process that starts NOW) and fires the registered spawner detached. The
 * caller never babysits the process; the record is how anyone follows it.
 */
export async function spawnRun(sql: postgres.Sql, input: SpawnRunInput): Promise<{ runId: string }> {
  const runId = await sql.begin(async (tx) => {
    const agents = await tx<{ id: string; current_version: number }[]>`
      select a.id, a.current_version from agents a
      where a.org_id = ${input.orgId} and a.slug = ${input.agentSlug} and a.status = 'active' and a.current_version > 0`;
    const agent = agents[0];
    if (!agent) throw new Error(`agent not runnable: ${input.agentSlug}`);
    const permissionRules = input.permissionRules;

    // Folder exclusivity: a live direct owner of the same folder pushes this run into worktree isolation.
    let isolation: 'worktree' | null = null;
    const wp = input.workspacePath ?? null;
    if (wp !== null && input.kind === 'work') {
      const [owner] = await tx<{ id: string }[]>`
        select id from runs
        where status = 'running' and isolation is null and workspace_path is not null
          and lower(rtrim(workspace_path, '\\/')) = lower(rtrim(${wp}, '\\/'))
        limit 1`;
      if (owner) isolation = 'worktree';
    }

    const rows = await tx<{ id: string }[]>`
      insert into runs (org_id, agent_id, agent_version, input, permission_rules,
                        kind, thread_id, workspace_path, prompt,
                        status, started_at, heartbeat_at, isolation)
      values (${input.orgId}, ${agent.id}, ${agent.current_version},
              ${tx.json(input.input as unknown as postgres.JSONValue)},
              ${tx.json(permissionRules as unknown as postgres.JSONValue)},
              ${input.kind}, ${input.threadId}, ${wp}, ${input.prompt ?? null},
              'running', now(), now(), ${isolation})
      returning id`;
    const run = rows[0];
    if (!run) throw new Error('run insert returned no row');
    await emitEvent(tx as unknown as postgres.Sql, {
      orgId: input.orgId, actor: 'kernel.runs', type: 'run.spawned',
      payload: { runId: run.id, agentSlug: input.agentSlug, kind: input.kind, threadId: input.threadId },
    });
    return run.id;
  }) as string;

  // The spawner owns the process from here; a spawn with no host settles honestly, never hangs.
  const spawner = runSpawner;
  if (spawner === null) {
    await failRun(sql, { runId, error: 'no run host is registered in this process - the run could not start' })
      .catch(() => undefined);
    return { runId };
  }
  void spawner({ orgId: input.orgId, runId }).catch(async (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    await failRun(sql, { runId, error: `run host failed: ${message}` }).catch(() => undefined);
  });
  return { runId };
}

/** Loads one spawned run for its executor; null = not found or not running. */
export async function loadSpawnedRun(sql: postgres.Sql, orgId: string, runId: string): Promise<SpawnedRun | null> {
  const rows = await sql<
    {
      id: string; org_id: string; agent_id: string; agent_version: number;
      input: Record<string, unknown>; slug: string;
      instructions: string; io_contract: IoContract;
      kind: JobKind; thread_id: string | null; workspace_path: string | null;
      permission_rules: PermissionRule[] | null; isolation: 'worktree' | null;
    }[]
  >`
    select runs.id, runs.org_id, runs.agent_id, runs.agent_version, runs.input,
           a.slug, v.instructions, v.io_contract,
           runs.kind, runs.thread_id, runs.workspace_path,
           runs.permission_rules, runs.isolation
    from runs
    join agents a on a.id = runs.agent_id
    join agent_versions v on v.agent_id = runs.agent_id and v.version = runs.agent_version
    where runs.id = ${runId} and runs.org_id = ${orgId} and runs.status = 'running'`;
  const r = rows[0];
  if (!r) return null;
  return {
    runId: r.id, orgId: r.org_id, agentId: r.agent_id, agentVersion: r.agent_version,
    slug: r.slug, input: r.input, instructions: r.instructions,
    permissionRules: r.permission_rules ?? [],
    ioContract: r.io_contract, kind: r.kind, threadId: r.thread_id,
    workspacePath: r.workspace_path, isolation: r.isolation,
  };
}

export interface CompleteRunInput {
  runId: string; output: string; costUsd: number | null; durationMs: number; tokensUsed?: number | null;
  /** Raw usage components behind tokensUsed. */
  usage?: RunUsage | null;
  /** The engine-side session ref this run left behind. */
  sessionRef?: string | null;
}

export async function completeRun(sql: postgres.Sql, input: CompleteRunInput): Promise<void> {
  await sql.begin(async (tx) => {
    const rows = await tx<{ org_id: string }[]>`
      update runs set status = 'succeeded', finished_at = now(),
        output = ${tx.json({ result: input.output } as unknown as postgres.JSONValue)},
        cost_estimate = ${input.costUsd}, duration_ms = ${input.durationMs},
        tokens_used = ${input.tokensUsed ?? null},
        usage = ${input.usage != null ? tx.json(input.usage as unknown as postgres.JSONValue) : null},
        session_id = ${input.sessionRef ?? null}
      where id = ${input.runId} and status = 'running'
      returning org_id`;
    const row = rows[0];
    if (!row) throw new Error(`completeRun: run not running: ${input.runId}`);
    await emitEvent(tx as unknown as postgres.Sql, {
      orgId: row.org_id, actor: 'kernel.runs', type: 'run.succeeded',
      payload: { runId: input.runId, costUsd: input.costUsd, durationMs: input.durationMs, tokensUsed: input.tokensUsed ?? null },
    });
  });
}

export interface FailRunInput { runId: string; error: string; }

/** Every failure is terminal and honest; there are no retries and no requeue. */
export async function failRun(sql: postgres.Sql, input: FailRunInput): Promise<void> {
  await sql.begin(async (tx) => {
    const rows = await tx<{ org_id: string }[]>`
      update runs set status = 'failed', finished_at = now(), failure = ${input.error}
      where id = ${input.runId} and status = 'running'
      returning org_id`;
    const row = rows[0];
    if (!row) throw new Error(`failRun: run not running: ${input.runId}`);
    await emitEvent(tx as unknown as postgres.Sql, {
      orgId: row.org_id, actor: 'kernel.runs', type: 'run.failed',
      payload: { runId: input.runId, error: input.error },
    });
  });
}

/** Heartbeat + optional bounded live tail; `alive: false` means the row was cancelled and the executor must abort the driver. */
export async function heartbeatRun(sql: postgres.Sql, runId: string, outputTail?: string): Promise<{ alive: boolean }> {
  if (outputTail === undefined) {
    const r = await sql`update runs set heartbeat_at = now() where id = ${runId} and status = 'running'`;
    return { alive: r.count > 0 };
  }
  const r = await sql`update runs set heartbeat_at = now(), output_tail = ${outputTail.slice(-4000)}
    where id = ${runId} and status = 'running'`;
  return { alive: r.count > 0 };
}

/**
 * Crash reconciliation (the Cline shape: the record follows the process): a
 * 'running' row whose heartbeat went stale has no living process behind it -
 * settle it failed so folder exclusivity and thread serialization never wedge.
 */
export async function failStaleRuns(sql: postgres.Sql, opts: { staleMs: number }): Promise<number> {
  return sql.begin(async (tx) => {
    const rows = await tx<{ id: string; org_id: string }[]>`
      update runs set status = 'failed', finished_at = now(),
        failure = 'the run process went silent (host crash or restart) - nothing more will land from it'
      where status = 'running'
        and heartbeat_at < now() - make_interval(secs => ${opts.staleMs / 1000})
      returning id, org_id`;
    for (const r of rows) {
      await emitEvent(tx as unknown as postgres.Sql, {
        orgId: r.org_id, actor: 'kernel.runs', type: 'run.failed',
        payload: { runId: r.id, error: 'stale heartbeat - settled by crash reconciliation' },
      });
    }
    return rows.length;
  }) as Promise<number>;
}

/** Cancels a running run; terminal runs refuse. */
export async function cancelRun(sql: postgres.Sql, runId: string): Promise<void> {
  await sql.begin(async (tx) => {
    const rows = await tx<{ org_id: string }[]>`
      update runs set status = 'cancelled', finished_at = now()
      where id = ${runId} and status = 'running'
      returning org_id`;
    const row = rows[0];
    if (!row) throw new Error(`run not cancellable: ${runId}`);
    await emitEvent(tx as unknown as postgres.Sql, {
      orgId: row.org_id, actor: 'kernel.runs', type: 'run.cancelled', payload: { runId },
    });
  });
}
