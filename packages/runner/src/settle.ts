import type postgres from 'postgres';
import type { DriverResult } from '@nodeloom/core';
import { checkContract } from '@nodeloom/kernel';
import type { SpawnedRun } from '@nodeloom/kernel';
import { toKernelPort, type KernelPort } from './kernelPort.js';
import { snapshotWorkspace, diffSnapshots, type WorkspaceSnapshot } from './workspaceDiff.js';
import { checkpoint, mergeRunBranch, surgicalRevert, worktreeRemove } from './workspaceGit.js';
import { runVerify } from './verifyProject.js';
import { scrubSecretValues } from './scrub.js';
import type { RunnerConfig, RunOutcome } from './runner.js';

// Post-run settle half of the loop kernel: the one place a driver result becomes
// a run outcome. Failures are terminal and honest - no retries, no requeue.

// Settles serialize per org through this in-process chain; a failed settle never blocks the org's next one.
const orgSettleChains = new Map<string, Promise<void>>();

/** Enqueue `fn` on the org's settle chain; worktree merges ride the same serialization. */
function enqueueOrgChain(orgId: string, fn: () => Promise<void>): Promise<void> {
  const prev = orgSettleChains.get(orgId) ?? Promise.resolve();
  const next = prev.then(fn);
  const guarded = next.catch(() => { /* the chain must survive a failed settle */ });
  orgSettleChains.set(orgId, guarded);
  void guarded.then(() => { if (orgSettleChains.get(orgId) === guarded) orgSettleChains.delete(orgId); });
  return next;
}

export interface SettleContext {
  cfg: RunnerConfig;
  claim: SpawnedRun;
  workspaceDir: string;
  workspaceBefore: WorkspaceSnapshot | null;
  projectCtx: { projectId: string; verifyCommand: string | null; preSha: string | null } | null;
  /** Failure settle: no half-edited project folders, ever. Owned by executeRun. */
  revertProjectOnFailure: () => Promise<void>;
  /** Set when this run executed in an isolated worktree; settle merges or discards it. */
  isolationCtx?: { realDir: string; wtDir: string; branch: string } | null;
  /** Secret values scrubbed from output and failure messages before they reach the record. */
  scrubValues?: readonly string[];
}

/** On a terminal WORK run, the mission reviews the settle (loop.ts owns the wake decision); never-fail. */
async function wakeMission(port: KernelPort, claim: SpawnedRun): Promise<void> {
  if (claim.kind !== 'work' || claim.threadId === null) return;
  try {
    await port.maybeSpawnLoopWake({ orgId: claim.orgId, threadId: claim.threadId, settledRunId: claim.runId });
  } catch (err) {
    console.error('mission wake failed for run', claim.runId, err instanceof Error ? err.message : String(err));
  }
}

/** The one place a driver result becomes a run outcome: recording, gates, worktree settle, the mission wake. */
export async function settleDriverResult(
  db: postgres.Sql | KernelPort, result: DriverResult, ctx: SettleContext,
): Promise<RunOutcome> {
  const port = toKernelPort(db);
  const { cfg, claim, workspaceDir, workspaceBefore, projectCtx, revertProjectOnFailure } = ctx;
  void cfg;
  const isolationCtx = ctx.isolationCtx ?? null;
  // Every non-merge exit discards the worktree, branch included; never-fail.
  const discardIsolation = async (): Promise<void> => {
    if (isolationCtx === null) return;
    try {
      await worktreeRemove(isolationCtx.realDir, isolationCtx.wtDir, isolationCtx.branch);
    } catch (err) {
      console.error('worktree discard failed for run', claim.runId, err instanceof Error ? err.message : String(err));
    }
  };
  // Stored output speaks the real folder: worktree paths rewrite back, both slash spellings.
  const scrubWorktreePath = (text: string): string => {
    if (isolationCtx === null) return text;
    const { wtDir, realDir } = isolationCtx;
    return text.split(wtDir).join(realDir)
      .split(wtDir.replace(/\\/g, '/')).join(realDir);
  };
  // Every text that reaches the record passes this scrub composition.
  const scrubAll = (text: string): string => scrubSecretValues(scrubWorktreePath(text), ctx.scrubValues ?? []);

  if (result.status === 'succeeded' && /timed out|stalled/i.test(result.errorMessage ?? '')) {
    await discardIsolation();
    await port.failRun({ runId: claim.runId, error: scrubAll(result.errorMessage ?? 'timed out') });
    await wakeMission(port, claim);
    return 'failed';
  }
  if (result.status === 'succeeded') {
    try {
      await port.completeRun({
        runId: claim.runId, output: scrubAll(result.output ?? ''), costUsd: result.costUsd, durationMs: result.durationMs,
        tokensUsed: result.tokensUsed ?? null,
        usage: result.usage ?? null,
        sessionRef: result.sessionRef ?? null,
      });
    } catch (e) {
      // Run was cancelled mid-execution — the record already moved on.
      console.error('completeRun skipped (run no longer running):', claim.runId, e instanceof Error ? e.message : String(e));
      await discardIsolation(); // cancelled mid-settle — the folder never sees this work
      return 'idle';
    }
    // Diff the consented workspace and record what actually changed; never-fail.
    if (workspaceBefore !== null) {
      try {
        const changes = diffSnapshots(workspaceBefore, await snapshotWorkspace(workspaceDir));
        const sample = [...changes.created, ...changes.modified, ...changes.deleted].slice(0, 10);
        const totalChanges = changes.created.length + changes.modified.length + changes.deleted.length;
        await port.emitEvent({
          orgId: claim.orgId, actor: 'kernel.runner', type: 'run.workspace_changes',
          payload: {
            runId: claim.runId, workspacePath: claim.workspacePath,
            created: changes.created.length, modified: changes.modified.length, deleted: changes.deleted.length,
            sample,
          },
        });
        // A task run holding write allows that changed nothing is a hallucinated completion.
        if (totalChanges === 0 && claim.workspacePath !== null
            && typeof claim.input['task'] === 'string'
            && claim.permissionRules.some((r) => r.effect === 'allow' && /^(Write|Edit)\b/.test(r.pattern))) {
          // Surface writes count as effects too; zero-change fails only with no write-class surface tool invoked.
          if (await port.countRunSurfaceWrites(claim.orgId, claim.runId) === 0) {
            await port.failDeliveredRun(claim.runId,
              'no filesystem changes detected in the consented workspace — the task requires acting with the Write/Edit/Bash tools; describing the work is a failure');
          }
        }
      } catch (err) {
        console.error('workspace verification failed for run', claim.runId, err instanceof Error ? err.message : String(err));
      }
    }
    // Labeled post-run commit, after the diff so .git churn never pollutes workspace_changes.
    if (projectCtx !== null) {
      try {
        const goalish = [claim.input['goal'], claim.input['task']].find((v) => typeof v === 'string') as string | undefined;
        const goal60 = (goalish ?? claim.slug).slice(0, 60);
        const post = await checkpoint(workspaceDir, `${goal60} (run ${claim.runId.slice(0, 8)})`);
        if (post.sha !== null) {
          await port.emitEvent({
            orgId: claim.orgId, actor: 'kernel.runner', type: 'project.checkpoint',
            payload: { runId: claim.runId, projectId: projectCtx.projectId, phase: 'post', sha: post.sha },
          });
        }
      } catch (err) {
        console.error('project post-checkpoint failed for run', claim.runId, err instanceof Error ? err.message : String(err));
      }
    }
    // The project's verifyCommand gates the outcome; a broken harness must not strand a completed run.
    if (projectCtx !== null && projectCtx.verifyCommand !== null && claim.kind === 'work') {
      try {
        const v = await runVerify(workspaceDir, projectCtx.verifyCommand);
        await port.emitEvent({
          orgId: claim.orgId, actor: 'kernel.runner',
          type: v.passed ? 'project.verify_passed' : 'project.verify_failed',
          payload: { runId: claim.runId, projectId: projectCtx.projectId, command: projectCtx.verifyCommand, tail: v.tail },
        });
        if (!v.passed) {
          await port.failDeliveredRun(claim.runId,
            `verify failed (${projectCtx.verifyCommand}): ${v.tail.slice(-800)}`);
        }
      } catch (err) {
        console.error('verify gate error for run', claim.runId, err instanceof Error ? err.message : String(err));
      }
    }
    // Contract check runs on every work run's output; a miss fails the run honestly.
    if (claim.kind === 'work') {
      try {
        const cc = checkContract(claim.ioContract, { result: result.output ?? '' });
        if (!cc.ok) {
          await port.failDeliveredRun(claim.runId, `missing declared outputs: ${cc.missing.join(', ')}`);
        }
      } catch (err) {
        console.error('contract check error for run', claim.runId, err instanceof Error ? err.message : String(err));
      }
    }
    // Worktree settles: merge on a delivered run, discard when a gate flipped it; a conflict never auto-resolves.
    if (isolationCtx !== null) {
      const { realDir, wtDir, branch } = isolationCtx;
      try {
        const runStatus = await port.getRunStatus(claim.runId);
        if (runStatus === 'succeeded') {
          // Commit any uncommitted work to the branch (projects already post-committed — no-op).
          await checkpoint(wtDir, `run ${claim.runId.slice(0, 8)} settle`);
          await enqueueOrgChain(claim.orgId, async () => {
            const m = await mergeRunBranch(realDir, branch);
            if (m.merged) {
              await worktreeRemove(realDir, wtDir, branch);
              await port.emitEvent({
                orgId: claim.orgId, actor: 'kernel.runner', type: 'worktree.merged',
                payload: { runId: claim.runId, branch, workspacePath: claim.workspacePath },
              });
            } else {
              await worktreeRemove(realDir, wtDir, branch, { keepBranch: true });
              await port.emitEvent({
                orgId: claim.orgId, actor: 'kernel.runner', type: 'worktree.merge_conflict',
                payload: {
                  runId: claim.runId, branch, workspacePath: claim.workspacePath,
                  files: m.conflicts, message: m.message,
                },
              });
              // The deliverable is parked, named, never lost.
              const note = `\n\nMERGE CONFLICT: this run's work could not merge into ${claim.workspacePath}`
                + (m.conflicts.length > 0 ? ` (conflicting files: ${m.conflicts.join(', ')})` : '')
                + `. The work is preserved on git branch ${branch} — nothing was auto-resolved.`;
              await port.appendMergeConflictNote(claim.runId, note);
            }
          });
        } else {
          await discardIsolation();
        }
      } catch (err) {
        console.error('worktree settle failed for run', claim.runId, err instanceof Error ? err.message : String(err));
      }
    }
    // Pending derived outputs flip registered or missing after the gates and merge; never-fail.
    try {
      if (isolationCtx !== null) {
        await port.rewriteDerivedOutputPathKeys(claim.orgId, claim.runId, isolationCtx.wtDir, isolationCtx.realDir);
      }
      const finalStatus = await port.getRunStatus(claim.runId);
      await port.confirmDerivedOutputs({
        orgId: claim.orgId, runId: claim.runId, runSucceeded: finalStatus === 'succeeded',
      });
    } catch (err) {
      console.error('derived-output confirm failed for run', claim.runId, err instanceof Error ? err.message : String(err));
    }
    await wakeMission(port, claim);
    return 'ran';
  }
  if (result.status === 'rate_limited') {
    // No queue to requeue into: a rate-limited run fails honestly and the user retries when the window opens.
    await discardIsolation();
    await port.failRun({
      runId: claim.runId,
      error: `rate limited: ${scrubAll(result.errorMessage ?? 'the model refused for rate limits')} - retry in a while`,
    });
    await wakeMission(port, claim);
    return 'failed';
  }
  // Surgical revert first — undo only the files this run touched; full reset is the fallback.
  if (projectCtx?.preSha != null && workspaceBefore !== null) {
    try {
      const changes = diffSnapshots(workspaceBefore, await snapshotWorkspace(workspaceDir));
      await surgicalRevert(workspaceDir, projectCtx.preSha, changes);
      await port.emitEvent({
        orgId: claim.orgId, actor: 'kernel.runner', type: 'project.reverted',
        payload: {
          runId: claim.runId, projectId: projectCtx.projectId,
          sha: projectCtx.preSha, mode: 'surgical',
          created: changes.created.length, modified: changes.modified.length, deleted: changes.deleted.length,
        },
      });
    } catch (err) {
      console.error('surgical revert failed for run', claim.runId, '— falling back to full reset:',
        err instanceof Error ? err.message : String(err));
      await revertProjectOnFailure();
    }
  } else {
    await revertProjectOnFailure();
  }
  // A failed isolated run discards its worktree.
  await discardIsolation();
  // A failed run's pending registrations turn missing; never-fail.
  try {
    await port.confirmDerivedOutputs({ orgId: claim.orgId, runId: claim.runId, runSucceeded: false });
  } catch (err) {
    console.error('derived-output confirm (failure path) failed for run', claim.runId, err instanceof Error ? err.message : String(err));
  }
  await port.failRun({ runId: claim.runId, error: scrubAll(result.errorMessage ?? 'driver failure') });
  await wakeMission(port, claim);
  return 'failed';
}
