import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Loads server config from env and tent-nocode-server.config.json with named refusals for missing keys. */

export class ConfigRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigRefusal';
  }
}

export interface ServerConfig {
  databaseUrl: string;
  port: number;
  /** Path to the `.tproject` file — required for `install`; optional for `serve` (an
   * already-provisioned database needs no file). */
  appPath: string | null;
  dataDir: string;
  enginesDir: string;
  fontsDir: string;
  /** The heavy-operation runtimes (pyodide, onnx) live here. */
  opsDir: string;
  opsWorkerFile: string;
  migrationsDir: string;
}

export const DEFAULT_PORT = 4680;
export const CONFIG_FILE_NAME = 'tent-nocode-server.config.json';

interface FileConfig {
  port?: number;
}

function readConfigFile(rootDir: string): FileConfig {
  const path = join(rootDir, CONFIG_FILE_NAME);
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new ConfigRefusal(`${CONFIG_FILE_NAME} is not valid JSON — fix or delete the file and try again.`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigRefusal(`${CONFIG_FILE_NAME} must be a JSON object.`);
  }
  const cfg = parsed as Record<string, unknown>;
  const out: FileConfig = {};
  if (cfg['port'] !== undefined) {
    if (typeof cfg['port'] !== 'number' || !Number.isInteger(cfg['port'])) {
      throw new ConfigRefusal(`${CONFIG_FILE_NAME}: "port" must be an integer.`);
    }
    out.port = cfg['port'];
  }
  return out;
}

function parsePort(raw: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigRefusal(`PORT must be an integer between 1 and 65535 — got "${raw}".`);
  }
  return port;
}

/** A Tent NoCode checkout runs from its own tree; a built bundle carries resources/ and migrations/ beside it. */
function layoutOf(rootDir: string): Pick<ServerConfig, 'enginesDir' | 'fontsDir' | 'opsDir' | 'opsWorkerFile' | 'migrationsDir'> {
  if (existsSync(join(rootDir, 'apps', 'desktop'))) {
    return {
      enginesDir: join(rootDir, 'apps', 'desktop', 'resources', 'engines'),
      fontsDir: join(rootDir, 'apps', 'desktop', 'src', 'renderer', 'fonts'),
      opsDir: join(rootDir, 'apps', 'desktop', 'resources'),
      opsWorkerFile: join(rootDir, 'packages', 'runner', 'src', 'ops', 'opsWorker.cjs'),
      migrationsDir: join(rootDir, 'packages', 'kernel', 'migrations'),
    };
  }
  return {
    enginesDir: join(rootDir, 'resources', 'engines'),
    fontsDir: join(rootDir, 'resources', 'fonts'),
    opsDir: join(rootDir, 'resources'),
    opsWorkerFile: join(rootDir, 'resources', 'opsWorker.cjs'),
    migrationsDir: join(rootDir, 'migrations'),
  };
}

/** Resolves full server config from rootDir, env, and optional config file; requireApp gates the install verb. */
export function loadConfig(input: {
  env: Record<string, string | undefined>;
  rootDir: string;
  /** The install verb's package path (its argument); TENT_APP is the fallback. */
  appArg?: string;
  requireApp?: boolean;
}): ServerConfig {
  const { env, rootDir } = input;
  const file = readConfigFile(rootDir);

  const databaseUrl = env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new ConfigRefusal(
      'DATABASE_URL is not set. Point it at any Postgres 15+ database, e.g. '
      + 'postgres://user:password@localhost:5432/tent-nocode.',
    );
  }

  const port = env['PORT'] !== undefined && env['PORT'] !== '' ? parsePort(env['PORT']) : (file.port ?? DEFAULT_PORT);
  if (file.port !== undefined && (file.port < 1 || file.port > 65535)) {
    throw new ConfigRefusal(`${CONFIG_FILE_NAME}: "port" must be between 1 and 65535.`);
  }

  const appPath = input.appArg ?? (env['TENT_APP'] !== undefined && env['TENT_APP'] !== '' ? env['TENT_APP'] : null);
  if (input.requireApp === true && appPath === null) {
    throw new ConfigRefusal(
      'Name the .tproject file to install, e.g. npm run server -- install app.tproject',
    );
  }
  if (appPath !== null && !existsSync(appPath)) {
    throw new ConfigRefusal(`TENT_APP points at "${appPath}", but no file exists there.`);
  }

  const dataDir = env['TENT_DATA'] !== undefined && env['TENT_DATA'] !== '' ? env['TENT_DATA'] : join(rootDir, 'tent-nocode-data');

  return {
    databaseUrl,
    port,
    appPath,
    dataDir,
    ...layoutOf(rootDir),
  };
}
