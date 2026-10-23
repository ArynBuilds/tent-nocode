import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

// In-house file helpers (read/grep/glob/write/edit) with bounded outputs; no gate knowledge, no shell.

const READ_MAX_LINES = 2000;
const READ_MAX_CHARS = 200_000;
const LINE_CAP = 2000;
const GREP_MAX_MATCHES = 200;
const GREP_MAX_FILES = 4000;
const GREP_MAX_FILE_BYTES = 1_000_000;
const GLOB_MAX_RESULTS = 500;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', '.venv', '__pycache__']);

export function resolveAgainst(cwd: string, p: string): string {
  return isAbsolute(p) ? resolve(p) : resolve(join(cwd, p));
}

export async function readBounded(path: string, offset?: number, limit?: number): Promise<string> {
  try {
    const raw = await readFile(path, 'utf8');
    const all = raw.split(/\r?\n/);
    const start = Math.max(0, (offset ?? 1) - 1);
    const count = Math.min(limit ?? READ_MAX_LINES, READ_MAX_LINES);
    const slice = all.slice(start, start + count).map((l, i) =>
      `${start + i + 1}\t${l.length > LINE_CAP ? l.slice(0, LINE_CAP) + '…' : l}`);
    let text = slice.join('\n');
    if (text.length > READ_MAX_CHARS) text = text.slice(0, READ_MAX_CHARS) + '\n…[truncated]';
    if (start + count < all.length) text += `\n…[${all.length - start - count} more lines — call again with offset ${start + count + 1}]`;
    return text.length > 0 ? text : '[empty file]';
  } catch (err) {
    return `cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Bounded recursive walk. Never throws; unreadable entries are skipped. */
async function walk(root: string, onFile: (path: string) => Promise<boolean>): Promise<void> {
  const queue = [root];
  let visited = 0;
  while (queue.length > 0) {
    const dir = queue.shift()!;
    let names: string[];
    try { names = await readdir(dir); } catch { continue; }
    for (const name of names) {
      const p = join(dir, name);
      let s;
      try { s = await stat(p); } catch { continue; }
      if (s.isDirectory()) {
        if (!SKIP_DIRS.has(name) && !name.startsWith('.')) queue.push(p);
        continue;
      }
      if (s.size > GREP_MAX_FILE_BYTES) continue;
      visited++;
      if (visited > GREP_MAX_FILES) return;
      if (!(await onFile(p))) return;
    }
  }
}

export async function grepBounded(pattern: string, root: string): Promise<string> {
  let re: RegExp;
  try { re = new RegExp(pattern, 'i'); } catch (err) {
    return `invalid pattern: ${err instanceof Error ? err.message : String(err)}`;
  }
  const hits: string[] = [];
  await walk(root, async (p) => {
    let text: string;
    try { text = await readFile(p, 'utf8'); } catch { return true; }
    if (text.includes('\u0000')) return true; // binary — skip
    const fileLines = text.split(/\r?\n/);
    for (let i = 0; i < fileLines.length; i++) {
      if (re.test(fileLines[i]!)) {
        hits.push(`${p}:${i + 1}: ${fileLines[i]!.slice(0, 300)}`);
        if (hits.length >= GREP_MAX_MATCHES) return false;
      }
    }
    return true;
  });
  if (hits.length === 0) return `no matches for /${pattern}/ under ${root}`;
  const capped = hits.length >= GREP_MAX_MATCHES ? `\n…[capped at ${GREP_MAX_MATCHES} matches]` : '';
  return hits.join('\n') + capped;
}

/** `**` crosses directories, `*` stays within a segment, `?` is one character. */
export function globToRegex(pattern: string): RegExp {
  const norm = pattern.replace(/\\/g, '/');
  let body = '';
  for (let i = 0; i < norm.length; i++) {
    const c = norm[i]!;
    if (c === '*') {
      if (norm[i + 1] === '*') {
        if (norm[i + 2] === '/') { body += '(?:.*/)?'; i += 2; }
        else { body += '.*'; i += 1; }
      } else {
        body += '[^/]*';
      }
    } else if (c === '?') {
      body += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      body += '\\' + c;
    } else {
      body += c;
    }
  }
  return new RegExp(`^${body}$`, 'i');
}

export async function globBounded(pattern: string, root: string): Promise<string> {
  const re = globToRegex(pattern);
  const out: string[] = [];
  await walk(root, async (p) => {
    const rel = p.slice(root.length).replace(/\\/g, '/').replace(/^\//, '');
    if (re.test(rel) || re.test(rel.split('/').pop() ?? '')) {
      out.push(p);
      if (out.length >= GLOB_MAX_RESULTS) return false;
    }
    return true;
  });
  return out.length > 0 ? out.join('\n') : `no files match ${pattern} under ${root}`;
}

export async function writeWhole(path: string, content: string): Promise<string> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, 'utf8');
    return `wrote ${content.split('\n').length} lines to ${path}`;
  } catch (err) {
    return `cannot write ${path}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function editExact(
  path: string, oldString: string, newString: string, replaceAll: boolean,
): Promise<string> {
  try {
    const text = await readFile(path, 'utf8');
    const count = text.split(oldString).length - 1;
    if (count === 0) return `old_string not found in ${path} — read the file and match its exact text`;
    if (count > 1 && !replaceAll) return `old_string appears ${count} times in ${path} — widen it to be unique, or pass replace_all`;
    const next = replaceAll ? text.split(oldString).join(newString) : text.replace(oldString, newString);
    await writeFile(path, next, 'utf8');
    return `edited ${path}`;
  } catch (err) {
    return `cannot edit ${path}: ${err instanceof Error ? err.message : String(err)}`;
  }
}
