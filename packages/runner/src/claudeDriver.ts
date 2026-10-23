import { spawn, type ChildProcess } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  CompiledInvocation, ContinuationRequest, DriverCapabilities, DriverHooks, DriverResult,
  PreparedContinuation, RunUsage,
} from '@tent-nocode/core';
import { KERNEL_DENY_RULES, cliSettingsFor, floorAskRules, type PermissionRule } from '@tent-nocode/kernel';
import type { ExecutionDriver } from './driver.js';
import { materializeClaudeSession, writeClaudeSession } from './continuationClaude.js';
import { NdjsonBuffer, mapStreamLine } from './streamParser.js';

// Matches every known CLI quota/limit message shape so limits settle 'rate_limited', not 'failed'.
const RATE_LIMIT_RE = /rate.?limit|usage limit|session limit|hit your [\w-]{0,12} ?limit|limit (?:reached|exceeded)|\blimit\b[^.\n]{0,24}resets|too many requests|overloaded/i;

const ENV_ALLOWLIST = [
  'PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'COMSPEC', 'ComSpec',
  'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP',
  'PATHEXT', 'WINDIR', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
  'LANG', 'LC_ALL', 'TZ',
];

/** When a run injects a credential, the parent's copies of these must not survive beside it. */
const CREDENTIAL_ENV_VARS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];

/** Builds the child env: OS/CLI essentials plus injected secrets; never leaks DATABASE_URL or TENT_SECRET_*. */
export function buildChildEnv(parentEnv: NodeJS.ProcessEnv, injected: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const v = parentEnv[key];
    if (v !== undefined) base[key] = v;
  }
  // Pass through the CLI's auth/config vars; excludes DATABASE_URL and TENT_SECRET_*.
  for (const [k, v] of Object.entries(parentEnv)) {
    if (v === undefined) continue;
    if (k.startsWith('CLAUDE_') || k === 'CLAUDECODE' || k.startsWith('ANTHROPIC_')) base[k] = v;
  }
  // Injected auth is exclusive: drop the parent's credential vars so they cannot shadow it.
  if (CREDENTIAL_ENV_VARS.some((k) => injected[k] !== undefined)) {
    for (const k of CREDENTIAL_ENV_VARS) delete base[k];
  }
  return { ...base, ...injected };
}

interface ClaudeResultJson {
  is_error?: boolean;
  result?: string;
  total_cost_usd?: number;
  duration_ms?: number;
  num_turns?: number;
  session_id?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

/** Effective tokens: each usage component weighted by its real cost relative to one uncached input token. */
function tokensFromUsage(usage: ClaudeResultJson['usage']): number | null {
  if (usage === undefined) return null;
  const n = (v: unknown): number | null => (typeof v === 'number' ? v : null);
  const input = n(usage.input_tokens);
  const output = n(usage.output_tokens);
  const cacheWrite = n(usage.cache_creation_input_tokens);
  const cacheRead = n(usage.cache_read_input_tokens);
  if (input === null && output === null && cacheWrite === null && cacheRead === null) return null;
  return Math.round((input ?? 0) + 1.25 * (cacheWrite ?? 0) + 0.1 * (cacheRead ?? 0) + 5 * (output ?? 0));
}

/** The four raw usage components, persisted per run for cache forensics. */
function componentsFromUsage(usage: ClaudeResultJson['usage']): RunUsage | null {
  if (usage === undefined) return null;
  const n = (v: unknown): number | null => (typeof v === 'number' ? v : null);
  const parsed: RunUsage = {
    inputTokens: n(usage.input_tokens),
    outputTokens: n(usage.output_tokens),
    cacheReadTokens: n(usage.cache_read_input_tokens),
    cacheWriteTokens: n(usage.cache_creation_input_tokens),
  };
  if (parsed.inputTokens === null && parsed.outputTokens === null
    && parsed.cacheReadTokens === null && parsed.cacheWriteTokens === null) return null;
  return parsed;
}

/** Maps CLI output to a DriverResult; the truth is the last parseable result line, with a whole-blob fallback. */
export function parseClaudeOutput(stdout: string, stderr: string, exitCode: number, durationMs: number): DriverResult {
  let json: ClaudeResultJson | null = null;
  const lines = stdout.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]!) as (ClaudeResultJson & { type?: string }) | null;
      if (obj !== null && typeof obj === 'object' && obj.type === 'result') { json = obj; break; }
      if (lines.length === 1) { json = obj; break; } // legacy single blob (any shape)
    } catch { /* keep scanning upward — earlier lines may be partial writes */ }
  }

  if (exitCode === 0 && json !== null && typeof json === 'object' && json.is_error !== true) {
    return {
      status: 'succeeded',
      output: json.result ?? '',
      errorMessage: null,
      costUsd: json.total_cost_usd ?? null,
      durationMs: json.duration_ms ?? durationMs,
      numTurns: json.num_turns ?? null,
      tokensUsed: tokensFromUsage(json.usage),
      usage: componentsFromUsage(json.usage),
      sessionRef: typeof json.session_id === 'string' ? json.session_id : null,
    };
  }

  // Stream-json errors land on stdout: carry the last stdout line into the failure
  // and run the rate-limit regex over it too.
  const lastStdout = lines.length > 0 ? lines[lines.length - 1]!.slice(0, 300) : '';
  const errorText = [json?.result, stderr].filter(Boolean).join(' | ')
    || (lastStdout ? `claude exited ${exitCode} · last stdout: ${lastStdout}` : `claude exited ${exitCode}`);
  return {
    status: RATE_LIMIT_RE.test(`${json?.result ?? ''} ${stderr} ${lastStdout}`) ? 'rate_limited' : 'failed',
    output: null,
    errorMessage: errorText,
    costUsd: json?.total_cost_usd ?? null,
    durationMs: json?.duration_ms ?? durationMs,
    numTurns: json?.num_turns ?? null,
    tokensUsed: tokensFromUsage(json?.usage),
    usage: componentsFromUsage(json?.usage),
  };
}

// Force-kills the child and its whole tree; on Windows child.kill() alone leaves orphans.
function killChild(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid !== undefined) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
    } catch {
      child.kill();
    }
  } else {
    child.kill();
  }
}

// ---- The CLI invocation assembly (landed beside the driver at the Phase 4 charter cutover). ----

export interface CliCompileInput {
  /** The composed system prompt (a charter compose's output; may carry {{secret:NAME}} refs). */
  systemPrompt: string;
  input: Record<string, unknown>;
  // The run's declared pattern ruleset; the kernel floor's ask-rules are always unioned in.
  permissionRules: PermissionRule[];
  workspaceDir: string;
  maxTurns?: number;
  model?: string;
  // Mount the tools.ts roster server.
  surfaceTools?: boolean;
  // Mount the walled browser tool.
  browseTools?: boolean;
  // Mount the visible-browser verbs, except acquire_browser (the consent gate).
  panelBrowserTools?: boolean;
  // Absolute mcp-config path outside the workspace; the relative default is only safe secret-free.
  mcpConfigPath?: string;
  // Where the runner writes settingsJson (absolute, outside the workspace); relative default is test-only.
  settingsPath?: string;
}

export interface CompiledCliInvocation extends CompiledInvocation {
  requiredSecrets: string[];
  // Per-run CLI settings content the runner writes before spawn; null on the tool-less path.
  settingsJson: string | null;
}

const SECRET_REF_RE = /\{\{secret:([A-Z0-9_]+)\}\}/g;

// Pure invocation assembly for the headless CLI. The driver writes systemPrompt to a file and sends promptText via stdin so argv never carries free text.
export function compileCliInvocation(input: CliCompileInput): CompiledCliInvocation {
  const argv = [
    '-p',
    // --verbose is required by the CLI for -p + stream-json.
    '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    // One ceiling for every run kind; budget caps, heartbeats, and cancel are the real guards.
    '--max-turns', String(input.maxTurns ?? 50),
    '--append-system-prompt-file', '.tent-nocode-system.md',
    // Deterministic permission surface, independent of the host's ~/.claude config.
    '--setting-sources', '',
    '--permission-mode', 'default',
  ];
  const mcpToolIds = [
    // The tools.ts roster server mounts the seven on every CLI-lane run.
    ...(input.surfaceTools === true
      ? ['mcp__tent-nocode-tools__read', 'mcp__tent-nocode-tools__contract', 'mcp__tent-nocode-tools__rows',
         'mcp__tent-nocode-tools__record', 'mcp__tent-nocode-tools__pixels', 'mcp__tent-nocode-tools__edit',
         'mcp__tent-nocode-tools__brief']
      : []),
    ...(input.browseTools === true ? ['mcp__tent-nocode-browser__browse_open'] : []),
    // acquire_browser is deliberately absent: its call falls to the permission wall; the other verbs are walled by the single-holder lease.
    ...(input.panelBrowserTools === true
      ? ['mcp__tent-nocode-panelbrowser__open_page', 'mcp__tent-nocode-panelbrowser__read_page',
         'mcp__tent-nocode-panelbrowser__screenshot', 'mcp__tent-nocode-panelbrowser__click',
         'mcp__tent-nocode-panelbrowser__type_text', 'mcp__tent-nocode-panelbrowser__scroll',
         'mcp__tent-nocode-panelbrowser__wait', 'mcp__tent-nocode-panelbrowser__hand_back',
         'mcp__tent-nocode-panelbrowser__release_browser']
      : []),
  ];
  // An explicit mcpConfigPath also forces the flag: external MCP mounts have no pre-enumerable tool ids.
  if (mcpToolIds.length > 0 || input.mcpConfigPath !== undefined) {
    // The mcp-config can carry secrets, so it lives outside the model's workspace.
    argv.push('--mcp-config', input.mcpConfigPath ?? '.tent-nocode-mcp.json');
  }
  let settingsJson: string | null = null;
  if (input.permissionRules.length > 0 || mcpToolIds.length > 0) {
    // The per-run settings file is the enforcement surface; the floor's ask-rules ride every governed run.
    const settings = cliSettingsFor([
      ...KERNEL_DENY_RULES,
      ...floorAskRules(),
      ...input.permissionRules,
      ...mcpToolIds.map((id) => ({ effect: 'allow' as const, pattern: id })),
    ]);
    settingsJson = JSON.stringify(settings, null, 2);
    argv.push('--settings', input.settingsPath ?? '.tent-nocode-settings.json');
  } else {
    // Tool-less by construction: --tools '' disables all tools, including any future built-ins.
    argv.push('--tools', '');
  }
  if (input.model) argv.push('--model', input.model);

  // Secret values never enter prompts: the token becomes an env-var pointer.
  const requiredSecrets: string[] = [];
  const systemPrompt = input.systemPrompt.replace(SECRET_REF_RE, (_m, name: string) => {
    if (!requiredSecrets.includes(name)) requiredSecrets.push(name);
    return `[secret ${name} is available as environment variable ${name}]`;
  });

  return {
    argv,
    promptText: JSON.stringify({ task: input.input }),
    systemPrompt,
    cwd: input.workspaceDir,
    // Harness memory stays off for product runs; this env var covers every branch including tool-less.
    env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
    requiredSecrets,
    settingsJson,
  };
}

export interface ClaudeDriverOptions {
  command?: string[];
  /** Explicit absolute ceiling; when omitted only silence kills (the stall watchdog). */
  timeoutMs?: number;
  mcpConfigPath?: string;
}

/** Stall threshold: a run silent this long is hung; 12 min clears the longest legitimate silent tool call. */
export const STALL_MS = 12 * 60 * 1000;

// Headless Claude Code driver; system prompt goes to a file, prompt via stdin - no free text crosses the shell.
export class ClaudeCodeDriver implements ExecutionDriver {
  readonly name = 'claude-code-local';
  /** What this engine declares to kernel policy; 200k is the CLI's default context window. */
  readonly capabilities: DriverCapabilities = {
    continuation: 'resume-file',
    cacheModel: 'block-prefix',
    windowTokens: 200_000,
  };
  private readonly command: string[];
  private readonly timeoutMs: number | undefined;
  private readonly mcpConfigPath: string | undefined;

  constructor(opts: ClaudeDriverOptions = {}) {
    this.command = opts.command ??
      (process.platform === 'win32' ? ['cmd.exe', '/d', '/s', '/c', 'claude'] : ['claude']);
    // No default absolute ceiling; explicit timeoutMs stays an absolute, non-resetting bound.
    this.timeoutMs = opts.timeoutMs;
    this.mcpConfigPath = opts.mcpConfigPath;
  }

  /** Resume an existing engine session by ref. */
  resumeArgs(sessionRef: string): string[] {
    return ['--resume', sessionRef];
  }

  /** Materializes history as a session file and returns the resume argv; null = cold path, never an error. */
  async prepareContinuation(req: ContinuationRequest): Promise<PreparedContinuation | null> {
    if (req.history.length === 0) return null;
    try {
      const m = materializeClaudeSession(req);
      await writeClaudeSession(m);
      return { argvExtra: ['--resume', m.sessionId], sessionRef: m.sessionId };
    } catch {
      return null;
    }
  }

  async execute(inv: CompiledInvocation, hooks?: DriverHooks): Promise<DriverResult> {
    const systemPromptFile = join(inv.cwd, '.tent-nocode-system.md');
    await writeFile(systemPromptFile, inv.systemPrompt, 'utf8');
    const [file, ...prefix] = this.command;
    if (!file) throw new Error('ClaudeCodeDriver: empty command');
    const started = Date.now();

    // The prompt file must exist during the run but never remain in the user's folder;
    // best-effort removal, a cleanup failure never fails the run.
    const cleanup = async (): Promise<void> => {
      try { await rm(systemPromptFile, { force: true }); } catch { /* never fail the run over cleanup */ }
    };

    const argv = this.mcpConfigPath !== undefined
      ? [...inv.argv, '--mcp-config', this.mcpConfigPath]
      : inv.argv;

    const signal = hooks?.signal;
    const result = await new Promise<DriverResult>((resolve) => {
      // Already aborted before spawn: start no child.
      if (signal?.aborted) {
        resolve({ status: 'failed', output: null, errorMessage: 'aborted before start', costUsd: null, durationMs: 0, numTurns: null, tokensUsed: null });
        return;
      }

      const child = spawn(file, [...prefix, ...argv], {
        cwd: inv.cwd,
        env: buildChildEnv(process.env, inv.env),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      let compacted = false;
      // onOutput carries only human-readable text, never raw NDJSON.
      const ndjson = new NdjsonBuffer();
      // Thinking streams as deltas: keep a short buffer and attach only a headline; the body never persists.
      let thinkBuf = '';
      const handleLines = (lines: string[]): void => {
        for (const line of lines) {
          const mapped = mapStreamLine(line);
          if (mapped === null) continue;
          if (mapped.compacted === true) compacted = true;
          if (mapped.thinkDelta !== undefined && thinkBuf.length < 300) thinkBuf += mapped.thinkDelta;
          for (const step of mapped.steps) {
            if (step.kind === 'thinking' && (step.text === undefined || step.text.length === 0) && thinkBuf.trim().length > 0) {
              const headline = (thinkBuf.split('\n').find((l) => l.trim().length > 0) ?? '').trim().slice(0, 100);
              if (headline.length > 0) step.text = headline;
            }
            if (step.kind === 'thinking') thinkBuf = '';
            hooks?.onEvent?.(step);
            if (step.kind === 'text' && step.text !== undefined) hooks?.onOutput?.(step.text + '\n');
          }
          if (mapped.delta !== undefined) hooks?.onTextDelta?.(mapped.delta);
        }
      };
      // Single-settle: watchdog, abort, error, and close can race; the first wins.
      let settled = false;
      const finish = (r: DriverResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve(r);
      };

      // Explicit timeoutMs is an absolute bound; otherwise every stream byte re-arms the stall watchdog.
      const absolute = this.timeoutMs !== undefined;
      const deadlineMs = this.timeoutMs ?? STALL_MS;
      const onDeadline = (): void => {
        killChild(child);
        finish({
          status: 'failed', output: null,
          errorMessage: absolute ? `timed out after ${deadlineMs}ms` : `stalled: no engine output for ${deadlineMs}ms`,
          costUsd: null, durationMs: Date.now() - started, numTurns: null, tokensUsed: null,
        });
      };
      let timer = setTimeout(onDeadline, deadlineMs);
      const feedWatchdog = (): void => {
        if (absolute || settled) return;
        clearTimeout(timer);
        timer = setTimeout(onDeadline, deadlineMs);
      };

      child.stdout.on('data', (d: Buffer) => { feedWatchdog(); const s = d.toString(); stdout += s; handleLines(ndjson.feed(s)); });
      child.stderr.on('data', (d: Buffer) => { feedWatchdog(); stderr += d.toString(); });

      // On abort, kill the tree and settle immediately rather than waiting for close.
      const onAbort = (): void => {
        killChild(child);
        finish({ status: 'failed', output: null, errorMessage: 'aborted', costUsd: null, durationMs: Date.now() - started, numTurns: null, tokensUsed: null });
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });

      child.on('error', (err) => {
        finish({ status: 'failed', output: null, errorMessage: err.message, costUsd: null, durationMs: Date.now() - started, numTurns: null, tokensUsed: null });
      });
      child.on('close', (code) => {
        handleLines(ndjson.flush());
        const parsed = parseClaudeOutput(stdout, stderr, code ?? -1, Date.now() - started);
        finish(compacted ? { ...parsed, compactedAnomaly: true } : parsed);
      });

      child.stdin.write(inv.promptText);
      child.stdin.end();
    });
    await cleanup();
    return result;
  }
}
