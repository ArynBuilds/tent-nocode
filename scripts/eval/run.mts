/**
 * THE EVAL HARNESS (AI-surface rebuild, Phase 9.4 - the one sanctioned new-file exception).
 * Drives the walk asks through the REAL loop - executeSpawnedRun with the real charters and the
 * real tools.ts roster - against the workspace DB, records per fixture the tool sequence, call
 * count, tokens and duration, and prints a pass/fail table per binary check.
 *
 *   npx tsx scripts/eval/run.mts --list                    the fixtures; no model, no DB
 *   npx tsx scripts/eval/run.mts --dry-run                 fixtures validated against the registry; no model, no DB
 *   npx tsx scripts/eval/run.mts --driver cli [--only id]  Claude Code + the tools child (this machine's own login)
 *   npx tsx scripts/eval/run.mts --driver api --model <registry id> [--only id]
 *                                                          the API loop: the org's vaulted vendor key + VAULT_MASTER_KEY
 *
 * DB: WORKSPACE_DB_URL or DATABASE_URL. Org: EVAL_ORG_ID, or a fresh org is inserted. The fixtures
 * run IN ORDER on one project + one thread (the walk), so later asks build on earlier ones.
 */
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import {
  createChatProject, createChatTurn, createThread, ensureDeskAgent, parseMasterKey,
  registerRunSpawner, resolveConsentCard, resolveSecretValue, setOrgConfig,
} from '@tent-nocode/kernel';
import {
  ApiDriver, ClaudeCodeDriver, createDirectKernelPort, executeSpawnedRun, productToolSpecs,
  type ExecutionDriver, type RunnerConfig,
} from '@tent-nocode/runner';

const ROOT = resolve(import.meta.dirname, '..', '..');
/** The harness's own actor id: every kernel door takes a uuid, never a word. */
const EVAL_USER = '00000000-0000-4000-8000-00000000e0a1';
/** The driver of the current run - the checks read it (the cli lane has no thinking text). */
let DRIVER_NAME: 'cli' | 'api' = 'cli';
const FIXTURES_FILE = join(ROOT, 'scripts', 'eval', 'fixtures.json');

const CLASSES = ['answer', 'change', 'first-surface', 'plan', 'card'] as const;
const CHECKS = [
  'sequence-matches', 'calls-under-max', 'tokens-under-budget', 'no-invalid-twice', 'no-wordless-thoughts', 'ends-with-report',
] as const;
type FixtureClass = (typeof CLASSES)[number];
type CheckName = (typeof CHECKS)[number];

interface Fixture {
  id: string;
  class: FixtureClass;
  ask: string;
  /** The ordered door sequence: tool names from the six-tool roster. */
  expectedDoors: string[];
  maxCalls: number;
  maxTokens: number;
  checks: CheckName[];
  /** The human's answer to the card this ask raises; absent = no card expected. */
  card?: 'approve' | 'decline';
}

/** One recorded tool call, from the run's own surface.tool_invoked events. */
interface Call { tool: string; invalid: boolean }

interface Telemetry {
  runId: string;
  status: string;
  failure: string | null;
  finalText: string;
  calls: Call[];
  tokens: number | null;
  durationMs: number;
  wordlessThoughts: number;
}

// ---------------------------------------------------------------------------
// Fixtures + the registry (no DB, no model).
// ---------------------------------------------------------------------------

function loadFixtures(): Fixture[] {
  const raw = JSON.parse(readFileSync(FIXTURES_FILE, 'utf8')) as unknown;
  if (!Array.isArray(raw)) throw new Error('fixtures.json must be an array');
  return raw as Fixture[];
}

/** The live roster names, built from the one tool file with every lane enabled; no DB touched. */
function rosterNames(): Set<string> {
  const specs = productToolSpecs({
    sql: undefined as unknown as postgres.Sql,
    ctx: {
      orgId: randomUUID(), runId: randomUUID(), threadId: randomUUID(), projectId: randomUUID(),
      kind: 'chat', modelId: 'cli', permissionRules: [], snapshot: { url: 'http://127.0.0.1', token: 'eval' },
    },
    cwd: ROOT,
    navigate: async () => ({ text: '' }),
    briefModel: async () => '',
  });
  return new Set(specs.map((s) => s.name));
}

/** Every fixture field and every door name checked against the registry; the problems, or none. */
function validateFixtures(fixtures: Fixture[]): string[] {
  const problems: string[] = [];
  const roster = rosterNames();
  const ids = new Set<string>();
  for (const f of fixtures) {
    const at = `fixture '${String(f.id)}'`;
    if (typeof f.id !== 'string' || f.id.length === 0) problems.push('a fixture has no id');
    if (ids.has(f.id)) problems.push(`${at}: duplicate id`);
    ids.add(f.id);
    if (!CLASSES.includes(f.class)) problems.push(`${at}: class '${String(f.class)}' is not one of ${CLASSES.join(', ')}`);
    if (typeof f.ask !== 'string' || f.ask.length === 0) problems.push(`${at}: ask is empty`);
    if (!Array.isArray(f.expectedDoors)) problems.push(`${at}: expectedDoors must be an array`);
    else {
      for (const door of f.expectedDoors) {
        if (!roster.has(door)) problems.push(`${at}: door '${door}' names no tool in the roster (${[...roster].join(', ')})`);
      }
    }
    if (!Number.isInteger(f.maxCalls) || f.maxCalls < 0) problems.push(`${at}: maxCalls must be a non-negative integer`);
    if (!Number.isInteger(f.maxTokens) || f.maxTokens <= 0) problems.push(`${at}: maxTokens must be a positive integer`);
    if (!Array.isArray(f.checks) || f.checks.length === 0) problems.push(`${at}: checks must name at least one check`);
    else for (const c of f.checks) if (!CHECKS.includes(c)) problems.push(`${at}: check '${String(c)}' is not one of ${CHECKS.join(', ')}`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// The binary checks - each answers pass/fail with one line of evidence.
// ---------------------------------------------------------------------------

const SENTENCE_CAPPED_CLASSES = new Set<FixtureClass>(['change', 'plan']);

function sentenceCount(text: string): number {
  return text.split(/[.!?]+(?:\s|$)/).map((s) => s.trim()).filter((s) => s.length > 0).length;
}

function runCheck(name: CheckName, f: Fixture, t: Telemetry): { pass: boolean; evidence: string } {
  const doors = t.calls.map((c) => c.tool);
  switch (name) {
    case 'sequence-matches': {
      const pass = doors.length === f.expectedDoors.length && doors.every((d, i) => d === f.expectedDoors[i]);
      return { pass, evidence: `got [${doors.join(', ')}] expected [${f.expectedDoors.join(', ')}]` };
    }
    case 'calls-under-max':
      return { pass: t.calls.length <= f.maxCalls, evidence: `${t.calls.length} calls, max ${f.maxCalls}` };
    case 'tokens-under-budget':
      return t.tokens === null
        ? { pass: false, evidence: 'no token count recorded on the run' }
        : { pass: t.tokens <= f.maxTokens, evidence: `${t.tokens} tokens, budget ${f.maxTokens}` };
    case 'no-invalid-twice': {
      let twice: string | null = null;
      for (let i = 1; i < t.calls.length; i += 1) {
        const a = t.calls[i - 1]!;
        const b = t.calls[i]!;
        if (a.invalid && b.invalid && a.tool === b.tool) { twice = doors[i]!; break; }
      }
      return { pass: twice === null, evidence: twice === null ? 'no consecutive invalid results' : `two consecutive invalid results on ${twice}` };
    }
    case 'no-wordless-thoughts':
      // The CLI lane's thinking blocks carry no text by construction (Claude Code owns them); the feed hides them.
      if (DRIVER_NAME === 'cli') return { pass: true, evidence: 'n/a on the cli lane (wordless by construction)' };
      return { pass: t.wordlessThoughts === 0, evidence: `${t.wordlessThoughts} wordless thinking steps` };
    case 'ends-with-report': {
      const text = t.finalText.trim();
      if (text.length === 0) return { pass: false, evidence: 'the final text is empty' };
      if (!SENTENCE_CAPPED_CLASSES.has(f.class)) return { pass: true, evidence: `${text.length} chars` };
      const n = sentenceCount(text);
      return { pass: n <= 3, evidence: `${n} sentences (cap 3 for ${f.class})` };
    }
  }
}

// ---------------------------------------------------------------------------
// The live drive: one org, one project, one thread; each fixture is one desk turn.
// ---------------------------------------------------------------------------

interface DriveOptions { driver: 'cli' | 'api'; model: string | null; only: string | null }

async function readTelemetry(sql: postgres.Sql, orgId: string, runId: string, durationMs: number): Promise<Telemetry> {
  const [run] = await sql<{ status: string; failure: string | null; result: string | null; tokens_used: number | null }[]>`
    select status, failure, output->>'result' as result, tokens_used from runs where id = ${runId} and org_id = ${orgId}`;
  const events = await sql<{ type: string; payload: Record<string, unknown> }[]>`
    select type, payload from events
    where org_id = ${orgId} and type in ('surface.tool_invoked', 'run.activity') and payload->>'runId' = ${runId}
    order by id asc`;
  const calls: Call[] = [];
  let wordlessThoughts = 0;
  for (const e of events) {
    const p = e.payload;
    if (e.type === 'surface.tool_invoked') {
      const tool = String(p['tool'] ?? '');
      const status = p['status'];
      const invalid = status === 'invalid' || status === 'stopped' || p['ok'] === false;
      calls.push({ tool, invalid });
      continue;
    }
    const steps = Array.isArray(p['steps']) ? (p['steps'] as { kind?: string; text?: string }[]) : [];
    for (const s of steps) if (s.kind === 'thinking' && (typeof s.text !== 'string' || s.text.trim().length === 0)) wordlessThoughts += 1;
  }
  return {
    runId, status: run?.status ?? 'missing', failure: run?.failure ?? null, finalText: run?.result ?? '',
    calls, tokens: run?.tokens_used ?? null, durationMs, wordlessThoughts,
  };
}

async function drive(fixtures: Fixture[], opts: DriveOptions): Promise<number> {
  const url = process.env['WORKSPACE_DB_URL'] ?? process.env['DATABASE_URL'];
  if (url === undefined || url.length === 0) {
    console.error('no DB: set WORKSPACE_DB_URL or DATABASE_URL');
    return 2;
  }
  // The tools child (CLI lane) reads DATABASE_URL from this process env.
  if (process.env['DATABASE_URL'] === undefined) process.env['DATABASE_URL'] = url;
  const sql = postgres(url, { max: 4, onnotice: () => {} });
  const port = createDirectKernelPort(sql);
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'tent-nocode-eval-'));
  try {
    let orgId = process.env['EVAL_ORG_ID'];
    if (orgId === undefined || orgId.length === 0) {
      const [org] = await sql<{ id: string }[]>`insert into orgs (name) values (${'eval ' + new Date().toISOString()}) returning id`;
      orgId = org!.id;
    }
    await ensureDeskAgent(sql, orgId);
    const { projectId } = await createChatProject(sql, { orgId, name: 'eval walk', createdBy: EVAL_USER, kind: 'app' });
    const { threadId } = await createThread(sql, { orgId, title: 'eval walk', createdBy: EVAL_USER, projectId });

    let driver: ExecutionDriver;
    const cfg: RunnerConfig = { maxConcurrent: 1, heartbeatMs: 1_500, workspaceRoot };
    if (opts.driver === 'api') {
      if (opts.model === null) { console.error('--driver api needs --model <registry id>'); return 2; }
      const material = process.env['VAULT_MASTER_KEY'];
      if (material === undefined || material.length === 0) { console.error('--driver api needs VAULT_MASTER_KEY (the vault holding the vendor key)'); return 2; }
      const masterKey = parseMasterKey(material);
      const apiDriver = new ApiDriver({
        sql,
        resolveSecret: async (o, name) => resolveSecretValue(sql, masterKey, { orgId: o, projectId: null, name }).catch(() => null),
      });
      await setOrgConfig(sql, orgId, { deskModel: opts.model }, { updatedBy: EVAL_USER });
      cfg.apiDriver = apiDriver;
      driver = apiDriver; // chat turns route to the API lane inside executeRun; this base driver is never reached for them
    } else {
      const tsxCli = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
      const toolsSrc = join(ROOT, 'packages', 'runner', 'src', 'tools.ts');
      cfg.toolsMcpCommand = [process.execPath, tsxCli, toolsSrc];
      driver = new ClaudeCodeDriver();
    }

    // The spawner executes each desk turn HERE and keeps its promise so the harness can await the settle.
    const inFlight = new Map<string, Promise<unknown>>();
    registerRunSpawner(async ({ orgId: o, runId }) => {
      const task = executeSpawnedRun(port, driver, cfg, o, runId);
      inFlight.set(runId, task);
      await task;
    });

    const selected = opts.only === null ? fixtures : fixtures.filter((f) => f.id === opts.only);
    if (selected.length === 0) { console.error(`no fixture named '${String(opts.only)}'`); return 2; }
    DRIVER_NAME = opts.driver;
    console.log(`driver ${opts.driver}${opts.model !== null ? ` (${opts.model})` : ''} · org ${orgId} · project ${projectId} · thread ${threadId}`);
    const rows: { fixture: string; check: string; pass: boolean; evidence: string }[] = [];
    let failed = 0;
    for (const f of selected) {
      const started = Date.now();
      const { runId } = await createChatTurn(sql, { orgId, threadId, text: f.ask, by: EVAL_USER });
      const task = inFlight.get(runId);
      if (task !== undefined) await task.catch(() => undefined);
      // The human's answer: every card this ask raised is answered as the fixture says, then every wake it spawns settles.
      if (f.card !== undefined) {
        const open = await sql<{ id: string }[]>`
          select id from messages where org_id = ${orgId} and type = 'escalation' and answered_at is null
            and payload->>'threadId' = ${threadId} order by created_at asc`;
        for (const m of open) await resolveConsentCard(sql, { orgId, messageId: m.id, approved: f.card === 'approve', resolvedBy: EVAL_USER });
        console.log(`  card: ${open.length} answered (${f.card})`);
        await Promise.allSettled([...inFlight.values()]);
      }
      const t = await readTelemetry(sql, orgId, runId, Date.now() - started);
      console.log(`\n[${f.id}] ${f.class} · run ${runId} · ${t.status}${t.failure !== null ? ` (${t.failure})` : ''}`);
      console.log(`  doors: [${t.calls.map((c) => c.tool + (c.invalid ? '!' : '')).join(', ')}] · ${t.calls.length} calls · ${t.tokens ?? 'n/a'} tokens · ${t.durationMs} ms`);
      console.log(`  final: ${t.finalText.replace(/\s+/g, ' ').slice(0, 200)}`);
      for (const c of f.checks) {
        const r = runCheck(c, f, t);
        if (!r.pass) failed += 1;
        rows.push({ fixture: f.id, check: c, pass: r.pass, evidence: r.evidence });
      }
    }
    printTable(rows);
    console.log(`\n${rows.length - failed} passed · ${failed} failed`);
    return failed === 0 ? 0 : 1;
  } finally {
    registerRunSpawner(null);
    await sql.end({ timeout: 5 }).catch(() => undefined);
  }
}

function printTable(rows: { fixture: string; check: string; pass: boolean; evidence: string }[]): void {
  const w1 = Math.max(7, ...rows.map((r) => r.fixture.length));
  const w2 = Math.max(5, ...rows.map((r) => r.check.length));
  console.log(`\n${'fixture'.padEnd(w1)}  ${'check'.padEnd(w2)}  result  evidence`);
  for (const r of rows) {
    console.log(`${r.fixture.padEnd(w1)}  ${r.check.padEnd(w2)}  ${(r.pass ? 'pass' : 'FAIL').padEnd(6)}  ${r.evidence}`);
  }
}

// ---------------------------------------------------------------------------
// The CLI.
// ---------------------------------------------------------------------------

function flag(argv: string[], name: string): string | null {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('--') ? argv[i + 1]! : null;
}

async function main(argv: string[]): Promise<number> {
  const fixtures = loadFixtures();
  if (argv.includes('--list')) {
    for (const f of fixtures) {
      console.log(`${f.id.padEnd(20)} ${f.class.padEnd(14)} doors [${f.expectedDoors.join(', ')}] · max ${f.maxCalls} calls · ${f.maxTokens} tokens · "${f.ask}"`);
    }
    console.log(`${fixtures.length} fixtures`);
    return 0;
  }
  if (argv.includes('--dry-run')) {
    const problems = validateFixtures(fixtures);
    if (problems.length > 0) {
      for (const p of problems) console.log(`problem: ${p}`);
      return 1;
    }
    console.log(`${fixtures.length} fixtures valid: every door names a live tool, every check a known check`);
    return 0;
  }
  const driverFlag = flag(argv, '--driver');
  if (driverFlag !== 'cli' && driverFlag !== 'api') {
    console.error('usage: run.mts --list | --dry-run | --driver cli|api [--model <registry id>] [--only <fixture id>]');
    return 2;
  }
  const problems = validateFixtures(fixtures);
  if (problems.length > 0) { for (const p of problems) console.error(`problem: ${p}`); return 1; }
  return drive(fixtures, { driver: driverFlag, model: flag(argv, '--model'), only: flag(argv, '--only') });
}

process.exitCode = await main(process.argv.slice(2));
