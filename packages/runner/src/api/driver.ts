import type postgres from 'postgres';
import { generateText, stepCountIs, streamText, type LanguageModel, type ModelMessage, type ToolSet } from 'ai';
import type {
  CompiledInvocation, ContinuationRequest, DriverCapabilities, DriverHooks, DriverResult,
  PreparedContinuation, RunUsage,
} from '@tent-nocode/core';
import type { ExecutionDriver } from '../driver.js';
import { STALL_MS } from '../claudeDriver.js';
import { languageModelFor, resolveRegistryModel, vaultNameFor, type ModelEntry } from './providers.js';
import { buildToolRoster } from '../tools.js';
import { ApiStepMapper } from './steps.js';
import {
  DEFAULT_TURN_EFFECTIVE_TOKEN_CEILING, componentsFromLoopUsage, effectiveTokens,
  turnCeilingSentence, type LoopUsageLike,
} from './usage.js';
import {
  nextStoredMessages, pgContinuationStore, priorMessagesFor, withAnthropicCacheBreakpoint,
  type ContinuationStore,
} from './continuation.js';

// ApiDriver: in-process agent loop on the Vercel AI SDK behind the ExecutionDriver seam.
// The vendor key resolves inside execute() and dies with the call - never env, argv, URL, or log.

// One ceiling for every run kind; the auto-finalize round and the 3-strike stop end a turn long before it.
const MAX_STEPS = 50;

const API_RATE_LIMIT_RE = /rate.?limit|too many requests|overloaded|quota|insufficient_quota/i;
const CONTEXT_OVERFLOW_RE = /context.length|context window|prompt is too long|maximum context|too many total (text bytes|tokens)|input length.*exceeds/i;

/** The one write door whose results decide the auto-finalize correction. */
const WRITE_DOORS = new Set(['edit']);
/** A final text that names the wait is an honest ending for a waiting call. */
const NAMES_THE_WAIT_RE = /\b(wait|waiting|card|approv|consent|permission)/i;

interface LastWrite { tool: string; verdict: 'invalid' | 'stopped' | 'waiting' | 'landed'; reason: string }

/** Reads a write-door result off its raw tool output; null for any other tool. */
function writeVerdict(toolName: string, output: unknown): LastWrite | null {
  if (!WRITE_DOORS.has(toolName)) return null;
  let parsed: unknown = output;
  if (typeof output === 'string') {
    try { parsed = JSON.parse(output); } catch { parsed = null; }
  }
  if (parsed === null || typeof parsed !== 'object') return { tool: toolName, verdict: 'landed', reason: '' };
  const r = parsed as Record<string, unknown>;
  const reason = typeof r['reason'] === 'string' ? r['reason']
    : Array.isArray(r['reason']) ? r['reason'].map(String).join(' | ')
      : typeof r['error'] === 'string' ? r['error'] : 'no reason given';
  if (r['status'] === 'stopped') return { tool: toolName, verdict: 'stopped', reason };
  if (r['status'] === 'waiting') return { tool: toolName, verdict: 'waiting', reason: typeof r['note'] === 'string' ? r['note'] : reason };
  if (r['status'] === 'invalid' || r['ok'] === false) return { tool: toolName, verdict: 'invalid', reason };
  return { tool: toolName, verdict: 'landed', reason: '' };
}

/** The ONE correction message (n8n's FIX instruction shape); null = the turn ended honestly. */
function correctionFor(last: LastWrite | null, finalText: string): string | null {
  if (last === null || last.verdict === 'landed') return null;
  if (last.verdict === 'waiting' && NAMES_THE_WAIT_RE.test(finalText)) return null;
  const what = last.verdict === 'stopped' ? 'stopped'
    : last.verdict === 'waiting' ? 'left waiting on a consent card, which your reply does not say' : 'refused';
  return `Your last ${last.tool} call was ${what}: ${last.reason.slice(0, 1500)}. Fix ALL named issues in one call, or report the gap plainly. Do NOT claim it landed.`;
}

export type ApiLaneResolution =
  | { route: 'api'; model: ModelEntry }
  | { route: 'missing-key'; model: ModelEntry; reason: string }
  | null;

export interface ApiDriverOptions {
  sql?: postgres.Sql;
  /** Vault decryptor for in-process key resolve. */
  resolveSecret?: (orgId: string, name: string) => Promise<string | null>;
  /** True when Claude Code is on the machine: a missing key hands the chat to it instead of failing. */
  cliFallback?: boolean;
  /** Per-turn effective-token ceiling; <=0 disables. */
  turnEffectiveTokenCeiling?: number;
  /** Test seams — production uses the real factories. */
  stallMs?: number;
  maxSteps?: number;
  languageModelFor?: (entry: ModelEntry, apiKey: string) => LanguageModel;
  toolsFactory?: typeof buildToolRoster;
  store?: ContinuationStore | null;
}

export class ApiDriver implements ExecutionDriver {
  readonly name = 'api-loop';
  /** 'resume-file' here only means this engine can continue; the real store is message arrays. */
  readonly capabilities: DriverCapabilities = {
    continuation: 'resume-file',
    cacheModel: 'block-prefix',
    windowTokens: 200_000,
  };
  private readonly opts: ApiDriverOptions;
  /** prepareContinuation stashes prior messages per thread key; execute consumes. */
  private readonly pending = new Map<string, ModelMessage[]>();

  constructor(opts: ApiDriverOptions = {}) {
    this.opts = opts;
  }

  /** Routing decision: null = CLI lane; 'missing-key' = explicit API pick without its vendor key. */
  async resolveLane(orgId: string, modelPin: string | null): Promise<ApiLaneResolution> {
    const entry = resolveRegistryModel(modelPin);
    if (entry === null) return null; // a CLI-lane pin — not ours
    const key = this.opts.resolveSecret === undefined
      ? null
      : await this.opts.resolveSecret(orgId, vaultNameFor(entry)).catch(() => null);
    if (key === null || key === '') {
      if (this.opts.cliFallback === true) return null;
      // The default pick is an API model too: no key is a missing key, never a silent fall into the unhosted CLI lane.
      return {
        route: 'missing-key', model: entry,
        reason: `the picked model '${entry.display}' needs a ${entry.vendor === 'anthropic' ? 'Anthropic' : 'OpenAI'} API key - add it in Settings, Engines`,
      };
    }
    return { route: 'api', model: entry };
  }

  /** Answers with the stored message array or a seed from history; null = cold turn, never an error. */
  async prepareContinuation(req: ContinuationRequest): Promise<PreparedContinuation | null> {
    try {
      const store = this.storeFor();
      const stored = store === null ? null : await store.load(req.key);
      const prior = priorMessagesFor(stored, req.history);
      if (prior.length === 0) return null;
      this.pending.set(req.key, prior);
      return { argvExtra: [], sessionRef: `api:${req.key}` };
    } catch {
      return null;
    }
  }

  private storeFor(): ContinuationStore | null {
    if (this.opts.store !== undefined) return this.opts.store;
    return this.opts.sql !== undefined ? pgContinuationStore(this.opts.sql) : null;
  }

  async execute(inv: CompiledInvocation, hooks?: DriverHooks): Promise<DriverResult> {
    const started = Date.now();
    const fail = (msg: string, status: 'failed' | 'rate_limited' = 'failed'): DriverResult => ({
      status, output: null, errorMessage: msg, costUsd: null,
      durationMs: Date.now() - started, numTurns: null, tokensUsed: null,
    });
    const ctx = inv.apiTurn;
    if (ctx === undefined) return fail('api driver invoked without a turn context');
    const entry = resolveRegistryModel(ctx.modelId);
    if (entry === null || entry.id !== ctx.modelId) return fail(`unknown API model '${ctx.modelId}'`);
    const key = this.opts.resolveSecret === undefined
      ? null
      : await this.opts.resolveSecret(ctx.orgId, vaultNameFor(entry)).catch(() => null);
    if ((key === null || key === '') && this.opts.languageModelFor === undefined) {
      return fail(`the ${entry.vendor === 'anthropic' ? 'Anthropic' : 'OpenAI'} API key is no longer in the vault — add it in Settings, Engines`);
    }
    const model = (this.opts.languageModelFor ?? languageModelFor)(entry, key ?? '');
    const sql = this.opts.sql;
    if (sql === undefined && this.opts.toolsFactory === undefined) {
      return fail('api driver has no database connection for its tools');
    }
    const tools: ToolSet = (this.opts.toolsFactory ?? buildToolRoster)({
      sql: sql as postgres.Sql, ctx, cwd: inv.cwd,
      // The brief tool's one model call rides this turn's model, tool-less (the summary-bridge precedent); its
      // usage joins the turn's totals.
      briefModel: async (prompt) => {
        const r = await generateText({ model, prompt, abortSignal: abort.signal });
        addUsage(r.usage as LoopUsageLike | undefined);
        return r.text;
      },
    });

    // ---- messages: system (+ cache breakpoint) · prior real history · this turn. ----
    const prior = ctx.threadId !== null ? (this.pending.get(ctx.threadId) ?? []) : [];
    if (ctx.threadId !== null) this.pending.delete(ctx.threadId);
    const anthropicCache = entry.caching === 'breakpoints';
    const systemMessage: ModelMessage = {
      role: 'system', content: inv.systemPrompt,
      ...(anthropicCache ? { providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } } : {}),
    } as ModelMessage;
    const priorWired = anthropicCache && prior.length > 0 ? withAnthropicCacheBreakpoint(prior) : prior;
    const userMessage: ModelMessage = { role: 'user', content: inv.promptText };
    const messages: ModelMessage[] = [systemMessage, ...priorWired, userMessage];

    // ---- the loop: stall watchdog + step cap + the effective-token ceiling. One round; the
    // auto-finalize correction below may add exactly one more - never a third. ----
    const ceiling = this.opts.turnEffectiveTokenCeiling ?? DEFAULT_TURN_EFFECTIVE_TOKEN_CEILING;
    const maxSteps = this.opts.maxSteps ?? MAX_STEPS;
    const stallMs = this.opts.stallMs ?? STALL_MS;
    const abort = new AbortController();
    let stalled = false;
    let externalAbort = false;
    const onOuterAbort = (): void => { externalAbort = true; abort.abort(); };
    hooks?.signal?.addEventListener('abort', onOuterAbort, { once: true });
    if (hooks?.signal?.aborted) return fail('aborted before start');
    let stallTimer = setTimeout(() => { stalled = true; abort.abort(); }, stallMs);
    const feedWatchdog = (): void => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => { stalled = true; abort.abort(); }, stallMs);
    };

    let spentEffective = 0;
    let ceilingHit = false;
    let stepCapHit = false;
    let numSteps = 0;
    const usageTotals: RunUsage = { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null };
    const addUsage = (u: LoopUsageLike | undefined): void => {
      const parts = componentsFromLoopUsage(u);
      if (parts === null) return;
      const acc = (a: number | null, b: number | null): number | null =>
        b === null ? a : (a ?? 0) + b;
      usageTotals.inputTokens = acc(usageTotals.inputTokens, parts.inputTokens);
      usageTotals.outputTokens = acc(usageTotals.outputTokens, parts.outputTokens);
      usageTotals.cacheReadTokens = acc(usageTotals.cacheReadTokens, parts.cacheReadTokens);
      usageTotals.cacheWriteTokens = acc(usageTotals.cacheWriteTokens, parts.cacheWriteTokens);
      spentEffective = effectiveTokens(usageTotals) ?? spentEffective;
    };

    const mapper = new ApiStepMapper();
    let fatal: unknown = null;
    let finishReason: string | null = null; // captured from the stream's own finish part
    const textBlocks: string[] = [];
    /** Everything after the user message, in order: round-one responses, the correction, round-two responses. */
    const turnMessages: ModelMessage[] = [];
    /** The turn's last write-door result (edit / act / data), read off the stream's own tool-result parts. */
    let lastWrite: LastWrite | null = null;
    // The ceiling condition derives its spend from the SDK's OWN steps argument at
    // evaluation time (never a callback-ordering race with onStepFinish).
    const spentFromSteps = (steps: Array<{ usage?: unknown }>): number => {
      let eff = 0;
      for (const s of steps) {
        const e = effectiveTokens(componentsFromLoopUsage(s.usage as LoopUsageLike | undefined));
        if (e !== null) eff += e;
      }
      return eff;
    };

    /** One streamText round over `messages`; a clean finish appends its response messages to both arrays. */
    const round = async (stepBudget: number, spentBefore: number): Promise<void> => {
      let result: ReturnType<typeof streamText> | null = null;
      try {
        result = streamText({
          model,
          messages,
          // The system prompt rides the messages array AS a system message so the Anthropic
          // cache breakpoint can mark it per-block; v7 gates that shape behind this flag.
          allowSystemInMessages: true,
          tools,
          abortSignal: abort.signal,
          maxRetries: 3, // rate-limit/overload retries ride the SDK's exponential backoff
          stopWhen: [
            stepCountIs(stepBudget),
            ({ steps }) => {
              if (ceiling <= 0) return false;
              const eff = spentBefore + spentFromSteps(steps as Array<{ usage?: unknown }>);
              if (eff >= ceiling) {
                ceilingHit = true;
                spentEffective = eff;
                return true;
              }
              return false;
            },
          ],
          onStepFinish: (step) => {
            numSteps += 1;
            // The last step's finish reason is the truthful loop-end signal (the stream's
            // terminal 'finish' part carries no reason in this SDK build).
            finishReason = (step as { finishReason?: string }).finishReason ?? finishReason;
            addUsage(step.usage as LoopUsageLike | undefined);
          },
          onError: ({ error }) => { fatal = error; },
        });
        const stream = result.fullStream;
        const consume = (async (): Promise<void> => {
          for await (const part of stream) {
            feedWatchdog();
            if (part.type === 'error') { fatal = (part as { error?: unknown }).error ?? fatal; continue; }
            if (part.type === 'tool-result') lastWrite = writeVerdict(part.toolName, part.output) ?? lastWrite;
            const mapped = mapper.onPart(part as never);
            for (const step of mapped.steps) hooks?.onEvent?.(step);
            if (mapped.delta !== undefined) hooks?.onTextDelta?.(mapped.delta);
            if (mapped.textBlock !== undefined) {
              textBlocks.push(mapped.textBlock);
              hooks?.onOutput?.(mapped.textBlock + '\n');
            }
          }
        })();
        // A wedged upstream (the stall class) may ignore the abort entirely — never let it
        // wedge the turn: the abort wins the race and the settle logic below takes over.
        const abortWait = new Promise<void>((res) => {
          if (abort.signal.aborted) { res(); return; }
          abort.signal.addEventListener('abort', () => res(), { once: true });
        });
        consume.catch(() => undefined);
        await Promise.race([consume, abortWait]);
      } catch (err) {
        fatal = fatal ?? err;
      }
      // Post-stream reads only on a clean finish — an aborted stream's promises are not
      // awaited (they may settle late or not at all; the mapper already holds the text).
      if (result !== null && fatal === null && !abort.signal.aborted) {
        try {
          const responses = (await result.responseMessages) as ModelMessage[];
          messages.push(...responses);
          turnMessages.push(...responses);
        } catch (err) {
          fatal = err;
        }
      }
    };

    try {
      await round(maxSteps, 0);
      // ---- the end of the turn: the model returned no tool call. AUTO-FINALIZE (n8n's shape): when
      // the turn's last write-door call did not land - refused, stopped, or left waiting yet claimed
      // done - ONE correction message is appended and one more round runs. Never twice; the CLI lane
      // never enters here (Claude Code owns that loop).
      if (fatal === null && !abort.signal.aborted && !ceilingHit && finishReason !== 'tool-calls') {
        const correction = correctionFor(lastWrite, textBlocks.join('\n'));
        if (correction !== null) {
          const correctionMessage: ModelMessage = { role: 'user', content: correction };
          messages.push(correctionMessage);
          turnMessages.push(correctionMessage);
          await round(Math.max(1, maxSteps - numSteps), spentEffective);
        }
      }
    } finally {
      clearTimeout(stallTimer);
      hooks?.signal?.removeEventListener('abort', onOuterAbort);
    }
    if (!ceilingHit && finishReason === 'tool-calls' && numSteps >= maxSteps) stepCapHit = true;
    const finalText = textBlocks.join('\n');

    const durationMs = Date.now() - started;
    const tokensUsed = effectiveTokens(usageTotals);
    const usage = (usageTotals.inputTokens ?? usageTotals.outputTokens
      ?? usageTotals.cacheReadTokens ?? usageTotals.cacheWriteTokens) === null ? null : usageTotals;

    if (externalAbort) return { ...fail('aborted'), durationMs, tokensUsed, usage };
    if (stalled) return { ...fail(`stalled: no engine output for ${stallMs}ms`), durationMs, tokensUsed, usage };
    if (fatal !== null) {
      const msg = fatal instanceof Error ? fatal.message : String(fatal);
      const statusCode = (fatal as { statusCode?: unknown }).statusCode;
      if (statusCode === 429 || statusCode === 529 || API_RATE_LIMIT_RE.test(msg)) {
        return { ...fail(msg, 'rate_limited'), durationMs, tokensUsed, usage };
      }
      if (CONTEXT_OVERFLOW_RE.test(msg)) {
        return { ...fail(`the conversation no longer fits the model's context window — continue in a new thread (${msg.slice(0, 200)})`), durationMs, tokensUsed, usage };
      }
      return { ...fail(msg), durationMs, tokensUsed, usage };
    }

    // The honest ceiling sentences ride the OUTPUT — the turn's work is preserved.
    let output = finalText;
    if (ceilingHit) output = `${output}\n\n${turnCeilingSentence(spentEffective, ceiling)}`.trim();
    else if (stepCapHit) output = `${output}\n\nStopped here: this turn reached its ${maxSteps}-step ceiling. Send a follow-up message to continue.`.trim();

    // ---- persist the real message array (chat turns; never on failure paths). ----
    if (ctx.threadId !== null) {
      try {
        await this.storeFor()?.save(ctx.threadId, ctx.orgId, nextStoredMessages(prior, userMessage, turnMessages));
      } catch (err) {
        console.error('api continuation save failed:', err instanceof Error ? err.message : String(err));
      }
    }

    return {
      status: 'succeeded',
      output,
      errorMessage: null,
      costUsd: null,
      durationMs,
      numTurns: numSteps,
      tokensUsed,
      usage,
      sessionRef: ctx.threadId !== null ? `api:${ctx.threadId}` : null,
    };
  }
}
