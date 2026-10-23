import { z } from 'zod';

/** Per-turn context for the API lane, attached by the runner; carries identity and the run's ruleset, never a credential value. */
export interface ApiTurnContext {
  orgId: string;
  runId: string;
  threadId: string | null;
  /** The run's project, resolved by the runner's mount. */
  projectId: string | null;
  kind: 'chat' | 'work';
  /** The MODEL_REGISTRY row id the pick resolved to. */
  modelId: string;
  /** The run's declared pattern ruleset. */
  permissionRules: { effect: 'allow' | 'ask' | 'deny'; pattern: string }[];
  /** The authed loopback draft-render channel; absent = no scene_snapshot. */
  snapshot?: { url: string; token: string };
}

/** A genome compiled to a concrete headless-CLI invocation; systemPrompt and promptText stay out of argv for spawn safety. */
export interface CompiledInvocation {
  argv: string[];
  promptText: string;
  systemPrompt: string;
  cwd: string;
  env: Record<string, string>;
  /** Present only on API-lane turns; the runner attaches it after compile. */
  apiTurn?: ApiTurnContext;
}

export const driverStatusSchema = z.enum(['succeeded', 'failed', 'rate_limited']);
export type DriverStatus = z.infer<typeof driverStatusSchema>;

/** The four raw usage components from the CLI result line; omitted components are null. */
export const runUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  cacheReadTokens: z.number().int().nonnegative().nullable(),
  cacheWriteTokens: z.number().int().nonnegative().nullable(),
});
export type RunUsage = z.infer<typeof runUsageSchema>;

export const driverResultSchema = z.object({
  status: driverStatusSchema,
  output: z.string().nullable(),
  errorMessage: z.string().nullable(),
  costUsd: z.number().nullable(),
  durationMs: z.number().int().nonnegative(),
  numTurns: z.number().int().nullable(),
  /** Effective tokens: input + 1.25·cacheWrite + 0.1·cacheRead + 5·output; absent = unknown. */
  tokensUsed: z.number().int().nonnegative().nullable().optional(),
  /** Raw components behind tokensUsed. */
  usage: runUsageSchema.nullable().optional(),
  /** The engine compacted the session mid-run; recorded as an anomaly event. */
  compactedAnomaly: z.boolean().optional(),
  /** Opaque engine-side session reference, persisted so a warm chain can resume it. */
  sessionRef: z.string().nullable().optional(),
});
export type DriverResult = z.infer<typeof driverResultSchema>;

/** One narrated step of a live run, persisted in run.activity event payloads. */
export const activityStepSchema = z.object({
  kind: z.enum(['text', 'tool', 'tool_done', 'thinking']),
  tool: z.string().optional(),
  target: z.string().optional(),
  ok: z.boolean().optional(),
  text: z.string().optional(),
  /** Edit magnitude: lines added/removed, computed from the tool input; display only. */
  plus: z.number().int().optional(),
  minus: z.number().int().optional(),
});
export type ActivityStep = z.infer<typeof activityStepSchema>;

/** Optional live-output hooks; drivers may stream child stdout chunks. */
export interface DriverHooks {
  /** Human-readable output text chunks, never raw NDJSON. */
  onOutput?: (chunk: string) => void;
  /** One structured step per agent action; streaming drivers only. */
  onEvent?: (step: ActivityStep) => void;
  /** Token-level text deltas; ephemeral, never persisted. */
  onTextDelta?: (text: string) => void;
  /** On abort a driver that spawned a child must kill it and settle with a non-succeeded result. */
  signal?: AbortSignal;
}

/** What an engine declares about continuing conversations; no declaration means cold-start-priced. */
export interface DriverCapabilities {
  /** 'resume-file': the driver can resume from a session artifact it owns; 'none': every invocation is cold. */
  continuation: 'resume-file' | 'none';
  /** 'block-prefix': repeated byte-identical content-block prefixes bill at a cached rate. */
  cacheModel: 'block-prefix' | 'none';
  /** The context window (tokens) the engine operates under. */
  windowTokens: number;
}

/** One engine-neutral transcript entry for continuation; nothing here may be engine-shaped. */
export interface ContinuationHistoryEntry {
  role: 'user' | 'assistant';
  text: string;
  /** ISO timestamp from the record row, never wall clock. */
  at: string;
}

/** A continuation request: a stable per-conversation key, the invocation cwd, and the full history in record order. */
export interface ContinuationRequest {
  key: string;
  cwd: string;
  history: ContinuationHistoryEntry[];
}

/** Result of materializing: extra argv for the invocation and an opaque engine-side session reference. */
export interface PreparedContinuation {
  argvExtra: string[];
  sessionRef: string;
}

/** Execution driver contract: the kernel/scheduler never know how execution happens. */
export interface ExecutionDriver {
  readonly name: string;
  /** Absent = an engine that declares nothing; the kernel runs it cold. */
  readonly capabilities?: DriverCapabilities;
  execute(inv: CompiledInvocation, hooks?: DriverHooks): Promise<DriverResult>;
  /** Materialize a conversation into this engine's continuation form; null means fall back to the cold path, never an error. */
  prepareContinuation?(req: ContinuationRequest): Promise<PreparedContinuation | null>;
  /** The argv that resumes an existing engine session by its opaque ref; omitted = the engine cannot warm-chain. */
  resumeArgs?(sessionRef: string): string[];
}
