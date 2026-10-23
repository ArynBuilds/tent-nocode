import { z } from 'zod';

/** Org-level tunables; thresholds are config, not code. */
export const orgConfigSchema = z.object({
  /** Per-org model override for agent runs; null = the runner/CLI default. */
  model: z.string().min(1).nullable().default(null),
  /** Chat-kind runs resolve to this when set, falling back to `model`, then the CLI default. */
  deskModel: z.string().min(1).nullable().default(null),
  domain: z.object({
    /** Scratch run workspaces older than this are deleted by the idle sweep. */
    scratchGcDays: z.number().int().min(1).default(7),
    /** A warm chain resumes the previous run's session only within this window. */
    warmChainMaxAgeMin: z.number().int().min(1).default(30),
    /** Chain length cap — after this many runs on one session, cold restart. */
    warmChainMaxRuns: z.number().int().min(1).default(4),
    /** Ceiling on a tab bundle's authored code in KB; engines, media, and data never count. */
    tabBundleMaxKb: z.number().int().min(64).default(2048),
    /** Per-tab private state pocket quota, in KB. */
    tabStateMaxKb: z.number().int().min(16).default(256),
    /** Write-door rate cap — rows accepted per tab per minute. */
    tabWriteMaxRowsPerMinute: z.number().int().min(1).default(120),
  }).default({}),
  /** Chat modes: `ask` asks the remaining gates, `auto` answers them; the budget cap is optional. */
  chat: z.object({
    // 'agent' = auto plus team dispatch.
    defaultMode: z.enum(['ask', 'auto', 'agent']).default('ask'),
    autoBudgetUsdPerJob: z.number().positive().nullable().default(null),
    /** Chat view budget in estimated tokens; crossing it arms the next window step. */
    viewBudgetTokens: z.number().int().positive().default(100_000),
    /** Total time one attended desk turn may hold itself open over dispatched work. */
    awaitBudgetSec: z.number().int().min(30).max(720).default(480),
    /** Max silent hold of one await beat — the long-poll chunk. */
    awaitChunkSec: z.number().int().min(10).max(300).default(120),
  }).default({}),
  /** Browse futility brake: low-content page limits and a hard page ceiling per run. */
  futility: z.object({
    maxPagesPerRun: z.number().int().min(1).default(20),
    minContentBytes: z.number().int().min(0).default(200),
    lowContentLimit: z.number().int().min(1).default(4),
  }).default({}),
  /** Reactive-graph brakes: depth caps transitive cascades; the daily budget caps one chain's executions per day. */
  reactive: z.object({
    maxChainDepth: z.number().int().min(1).max(20).default(5),
    dailyBudgetPerChain: z.number().int().min(1).max(1000).default(50),
  }).default({}),
  /** A brief carries intent, contracts, and pointers, never data; the dispatch door refuses briefs over this cap. */
  work: z.object({
    briefMaxChars: z.number().int().min(1000).max(8000).default(4000),
  }).default({}),
  /** A tombstone stays restorable for this many days before the purge sweep hard-deletes the content. */
  cleanup: z.object({
    trashDays: z.number().int().min(1).default(7),
  }).default({}),
  /** Outbound-call brakes: budgets count per connection per day; send-class calls carry a tighter budget on top. */
  integrations: z.object({
    callTimeoutMs: z.number().int().min(1000).max(60000).default(15000),
    responseCapBytes: z.number().int().min(1024).max(4194304).default(1048576),
    callsPerDayPerConnection: z.number().int().min(1).max(10000).default(2000),
    sendsPerDayPerConnection: z.number().int().min(1).max(2000).default(200),
  }).default({}),
});
export type OrgConfig = z.infer<typeof orgConfigSchema>;
