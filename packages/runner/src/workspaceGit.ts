import { appendFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';

// Git checkpoints around runs: commit before, reset on failure, worktree lifecycle.

/** Init a repo at `dir` only when neither it nor any ancestor is one. */
export async function ensureRepo(dir: string): Promise<{ inited: boolean }> {
  const git = simpleGit(dir);
  if (await git.checkIsRepo()) {
    return { inited: false };
  }
  await git.init();
  await git.addConfig('user.name', 'nodeloom');
  await git.addConfig('user.email', 'nodeloom@nodeloom.local');
  await git.addConfig('commit.gpgsign', 'false');
  const ignorePath = join(dir, '.gitignore');
  // .nodeloom-* driver files stay out of checkpoint commits.
  const lines = ['.nodeloom-*'];
  if (!existsSync(ignorePath)) {
    await writeFile(ignorePath, lines.join('\n') + '\n');
  } else {
    const current = readFileSync(ignorePath, 'utf8');
    const missing = lines.filter((l) => !current.includes(l));
    if (missing.length > 0) await appendFile(ignorePath, missing.join('\n') + '\n');
  }
  return { inited: true };
}

/** Commit the folder's entire current state as `nodeloom: <label>`; null when nothing changed. */
export async function checkpoint(dir: string, label: string): Promise<{ sha: string | null }> {
  const git = simpleGit(dir);
  const status = await git.status();
  if (status.isClean()) return { sha: null };
  // Set a local identity only when absent so commits never fail on unconfigured repos.
  if (!(await git.getConfig('user.name')).value) {
    await git.addConfig('user.name', 'nodeloom');
    await git.addConfig('user.email', 'nodeloom@nodeloom.local');
  }
  await git.add(['-A']);
  const result = await git.commit(`nodeloom: ${label}`);
  return { sha: result.commit || null };
}

/** Restore the exact checkpoint state: tracked edits reverted, new files removed. */
export async function resetTo(dir: string, sha: string): Promise<void> {
  const git = simpleGit(dir);
  await git.reset(['--hard', sha]);
  await git.clean('f', ['-d']);
}

/** Undo only the failed run's own files: created ones removed, others restored from the sha. */
export async function surgicalRevert(
  dir: string, sha: string,
  changes: { created: string[]; modified: string[]; deleted: string[] },
): Promise<void> {
  const git = simpleGit(dir);
  const restore = [...changes.modified, ...changes.deleted];
  if (restore.length > 0) {
    await git.checkout([sha, '--', ...restore]);
  }
  for (const rel of changes.created) {
    await rm(join(dir, rel), { force: true }).catch(() => { /* already gone is fine */ });
  }
}

/** The current HEAD sha, or null on a repo with no commits yet. */
export async function headSha(dir: string): Promise<string | null> {
  try {
    return (await simpleGit(dir).revparse(['HEAD'])).trim();
  } catch {
    return null;
  }
}

async function ensureIdentity(dir: string): Promise<void> {
  const git = simpleGit(dir);
  if (!(await git.getConfig('user.name')).value) {
    await git.addConfig('user.name', 'nodeloom');
    await git.addConfig('user.email', 'nodeloom@nodeloom.local');
  }
}

/** Create the run's isolated worktree at `wtDir`, seeding a base commit if the repo has none. */
export async function worktreeAdd(realDir: string, wtDir: string, branch: string): Promise<void> {
  const git = simpleGit(realDir);
  if ((await headSha(realDir)) === null) {
    await ensureIdentity(realDir);
    await checkpoint(realDir, 'worktree base');
    if ((await headSha(realDir)) === null) {
      await git.raw(['commit', '--allow-empty', '-m', 'nodeloom: worktree base']);
    }
  }
  await git.raw(['worktree', 'add', wtDir, '-b', branch]);
}

/** Merge the run's branch into the current branch; any failure aborts and reports conflicts. */
export async function mergeRunBranch(
  realDir: string, branch: string,
): Promise<{ merged: boolean; conflicts: string[]; message: string | null }> {
  const git = simpleGit(realDir);
  await ensureIdentity(realDir);
  // simple-git raw() does not reliably throw on a conflicted merge; check status instead.
  let threwMessage: string | null = null;
  try {
    await git.raw(['merge', '-m', `nodeloom: merge ${branch}`, branch]);
  } catch (err) {
    threwMessage = err instanceof Error ? err.message.slice(0, 500) : String(err);
  }
  const status = await git.status();
  if (status.conflicted.length > 0) {
    const conflicts = [...status.conflicted];
    try { await git.raw(['merge', '--abort']); } catch { /* nothing to abort */ }
    return { merged: false, conflicts, message: threwMessage };
  }
  if (threwMessage !== null) {
    // Failed without a conflict listing (dirty-tree refusal, unrelated histories).
    try { await git.raw(['merge', '--abort']); } catch { /* no merge in progress */ }
    return { merged: false, conflicts: [], message: threwMessage };
  }
  return { merged: true, conflicts: [], message: null };
}

/** Remove a run's worktree and optionally its branch; keepBranch preserves conflicted work. */
export async function worktreeRemove(
  realDir: string, wtDir: string, branch: string, opts?: { keepBranch?: boolean },
): Promise<void> {
  const git = simpleGit(realDir);
  try { await git.raw(['worktree', 'remove', '--force', wtDir]); } catch { /* already gone */ }
  try { await git.raw(['worktree', 'prune']); } catch { /* best-effort */ }
  if (opts?.keepBranch !== true) {
    try { await git.raw(['branch', '-D', branch]); } catch { /* never existed / already deleted */ }
  }
}
