import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ContinuationRequest } from '@tent-nocode/core';

export interface MaterializedClaudeSession {
  sessionId: string;
  dir: string;
  path: string;
  jsonl: string;
}

// Materializes a record-derived conversation into a Claude Code session file so a fresh
// headless invocation can --resume it. The file is a disposable cache regenerated from the
// record every turn; ids and timestamps are deterministic so output is byte-identical.

const FILE_VERSION = '2.1.214';

/** Deterministic uuid-v4-shaped id from content (version and variant nibbles forced). */
export function deterministicUuid(content: string): string {
  const h = createHash('sha256').update(content).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** The CLI normalizes the working directory with an uppercase drive letter. */
export function normalizeCwd(cwd: string): string {
  return /^[a-z]:/.test(cwd) ? cwd[0]!.toUpperCase() + cwd.slice(1) : cwd;
}

export function claudeProjectSlug(cwd: string): string {
  // The CLI flattens every non-[A-Za-z0-9_-] character to '-'; match it exactly.
  return normalizeCwd(cwd).replace(/[^A-Za-z0-9_-]/g, '-');
}

/** Pure materialization: request to session id + target path + full JSONL bytes. */
export function materializeClaudeSession(
  req: ContinuationRequest,
  projectsRoot: string = join(homedir(), '.claude', 'projects'),
): MaterializedClaudeSession {
  const cwd = normalizeCwd(req.cwd);
  const sessionId = deterministicUuid(`tent-nocode-session:${req.key}`);
  let parent: string | null = null;
  const lines: string[] = [];
  req.history.forEach((entry, idx) => {
    const uuid = deterministicUuid(`tent-nocode-entry:${req.key}:${idx}`);
    const base = {
      parentUuid: parent,
      isSidechain: false,
      type: entry.role,
      message: entry.role === 'user'
        ? { role: 'user', content: entry.text }
        : {
            model: 'claude-fable-5', id: `msg_tent_nocode_${idx}`, type: 'message', role: 'assistant',
            content: [{ type: 'text', text: entry.text }], stop_reason: 'end_turn', stop_sequence: null,
          },
      uuid,
      timestamp: entry.at,
      ...(entry.role === 'user'
        ? { permissionMode: 'default', promptSource: 'sdk', userType: 'external', entrypoint: 'sdk-cli' }
        : {}),
      cwd, sessionId, version: FILE_VERSION, gitBranch: 'HEAD',
    };
    lines.push(JSON.stringify(base));
    parent = uuid;
  });
  const dir = join(projectsRoot, claudeProjectSlug(req.cwd));
  return { sessionId, dir, path: join(dir, `${sessionId}.jsonl`), jsonl: lines.join('\n') + '\n' };
}

/** Writes the session file; overwrite is required so each turn wipes prior appends. */
export async function writeClaudeSession(m: MaterializedClaudeSession): Promise<void> {
  await mkdir(m.dir, { recursive: true });
  await writeFile(m.path, m.jsonl, 'utf8');
}

// Deletes stale session files, but only under slugs derived from our workspaceRoot -
// the same projects root holds the user's own sessions. Never throws.
export async function sweepClaudeSessions(
  workspaceRoot: string,
  opts: { olderThanDays: number },
  projectsRoot: string = join(homedir(), '.claude', 'projects'),
): Promise<number> {
  const prefix = claudeProjectSlug(workspaceRoot);
  const cutoff = Date.now() - opts.olderThanDays * 24 * 60 * 60 * 1000;
  let deleted = 0;
  try {
    const { readdir, rm, stat } = await import('node:fs/promises');
    for (const dirName of await readdir(projectsRoot)) {
      // Our slugs are the root slug itself or root slug + '-…' (path separators flatten to '-').
      if (dirName !== prefix && !dirName.startsWith(prefix + '-')) continue;
      const dirPath = join(projectsRoot, dirName);
      let names: string[];
      try { names = await readdir(dirPath); } catch { continue; }
      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue;
        const p = join(dirPath, name);
        try {
          const s = await stat(p);
          if (s.mtimeMs < cutoff) {
            await rm(p, { force: true });
            deleted++;
          }
        } catch { /* per-file best effort */ }
      }
    }
  } catch { /* projects root missing/unreadable = nothing to sweep */ }
  return deleted;
}
