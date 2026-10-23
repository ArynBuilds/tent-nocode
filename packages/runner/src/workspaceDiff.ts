import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

// Snapshots a workspace before a run and diffs it after to record what changed on disk.
export type WorkspaceSnapshot = Map<string, { mtimeMs: number; size: number }>;

const MAX_DEPTH = 4;
const MAX_ENTRIES = 5000;

export async function snapshotWorkspace(dir: string): Promise<WorkspaceSnapshot> {
  const snap: WorkspaceSnapshot = new Map();
  async function walk(current: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH || snap.size >= MAX_ENTRIES) return;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip, never fail
    }
    for (const e of entries) {
      if (snap.size >= MAX_ENTRIES) return;
      const full = join(current, e.name);
      if (e.isDirectory()) {
        await walk(full, depth + 1);
      } else if (e.isFile()) {
        try {
          const s = await stat(full);
          snap.set(relative(dir, full), { mtimeMs: s.mtimeMs, size: s.size });
        } catch { /* raced/unreadable file — skip */ }
      }
    }
  }
  await walk(dir, 0);
  return snap;
}

export interface WorkspaceChanges {
  created: string[];
  modified: string[];
  deleted: string[];
}

export function diffSnapshots(before: WorkspaceSnapshot, after: WorkspaceSnapshot): WorkspaceChanges {
  const created: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  for (const [path, meta] of after) {
    const prev = before.get(path);
    if (!prev) created.push(path);
    else if (prev.mtimeMs !== meta.mtimeMs || prev.size !== meta.size) modified.push(path);
  }
  for (const path of before.keys()) {
    if (!after.has(path)) deleted.push(path);
  }
  return { created: created.sort(), modified: modified.sort(), deleted: deleted.sort() };
}
