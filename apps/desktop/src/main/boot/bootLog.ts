import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Local-only boot log at userData/logs/boot.log, rotated once at 256KB; never uploaded.

const MAX_BYTES = 256 * 1024;

export interface BootLog {
  path: string;
  append(line: string): void;
}

export function createBootLog(userDataDir: string): BootLog {
  const dir = join(userDataDir, 'logs');
  const path = join(dir, 'boot.log');
  try {
    mkdirSync(dir, { recursive: true });
    if (existsSync(path) && statSync(path).size > MAX_BYTES) {
      const old = `${path}.1`;
      rmSync(old, { force: true });
      renameSync(path, old);
    }
  } catch { /* logging must never block boot */ }
  return {
    path,
    append(line: string): void {
      try {
        appendFileSync(path, `${new Date().toISOString()} ${line}\n`);
      } catch { /* never fatal */ }
    },
  };
}
