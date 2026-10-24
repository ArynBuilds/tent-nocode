import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { app, shell } from 'electron';
import { importFormatFor } from '@nodeloom/core';
import { workspaceCall } from '../workspaceClient.js';
import { assertOwnOrg, handle } from './registry.js';

// THE DISK: every door that reads or writes this machine's files - the code tab's write, the viewer's read,
// the import staging.

const WRITE_CAP = 256 * 1024;

/** Write door for the code tab: absolute path, inside a live folder grant, size-capped, evented. */
async function writeFileForEditImpl(
  hasGrant: (dir: string) => Promise<boolean>, absolutePath: string, content: string,
): Promise<{ ok: true; bytes: number } | { ok: false; error: string }> {
  if (typeof absolutePath !== 'string' || !isAbsolute(absolutePath)) {
    return { ok: false, error: 'an absolute path is required' };
  }
  if (!(await hasGrant(dirname(absolutePath)))) {
    return { ok: false, error: 'this file is outside every granted folder' };
  }
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > WRITE_CAP) {
    return { ok: false, error: `the editor writes files up to ${WRITE_CAP / 1024}KB` };
  }
  try {
    // Overwrite-only: the door edits existing files, never creates them.
    await readFile(absolutePath);
  } catch {
    return { ok: false, error: 'no file at that path - the write door edits existing files' };
  }
  try {
    await writeFile(absolutePath, content, 'utf8');
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'unwritable file' };
  }
  return { ok: true, bytes: Buffer.byteLength(content, 'utf8') };
}

const hasGrant = async (dir: string): Promise<boolean> => (await workspaceCall('findActiveFolderGrant', [dir])) !== null;

/** Reads a local file for viewing; the folder grant is checked before the bytes are read. */
export async function readFileForViewImpl(
  hasGrant: (dir: string) => Promise<boolean>, absolutePath: string,
): Promise<{ ok: true; content: string; truncated: boolean } | { ok: false; error: string }> {
  if (typeof absolutePath !== 'string' || !isAbsolute(absolutePath)) {
    return { ok: false, error: 'an absolute path is required' };
  }
  if (!(await hasGrant(dirname(absolutePath)))) {
    return { ok: false, error: 'this file is outside every granted folder' };
  }
  try {
    const CAP = 256 * 1024;
    const buf = await readFile(absolutePath);
    const truncated = buf.byteLength > CAP;
    return { ok: true, content: buf.subarray(0, CAP).toString('utf8'), truncated };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'unreadable file' };
  }
}

export function registerFileHandlers(): void {
  handle('writeFileForEdit', ['submit'], async (identity, orgId: string, absolutePath: string, content: string) => {
    assertOwnOrg(identity, orgId);
    const res = await writeFileForEditImpl(hasGrant, absolutePath, content);
    if (!res.ok) throw new Error(res.error);
    await workspaceCall('humanFileWritten', [{ path: absolutePath, bytes: res.bytes }]);
    return undefined;
  });

  // Reveals a delivered file in the OS file manager.
  handle('openPath', ['submit'], async (_identity, _orgId: string, absolutePath: string) => {
    if (typeof absolutePath !== 'string' || !isAbsolute(absolutePath)) {
      return { ok: false as const, error: 'openPath requires an absolute path' };
    }
    shell.showItemInFolder(absolutePath);
    return { ok: true as const };
  });

  handle('readFileForView', [], async (_identity, _orgId: string, absolutePath: string) => readFileForViewImpl(hasGrant, absolutePath));

  // Import: rows files stage locally for the ops loop; a .tproject parses here and the parsed package travels the wire.
  handle('humanImportFile', ['approve_plan'], async (_identity, _orgId: string, filePath: string, projectId?: string) => {
    const fmt = importFormatFor(basename(filePath));
    if (fmt === null) throw new Error("this file isn't an importable format");
    if (fmt.lane === 'package') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(filePath, 'utf8'));
      } catch {
        throw new Error('this file could not be read as a package');
      }
      return workspaceCall('humanImportPackage', [{
        file: parsed, sourceName: basename(filePath),
        ...(projectId !== undefined ? { projectId } : {}),
      }]);
    }
    if (projectId === undefined) throw new Error('focus a project first — the table needs a home');
    const dir = join(app.getPath('userData'), 'workspaces', 'imports');
    mkdirSync(dir, { recursive: true });
    const staged = join(dir, `${randomUUID()}.${fmt.ext}`);
    try {
      copyFileSync(filePath, staged);
    } catch {
      throw new Error('this file could not be read');
    }
    return workspaceCall('humanImportRows', [{
      projectId, fileName: basename(filePath), stagedPath: staged, ext: fmt.ext,
    }]);
  });

}
