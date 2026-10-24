import { z } from 'zod';
import type { ActivityStep } from './execution.js';
import type { AssetBinding } from './sceneContracts.js';
import type { LibraryItem, PrimitiveName } from './primitives.js';

// Workspace DTOs: the row shapes desk channels return, and the enum vocabulary their columns carry.

// ---------------------------------------------------------------------------
// The enum vocabulary (orgs, agents, runs, messages, threads, jobs)
// ---------------------------------------------------------------------------

export const orgRoleSchema = z.enum(['owner', 'admin', 'viewer']);
export type OrgRole = z.infer<typeof orgRoleSchema>;

export const agentStatusSchema = z.enum(['draft', 'active', 'deprecated']);
export type AgentStatus = z.infer<typeof agentStatusSchema>;

export const runVerdictSchema = z.enum(['success', 'partial', 'failure']);
export type RunVerdict = z.infer<typeof runVerdictSchema>;

export const messageTypeSchema = z.enum(['request', 'result', 'question', 'escalation', 'chat']);
export type MessageType = z.infer<typeof messageTypeSchema>;

/** The mode ladder, each layer including the one below: ask waits on gates, auto answers them recorded, agent adds team dispatch. */
export const threadModeSchema = z.enum(['ask', 'auto', 'agent']);
export type ThreadMode = z.infer<typeof threadModeSchema>;

/** True when this mode auto-answers the recorded gates; the one predicate so no caller writes `=== 'auto'`. */
export function modeAutoAnswers(mode: ThreadMode): boolean {
  return mode === 'auto' || mode === 'agent';
}

export const jobKindSchema = z.enum(['work', 'chat']);
export type JobKind = z.infer<typeof jobKindSchema>;

// ---------------------------------------------------------------------------
// Run / message / event rows (runs, messages, events tables)
// ---------------------------------------------------------------------------

export type RunStatus = 'queued' | 'running' | 'paused' | 'succeeded' | 'failed' | 'cancelled';

export interface RunRow {
  id: string;
  orgId: string;
  agentId: string;
  agentVersion: number;
  status: RunStatus;
  verdict: RunVerdict | null;
  verdictBy: 'auditor' | 'human' | null;
  costEstimate: number | null;
  durationMs: number | null;
  /** Real tokens consumed (input+output). */
  tokensUsed: number | null;
  outputTail: string | null;
  /** The run's final output (`{ result }` shape), rendered inert. */
  output: Record<string, unknown> | null;
  failure: string | null;
  /** The plain ask this run owns; rides the record beside the input. */
  prompt: string | null;
  /** The chat thread this run belongs to, or null for a threadless run. */
  threadId: string | null;
  /** `'work'` for a dispatched run, `'chat'` for a thread's desk turn. */
  kind: JobKind;
  /** Last liveness ping while running; null before the first heartbeat. */
  heartbeatAt: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface MessageRow {
  id: string;
  orgId: string;
  fromRun: string | null;
  toRun: string | null;
  type: MessageType;
  payload: Record<string, unknown>;
  answeredAt: string | null;
  answer: Record<string, unknown> | null;
  createdAt: string;
}

export interface EventRow {
  id: string; // bigint, stringified for the wire
  orgId: string | null;
  actor: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

/** One work run's detail: the run row plus its messages and events (the getThread read). */
export interface WorkRunView {
  run: RunRow;
  messages: MessageRow[];
  events: EventRow[];
}

/** One batched `run.activity` events row: a slice of a run's narrated steps, ordered by event id. */
export interface ActivityRow {
  id: string; // events.id (bigint, stringified)
  runId: string;
  steps: ActivityStep[];
  at: string;
}

export interface RunsOverviewDto {
  counts: { queued: number; running: number };
  /** Every currently-running run's heartbeat, org-wide; bounded by counts.running. */
  runningRuns: Array<{ id: string; heartbeatAt: string | null }>;
}

// ---------------------------------------------------------------------------
// Org-wide DTOs (agents · members · grants · missions · usage)
// ---------------------------------------------------------------------------

export interface AgentRow {
  id: string;
  orgId: string;
  slug: string;
  status: AgentStatus;
  currentVersion: number;
  capability: string;
  createdAt: string;
  /** 'voice' (the Nodeloom genome) | 'hands' (historical) | null. */
  reserved: 'voice' | 'hands' | null;
}

/** One row of the ONE grant store (consent.ts): subject strings are `folder:<path>` · `scene:<slug>` · `impact:<agentId>:<action>` · `verb:<name>`. */
export interface ConsentGrantRow {
  id: string;
  /** null = covers the whole org; else the one project this consent remembers. */
  projectId: string | null;
  class: 'free' | 'ask-once' | 'always-ask';
  subject: string;
  grantedBy: string;
  grantedAt: string;
  revokedAt: string | null;
}

export interface MemberRow {
  userId: string;
  role: OrgRole;
  email: string;
  displayName: string | null;
  createdAt: string;
}

export interface IntentPartDto {
  text: string;
  acceptance: string;
  status: 'pending' | 'in_flight' | 'done' | 'blocked' | 'dropped';
  runId?: string;
  note?: string;
}

/** The thread's mission; spendTokens/spendUsd price the whole mission across its runs. */
export interface ThreadIntent {
  id: string;
  status: 'open' | 'done' | 'parked' | 'cancelled';
  parts: IntentPartDto[];
  note: string | null;
  spendTokens: number;
  spendUsd: number;
  createdAt: string;
  updatedAt: string;
}

/** The threadIntent read: the LATEST mission (any status) + its intent.* events. */
export interface ThreadIntentView {
  intent: ThreadIntent | null;
  events: EventRow[];
}

/** Thread token spend; headline unit is tokens. */
export interface ThreadUsage {
  totalTokens: number;
  byRun: Record<string, { tokens: number; spentUsd: number }>;
  capUsd: number | null;
}

// ---------------------------------------------------------------------------
// Thread / chat DTOs
// ---------------------------------------------------------------------------

export interface ThreadRow {
  id: string;
  orgId: string;
  title: string;
  /** Explicit per-thread mode override, or null to inherit the org default. */
  mode: ThreadMode | null;
  /** The thread's project home — always a real project. */
  projectId: string;
  createdBy: string;
  createdAt: string;
}

/** One rendered turn of a conversation (user message or desk run). */
export interface ChatTurn {
  messageId: string | null; // user turns
  runId: string | null; // desk turns
  role: 'user' | 'desk';
  /** User text, or the desk run's result; `''` while the run has no result yet. */
  text: string;
  status: RunStatus | null; // desk turns only
  /** Desk turns only: the run's failure sentence when it failed; the feed shows it in place of the reply. */
  failure?: string | null;
  /** Streaming partial output while a desk run is still in flight. */
  outputTail: string | null;
  createdAt: string;
  /** Desk turns only: the run's own clock (the settled 'worked' group's duration). */
  startedAt?: string | null;
  finishedAt?: string | null;
}

/** The thread list's per-row summary — aggregates that would otherwise cost one read per row. */
export interface ThreadOverview {
  thread: ThreadRow;
  openGates: number;
  running: number;
  lastActivityAt: string;
}

export interface ConversationView {
  thread: ThreadRow;
  turns: ChatTurn[];
  /** The thread's dispatched work runs, oldest first. */
  work: RunRow[];
  /** Escalations attributable to this thread; answered ones stay listed. */
  gates: MessageRow[];
}

// ---------------------------------------------------------------------------
// Standing-consent DTOs (schedules · chains · triggers · grants)
// ---------------------------------------------------------------------------


/** A standing reactive chain — both dependency record and standing grant; revoked rows stay listed. */
export interface ReactiveChainRow {
  id: string;
  operation: string;
  inputs: Record<string, unknown>;
  watch: string[];
  enabled: boolean;
  grantMode: 'ask-approved' | 'auto';
  revokedAt: string | null;
  createdAt: string;
}

/** Integration catalog entry as the renderer sees it — auth flattened to presence facts, never values. */
export interface IntegrationCatalogWire {
  name: string;
  version: number;
  displayName: string;
  blurb: string;
  category: string;
  surfaces: 'app' | 'website' | 'both';
  /** 'upcoming' = listed and placeable, but connecting waits for approval. */
  availability: 'ready' | 'upcoming';
  scope: 'builder' | 'app-user' | 'both';
  authKind: 'none' | 'bearer' | 'header' | 'basic' | 'query' | 'path' | 'body' | 'oauth';
  secretName: string | null;
  tokenHelp: string | null;
  /** True = the owner supplies the host on the Connect card (the one host exception). */
  ownerPinned: boolean;
  /** Host template with one single-label slot filled at Connect. */
  hostTemplate: { template: string; slot: string } | null;
  hosts: string[];
  /** Endpoint params ride the wire so the field-port pick can offer them. */
  endpoints: Array<{ id: string; displayName: string; class: 'read' | 'write' | 'send'; params: Array<{ name: string; type: 'string' | 'number' | 'boolean'; required: boolean; help?: string }> }>;
  settings: Array<{ id: string; label: string; kind: 'text' | 'number' | 'boolean' | 'enum' | 'template' | 'channel-pick'; choices?: string[]; help?: string }>;
  /** True = this def can recreate the service's data as a Table. */
  importDoor: boolean;
  /** The service's declared trigger rows, offered as preconfigured triggers. */
  triggers: Array<
    | { kind: 'webhook'; id: string; displayName: string; eventPath: string; events: string[] }
    | { kind: 'poll'; id: string; displayName: string; table: string }
  >;
  /** Webhook dialect for this service; null = signatures unverifiable, so its webhook triggers stay off the shelf. */
  webhookScheme: WebhookEndpointWire['scheme'] | null;
}

/** A placed Connection node (the row is the node). */
export interface IntegrationConnectionWire {
  id: string;
  integration: string;
  version: number;
  label: string;
  status: 'unconnected' | 'active' | 'revoked';
  ownerHost: string | null;
  scope: 'builder' | 'app-user';
  settings: Record<string, unknown>;
  /** Born inside tables: declaredName -> the real dataset name. */
  insideTables: Record<string, string>;
  projectId: string;
  createdAt: string;
}

/** One import pull's progress. */
export interface IntegrationImportWire {
  id: string;
  connectionId: string;
  integration: string;
  dataset: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  pages: number;
  rowsLanded: number;
  error: string | null;
  createdAt: string;
}

/** A webhook-in endpoint; the secret is never here (shown once at mint). */
export interface WebhookEndpointWire {
  id: string;
  token: string;
  label: string;
  /** Vendor signature dialect; the kernel's WEBHOOK_SCHEMES is the one registry. */
  scheme: 'generic' | 'stripe' | 'paddle' | 'slack' | 'linear' | 'gitlab' | 'calendly' | 'telegram' | 'box';
  projectId: string;
  createdAt: string;
}

/** Plain words for the trigger kinds; every surface renders from this one registry. */
export const TRIGGER_KIND_WORDS: Record<string, string> = {
  dataset_threshold: 'Rows cross a line',
  rows_changed: 'New row lands',
  output_registered: 'A result lands',
  file_landed: 'A file lands',
  webhook_in: 'A call arrives',
  schedule: 'Each day',
  cron: 'On a schedule',
  interval: 'Every few minutes',
};

export function triggerKindWord(kind: string): string {
  return TRIGGER_KIND_WORDS[kind] ?? kind.replace(/_/g, ' ');
}

/** A standing trigger row. */
export interface TriggerWireRow {
  id: string;
  kind: 'dataset_threshold' | 'output_registered' | 'file_landed' | 'webhook_in' | 'schedule' | 'cron' | 'interval' | 'rows_changed';
  spec: Record<string, unknown>;
  action: Record<string, unknown>;
  enabled: boolean;
  createdAt: string;
  /** Last fire: when + how many rows; paused why. */
  lastFiredAt?: string | null;
  lastFireCount?: number | null;
  pausedReason?: string | null;
}

// ---------------------------------------------------------------------------
// Tab + scene read DTOs
// ---------------------------------------------------------------------------

/** A generated tab in the sidebar Tabs group. */
export interface TabRow {
  id: string;
  slug: string;
  title: string;
  status: string;
  currentVersion: number;
  createdAt: string;
  /** Set when the tab hosts a scene. */
  sceneId: string | null;
  /** The hosted scene's slug. */
  sceneSlug: string | null;
  /** Exporting org when the hosted scene arrived by package; null otherwise. */
  sceneImportedFrom: string | null;
  /** The screen's project, derived from the record. */
  projectId: string | null;
}

/** One tab's executed bindings — per-binding isolation: one sick binding never kills the surface. */
export interface TabDataResult {
  tab: TabRow;
  results: Array<{
    binding: string;
    kind: string;
    rows: Record<string, unknown>[];
    text: string | null;
    error: string | null;
  }>;
}

/** One binding's feed entry over the one grammar (query, asset, clock); `tick` rides clock bindings alone (the engine re-mints the now row on it). */
export interface SceneBindingFeed {
  binding: string;
  kind: 'query' | 'asset' | 'clock';
  rows: Record<string, unknown>[];
  text: string | null;
  error: string | null;
  tick?: number;
}

/** The whole scene feed: the served (instance-expanded) primitives document plus one entry per binding. */
export interface SceneDataResult {
  scene: { id: string; slug: string; title: string; status: string; headRevision: number };
  document: unknown;
  results: SceneBindingFeed[];
  /** The design size the document was authored at; the engine's reflow reads its width. */
  targetScreen: { w: number; h: number } | null;
  /** The scene's tokens and the project's theme as one :root block - a direct mount rescopes it to its host. */
  hostCss?: string;
  /** The project theme's named breakpoints when it declares them - the mounted theme reads these. */
  breakpoints?: Record<string, { minWidth?: number; maxWidth?: number }>;
}

// ---------------------------------------------------------------------------
// The editor's scene catalog: the five primitives and the library items a screen may place (one list).
// ---------------------------------------------------------------------------

/** One of the five, as the browser and the create pick list it. */
export interface PrimitiveCatalogEntry {
  kind: 'primitive';
  name: PrimitiveName;
  title: string;
  breath: string;
}

/** A library item the project may place as an instance; the item document rides along so the editor's engine expands it. */
export interface LibraryItemCatalogEntry {
  kind: 'item';
  /** name@version */
  ref: string;
  name: string;
  version: number;
  title: string;
  description: string;
  item: LibraryItem;
}

export type SceneCatalogEntry = PrimitiveCatalogEntry | LibraryItemCatalogEntry;

/** The raw editing document of one screen (never instance-expanded) beside the screen's facts. */
export interface SceneEditRead {
  scene: { id: string; slug: string; title: string; headRevision: number };
  document: unknown;
  /** The design size the screen frames at. */
  targetScreen: { w: number; h: number } | null;
}

/** One projected read of an array binding — raw little-endian C-order payload under the kernel caps. */
export interface SceneProjectionResult {
  binding: string;
  dtype: 'float32' | 'float64' | 'int16' | 'int32' | 'uint8' | 'uint16' | null;
  shape: number[];
  data: ArrayBuffer | null;
  error: string | null;
}

/** A bindable derived output (newest registered per name). */
export interface BindableOutputRow {
  name: string;
  kind: 'array' | 'raster';
  descriptor: Record<string, unknown>;
  runId: string | null;
  createdAt: string;
  /** Set when a successor has landed — staleness is never silent. */
  staleAt: string | null;
  /** The asset binding a screen declares to read it (the one grammar). */
  binding: AssetBinding;
}

/** The inspector's node read — identity, component payloads, defaults, variants, refs, children. */
export interface SceneNodeInspect {
  revision: number;
  node: {
    id: string;
    parent: string | null;
    slot?: string;
    components: Record<string, Record<string, unknown>>;
    variants?: Record<string, { options: string[]; default: string; selection?: string }>;
    refs?: Record<string, string>;
    childCount: number;
    /** Composed child ids in order. */
    children: string[];
    /** The parent's composed children including this node. */
    siblings: string[];
  } | null;
  /** Per-referenced-definition param defaults (builtin + org). */
  defaults: Record<string, Record<string, unknown>>;
}

export interface SceneExplainEntry {
  revisionNo: number;
  actor: string;
  createdAt: string;
  op: string;
  value: unknown;
}

export interface SceneExplainResult {
  winner: SceneExplainEntry | null;
  losers: SceneExplainEntry[];
}

/** The launcher's parts shelf — one row per component name; the head version leads. */
export interface ComponentShelfRow {
  name: string;
  version: number;
  title: string;
  description: string;
  status: 'active' | 'retired';
  versions: number;
}

/** The live component library projected for create gestures and grip declarations. */
export interface ComponentCatalogParam {
  name: string;
  type: string;
  required: boolean;
  enum?: string[];
  default?: unknown;
  /** The contract's one-line teaching for this property (primitives carry it; never dropped). */
  hint?: string;
  /** Declared number bounds — Properties renders number+slider from them. */
  min?: number;
  max?: number;
  /** The typed-grip declaration — 'radius' today. */
  grip?: string;
  /** The motion word this param carries. */
  motion?: string;
  /** A composition control's authored display words. */
  word?: string;
}
/** A declared socket, projected. */
export interface ComponentCatalogSlot {
  name: string;
  description: string;
  accepts: 'any' | string[];
  repeats: boolean;
}
/** A declared emit, projected. */
export interface ComponentCatalogEmit { name: string; type: string; description: string }
export interface ComponentCatalogEntry {
  ref: string;
  title: string;
  purpose: string;
  params: ComponentCatalogParam[];
  slots?: ComponentCatalogSlot[];
  emits?: ComponentCatalogEmit[];
  /** A composition entry - `params` are its exposed controls. */
  composition?: true;
}
