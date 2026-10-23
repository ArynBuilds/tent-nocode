import { spawn } from 'node:child_process';

/**
 * FR-221 (D-59): no green, no "done". The project's own verifyCommand is the outcome gate —
 * run bounded in the project cwd after every edit job; a red result routes the run into the
 * correction ladder WITH this output as evidence (correction finally content-aware).
 *
 * Env posture follows nativeHost's hygiene idiom — no inherited secrets/DB creds reach the
 * command — but keeps the infra vars real dev commands need (npm/node resolve config and temp
 * space through these): PATH, SYSTEMROOT, TEMP/TMP, APPDATA/LOCALAPPDATA, USERPROFILE/HOME.
 */

const TAIL_CHARS = 2000;

const keep = (names: string[]): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const n of names) {
    const v = process.env[n];
    if (v !== undefined) env[n] = v;
  }
  return env;
};

export async function runVerify(
  dir: string, command: string, timeoutMs = 180_000,
): Promise<{ passed: boolean; tail: string }> {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let combined = '';
    const finish = (passed: boolean, note?: string): void => {
      if (settled) return;
      settled = true;
      const text = note ? `${combined}\n${note}` : combined;
      resolve({ passed, tail: text.slice(-TAIL_CHARS).trim() });
    };

    // shell:true — verifyCommand is a human-authored command line ('npm test'), consented at
    // project creation and always run in the project's own folder.
    const child = spawn(command, {
      cwd: dir, shell: true,
      env: keep(['PATH', 'SYSTEMROOT', 'COMSPEC', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOME', 'PROGRAMFILES']),
    });
    child.stdout.on('data', (d: Buffer) => { combined = (combined + d.toString()).slice(-TAIL_CHARS * 4); });
    child.stderr.on('data', (d: Buffer) => { combined = (combined + d.toString()).slice(-TAIL_CHARS * 4); });

    const timer = setTimeout(() => {
      timedOut = true;
      // shell:true means the direct child is a shell — kill the whole tree on Windows or the
      // real command survives its parent.
      if (process.platform === 'win32' && child.pid !== undefined) {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
      } else {
        child.kill('SIGKILL');
      }
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      finish(false, `verify command failed to launch: ${err.message}`);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) { finish(false, `verify timed out after ${timeoutMs}ms`); return; }
      finish(code === 0, code === 0 ? undefined : `exit code ${code}`);
    });
  });
}
