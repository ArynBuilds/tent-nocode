import type { WorkspaceClient } from '@tent-nocode/kernel';
import type { AgentStatus, EdgeConfidence, FlowEffect, GenomeCreator, OrgConfig, OrgRole, SceneBinding, ThreadMode } from '@tent-nocode/core';

/** The contract between main and renderer: the router's inferred client (type-only from @tent-nocode/kernel) plus the
 * native set below; never import main/preload here. */

import type {
  ActivityRow, AgentRow, BindableOutputRow, ChatTurn, ComponentCatalogEntry,
  ComponentShelfRow, ConsentGrantRow, ConversationView, EventRow,
  IntegrationCatalogWire, IntegrationConnectionWire,
  MemberRow, MessageRow, ReactiveChainRow, RunsOverviewDto, RunStatus,
  SceneBindingFeed, SceneCatalogEntry, SceneDataResult, SceneEditRead, SceneExplainResult, SceneNodeInspect,
  SceneProjectionResult, TabDataResult, TabRow,
  ThreadIntentView, ThreadOverview, ThreadRow, ThreadUsage, TriggerWireRow, WorkRunView,
  IntegrationImportWire, WebhookEndpointWire,
} from '@tent-nocode/core';
export type {
  ActivityRow, AgentRow, BindableOutputRow, ChatTurn, ComponentCatalogEmit,
  ComponentCatalogEntry, ComponentCatalogParam, ComponentCatalogSlot, ComponentShelfRow,
  ConsentGrantRow, ConversationView, EventRow,
  IntentPartDto,
  MemberRow, MessageRow, ReactiveChainRow, RunRow, RunsOverviewDto,
  RunStatus, SceneBindingFeed, SceneCatalogEntry, SceneDataResult, SceneEditRead, SceneExplainEntry, SceneExplainResult,
  SceneNodeInspect, SceneProjectionResult, PrimitiveCatalogEntry, LibraryItemCatalogEntry,
  TabDataResult, TabRow, ThreadIntent, ThreadIntentView, ThreadOverview, ThreadRow,
  ThreadUsage, TriggerWireRow, WorkRunView,
  IntegrationCatalogWire, IntegrationConnectionWire, IntegrationImportWire, WebhookEndpointWire,
} from '@tent-nocode/core';

export interface EventsFilter {
  type?: string;
  limit?: number;
  /** Exact-id lookup (Task 15's `/system/:eventId` route — `SystemBody` fetches its one event this way). */
  id?: string;
}

// Projects and threads: org-wide project read and conversation thread data.

/** Rail tree's projects read (mirrors kernel ProjectRow). */
export interface ProjectRow {
  id: string;
  orgId: string;
  /** Null = chat-born (every chat birth creates its project). */
  path: string | null;
  name: string;
  /** Project's human-surface kind (null reads as 'app'). */
  kind: 'app' | 'website' | null;
  verifyCommand: string | null;
  createdBy: string;
  createdAt: string;
}

// Conversation turn: user message or agent run reply.

/** Org owner's forensic read: deterministic kernel numbers and weekly note. */
export interface HealthReport {
  spend: {
    tokens30d: number;
    usd30d: number;
    topThreads: { threadId: string; title: string | null; tokens: number; usd: number }[];
    grindRuns30d: number;
    /** Cache hit rate (cache_read/(input+read+write)); 0 when none. */
    cacheHitRate30d: number;
    /** Avg effective tokens per chat turn. */
    avgChatTurnTokens30d: number;
  };
  honesty: {
    succeededRuns30d: number;
    failedRuns30d: number;
    honestEmptyJobs30d: number;
    /** Rows the tab write door refused (schema drift surfaces here). */
    tabWriteRejects30d: number;
  };
  loop: {
    openIntents: number;
    parkedIntents: number;
    parkedOver24h: number;
    /** Budget-exhausted missions. */
    budgetExhausted: number;
    rescueFirings30d: number;
    cancelled30d: number;
  };
  /** Work-diet gauges (numbers that should decline). */
  discipline: {
    avgReportChars30d: number;
    doubleReporterWakes30d: number;
    effPerSettledPart30d: number;
  };
  errors: {
    clusters7d: { type: string; count: number }[];
    daemonRestarts7d: number;
  };
  /** Browse reach spend (pages, connector calls, per-domain page counts). */
  browse: {
    pages30d: number;
    connectorCalls30d: number;
    /** External MCP connection tool calls (mcp__ext-*), 30d. */
    externalMcpCalls30d: number;
    topDomains: { domain: string; pages: number }[];
  };
  generatedAt: string;
}

// Mission part: outcome with acceptance line and status.

// Thread conversation data and work jobs.

// Agents and org config: role matrix and permissions.

/** Deep-partial patch for org config updates (one level deep). */
export type OrgConfigPatch = {
  [K in keyof OrgConfig]?: OrgConfig[K] extends object ? Partial<OrgConfig[K]> : OrgConfig[K];
};

// MemberRow moved to @tent-nocode/core (E1 slice 8).

// The standing-consent DTOs (ReactiveChainRow · TriggerWireRow ·
// ConsentGrantRow) live in @tent-nocode/core.
// The tab + scene read DTOs moved to @tent-nocode/core's workspace module (E1 slice 2 —
// one definition, both mouths); re-exported below with the job/run block.

export interface ComponentUsageRow { slug: string; title: string; ref: string }

/**
 * The single local identity the whole renderer boots against (Task 8 — no
 * login, single-user desktop; see `main/identity.ts`'s `Identity`). `role`
 * is `OrgRole`-typed (not narrowed to `'owner'`) so this DTO stays correct
 * if a future team-mode identity resolver ever returns a different role.
 */
export interface IdentityDto {
  userId: string;
  orgId: string;
  role: OrgRole;
  displayName: string;
  email: string;
}

// ---------------------------------------------------------------------------
// Mutation envelope
// ---------------------------------------------------------------------------

export type MutationResult<T = undefined> = { ok: true; data?: T } | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Live subscription channel (Task 7 implements the watcher; typed here now)
// ---------------------------------------------------------------------------

/** Phase 2-G (FR-512): the project tab's remaining doors — "Share as a file" (the T48
 * export, surfaced) and "Publish a release" (the desktop publish arm, sign-only). */
export interface ExportProjectInput {
  sceneSlugs: string[];
  fileName: string;
  license?: string;
  /** D-PT2: the ceremony's choices — Tables whose rows ride (ALL rows, install spec
   * §0.5) and named notes projects; hard refs are computed, never passed. */
  inlineDatasets?: string[];
  notesProjects?: string[];
  /** D-PT1.2: the manifest's identity (title/kind + assistant) comes from this row. */
  projectId?: string;
}

/** 2026-08-02 (user): the destination is CHOSEN in the native save dialog, never a
 * hardcoded folder — a dismissed dialog is a quiet no-op, not a failure. */
export type ExportProjectDto = { canceled: true } | { canceled?: false; path: string; packageHash: string };

/** D-PT2 (FR-PT2): the ceremony's dry-run — what would travel, with the one quiet
 * reason per hard/soft ref and the per-Table local row count. */
export interface ExportPreviewInput {
  sceneSlugs: string[];
  projectId?: string;
}
export interface ExportPreviewEntryDto {
  kind: 'screen' | 'library-item' | 'operation' | 'table';
  name: string;
  title?: string;
  role: 'root' | 'hard' | 'soft';
  reason?: string;
  usedBy?: string[];
  totalRows?: number;
}
export interface ExportPreviewDto {
  entries: ExportPreviewEntryDto[];
  notesCount: number;
}

/** "Publish": the project closure goes to the local server's publish door (Bearer = the account token). */
export interface PublishWebsiteInput {
  appSlug: string;
  appTitle: string;
  sceneSlugs: string[];
  /** The project whose identity (title/kind + assistant) rides the release envelope. */
  projectId?: string;
  license?: string;
  /** D-PT3.1 (fork 2): rows ride only by this explicit per-Table choice — OFF by
   * default (descriptors always travel; the published app's data lives in its server). */
  inlineDatasets?: string[];
  /** Spec §6 (2026-08-03): THE ENTRY-SCENE CHOICE — which screen is the front page.
   * Defaults to the project's only/primary scene; never a blind scenes[0]/Home. */
  entrySceneSlug?: string;
}

export interface PublishWebsiteDto {
  /** The live address on the local server - `http://<slug>.localhost:<port>`. */
  url: string;
  releaseHash: string;
  /** True when the exact same bytes were already live (idempotent by package hash). */
  alreadyPublished: boolean;
}

/** A desk_live pointer's table; the trigger set defines it, never a list in code. */
export type LiveTable = string;

/** A desk_live pointer: the row changed, refetch what reads it. */
export interface LivePointer {
  table: LiveTable;
  op: 'INSERT' | 'UPDATE';
  orgId: string | null;
  id: string;
}

/** A computed push: one binding's fresh rows for one screen. */
export interface LiveBindingDelta {
  kind: 'binding';
  orgId: string;
  sceneId: string;
  scene: string;
  binding: string;
  rows: Record<string, unknown>[];
  text: string | null;
  error: string | null;
  tick?: number;
}

/** A computed push: the effects of a scene-action run that settled after its answer. */
export interface LiveEffectsPush {
  kind: 'effects';
  orgId: string;
  scene: string;
  execution: string;
  status: 'succeeded' | 'failed';
  effects: FlowEffect[];
  error?: string;
}

/** The computed pushes alone. */
export type LiveComputed = LiveBindingDelta | LiveEffectsPush;
/** Everything the one live stream carries (the kernel's LivePush, mirrored here - shared never imports the kernel). */
export type LivePush = LivePointer | LiveComputed;
/** The stream's frame type as the renderer's hooks receive it. */
export type LiveEvent = LivePush;

/** Tier 11 (FR-180): one live typing delta — ephemeral (D-40), pushed over `desk:delta`. */
export interface DeskDelta {
  runId: string;
  text: string;
}


export type ProjectRoleDto = 'owner' | 'builder' | 'member';
export interface ProjectMemberDto {
  projectId: string; userId: string; role: ProjectRoleDto; orgId: string; createdAt: string;
}

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The desk API: the router's inferred client + the desktop-native set
// ---------------------------------------------------------------------------

/**
 * The desktop-native set: the handlers the main process answers itself (the device, the disk, the
 * credentials, the delivery doors). Every other member of DeskApi is inferred from
 * the one router in @tent-nocode/kernel - no hand-written mirror of it exists.
 */
export interface DesktopNativeApi {
  // The device (nativeShell.ts).
  identity(): Promise<IdentityDto>;
  authState(): Promise<AuthState>;
  signUp(input: SignUpInput): Promise<MutationResult<undefined>>;
  signIn(password: string): Promise<MutationResult<undefined>>;
  signOut(): Promise<null>;
  latestSceneDraft(orgId: string): Promise<{ sceneId: string; pngBase64: string; at: string } | null>;
  panelBrowserGuest(id: number | null): Promise<null>;
  panelBrowserState(): Promise<{ task: string; mode: 'agent' | 'user'; handBackReason: string | null } | null>;
  panelBrowserUserAction(action: 'revoke' | 'resume'): Promise<null>;
  focusedScene(): Promise<string | null>;
  takePendingPackageOffer(): Promise<string | null>;
  windowControl(action: 'minimize' | 'maximize' | 'close'): Promise<null>;

  // The disk (nativeFiles.ts).
  writeFileForEdit(orgId: string, absolutePath: string, content: string): Promise<MutationResult<undefined>>;
  openPath(orgId: string, absolutePath: string): Promise<MutationResult<undefined>>;
  readFileForView(orgId: string, absolutePath: string): Promise<{ ok: true; content: string; truncated: boolean } | { ok: false; error: string }>;
  humanImportFile(orgId: string, filePath: string, projectId?: string): Promise<MutationResult<
    | { lane: 'package'; alreadyImported?: boolean; projectName?: string; projectId?: string }
    | { lane: 'rows'; table: string }
  >>;

  // The credentials (nativeCredentials.ts).
  listEngines(orgId: string): Promise<EngineStatus[]>;
  probeInheritedLogin(orgId: string): Promise<boolean>;
  saveEngineCredential(orgId: string, engineId: string, kind: string, value: string): Promise<MutationResult<{ validated: true } | { validated: false; error: string }>>;
  removeEngineCredential(orgId: string, engineId: string, kind: string): Promise<MutationResult<undefined>>;
  setSecret(orgId: string, name: string, value: string, projectId?: string): Promise<MutationResult<undefined>>;
  deleteSecret(orgId: string, name: string, projectId?: string): Promise<MutationResult<undefined>>;
  listSecretNames(orgId: string, projectId?: string): Promise<string[]>;

  // The delivery doors (nativeDelivery.ts).
  exportProjectPackage(orgId: string, input: ExportProjectInput): Promise<MutationResult<ExportProjectDto>>;
  publishWebsite(orgId: string, input: PublishWebsiteInput): Promise<MutationResult<PublishWebsiteDto>>;
  unpublishWebsite(orgId: string, appSlug: string): Promise<MutationResult<undefined>>;
}

/** The whole desk: the router's inferred client (a native name wins where both answer) + the native set + the live stream. */
export type DeskApi = Omit<WorkspaceClient, keyof DesktopNativeApi> & DesktopNativeApi & {
  onLive(cb: (event: LiveEvent) => void): () => void;
};

export type DeskInvokeChannel = Exclude<keyof DeskApi, 'onLive'>;

/** The renderer-visible engine status - presence booleans, never values. `lane` says which species:
 * 'api' = a direct-API engine (no binary - the key is the whole connection); 'cli' = Claude Code on this machine. */
export interface EngineStatus {
  engineId: string;
  displayName: string;
  lane: 'cli' | 'api';
  installHint: string;
  /** null = the engine binary was not detected on PATH (cli lane; installHint renders).
   * API engines always read null — there is no binary. */
  binaryVersion: string | null;
  kinds: Array<{ kind: string; label: string; present: boolean; placeholder?: string }>;
}

/** The renderer-visible account state - identity only, the password and the token never cross. */
export interface AuthState {
  /** needs-sign-up = no account on this computer yet; signed-out = an account exists, the password is asked. */
  status: 'needs-sign-up' | 'signed-out' | 'signed-in';
  email: string | null;
  displayName: string | null;
  /** A named sign-in failure (wrong password) - null once signed in. */
  pendingError: string | null;
}

/** The one-time local sign-up: kept on this computer alone. */
export interface SignUpInput {
  name: string;
  email: string;
  password: string;
}
