import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { connect } from 'node:net';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import postgres from 'postgres';
import { startHost } from '@nodeloom/server/host';
import { resourcePath } from './resources.js';

// THE LOCAL SERVER: the bundled Postgres under userData/pgdata, then the host on loopback - the
// workspace door the desktop talks to and the address published apps answer at.

const PG_PORT = 54329;
export const HOST_PORT = 4700;
const PG_USER = 'postgres';
const PG_PASSWORD = 'nodeloom-desktop';
// A database created under the app's former name answers to this password until it is switched once.
const FORMER_PG_PASSWORD = 'tent-nocode-desktop';

export class PortBusyError extends Error {
  readonly port: number;
  constructor(port: number) {
    super(`port ${port} is taken by another program - close it (or another copy of this app) and start again`);
    this.name = 'PortBusyError';
    this.port = port;
  }
}

/** Probe first: embedded-postgres rejects a busy port with a non-Error, so its message cannot be sniffed. */
function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' });
    const done = (result: boolean): void => { socket.destroy(); resolve(result); };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(1500, () => done(false));
  });
}

/** A clean pg_ctl fast stop on Windows; the library's own stop force-kills, costing WAL recovery next boot. */
async function pgCtlStopFast(databaseDir: string): Promise<boolean> {
  try {
    // The platform binary package exists only on Windows installs; a variable specifier keeps other platforms compiling.
    const windowsBinaries = '@embedded-postgres/windows-x64';
    const { pg_ctl } = (await import(windowsBinaries)) as { pg_ctl: string };
    return await new Promise<boolean>((resolve) => {
      const child = spawn(pg_ctl, ['stop', '-D', databaseDir, '-m', 'fast', '-w', '-t', '15'], { windowsHide: true });
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
    });
  } catch {
    return false;
  }
}

async function startPostgres(userDataDir: string): Promise<{ superUrl: string; stop: () => Promise<void> }> {
  if (await portInUse(PG_PORT)) throw new PortBusyError(PG_PORT);
  const databaseDir = join(userDataDir, 'pgdata');
  await mkdir(databaseDir, { recursive: true });
  const pg = new EmbeddedPostgres({
    databaseDir, user: PG_USER, password: PG_PASSWORD, port: PG_PORT, persistent: true,
    // UTF-8 always: initdb on Windows otherwise inherits the OS codepage and refuses emoji and non-Latin text.
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });
  if (!existsSync(join(databaseDir, 'PG_VERSION'))) await pg.initialise();
  await pg.start();
  await adoptPassword();
  const superUrl = `postgres://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/postgres`;
  const probe = postgres(superUrl, { max: 1, onnotice: () => {} });
  try {
    const [row] = await probe<{ server_encoding: string }[]>`show server_encoding`;
    if (row?.server_encoding?.toUpperCase() !== 'UTF8') {
      throw new Error(`the database at "${databaseDir}" is not UTF-8 - close the app and delete that folder to recreate it`);
    }
  } finally {
    await probe.end();
  }
  return {
    superUrl,
    stop: async () => {
      if (process.platform === 'win32' && (await pgCtlStopFast(databaseDir))) return;
      await pg.stop();
    },
  };
}

/** A database that refuses the current password but takes the former one is switched to the current one. */
async function adoptPassword(): Promise<void> {
  const urlWith = (password: string): string => `postgres://${PG_USER}:${password}@127.0.0.1:${PG_PORT}/postgres`;
  const current = postgres(urlWith(PG_PASSWORD), { max: 1, onnotice: () => {} });
  try {
    await current`select 1`;
    return;
  } catch (e) {
    if ((e as { code?: string }).code !== '28P01') throw e;
  } finally {
    await current.end();
  }
  const former = postgres(urlWith(FORMER_PG_PASSWORD), { max: 1, onnotice: () => {} });
  try {
    await former.unsafe(`alter user ${PG_USER} with password '${PG_PASSWORD}'`);
  } finally {
    await former.end();
  }
}

/** Claude Code on PATH answers its version; the same launch the driver uses. */
function claudeCodeFound(): boolean {
  const [file, ...prefix] = process.platform === 'win32' ? ['cmd.exe', '/d', '/s', '/c', 'claude'] : ['claude'];
  const probe = spawnSync(file!, [...prefix, '--version'], { windowsHide: true, timeout: 15_000, encoding: 'utf8' });
  return probe.status === 0 && /claude code/i.test(probe.stdout ?? '');
}

export interface LocalServer {
  origin: string;
  stop: () => Promise<void>;
}

export async function startLocalServer(input: {
  userDataDir: string; tokenSecret: string; vaultKey: string;
  /** The built tools MCP entry (out/main/toolsMcp.js); Electron runs it as node. */
  toolsMcpEntry: string;
}): Promise<LocalServer> {
  if (await portInUse(HOST_PORT)) throw new PortBusyError(HOST_PORT);
  const pg = await startPostgres(input.userDataDir);
  const origin = `http://127.0.0.1:${HOST_PORT}`;
  try {
    const host = await startHost({
      superUrl: pg.superUrl,
      tokenSecret: input.tokenSecret,
      baseDomain: 'localhost',
      port: HOST_PORT,
      publicOrigin: origin,
      enginesDir: resourcePath('engines'),
      fontsDir: resourcePath('fonts'),
      roomsMigrationsDir: resourcePath('roomsMigrations'),
      workspaceMigrationsDir: resourcePath('workspaceMigrations'),
      vaultMasterKey: Buffer.from(input.vaultKey, 'hex'),
      authoringRoot: join(input.userDataDir, 'authoring'),
      ...(claudeCodeFound() ? { claudeCode: { toolsMcpCommand: [process.execPath, input.toolsMcpEntry] } } : {}),
    });
    return {
      origin,
      stop: async () => {
        await host.stop().catch((e: unknown) => console.error('[host] stop failed:', e));
        await pg.stop();
      },
    };
  } catch (err) {
    await pg.stop().catch(() => undefined);
    throw err;
  }
}
