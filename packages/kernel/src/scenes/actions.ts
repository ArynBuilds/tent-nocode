import type postgres from 'postgres';
import {
  flowEnvelopeSchema, sceneActionsSchema, sceneBindingsSchema, sceneDocumentSchema,
  type ActionAnswer, type ActionCriterion, type ActionEffect, type ActionExecution, type ActionRule, type ActionWhen, type SceneAction,
} from '@tent-nocode/core';
import { emitEvent } from '../events.js';
import { projectArm } from '../containment.js';
import { validateRows } from '../tabs/datasets.js';
import { formatIssues, loadValidateContext, validateScene } from './validate.js';
import { requireScene } from './store.js';
import { claimNextFlowExecution, getFlow, startFlowExecution } from '../flows/store.js';
import { tickFlowExecution } from '../flows/engine.js';
import { MAIN_FLOW } from '../flows/authoring.js';

// EFFECTS RIDE THE ANSWER (Phase 12, ruling 9): submitSceneAction materializes params, checks criteria, runs
// the rules, and answers {effects, execution?} in the same call - json-render's onSuccess arms computed
// here, Bolt's one promise chain. start_flow awaits the run up to a budget (the engine ticks it inline)
// and folds its effects in; a longer run answers `execution` and its effects push over the live channel.

const ACTOR = 'kernel.scenes';
/** How long a start_flow rule waits for its run before the answer goes out without it. */
export const FLOW_ANSWER_BUDGET_MS = 3_000;
/** A chained `action` rule may chain again this deep; past it the chain stops and says so. */
const CHAIN_DEPTH = 3;

export async function setSceneContracts(
  sql: postgres.Sql,
  input: { orgId: string; sceneSlug: string; bindings: unknown; actions: unknown },
): Promise<{ ok: true } | { ok: false; errors: string[] }> {
  const bindings = sceneBindingsSchema.safeParse(input.bindings);
  const actions = sceneActionsSchema.safeParse(input.actions);
  if (!bindings.success || !actions.success) {
    return {
      ok: false,
      errors: [...(bindings.success ? [] : bindings.error.issues.map((i) => `bindings: ${i.path.join('.')} ${i.message}`)),
               ...(actions.success ? [] : actions.error.issues.map((i) => `actions: ${i.path.join('.')} ${i.message}`))],
    };
  }
  const scene = await requireScene(sql, input.orgId, input.sceneSlug);
  // Contracts contradicting the built document refuse before persisting - the one validator, over the new contracts.
  const [docRow] = await sql<{ document: unknown; project_id: string | null }[]>`select document, project_id from scenes where id = ${scene.id}`;
  const headDoc = sceneDocumentSchema.parse(docRow?.document);
  const ctx = await loadValidateContext(sql, { orgId: input.orgId, projectId: docRow?.project_id ?? null, doc: headDoc, bindings: bindings.data, actions: actions.data });
  const verdict = validateScene(headDoc, ctx);
  if (!verdict.ok) return { ok: false, errors: formatIssues(verdict.issues.filter((i) => i.severity === 'error')) };
  await sql`
    update scenes set bindings = ${sql.json(bindings.data as unknown as postgres.JSONValue)},
                      actions = ${sql.json(actions.data as unknown as postgres.JSONValue)}
    where id = ${scene.id}`;
  await emitEvent(sql, {
    orgId: input.orgId, actor: ACTOR, type: 'scene.contracts_set',
    payload: {
      sceneId: scene.id, slug: scene.slug,
      bindings: bindings.data.map((b) => ({ name: b.name, kind: b.kind, ...(b.kind === 'query' ? { table: b.table } : {}) })),
      actions: actions.data.map((a) => a.name),
    },
  });
  return { ok: true };
}

export type ActionSubmitResult = ActionAnswer;

export interface SubmitSceneActionInput {
  orgId: string;
  sceneSlug: string;
  action: string;
  values: Record<string, unknown>;
  userId: string;
  /** The start_flow wait, in ms; the default is the three-second budget. */
  budgetMs?: number;
}

export async function submitSceneAction(sql: postgres.Sql, input: SubmitSceneActionInput): Promise<ActionAnswer> {
  const scene = await requireScene(sql, input.orgId, input.sceneSlug);
  // The scene's own project scopes every rule below.
  const [row] = await sql<{ actions: unknown; title: string; project_id: string | null }[]>`
    select actions, title, project_id from scenes where id = ${scene.id}`;
  const sceneProjectId = row?.project_id ?? null;
  const actions = sceneActionsSchema.parse(row?.actions ?? []);
  const action = actions.find((a) => a.name === input.action);
  if (!action) {
    return { ok: false, failures: [`no action '${input.action}' is declared on this scene - its actions are [${actions.map((a) => a.name).join(', ') || 'none'}]`] };
  }

  const { params, failures, decisions } = materialize(action, input.values, input.userId);
  const criteriaFailures = failures.length === 0 ? checkCriteria(action.criteria, params) : [];
  const allFailures = [...failures, ...criteriaFailures];
  if (allFailures.length > 0) {
    await emitEvent(sql, {
      orgId: input.orgId, actor: ACTOR, type: 'scene.action_submitted',
      payload: { sceneId: scene.id, slug: scene.slug, action: action.name, by: input.userId, ok: false, failures: allFailures },
    });
    return { ok: false, failures: allFailures };
  }

  const ctx: RunContext = {
    sql, orgId: input.orgId, sceneSlug: scene.slug, sceneTitle: row?.title ?? scene.slug, projectId: sceneProjectId,
    userId: input.userId, actions, budgetMs: input.budgetMs ?? FLOW_ANSWER_BUDGET_MS, startedAt: Date.now(),
  };
  const out = await runRules(ctx, action, params, decisions, 0);

  await emitEvent(sql, {
    orgId: input.orgId, actor: ACTOR, type: 'scene.action_submitted',
    payload: {
      sceneId: scene.id, slug: scene.slug, action: action.name, by: input.userId, ok: true, params, results: out.results,
      effects: out.effects, ...(out.execution !== undefined ? { execution: out.execution } : {}),
    },
  });
  return { ok: true, results: out.results, effects: out.effects, ...(out.execution !== undefined ? { execution: out.execution } : {}) };
}

interface RunContext {
  sql: postgres.Sql;
  orgId: string;
  sceneSlug: string;
  sceneTitle: string;
  projectId: string | null;
  userId: string;
  actions: SceneAction[];
  budgetMs: number;
  startedAt: number;
}

interface RunOutcome {
  results: Array<Record<string, unknown>>;
  effects: ActionEffect[];
  execution?: ActionExecution;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function valueOf(from: { from: string; param?: string; value?: unknown }, params: Record<string, unknown>): unknown {
  return from.from === 'param' ? params[from.param!] : from.value;
}

/** Runs one action's rules in order; every rule lands a result row, an effect, or both. */
async function runRules(ctx: RunContext, action: SceneAction, params: Record<string, unknown>, decisions: RuleDecision[], depth: number): Promise<RunOutcome> {
  const { sql, orgId } = ctx;
  const results: Array<Record<string, unknown>> = [];
  const effects: ActionEffect[] = [];
  let execution: ActionExecution | undefined;
  for (let ri = 0; ri < action.rules.length; ri++) {
    const rule = action.rules[ri]!;
    const decision = decisions[ri]!;
    if (!decision.active) {
      // A skipped rule is recorded with its reason, never silently dropped.
      results.push({ rule: rule.rule, skipped: true, because: decision.because });
      continue;
    }
    if (rule.rule === 'append_row') {
      const [dataset] = await sql<{ id: string; row_schema: Record<string, 'string' | 'number' | 'boolean'>; user_scope: string }[]>`
        select id, row_schema, user_scope from datasets
        where org_id = ${orgId} and ${projectArm(sql, ctx.projectId)} and name = ${rule.table} and deleted_at is null`;
      if (!dataset) {
        results.push({ rule: 'append_row', table: rule.table, accepted: 0, rejected: [{ index: 0, reason: `table '${rule.table}' does not exist - the action door never creates tables` }] });
        continue;
      }
      if (dataset.user_scope === 'app') {
        results.push({ rule: 'append_row', table: rule.table, accepted: 0, rejected: [{ index: 0, reason: `'${rule.table}' belongs to the app - its rows arrive on their own, people don't write them` }] });
        continue;
      }
      const built: Record<string, unknown> = {};
      for (const [col, from] of Object.entries(rule.row)) built[col] = valueOf(from, params);
      const verdict = validateRows([built], dataset.row_schema);
      for (const r of verdict.accepted) {
        await sql`
          insert into dataset_rows (org_id, dataset_id, row, evidence_run_id)
          values (${orgId}, ${dataset.id}, ${sql.json(r as postgres.JSONValue)}, ${null})`;
      }
      results.push({ rule: 'append_row', table: rule.table, accepted: verdict.accepted.length, rejected: verdict.rejected });
    } else if (rule.rule === 'update_row' || rule.rule === 'delete_row') {
      // Rows are addressed by kernel row id only; an unknown id updates nothing; a non-uuid refuses before the cast.
      const rowIdRaw = valueOf(rule.rowId, params);
      const rowId = typeof rowIdRaw === 'string' && UUID_RE.test(rowIdRaw) ? rowIdRaw : '';
      const [target] = rowId === '' ? [] : await sql<{ id: string; row: Record<string, unknown>; row_schema: Record<string, 'string' | 'number' | 'boolean'>; user_scope: string }[]>`
        select r.id, r.row, d.row_schema, d.user_scope from dataset_rows r join datasets d on d.id = r.dataset_id
        where r.id = ${rowId} and d.org_id = ${orgId} and ${projectArm(sql, ctx.projectId, 'd')} and d.name = ${rule.table} and d.deleted_at is null`;
      if (!target) {
        results.push({ rule: rule.rule, table: rule.table, applied: false, reason: `no row with that id in '${rule.table}' - rows are addressed by the _id the query carried, never matched by value` });
        continue;
      }
      if (target.user_scope === 'app') {
        results.push({ rule: rule.rule, table: rule.table, applied: false, reason: `'${rule.table}' belongs to the app - its rows arrive on their own, people don't write them` });
        continue;
      }
      if (rule.rule === 'delete_row') {
        await sql`delete from dataset_rows where id = ${target.id}`;
        results.push({ rule: 'delete_row', table: rule.table, applied: true, rowId: target.id });
      } else {
        const patch: Record<string, unknown> = {};
        for (const [col, from] of Object.entries(rule.set)) patch[col] = valueOf(from, params);
        // The merged row must still satisfy the table's row schema.
        const verdict = validateRows([{ ...target.row, ...patch }], target.row_schema);
        if (verdict.accepted.length === 0) {
          results.push({ rule: 'update_row', table: rule.table, applied: false, reason: verdict.rejected[0]?.reason ?? 'patch violates the row schema' });
          continue;
        }
        await sql`update dataset_rows set row = ${sql.json(verdict.accepted[0] as postgres.JSONValue)} where id = ${target.id}`;
        results.push({ rule: 'update_row', table: rule.table, applied: true, rowId: target.id, set: Object.keys(patch) });
      }
    } else if (rule.rule === 'start_flow') {
      const out = await runStartFlow(ctx, action, rule, params);
      results.push(out.result);
      effects.push(...out.effects);
      if (out.execution !== undefined) execution = out.execution;
    } else if (rule.rule === 'navigate') {
      const key = rule.key !== undefined ? valueOf(rule.key, params) : undefined;
      effects.push({ kind: 'goto', scene: rule.scene });
      results.push({ rule: 'navigate', scene: rule.scene, ...(key !== undefined ? { key } : {}) });
    } else if (rule.rule === 'set') {
      const value = valueOf(rule.value, params);
      effects.push({ kind: 'answer', key: rule.key, value });
      results.push({ rule: 'set', key: rule.key });
    } else {
      // A chained action runs in the same call with its own params on top of ours; a missing one records its absence.
      const next = ctx.actions.find((a) => a.name === rule.action);
      if (next === undefined) { results.push({ rule: 'action', action: rule.action, ran: false, reason: `no action named '${rule.action}' on this screen` }); continue; }
      if (depth >= CHAIN_DEPTH) { results.push({ rule: 'action', action: rule.action, ran: false, reason: `the chain is ${CHAIN_DEPTH} deep - it stops here` }); continue; }
      const handed: Record<string, unknown> = { ...params };
      for (const [k, from] of Object.entries(rule.with)) handed[k] = valueOf(from, params);
      const m = materialize(next, handed, ctx.userId);
      const criteriaFailures = m.failures.length === 0 ? checkCriteria(next.criteria, m.params) : [];
      const fails = [...m.failures, ...criteriaFailures];
      if (fails.length > 0) { results.push({ rule: 'action', action: rule.action, ran: false, failures: fails }); continue; }
      const sub = await runRules(ctx, next, m.params, m.decisions, depth + 1);
      results.push({ rule: 'action', action: rule.action, ran: true, results: sub.results });
      effects.push(...sub.effects);
      if (sub.execution !== undefined && execution === undefined) execution = sub.execution;
    }
  }
  return { results, effects, ...(execution !== undefined ? { execution } : {}) };
}

/** Starts the run and awaits it up to the budget: the engine ticks the org's queue inline until ours settles or parks. */
async function runStartFlow(
  ctx: RunContext, action: SceneAction, rule: Extract<ActionRule, { rule: 'start_flow' }>, params: Record<string, unknown>,
): Promise<{ result: Record<string, unknown>; effects: ActionEffect[]; execution?: ActionExecution }> {
  const { sql, orgId } = ctx;
  if (ctx.projectId === null) {
    return { result: { rule: 'start_flow', queued: false, reason: `the '${ctx.sceneTitle}' scene has no project home, so there is no flow to start` }, effects: [] };
  }
  const flowName = rule.flow ?? MAIN_FLOW;
  const flow = await getFlow(sql, orgId, { projectId: ctx.projectId, name: flowName });
  if (flow === null) {
    return { result: { rule: 'start_flow', queued: false, reason: `no flow named '${flowName}' lives in this project - the wire points at nothing` }, effects: [] };
  }
  const started = await startFlowExecution(sql, {
    orgId, flowId: flow.id, entry: rule.entry,
    trigger: { kind: 'scene_action', sceneSlug: ctx.sceneSlug, action: action.name, by: ctx.userId, ...params },
    inputs: params,
  });
  if (!started.ok) return { result: { rule: 'start_flow', queued: false, reason: started.refusal }, effects: [] };
  const id = started.executionId;
  const deadline = ctx.startedAt + ctx.budgetMs;
  // Drain the org's queue in order until our run has been ticked; each tick is awaited whole. When nothing is
  // claimable (another sweeper holds the queue) the record is read again on a short beat until the budget ends.
  const readRow = async (): Promise<{ status: string; envelope: unknown; error: string | null } | undefined> =>
    (await sql<{ status: string; envelope: unknown; error: string | null }[]>`
      select status, envelope, error from flow_executions where org_id = ${orgId} and id = ${id}`)[0];
  let row = await readRow();
  let ticked = false;
  for (let n = 0; n < 40 && !ticked && Date.now() < deadline; n++) {
    if (row !== undefined && (row.status === 'succeeded' || row.status === 'failed')) break;
    const claimed = await claimNextFlowExecution(sql, orgId);
    if (claimed === null) {
      await new Promise((r) => setTimeout(r, Math.min(100, Math.max(0, deadline - Date.now()))));
      row = await readRow();
      continue;
    }
    try {
      await tickFlowExecution(sql, claimed);
    } catch (err) {
      const { settleFlowExecution } = await import('../flows/store.js');
      await settleFlowExecution(sql, { executionId: claimed.id, orgId, status: 'failed', error: err instanceof Error ? err.message.slice(0, 300) : 'the run failed' });
    }
    if (claimed.id === id) ticked = true;
    row = await readRow();
  }
  const status = row?.status ?? 'pending';
  if (status === 'succeeded') {
    const env = flowEnvelopeSchema.safeParse(row?.envelope);
    return { result: { rule: 'start_flow', executionId: id, settled: true, status }, effects: env.success ? env.data.effects : [] };
  }
  if (status === 'failed') {
    const error = (row?.error ?? 'the flow failed').slice(0, 300);
    return { result: { rule: 'start_flow', executionId: id, settled: true, status, error }, effects: [{ kind: 'message', text: error }], execution: { id, status: 'failed', error } };
  }
  // Pending, running or waiting past the budget: the answer names the run; its effects push when it settles.
  return { result: { rule: 'start_flow', executionId: id, settled: false, status }, effects: [], execution: { id, status: status === 'waiting' ? 'waiting' : 'running' } };
}

/** A rule's verdict for this submission: active, or skipped with its reason. */
type RuleDecision = { active: true } | { active: false; because: string };

/** The params a rule consumes; a required param consumed only by skipped rules is not required. */
function ruleConsumes(rule: ActionRule): string[] {
  const of = (vs: Array<{ from: string; param?: string }>): string[] =>
    vs.filter((v) => v.from === 'param' && v.param !== undefined).map((v) => v.param!);
  switch (rule.rule) {
    case 'append_row': return of(Object.values(rule.row));
    case 'update_row': return of([rule.rowId, ...Object.values(rule.set)]);
    case 'delete_row': return of([rule.rowId]);
    case 'navigate': return rule.key !== undefined ? of([rule.key]) : [];
    case 'set': return of([rule.value]);
    case 'action': return of(Object.values(rule.with));
    // start_flow consumes all params implicitly via the trigger item, so it lists none.
    case 'start_flow': return [];
  }
}

/** The reason sentence a skipped rule records. */
function whenBecause(w: ActionWhen): string {
  const val = typeof w.value === 'string' ? `'${w.value}'` : String(w.value);
  switch (w.check) {
    case 'is': return `'${w.param}' is not ${val}`;
    case 'matches': return `'${w.param}' does not match ${val}`;
    case 'includes': return `'${w.param}' is not one of ${Array.isArray(w.value) ? `[${(w.value as unknown[]).join(', ')}]` : val}`;
    case 'gte': return `'${w.param}' is below ${val}`;
    case 'lte': return `'${w.param}' is above ${val}`;
    case 'nonempty': return `'${w.param}' is empty`;
  }
}

function materialize(
  action: SceneAction, values: Record<string, unknown>, userId: string,
): { params: Record<string, unknown>; failures: string[]; decisions: RuleDecision[] } {
  const params: Record<string, unknown> = {};
  const failures: string[] = [];
  const absent: Array<{ pname: string; description: string }> = [];
  for (const [pname, decl] of Object.entries(action.params)) {
    let v: unknown;
    if (decl.source === 'static') v = decl.value;
    else if (decl.source === 'contextual') v = decl.contextual === 'currentUser' ? userId : new Date().toISOString();
    else v = values[pname]; // user and binding values both arrive from the widget
    if (v === undefined) {
      if (decl.required) absent.push({ pname, description: decl.description });
      continue;
    }
    const typeErr =
      decl.type === 'string' && typeof v !== 'string' ? 'expects a string'
      : decl.type === 'number' && typeof v !== 'number' ? 'expects a number'
      : decl.type === 'boolean' && typeof v !== 'boolean' ? 'expects a boolean'
      : decl.type === 'enum' && !(typeof v === 'string' && (decl.enum ?? []).includes(v)) ? `must be one of [${(decl.enum ?? []).join(', ')}]`
      : null;
    if (typeErr) failures.push(`'${pname}' ${typeErr}`);
    else params[pname] = v;
  }
  // Active rules are computed first; each when evaluates over the materialized params.
  const decisions: RuleDecision[] = action.rules.map((r) =>
    r.when === undefined || checkPasses(r.when.check, params[r.when.param], r.when.value)
      ? { active: true }
      : { active: false, because: whenBecause(r.when) });
  // A required param consumed only by skipped rules is not required this submission.
  for (const { pname, description } of absent) {
    const consumers = action.rules.map((r, i) => ({ r, i })).filter(({ r }) => ruleConsumes(r).includes(pname));
    const onlySkipped = consumers.length > 0 && consumers.every(({ i }) => decisions[i]!.active === false);
    if (!onlySkipped) failures.push(`'${pname}' is required (${description})`);
  }
  return { params, failures, decisions };
}

/** The one check predicate; criteria and rule whens share it. */
function checkPasses(check: ActionCriterion['check'], v: unknown, value: unknown): boolean {
  return check === 'is' ? v === value
    : check === 'matches' ? typeof v === 'string' && typeof value === 'string' && new RegExp(value).test(v)
    : check === 'includes' ? Array.isArray(value) && (value as unknown[]).includes(v)
    : check === 'gte' ? typeof v === 'number' && typeof value === 'number' && v >= value
    : check === 'lte' ? typeof v === 'number' && typeof value === 'number' && v <= value
    : v !== undefined && v !== null && v !== '';
}

function checkCriteria(criteria: ActionCriterion[], params: Record<string, unknown>): string[] {
  const failures: string[] = [];
  for (const c of criteria) {
    if (!checkPasses(c.check, params[c.param], c.value)) failures.push(c.message); // the declared message, unchanged
  }
  return failures;
}
