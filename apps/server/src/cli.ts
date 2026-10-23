import { existsSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import postgres from 'postgres';
import { listScenes } from '@tent-nocode/kernel';
import { ConfigRefusal, loadConfig, type ServerConfig } from './config.js';
import { bootFailureSentence, bootServer } from './boot.js';
import { provisionApp } from './provision.js';
import { createHttpHost } from './httpHost.js';
import { startHeadlessLanes } from './lanes.js';

export interface CliFlags {
  root: string;
  acceptClosure?: string;
  arm: string[];
  /** The install verb's package path. */
  file?: string;
}

export function parseFlags(argv: string[]): { verb: string | null; flags: CliFlags; refusal?: string } {
  const flags: CliFlags = { root: process.cwd(), arm: [] };
  let verb: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === '--root') {
      const v = argv[++i];
      if (v === undefined) return { verb, flags, refusal: '--root needs a directory.' };
      flags.root = v;
    } else if (a === '--accept-closure') {
      const v = argv[++i];
      if (v === undefined) return { verb, flags, refusal: '--accept-closure needs the package hash printed by the closure.' };
      flags.acceptClosure = v;
    } else if (a === '--arm') {
      const v = argv[++i];
      if (v === undefined) return { verb, flags, refusal: '--arm needs a chain name.' };
      flags.arm.push(v);
    } else if (a.startsWith('--')) {
      return { verb, flags, refusal: `Unknown flag ${a}.` };
    } else if (verb === null) {
      verb = a;
    } else if (verb === 'install' && flags.file === undefined) {
      flags.file = a;
    } else {
      return { verb, flags, refusal: `Unexpected argument "${a}".` };
    }
  }
  return { verb, flags };
}

function opsConfigFor(cfg: ServerConfig): { workerFile: string; pyodideDir: string; workspaceRoot: string; onnxDir?: string } {
  const onnxDir = join(cfg.opsDir, 'onnx');
  return {
    workerFile: cfg.opsWorkerFile,
    pyodideDir: join(cfg.opsDir, 'pyodide'),
    workspaceRoot: join(cfg.dataDir, 'workspaces'),
    ...(existsSync(onnxDir) ? { onnxDir } : {}),
  };
}

async function cmdInstall(flags: CliFlags): Promise<number> {
  const cfg = loadConfig({ env: process.env, rootDir: flags.root, requireApp: true, ...(flags.file !== undefined ? { appArg: flags.file } : {}) });
  const { sql, identity, migrations } = await bootServer(cfg);
  try {
    console.log(`[boot] migrations: ${migrations.applied.length} applied, ${migrations.skipped.length} already there`);
    const rl = flags.acceptClosure === undefined && process.stdin.isTTY
      ? createInterface({ input: process.stdin, output: process.stdout })
      : null;
    const result = await provisionApp(sql, {
      orgId: identity.orgId,
      userId: identity.ownerUserId,
      appPath: cfg.appPath!,
      ...(flags.acceptClosure !== undefined ? { acceptClosureHash: flags.acceptClosure } : {}),
      armNames: flags.arm,
      io: {
        out: (line) => console.log(line),
        ...(rl ? { confirm: async (q: string) => (await rl.question(q)).trim().toLowerCase() === 'y' } : {}),
      },
    });
    rl?.close();
    if (!result.ok) {
      console.error(result.refusal);
      return result.denied === true ? 0 : 1;
    }
    console.log(`Done. Serve it: npm run server -- serve`);
    return 0;
  } finally {
    await sql.end();
  }
}

async function cmdServe(flags: CliFlags): Promise<number> {
  const cfg = loadConfig({ env: process.env, rootDir: flags.root });
  const { sql, identity, migrations } = await bootServer(cfg);
  console.log(`[boot] migrations: ${migrations.applied.length} applied, ${migrations.skipped.length} already there`);
  const { server } = createHttpHost({
    sql,
    orgId: identity.orgId,
    visitorUserId: identity.visitorUserId,
    enginesDir: cfg.enginesDir,
    fontsDir: cfg.fontsDir,
    dbUrl: cfg.databaseUrl,
  });
  // Runtime loop: executor + trigger sweeps (liveness from feeder's short poll).
  const lanes = await startHeadlessLanes({
    sql,
    ops: opsConfigFor(cfg),
    integrations: { masterKey: null },
  });
  await new Promise<void>((resolve) => server.listen(cfg.port, resolve));
  console.log(`[serve] listening on http://localhost:${cfg.port}`);
  const stop = async (): Promise<void> => {
    server.close();
    await lanes.stop();
    await sql.end();
  };
  process.on('SIGINT', () => { void stop().then(() => process.exit(0)); });
  process.on('SIGTERM', () => { void stop().then(() => process.exit(0)); });
  return -1; // stays alive; the signal handlers own the exit
}

async function cmdStatus(flags: CliFlags): Promise<number> {
  const cfg = loadConfig({ env: process.env, rootDir: flags.root });
  const sql = postgres(cfg.databaseUrl, { max: 1, onnotice: () => {} });
  try {
    const [local] = await sql<{ org_id: string }[]>`select org_id from server_local where id = 1`;
    if (!local) {
      console.log('Not provisioned yet — run: npm run server -- install <app.tproject>');
      return 0;
    }
    const scenes = await listScenes(sql, local.org_id);
    const [pending] = await sql<{ n: number }[]>`
      select count(*)::int as n from operation_executions where org_id = ${local.org_id} and status = 'pending'`;
    const events = await sql<{ type: string; created_at: Date }[]>`
      select type, created_at from events where org_id = ${local.org_id} order by id desc limit 5`;
    console.log(`Scenes: ${scenes.length} (${scenes.map((s) => s.slug).join(', ') || 'none'})`);
    console.log(`Pending operation executions: ${pending?.n ?? 0}`);
    console.log('Recent record:');
    for (const e of events) console.log(`  ${e.created_at.toISOString()}  ${e.type}`);
    return 0;
  } catch (err) {
    // A virgin database has no tables yet — that is a state, not a crash.
    if (/does not exist/i.test(err instanceof Error ? err.message : '')) {
      console.log('Not provisioned yet — run: npm run server -- install <app.tproject>');
      return 0;
    }
    throw err;
  } finally {
    await sql.end();
  }
}

export async function runServerCli(argv: string[]): Promise<number> {
  const { verb, flags, refusal } = parseFlags(argv);
  if (refusal !== undefined) {
    console.error(refusal);
    return 1;
  }
  try {
    switch (verb) {
      case 'install': return await cmdInstall(flags);
      case 'serve': return await cmdServe(flags);
      default:
        console.error('Usage: tent-nocode-server <install <app.tproject>|serve|status> [--root <dir>] [--accept-closure <hash>] [--arm <chain>]');
        return 1;
    }
  } catch (err) {
    const { sentence, detail } = bootFailureSentence(err);
    console.error(sentence);
    console.error(`  details: ${detail}`);
    return 1;
  }
}

const entryArg = process.argv[1] !== undefined ? resolvePath(process.argv[1]) : '';
const invokedDirectly = entryArg !== '' && resolvePath(fileURLToPath(import.meta.url)) === entryArg;
if (invokedDirectly) {
  void runServerCli(process.argv.slice(2)).then((code) => {
    if (code >= 0) process.exit(code);
  });
}
