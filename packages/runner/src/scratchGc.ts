import { readdir, rm, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

// Deletes old scratch run workspaces; only uuid-named direct children of workspaceRoot, never throws.

const UUID_DIR_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function sweepScratchWorkspaces(
  workspaceRoot: string,
  opts: { olderThanDays: number },
): Promise<{ deleted: string[] }> {
  const deleted: string[] = [];
  const rootAbs = resolve(workspaceRoot);
  const cutoffMs = Date.now() - opts.olderThanDays * 86_400_000;

  let entries;
  try {
    entries = await readdir(rootAbs, { withFileTypes: true });
  } catch {
    return { deleted }; // no scratch root yet — nothing to sweep
  }
  for (const e of entries) {
    if (!e.isDirectory() || !UUID_DIR_RE.test(e.name)) continue;
    const full = resolve(rootAbs, e.name);
    // Never delete anything that is not strictly inside workspaceRoot.
    if (!full.startsWith(rootAbs + sep)) continue;
    try {
      const s = await stat(full);
      if (s.mtimeMs >= cutoffMs) continue;
      await rm(full, { recursive: true, force: true });
      deleted.push(e.name);
    } catch { /* raced/locked dir — skip, next sweep retries */ }
  }
  return { deleted };
}
