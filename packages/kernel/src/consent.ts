import type postgres from 'postgres';
import { modeAutoAnswers, type ThreadMode } from '@nodeloom/core';
import { ACTION_REGISTRY, executeSceneRevise, type ActionSpec } from './chat/actions.js';
import { getOrgConfig } from './config.js';
import { emitEvent } from './events.js';
import { answerEscalation, escalate } from './inbox.js';
import { listConnections } from './connections.js';
import { resolveProject } from './containment.js';
import { listProjects, pathIsWithin } from './projects.js';
import { spawnRun } from './scheduler.js';
import { DESK_SLUG, ensureDeskAgent } from './chat/desk.js';
import { cardConstructLine, patternShelf, renderServiceContract } from './dialect.js';
import { listFlowStepDefs } from './flows/registry.js';
import { resolveIntegrationDef } from './integrations/catalog.js';

// THE ONE CONSENT FILE (the 500-line law is waived here).
// Four concerns in order: 1 the policy table · 2 the gate · 3 the grant store · 4 cards.
// A trailing section carries the run-call wall (walls 1-2), Phase 1's KEEP, intact.

// ---------------------------------------------------------------------------
// 1 · THE POLICY TABLE (Casbin's shape: request = (verb, params) · policy = one
//     row per verb · matcher = the gate below)
// ---------------------------------------------------------------------------
// free      = mutates only project content revisions can undo. Lands instantly,
//             never cards, in every mode.
// ask-once  = standing behavior or standing access inside the project. First
//             approval writes a grant; the same class+subject never cards again.
// always-ask= reaches outside or cannot be undone. Cards in every mode, forever.
// refusals  = words (word-boundary, goal/brief text only) that mean the ask
//             belongs to another door; a hit answers `invalid` and raises nothing.

export type ConsentClass = 'free' | 'ask-once' | 'always-ask';

export interface ConsentRefusal {
  when: string[];
  invalid: string;
}

export interface ConsentPolicyRow {
  verb: string;
  class: ConsentClass;
  /** The subject one ask-once approval covers; absent = the default rule (folder > scene > verb). */
  subjectOf?: (params: Record<string, unknown>) => string;
  refusals?: ConsentRefusal[];
}

export const CONSENT_POLICY: readonly ConsentPolicyRow[] = [
  { verb: 'work_proposal', class: 'ask-once', refusals: [{
    when: ['bind', 'binding', 'show rows on', 'screen data', 'connect table to'],
    invalid: 'this reads like data on a screen - that goes through revise_view, not work_proposal',
  }] },
  { verb: 'app_plan', class: 'always-ask' },
  { verb: 'create_project', class: 'ask-once' },
  { verb: 'rename_project', class: 'free' },
  { verb: 'org_settings', class: 'always-ask' },
  { verb: 'thread_mode', class: 'always-ask' },
  { verb: 'connect_service', class: 'always-ask' },
  { verb: 'component_proposal', class: 'always-ask' },
  { verb: 'import_component', class: 'always-ask' },
  { verb: 'scene_revise', class: 'free' },
  { verb: 'create_view', class: 'free' },
  { verb: 'revise_view', class: 'ask-once' },
  { verb: 'delete_view', class: 'always-ask' },
  { verb: 'rename_view', class: 'free' },
  { verb: 'operation_proposal', class: 'always-ask' },
  { verb: 'run_operation', class: 'ask-once' },
  { verb: 'create_reactive_chain', class: 'ask-once' },
  { verb: 'revoke_reactive_chain', class: 'ask-once' },
  { verb: 'create_trigger', class: 'ask-once' },
  { verb: 'delete_trigger', class: 'ask-once' },
  { verb: 'flows_place_step', class: 'free' },
  { verb: 'flows_wire_steps', class: 'free' },
  { verb: 'flows_unwire_steps', class: 'free' },
  { verb: 'flows_set_step_params', class: 'free' },
  { verb: 'flows_remove_step', class: 'free' },
  { verb: 'flows_toggle_step', class: 'free' },
  { verb: 'integrations_place', class: 'free' },
  { verb: 'integrations_connect', class: 'always-ask' },
  { verb: 'call_integration', class: 'always-ask' },
  { verb: 'import_package', class: 'always-ask' },
  { verb: 'export_package', class: 'always-ask' },
  { verb: 'delete_dataset', class: 'always-ask' },
  { verb: 'delete_thread', class: 'always-ask' },
  { verb: 'delete_note', class: 'free' },
];

const POLICY_BY_VERB = new Map(CONSENT_POLICY.map((row) => [row.verb, row]));

/** The policy row of one verb; a verb without a row throws - the table must be whole. */
export function consentPolicyOf(verb: string): ConsentPolicyRow {
  const row = POLICY_BY_VERB.get(verb);
  if (row === undefined) throw new Error(`unclassed verb: '${verb}' has no CONSENT_POLICY row - every verb must`);
  return row;
}

/** The declared class of one verb. */
export function consentClassOf(spec: Pick<ActionSpec, 'name'>): ConsentClass {
  return consentPolicyOf(spec.name).class;
}

let rosterValidated = false;

/** Validates once per process that every registry verb has a row and every row names a registry verb. */
export function validateConsentRoster(): void {
  if (rosterValidated) return;
  for (const spec of Object.values(ACTION_REGISTRY)) consentClassOf(spec);
  for (const row of CONSENT_POLICY) {
    if (!(row.verb in ACTION_REGISTRY)) throw new Error(`stale policy row: '${row.verb}' is not a registered verb`);
  }
  rosterValidated = true;
}

/** The matcher's refusal arm: the first row refusal whose words the goal/brief speak, or null. */
export function consentRefusalFor(row: ConsentPolicyRow, params: Record<string, unknown>): string | null {
  const spoken = [params['goal'], params['brief']].filter((v): v is string => typeof v === 'string').join('\n');
  if (spoken.length === 0) return null;
  for (const refusal of row.refusals ?? []) {
    const hit = refusal.when.find((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(spoken));
    if (hit !== undefined) return refusal.invalid;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 2 · THE GATE (the matcher)
// ---------------------------------------------------------------------------
// Path: refusals -> class -> the mode threshold (a mode moves ONLY the
// free/ask-once line; no mode ever skips always-ask) -> the grant store
// -> LAND now, or mint a card.

export interface ResolveThreadModeInput { orgId: string; threadId: string; }

// Effective mode for a thread: an explicit override wins, else the org default.
export async function resolveThreadMode(sql: postgres.Sql, input: ResolveThreadModeInput): Promise<ThreadMode> {
  const [row] = await sql<{ mode: ThreadMode | null }[]>`
    select mode from threads where id = ${input.threadId} and org_id = ${input.orgId} and deleted_at is null`;
  if (!row) throw new Error(`thread not found: ${input.threadId}`);
  if (row.mode) return row.mode;
  const config = await getOrgConfig(sql, input.orgId);
  return config.chat.defaultMode;
}

export interface ResolveRunModeInput { orgId: string; runId: string; }

// Effective mode for a run via its thread; threadless and unknown runs resolve 'ask'.
export async function resolveRunMode(sql: postgres.Sql, input: ResolveRunModeInput): Promise<ThreadMode> {
  const [row] = await sql<{ thread_id: string | null }[]>`
    select thread_id from runs where id = ${input.runId} and org_id = ${input.orgId}`;
  if (!row || row.thread_id === null) return 'ask';
  return resolveThreadMode(sql, { orgId: input.orgId, threadId: row.thread_id });
}

export interface SetThreadModeInput { orgId: string; threadId: string; mode: ThreadMode; }

// Per-thread mode override; the optional budget cap is enforced at claim time.
export async function setThreadMode(sql: postgres.Sql, input: SetThreadModeInput): Promise<void> {
  const rows = await sql<{ id: string }[]>`
    update threads set mode = ${input.mode} where id = ${input.threadId} and org_id = ${input.orgId} and deleted_at is null
    returning id`;
  if (!rows[0]) throw new Error(`thread not found: ${input.threadId}`);
}

// Result of the gate; execution is inline - 'applied' means it LANDED.
export interface GovernedActionResult {
  // applied = landed now; awaiting-consent = card pending (the op has NOT run); invalid = refused, nothing raised.
  status: 'approved' | 'applied' | 'awaiting-consent' | 'invalid';
  cardId?: string;
  resolvedBy?: string;
  reason?: string;
  // 'applied' on scene_revise: the revision the batch landed at.
  revisionNo?: number;
}

export interface ConsentGateInput {
  orgId: string;
  threadId: string;
  runId?: string | null;
  spec: ActionSpec;
  /** Schema-validated params (the caller validates before the gate). */
  params: Record<string, unknown>;
  /** Kernel-computed card riders (closures, notes, previews); ride the card payload only. */
  riders?: Record<string, unknown>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The plan pointer a dispatched brief carries: the approved plan is the build's scope ceiling. */
export interface AppPlanPointer {
  planId: string;
  revision: number;
  /** The citizen grid as approved: {tables, screens, flows, services}. */
  rows: Record<string, unknown>;
  note: string;
}

/** The project's active (unsuperseded) plan, or null. */
export async function activeAppPlan(
  sql: postgres.Sql, orgId: string, projectId: string,
): Promise<AppPlanPointer | null> {
  const [row] = await sql<{ id: string; revision: number; plan: Record<string, unknown> }[]>`
    select id, revision, plan from app_plans
    where org_id = ${orgId} and project_id = ${projectId} and superseded_at is null`;
  if (!row) return null;
  return {
    planId: row.id, revision: row.revision, rows: row.plan,
    note: "READ THIS FIRST: the approved plan is the build's scope ceiling - off-plan work returns as a gap report, never as built work",
  };
}

/** The thread's project resolved to its active plan; threadless or projectless resolves null. */
export async function activeAppPlanForThread(
  sql: postgres.Sql, orgId: string, threadId: string,
): Promise<AppPlanPointer | null> {
  const [thread] = await sql<{ project_id: string | null }[]>`
    select project_id from threads where id = ${threadId} and org_id = ${orgId}`;
  if (!thread || thread.project_id === null) return null;
  return activeAppPlan(sql, orgId, thread.project_id);
}

/** Lands one consented action now. work_proposal becomes a job; scene_revise returns its revision. */
async function executeConsented(
  sql: postgres.Sql,
  input: { orgId: string; threadId: string; runId?: string | null; resolvedBy: string; createdBy: string },
  spec: ActionSpec,
  params: Record<string, unknown>,
): Promise<{ revisionNo?: number }> {
  if (spec.name === 'work_proposal') {
    // Approval spawns the run DIRECTLY (the loop collapse): rules computed here, no queue, no planning pass.
    const brief = params['brief'];
    const wp = params['workspacePath'];
    const prompt = (typeof brief === 'string' && brief.length > 0 ? brief : params['goal']) as string;
    // The plan pointer: the project's active plan rides the brief first; the run builds inside its rows.
    const plan = await activeAppPlanForThread(sql, input.orgId, input.threadId);
    const browse = Array.isArray(params['browse'])
      ? (params['browse'] as unknown[]).filter((d): d is string => typeof d === 'string' && d.length > 0)
      : [];
    const declaredConnect = Array.isArray(params['connect'])
      ? (params['connect'] as unknown[]).filter((s): s is string => typeof s === 'string' && s.length > 0)
      : [];
    // Connect services compose only when a live connection row exists.
    const liveConnections = declaredConnect.length > 0
      ? (await listConnections(sql, input.orgId)).filter((c) => declaredConnect.includes(c.serviceId))
      : [];
    const panel = params['browserVisible'] === true;
    const reaching = browse.length > 0 || liveConnections.length > 0 || panel;
    // A reaching run stays read+report only (wall 2); everything else gets the work rules.
    const permissionRules = reaching
      ? [
        ...READ_RULES,
        ...browse.map((d) => ({ effect: 'allow' as const, pattern: `browse:${d}` })),
        ...liveConnections.map((c) => ({ effect: 'allow' as const, pattern: `connect:${c.serviceId}` })),
        ...liveConnections.flatMap((c) => c.defaultRules.map((r) => ({ effect: r.effect, pattern: r.pattern }))),
        ...(panel
          ? [{ effect: 'allow' as const, pattern: 'panel:visible' },
             { effect: 'allow' as const, pattern: 'mcp__nodeloom-panelbrowser__acquire_browser' }]
          : []),
      ]
      : WORK_RULES;
    // The desk owns every dispatched run (the roles library died); role is a plain display name on the card.
    await ensureDeskAgent(sql, input.orgId);
    await spawnRun(sql, {
      orgId: input.orgId, agentSlug: DESK_SLUG, kind: 'work', threadId: input.threadId,
      workspacePath: typeof wp === 'string' && wp.length > 0 ? wp : null,
      prompt: prompt.slice(0, 200),
      // The plan rides FIRST so it is the run's first read; the task follows it.
      input: plan !== null ? { plan, task: prompt } : { task: prompt },
      permissionRules,
    });
    return {};
  }
  if (spec.name === 'scene_revise') {
    // The payload is dialect text; the executor compiles it to ops and lands.
    const p = params as { sceneSlug: string; code: string };
    const res = await executeSceneRevise(sql, {
      orgId: input.orgId, runId: input.runId ?? null, sceneSlug: p.sceneSlug, code: p.code,
    });
    if (!res.ok) throw new Error(res.errors.join('; '));
    return { revisionNo: res.revisionNo };
  }
  await spec.execute(sql, {
    orgId: input.orgId, threadId: input.threadId,
    resolvedBy: input.resolvedBy, createdBy: input.createdBy,
    runId: input.runId ?? null,
  }, params);
  if (spec.escalationKind === 'app_plan') {
    // Approval continues the build: one desk turn wakes on the thread carrying the revision just written and,
    // pre-rendered, the contracts the plan already names (its services and the flows shelf) - no round trip for them.
    const plan = await activeAppPlanForThread(sql, input.orgId, input.threadId);
    if (plan === null) {
      console.error('app_plan approved but no active plan row found - no build turn spawned');
      return {};
    }
    const userMessage = `The plan (revision ${plan.revision}) is approved - build exactly its rows.`;
    const named = (key: string): string[] => (Array.isArray(plan.rows[key]) ? (plan.rows[key] as unknown[]) : [])
      .filter((v): v is string => typeof v === 'string' && v.length > 0);
    const contracts: Record<string, unknown> = {};
    for (const name of named('services')) {
      const def = resolveIntegrationDef(name);
      if (def !== null) contracts[name] = renderServiceContract(def);
    }
    if (named('flows').length > 0) {
      contracts['shelf:flows'] = { shelf: patternShelf('flows'), kinds: listFlowStepDefs().map((d) => `${d.kind} - ${d.blurb}`) };
    }
    await ensureDeskAgent(sql, input.orgId);
    await spawnRun(sql, {
      orgId: input.orgId, agentSlug: DESK_SLUG, kind: 'chat', threadId: input.threadId,
      prompt: userMessage.slice(0, 200),
      input: { threadId: input.threadId, userMessage, planApproved: { revision: plan.revision }, contracts },
      permissionRules: await voiceTurnRules(sql, input.orgId),
    });
  }
  return {};
}

/**
 * The one gate over the policy table. A refusal row hit answers invalid. Free
 * lands instantly and never cards; ask-once lands on an auto-answering mode or
 * a standing grant, else cards once; always-ask cards in every mode, forever.
 * A waiting card = the op has NOT run.
 */
export async function consentGate(sql: postgres.Sql, input: ConsentGateInput): Promise<GovernedActionResult> {
  validateConsentRoster();
  const { spec, params } = input;
  const row = consentPolicyOf(spec.name);
  const refused = consentRefusalFor(row, params);
  if (refused !== null) return { status: 'invalid', reason: refused };
  const land = async (resolvedBy: string): Promise<GovernedActionResult> => {
    try {
      const receipt = await executeConsented(sql, {
        orgId: input.orgId, threadId: input.threadId, runId: input.runId ?? null,
        resolvedBy, createdBy: UUID_RE.test(resolvedBy) ? resolvedBy : crypto.randomUUID(),
      }, spec, params);
      return { status: 'applied', resolvedBy, ...(receipt.revisionNo !== undefined ? { revisionNo: receipt.revisionNo } : {}) };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await emitEvent(sql, {
        orgId: input.orgId, actor: 'kernel.consent', type: 'action.invalid',
        payload: { action: spec.name, threadId: input.threadId, reason: reason.slice(0, 400) },
      }).catch(() => undefined);
      return { status: 'invalid', reason: reason.slice(0, 400) };
    }
  };
  if (row.class === 'free') return land('consent:free');
  if (row.class === 'ask-once') {
    // The mode threshold moves only this line; then the grant store; then a card.
    const mode = await resolveThreadMode(sql, { orgId: input.orgId, threadId: input.threadId });
    if (modeAutoAnswers(mode)) return land('mode:auto');
    const projectId = await resolveProject(sql, { orgId: input.orgId, threadId: input.threadId }).catch(() => null);
    const grant = await findConsentGrant(sql, input.orgId, grantSubjectFor(spec, params), { projectId });
    if (grant !== null) return land(`grant:${grant.id}`);
  }
  const { cardId } = await mintConsentCard(sql, {
    orgId: input.orgId, threadId: input.threadId, runId: input.runId ?? null,
    spec, params, riders: input.riders ?? {},
  });
  return { status: 'awaiting-consent', cardId };
}

// -- runtime approvals: a run's mid-run ask; approval grants standing for the NEXT run --

export const RUNTIME_APPROVAL_KIND = 'runtime_approval';

export interface RequestRuntimeApprovalInput {
  orgId: string; runId: string; action: string; justification: string;
}

export async function requestRuntimeApproval(
  sql: postgres.Sql, input: RequestRuntimeApprovalInput,
): Promise<{ requestId: string }> {
  const [run] = await sql<{ agent_id: string; thread_id: string | null; slug: string | null }[]>`
    select r.agent_id, r.thread_id, a.slug
    from runs r left join agents a on a.id = r.agent_id
    where r.id = ${input.runId} and r.org_id = ${input.orgId}`;
  if (!run) throw new Error(`requestRuntimeApproval: run not found in org: ${input.runId}`);
  const { messageId } = await escalate(sql, {
    orgId: input.orgId,
    kind: RUNTIME_APPROVAL_KIND,
    payload: {
      runId: input.runId, threadId: run.thread_id,
      agentId: run.agent_id, agentSlug: run.slug ?? 'agent',
      action: input.action, justification: input.justification,
    },
  });
  return { requestId: messageId };
}

export async function runtimeApprovalStatus(
  sql: postgres.Sql, input: { orgId: string; requestId: string },
): Promise<'pending' | 'granted' | 'denied'> {
  const [msg] = await sql<{ answered_at: Date | null; answer: Record<string, unknown> | null }[]>`
    select answered_at, answer from messages
    where id = ${input.requestId} and org_id = ${input.orgId} and payload->>'kind' = ${RUNTIME_APPROVAL_KIND}`;
  if (!msg || msg.answered_at === null) return 'pending';
  return msg.answer?.['approved'] === true ? 'granted' : 'denied';
}

// ---------------------------------------------------------------------------
// 3 · THE GRANT STORE
// ---------------------------------------------------------------------------
// One table, the ruled data model {projectId, class, subject, grantedAt}. Read
// by the gate; written on ask-once approval; listed and revoked by the settings
// panel. A projectless grant covers the org; a project-scoped grant covers its
// project. Subjects: folder:<path> · scene:<slug> · impact:<agentId>:<action> · verb:<name>.

export interface ConsentGrant {
  id: string;
  orgId: string;
  projectId: string | null;
  class: ConsentClass;
  subject: string;
  grantedBy: string;
  grantedAt: string;
  revokedAt: string | null;
}

/** Normalized comparison key: Windows paths are case-insensitive; trailing slashes are noise. */
export function normalizeGrantPath(p: string): string {
  return p.replace(/[\\/]+$/, '').toLowerCase();
}

/** The subject one ask-once approval covers: the row's subjectOf, else folder access by path, scene edits by slug, else the verb. */
export function grantSubjectFor(spec: Pick<ActionSpec, 'name'>, params: Record<string, unknown>): string {
  const own = POLICY_BY_VERB.get(spec.name)?.subjectOf;
  if (own !== undefined) return own(params);
  const wp = params['workspacePath'];
  if (typeof wp === 'string' && wp.length > 0) return `folder:${wp.replace(/[\\/]+$/, '')}`;
  const scene = params['sceneSlug'];
  if (typeof scene === 'string' && scene.length > 0) return `scene:${scene}`;
  return `verb:${spec.name}`;
}

/** Idempotent write; folder subjects dedupe by normalized path. grantedBy must be a uuid. */
export async function writeConsentGrant(
  sql: postgres.Sql,
  input: { orgId: string; subject: string; grantedBy: string; class?: ConsentClass; projectId?: string | null },
): Promise<{ grantId: string; created: boolean }> {
  const existing = await findConsentGrant(sql, input.orgId, input.subject, { exact: true });
  if (existing !== null) return { grantId: existing.id, created: false };
  const [row] = await sql<{ id: string }[]>`
    insert into consent_grants (org_id, project_id, class, subject, granted_by)
    values (${input.orgId}, ${input.projectId ?? null}, ${input.class ?? 'ask-once'}, ${input.subject}, ${input.grantedBy})
    returning id`;
  if (!row) throw new Error('consent grant insert returned no row');
  await emitEvent(sql, {
    orgId: input.orgId, actor: 'kernel.consent', type: 'consent.granted',
    payload: { grantId: row.id, subject: input.subject, projectId: input.projectId ?? null, grantedBy: input.grantedBy },
  });
  return { grantId: row.id, created: true };
}

/**
 * The active grant covering this subject, or null. A projectless grant covers
 * the whole org; a project-scoped grant covers only its project (`projectId`
 * filters when given). Folder subjects match the exact folder always, and an
 * ancestor folder only when it is a project path (project grants cover their
 * subtree). `exact` skips the ancestor walk.
 */
export async function findConsentGrant(
  sql: postgres.Sql, orgId: string, subject: string, opts?: { exact?: boolean; projectId?: string | null },
): Promise<{ id: string; subject: string } | null> {
  const pid = opts?.projectId ?? null;
  if (!subject.startsWith('folder:')) {
    const [row] = await sql<{ id: string; subject: string }[]>`
      select id, subject from consent_grants
      where org_id = ${orgId} and subject = ${subject} and revoked_at is null
        and (project_id is null or project_id = ${pid})
      order by granted_at asc limit 1`;
    return row ? { id: row.id, subject: row.subject } : null;
  }
  const path = subject.slice('folder:'.length);
  const key = normalizeGrantPath(path);
  const rows = await sql<{ id: string; subject: string }[]>`
    select id, subject from consent_grants
    where org_id = ${orgId} and subject like 'folder:%' and revoked_at is null
      and (project_id is null or project_id = ${pid})`;
  const folderRows = rows.map((r) => ({ id: r.id, subject: r.subject, path: r.subject.slice('folder:'.length) }));
  const exact = folderRows.find((r) => normalizeGrantPath(r.path) === key);
  if (exact) return { id: exact.id, subject: exact.subject };
  if (opts?.exact === true) return null;
  const ancestors = folderRows.filter((r) => pathIsWithin(r.path, path));
  if (ancestors.length === 0) return null;
  const projects = await listProjects(sql, orgId);
  const hit = ancestors.find((r) =>
    projects.some((p) => p.path !== null && normalizeGrantPath(p.path) === normalizeGrantPath(r.path)));
  return hit ? { id: hit.id, subject: hit.subject } : null;
}

/** The active grant covering this folder, or null - the folder-subject view of the one store. */
export async function findActiveFolderGrant(
  sql: postgres.Sql, orgId: string, path: string,
): Promise<{ id: string; path: string } | null> {
  const hit = await findConsentGrant(sql, orgId, `folder:${path.replace(/[\\/]+$/, '')}`);
  return hit === null ? null : { id: hit.id, path: hit.subject.slice('folder:'.length) };
}

export async function listConsentGrants(sql: postgres.Sql, orgId: string): Promise<ConsentGrant[]> {
  const rows = await sql<{ id: string; org_id: string; project_id: string | null; class: ConsentClass; subject: string; granted_by: string; granted_at: Date; revoked_at: Date | null }[]>`
    select id, org_id, project_id, class, subject, granted_by, granted_at, revoked_at from consent_grants
    where org_id = ${orgId} order by granted_at desc`;
  return rows.map((r) => ({
    id: r.id, orgId: r.org_id, projectId: r.project_id, class: r.class, subject: r.subject, grantedBy: r.granted_by,
    grantedAt: r.granted_at.toISOString(), revokedAt: r.revoked_at ? r.revoked_at.toISOString() : null,
  }));
}

// Tombstone, never delete: the audit of standing consents survives revocation.
export async function revokeConsentGrant(
  sql: postgres.Sql,
  input: { orgId: string; grantId: string; revokedBy: string },
): Promise<void> {
  const rows = await sql<{ id: string; subject: string }[]>`
    update consent_grants set revoked_at = now(), revoked_by = ${input.revokedBy}
    where id = ${input.grantId} and org_id = ${input.orgId} and revoked_at is null
    returning id, subject`;
  const row = rows[0];
  if (!row) return; // already revoked or unknown - idempotent
  await emitEvent(sql, {
    orgId: input.orgId, actor: 'kernel.consent', type: 'consent.revoked',
    payload: { grantId: row.id, subject: row.subject, revokedBy: input.revokedBy },
  });
}

/** Revoke by subject (exact); idempotent no-op when nothing is active. */
export async function revokeConsentGrantBySubject(
  sql: postgres.Sql,
  input: { orgId: string; subject: string; revokedBy: string },
): Promise<void> {
  const hit = await findConsentGrant(sql, input.orgId, input.subject, { exact: true });
  if (hit === null) return;
  await revokeConsentGrant(sql, { orgId: input.orgId, grantId: hit.id, revokedBy: input.revokedBy });
}

// ---------------------------------------------------------------------------
// 4 · CARDS
// ---------------------------------------------------------------------------
// mint = the escalation row carrying the verb, its params, and the plain-words
// sentence from the verb's lands field. resolve = approve -> (ask-once writes
// its grant) -> execute via the registry row -> receipt; decline -> a typed
// refusal the model must respect. WAITING = a card without an answer: the op
// has NOT run - never assume, never re-issue, never work around.

export interface MintConsentCardInput {
  orgId: string; threadId: string; runId?: string | null;
  spec: ActionSpec; params: Record<string, unknown>; riders?: Record<string, unknown>;
}

export async function mintConsentCard(sql: postgres.Sql, input: MintConsentCardInput): Promise<{ cardId: string }> {
  const { messageId } = await escalate(sql, {
    orgId: input.orgId, kind: input.spec.escalationKind,
    payload: {
      threadId: input.threadId, ...input.params, ...(input.riders ?? {}),
      runId: input.runId ?? null, lands: input.spec.lands,
      // The card speaks the construct: the verb's plain words plus the one name the params carry.
      construct: cardConstructLine(input.spec.name, input.params),
      // The card face reads the class: ask-once carries the remembered-for-this-project line.
      consentClass: consentClassOf(input.spec),
    },
  });
  return { cardId: messageId };
}

export interface ResolveConsentCardInput {
  orgId: string; messageId: string; approved: boolean;
  /** The answering human (uuid) - attribution and grant authorship. */
  resolvedBy: string;
  note?: string;
}

/** Answers one waiting card and, on approval, lands it: grant (ask-once) -> execute -> receipt. */
export async function resolveConsentCard(sql: postgres.Sql, input: ResolveConsentCardInput): Promise<void> {
  // answerEscalation is the claim: it throws on an already-answered card, so a card resolves at most once.
  const { payload } = await answerEscalation(sql, {
    messageId: input.messageId, orgId: input.orgId,
    answer: { approved: input.approved, note: input.note ?? null, resolvedBy: input.resolvedBy },
  });
  const kind = typeof payload['kind'] === 'string' ? payload['kind'] : '';
  const threadId = typeof payload['threadId'] === 'string' ? payload['threadId'] : null;
  const createdBy = UUID_RE.test(input.resolvedBy) ? input.resolvedBy : crypto.randomUUID();

  if (!input.approved) {
    // The typed refusal: the record carries the decline and an open mission wakes to absorb it.
    await emitEvent(sql, {
      orgId: input.orgId, actor: 'kernel.consent', type: 'action.declined',
      payload: { messageId: input.messageId, kind, threadId, note: input.note ?? null },
    }).catch(() => undefined);
    if (threadId !== null) {
      const { wakeOnDeniedAction } = await import('./chat/loop.js');
      await wakeOnDeniedAction(sql, {
        orgId: input.orgId, threadId, deniedKind: kind, note: input.note ?? null,
      }).catch(() => undefined);
    }
    return;
  }

  // Approved runtime_approval: the standing impact grant serves the agent's next run.
  if (kind === RUNTIME_APPROVAL_KIND) {
    const agentId = payload['agentId'];
    const action = payload['action'];
    if (typeof agentId === 'string' && typeof action === 'string') {
      // Org-wide standing answer: the run gate reads it agent-scoped, never project-scoped.
      await writeConsentGrant(sql, { orgId: input.orgId, subject: `impact:${agentId}:${action}`, grantedBy: createdBy, class: 'ask-once', projectId: null });
    }
    return;
  }

  const spec = Object.values(ACTION_REGISTRY).find((s) => s.escalationKind === kind);
  if (spec === undefined) {
    await emitEvent(sql, {
      orgId: input.orgId, actor: 'kernel.consent', type: 'action.invalid',
      payload: { messageId: input.messageId, threadId, reason: `approved card of unknown kind '${kind}' - nothing executed` },
    }).catch(() => undefined);
    return;
  }
  // First approval of an ask-once subject writes the standing grant, remembered for this project.
  if (consentClassOf(spec) === 'ask-once') {
    const { kind: _k, threadId: _t, runId: _r, lands: _l, construct: _x, consentClass: _c, ...bare } = payload;
    const projectId = threadId === null ? null
      : await resolveProject(sql, { orgId: input.orgId, threadId }).catch(() => null);
    await writeConsentGrant(sql, {
      orgId: input.orgId, subject: grantSubjectFor(spec, bare), grantedBy: createdBy,
      class: 'ask-once', projectId,
    }).catch((err) => {
      console.error('ask-once grant write failed:', err instanceof Error ? err.message : String(err));
    });
  }
  const { kind: _kind, threadId: _threadId, runId, lands: _lands, construct: _construct, consentClass: _consentClass, ...params } = payload;
  try {
    await executeConsented(sql, {
      orgId: input.orgId, threadId: threadId ?? '', runId: typeof runId === 'string' ? runId : null,
      resolvedBy: input.resolvedBy, createdBy,
    }, spec, params);
  } catch (err) {
    // A failed execution must never die silently: it lands on the answer row + an event.
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`${spec.name} execution failed:`, reason);
    try {
      await sql`update messages set answer = answer || jsonb_build_object('executeError', ${reason.slice(0, 500)}::text) where id = ${input.messageId}`;
      await emitEvent(sql, {
        orgId: input.orgId, actor: 'kernel.consent', type: 'action.invalid',
        payload: {
          messageId: input.messageId, action: spec.name, threadId,
          reason: `approved but FAILED to execute: ${reason.slice(0, 400)}`,
        },
      });
    } catch { /* the console line above already carries it */ }
  }
}

/** The approval mutation: answer + land in one call. */
export async function answerApproval(
  sql: postgres.Sql,
  input: { messageId: string; orgId: string; approved: boolean; note?: string; answeredBy?: string },
): Promise<void> {
  await resolveConsentCard(sql, {
    orgId: input.orgId, messageId: input.messageId, approved: input.approved,
    resolvedBy: input.answeredBy ?? crypto.randomUUID(),
    ...(input.note !== undefined ? { note: input.note } : {}),
  });
}

// ---------------------------------------------------------------------------
// THE RUN-CALL WALL (survivors of the swept permission files; walls 1-2)
// ---------------------------------------------------------------------------
// Wall 1 keeps the always-ask floor and the one adjudication for run tool
// calls; wall 2 keeps the reach/write combo wall. The CLI-settings renderer
// moves onto tools.ts at Phase 2.

export type RuleEffect = 'allow' | 'ask' | 'deny';

export interface PermissionRule {
  effect: RuleEffect;
  /** `Tool` | `Tool(specPattern)` | a named action pattern (`deploy`, `connect:*`). */
  pattern: string;
}

export interface ToolCall {
  /** Tool name (`Bash`, `Write`) or action name (`deploy`, `connect:stripe`). */
  tool: string;
  /** The argument scope being matched: a command line, an absolute path, `domain:<host>`… */
  spec?: string;
}

/** Matching is case-insensitive and backslash-normalized on both sides. */
function canon(s: string): string {
  return s.replace(/\\/g, '/').toLowerCase();
}

/** `*` and `**` both match any characters; everything else is literal. */
function wildcardToRegex(pattern: string): RegExp {
  const escaped = canon(pattern).replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*+/g, '.*')}$`);
}

function splitPattern(pattern: string): { tool: string; spec: string | null } {
  const m = /^(.*?)\((.*)\)$/s.exec(pattern.trim());
  if (m) return { tool: m[1]!, spec: m[2]! };
  return { tool: pattern.trim(), spec: null };
}

/** A bare tool pattern covers every call of that tool; Tool(specPattern) needs a present, matching spec. */
export function matchesPattern(pattern: string, call: ToolCall): boolean {
  const p = splitPattern(pattern);
  if (!wildcardToRegex(p.tool).test(canon(call.tool))) return false;
  if (p.spec === null) return true;
  if (call.spec === undefined) return false;
  return wildcardToRegex(p.spec).test(canon(call.spec));
}

/** deny > ask > allow across every matching rule; nothing matched returns 'unmatched'. */
export function evaluateRules(rules: PermissionRule[], call: ToolCall): RuleEffect | 'unmatched' {
  let best: RuleEffect | 'unmatched' = 'unmatched';
  for (const r of rules) {
    if (!matchesPattern(r.pattern, call)) continue;
    if (r.effect === 'deny') return 'deny';
    if (r.effect === 'ask') best = 'ask';
    else if (best === 'unmatched') best = 'allow';
  }
  return best;
}

const READ_TOOL_NAMES = ['Read', 'Grep', 'Glob'] as const;
const WRITE_TOOL_NAMES = ['Write', 'Edit', 'Bash'] as const;

// WebSearch/WebFetch are deliberately absent from WORK_RULES: open-web ingestion and write tools never compose by default.
export const READ_RULES: PermissionRule[] = READ_TOOL_NAMES.map((t) => ({ effect: 'allow', pattern: t }));
export const WORK_RULES: PermissionRule[] = [
  ...READ_RULES,
  ...WRITE_TOOL_NAMES.map((t) => ({ effect: 'allow' as const, pattern: t })),
];

// The always-ask floor (wall 1): a separate evaluation stage no allow, mode, or
// memory can shadow; only a human-attributed standing answer lifts a pattern.
export const ALWAYS_ASK_FLOOR: readonly { cls: string; pattern: string }[] = [
  { cls: 'deploy', pattern: 'deploy' },
  { cls: 'send', pattern: 'send' },
  { cls: 'spend', pattern: 'spend' },
  { cls: 'connect', pattern: 'connect:*' },
  { cls: 'browse', pattern: 'browse:*' },
  // Deploy-class shell shapes: pushing/publishing leaves the machine.
  { cls: 'deploy', pattern: 'Bash(git push*)' },
  { cls: 'deploy', pattern: 'Bash(npm publish*)' },
  { cls: 'deploy', pattern: 'Bash(vercel *)' },
  // Machine-wide process kills.
  { cls: 'machine-wide-kill', pattern: 'Bash(taskkill *)' },
  { cls: 'machine-wide-kill', pattern: 'Bash(killall *)' },
  { cls: 'machine-wide-kill', pattern: 'Bash(pkill *)' },
];

// Bash is the one governed shell; PowerShell would bypass the floor, so deny beats allow.
export const KERNEL_DENY_RULES: readonly PermissionRule[] = [
  { effect: 'deny', pattern: 'PowerShell' },
];

/** The floor pattern a call hits, or null; first match wins. */
export function matchesFloor(call: ToolCall): { cls: string; pattern: string } | null {
  for (const f of ALWAYS_ASK_FLOOR) {
    if (matchesPattern(f.pattern, call)) return f;
  }
  return null;
}

/** The floor as explicit ask-rules; the CLI auto-allows unlisted read-only calls, so absence is not a park. */
export function floorAskRules(): PermissionRule[] {
  return ALWAYS_ASK_FLOOR.map((f) => ({ effect: 'ask' as const, pattern: f.pattern }));
}

/** A run's declared ruleset plus the standing answers that may cover floor patterns and asks. */
export interface RunPermissions {
  rules: PermissionRule[];
  /** Exact patterns a human has standing-answered (impact grants in the one store). */
  standingAnswers: string[];
}

/** The one shared adjudication: deny > floor > declared ask > declared allow > default ask; unmatched is never allowed. */
export function evaluateCall(perms: RunPermissions, call: ToolCall): 'allow' | 'ask' | 'deny' {
  if (perms.rules.some((r) => r.effect === 'deny' && matchesPattern(r.pattern, call))) return 'deny';
  const answered = (): boolean => perms.standingAnswers.some((a) => matchesPattern(a, call));
  if (matchesFloor(call) !== null) return answered() ? 'allow' : 'ask';
  const effect = evaluateRules(perms.rules, call);
  if (effect === 'ask') return answered() ? 'allow' : 'ask';
  return effect === 'unmatched' ? 'ask' : effect;
}

/** CLI tools are Capitalized identifiers or mcp__* ids; kernel action grammar never matches. */
export function isCliToolPattern(pattern: string): boolean {
  const paren = pattern.indexOf('(');
  const root = (paren === -1 ? pattern : pattern.slice(0, paren)).trim();
  return /^[A-Z][A-Za-z]*$/.test(root) || root.startsWith('mcp__');
}

export interface CliSettings {
  permissions: { allow: string[]; ask: string[]; deny: string[] };
  /** Always false: kernel notes are the only memory on compiled runs. */
  autoMemoryEnabled: false;
}

/** Bare-tool-name deny patterns do not bind on the CLI, so a bare deny expands to all specifier forms. */
function denyForms(pattern: string): string[] {
  if (pattern.includes('(')) return [pattern];
  return [pattern, `${pattern}(*)`, `${pattern}(**)`];
}

/** Buckets a ruleset into the CLI settings object: CLI shapes only, deduped; every deny is also mirrored into ask. */
export function cliSettingsFor(rules: PermissionRule[]): CliSettings {
  const buckets = { allow: [] as string[], ask: [] as string[], deny: [] as string[] };
  const seen = new Set<string>();
  const push = (effect: 'allow' | 'ask' | 'deny', pattern: string): void => {
    const key = `${effect}:${pattern}`;
    if (seen.has(key)) return;
    seen.add(key);
    buckets[effect].push(pattern);
  };
  for (const r of rules) {
    if (!isCliToolPattern(r.pattern)) continue;
    if (r.effect === 'deny') {
      for (const form of denyForms(r.pattern)) push('deny', form);
    } else {
      push(r.effect, r.pattern);
    }
  }
  // The ask mirror renders after all declared asks so declared ordering is untouched.
  for (const d of buckets.deny) push('ask', d);
  return { permissions: buckets, autoMemoryEnabled: false };
}

/** Active folder grants become subtree Write/Edit allows; grant paths slash-normalize into patterns. */
export async function folderGrantRules(sql: postgres.Sql, orgId: string): Promise<PermissionRule[]> {
  const rows = await sql<{ subject: string }[]>`
    select subject from consent_grants
    where org_id = ${orgId} and subject like 'folder:%' and revoked_at is null
    order by granted_at asc`;
  return rows.flatMap((r) => {
    const base = r.subject.slice('folder:'.length).replace(/\\/g, '/').replace(/\/+$/, '');
    return [
      { effect: 'allow' as const, pattern: `Write(${base}/**)` },
      { effect: 'allow' as const, pattern: `Edit(${base}/**)` },
    ];
  });
}

/** The agent's standing answers: impact grants in the one store — the only thing that lifts a floor hit or a declared ask. */
export async function standingAnswers(sql: postgres.Sql, orgId: string, agentId: string): Promise<string[]> {
  const prefix = `impact:${agentId}:`;
  const rows = await sql<{ subject: string }[]>`
    select subject from consent_grants
    where org_id = ${orgId} and subject like ${prefix + '%'} and revoked_at is null`;
  return rows.map((r) => r.subject.slice(prefix.length));
}

/** The voice turn's ruleset: read-only tools free, Write/Edit inside granted folders, everything else unmatched. */
export async function voiceTurnRules(sql: postgres.Sql, orgId: string): Promise<PermissionRule[]> {
  return [...READ_RULES, ...(await folderGrantRules(sql, orgId))];
}

/** Loads a run's ruleset plus the agent's standing answers; null = unknown run. */
export async function loadRunPermissions(
  sql: postgres.Sql, orgId: string, runId: string,
): Promise<RunPermissions | null> {
  const [row] = await sql<{ permission_rules: PermissionRule[] | null; agent_id: string }[]>`
    select r.permission_rules, r.agent_id from runs r
    where r.id = ${runId} and r.org_id = ${orgId}`;
  if (!row) return null;
  return {
    // The kernel deny set rides every load; no run row can omit it.
    rules: [...KERNEL_DENY_RULES, ...(row.permission_rules ?? [])],
    standingAnswers: await standingAnswers(sql, orgId, row.agent_id),
  };
}

const WRITE_ROOTS = new Set(['write', 'edit', 'bash']);
const OUTBOUND_ROOTS = new Set(['websearch', 'webfetch']);
const READ_ROOTS = new Set(['read', 'grep', 'glob']);

function patternRoot(pattern: string): string {
  const paren = pattern.indexOf('(');
  return (paren === -1 ? pattern : pattern.slice(0, paren)).trim().toLowerCase();
}

export type ComboWallResult = { ok: true } | { ok: false; reason: string };

export type GateDecision = { allowed: true } | { allowed: false; reason: string };

/** Claim-time gate: the combo wall (wall 2), then declared action ask-patterns require a standing answer. */
export async function gateRun(
  sql: postgres.Sql,
  input: { orgId: string; agentId: string; runId: string; rules: PermissionRule[] },
): Promise<GateDecision> {
  const combo = checkComboWall(input.rules);
  if (!combo.ok) {
    await emitEvent(sql, {
      orgId: input.orgId, actor: 'kernel.consent', type: 'policy.denied',
      payload: { runId: input.runId, agentId: input.agentId, reason: 'combo wall' },
    });
    return { allowed: false, reason: combo.reason };
  }
  const actionAsks = input.rules
    .filter((r) => r.effect === 'ask' && !isCliToolPattern(r.pattern))
    .map((r) => r.pattern);
  if (actionAsks.length > 0) {
    const answers = new Set(await standingAnswers(sql, input.orgId, input.agentId));
    const missing = actionAsks.filter((a) => !answers.has(a));
    if (missing.length > 0) {
      await emitEvent(sql, {
        orgId: input.orgId, actor: 'kernel.consent', type: 'policy.denied',
        payload: { runId: input.runId, agentId: input.agentId, missing, reason: 'action ask without standing answer' },
      });
      return { allowed: false, reason: `declared actions require a standing answer: ${missing.join(', ')}` };
    }
  }
  await emitEvent(sql, {
    orgId: input.orgId, actor: 'kernel.consent', type: 'policy.granted',
    payload: {
      runId: input.runId, agentId: input.agentId,
      patterns: input.rules.filter((r) => r.effect === 'allow').map((r) => r.pattern),
    },
  });
  return { allowed: true };
}

/** Wall 2: a reaching ruleset (browse/connector) may hold no other write or outbound capability. */
export function checkComboWall(rules: PermissionRule[]): ComboWallResult {
  const held = rules.filter((r) => r.effect !== 'deny').map((r) => patternRoot(r.pattern));
  const isReach = (root: string) => root.startsWith('browse:') || root.startsWith('connect:');
  if (!held.some(isReach)) return { ok: true };
  // A connection's own mcp__ext-<service>__ tools are part of the reach itself, not other capability.
  const connectedServices = held.filter((r) => r.startsWith('connect:')).map((r) => r.slice('connect:'.length));
  const isOwnConnectionTool = (root: string) =>
    connectedServices.some((s) => s.length > 0 && !s.includes('*') && root.startsWith(`mcp__ext-${s}__`));
  const offender = held.find((root) =>
    WRITE_ROOTS.has(root) || OUTBOUND_ROOTS.has(root)
    || (!isReach(root) && !READ_ROOTS.has(root) && !isOwnConnectionTool(root)));
  if (offender === undefined) return { ok: true };
  return {
    ok: false,
    reason: `a reaching ruleset (browse/connector) may hold no other write or outbound capability (FR-45 combo wall): ${offender}`,
  };
}
