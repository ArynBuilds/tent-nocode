import type postgres from 'postgres';
import {
  KEBAB_RE, flowDocSchema, sceneActionsSchema, type FlowDoc, type LsgEntry, type LsgEntryDraft,
} from '@nodeloom/core';
import { canonicalContentHash } from './packageVerify.js';
import { projectArm } from '../containment.js';
import { emitEvent } from '../events.js';
import { saveFlow } from '../flows/store.js';
import { TRIGGER_ACTIONS, TRIGGER_SPECS, type TriggerAction, type TriggerKind } from '../triggerSpecs.js';

// Flow and trigger travel for tproject@2 export/import; both mouths strip connections and endpoint tokens.

/** Pure: flow names a scene's start_flow rules reference (rule.flow ?? 'main'). */
export function startFlowRefsOf(actionsRaw: unknown): string[] {
  const names = new Set<string>();
  const actions = sceneActionsSchema.safeParse(actionsRaw ?? []);
  if (actions.success) {
    for (const action of actions.data) {
      for (const rule of action.rules) {
        if (rule.rule === 'start_flow') names.add(rule.flow ?? 'main');
      }
    }
  }
  return [...names].sort();
}

/** Re-validates the doc, then drops every call-integration step's connection value; runs at export and import. */
export function stripFlowDocForTravel(docRaw: unknown): { ok: true; doc: FlowDoc } | { ok: false; errors: string[] } {
  const parsed = flowDocSchema.safeParse(docRaw);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')} ${i.message}`) };
  }
  const steps: FlowDoc['steps'] = {};
  for (const [id, step] of Object.entries(parsed.data.steps)) {
    if (step.kind === 'call-integration' && 'connection' in step.params) {
      const { connection: _stripped, ...params } = step.params;
      steps[id] = { ...step, params };
    } else {
      steps[id] = step;
    }
  }
  return { ok: true, doc: { ...parsed.data, steps } };
}

/** Pure: table names a flow doc's get-rows/save-rows steps use; static string params only. */
export function flowTableRefsOf(doc: FlowDoc): string[] {
  const names = new Set<string>();
  for (const step of Object.values(doc.steps)) {
    if (step.kind !== 'get-rows' && step.kind !== 'save-rows') continue;
    const table = step.params['table'];
    if (typeof table === 'string' && KEBAB_RE.test(table)) names.add(table);
  }
  return [...names].sort();
}

/** Pure: tool names a flow doc's run-tool steps dispatch; static string params only. */
export function flowToolRefsOf(doc: FlowDoc): string[] {
  const names = new Set<string>();
  for (const step of Object.values(doc.steps)) {
    if (step.kind !== 'run-tool') continue;
    const tool = step.params['tool'];
    if (typeof tool === 'string' && KEBAB_RE.test(tool)) names.add(tool);
  }
  return [...names].sort();
}

/** Export half: resolve referenced flows and their start-flow triggers, pre-stripped; the tables and tools they name come back as refs. */
export async function collectTravelEntries(
  sql: postgres.Sql,
  input: { orgId: string; projectId: string | null; flowNames: string[] },
): Promise<{ entries: LsgEntryDraft[]; tableRefs: string[]; toolRefs: string[]; errors: string[] }> {
  const entries: LsgEntryDraft[] = [];
  const errors: string[] = [];
  const landedFlows = new Set<string>();
  const tableRefs = new Set<string>();
  const toolRefs = new Set<string>();
  for (const name of input.flowNames) {
    const [flow] = await sql<{ doc: unknown }[]>`
      select doc from flows
      where org_id = ${input.orgId} and ${projectArm(sql, input.projectId)} and name = ${name} and deleted_at is null`;
    if (!flow) { errors.push(`flow ${name}: not found in this project - a start-a-flow button names it`); continue; }
    const stripped = stripFlowDocForTravel(flow.doc);
    if (!stripped.ok) { errors.push(`flow ${name}: ${stripped.errors.join(' · ')}`); continue; }
    landedFlows.add(name);
    entries.push({ kind: 'flow', name, role: 'hard', doc: stripped.doc as unknown as Record<string, unknown> });
    for (const table of flowTableRefsOf(stripped.doc)) tableRefs.add(table);
    for (const tool of flowToolRefsOf(stripped.doc)) toolRefs.add(tool);
  }
  if (landedFlows.size > 0) {
    const rows = await sql<Array<{ kind: string; spec: Record<string, unknown>; action: Record<string, unknown> }>>`
      select kind, spec, action from triggers
      where org_id = ${input.orgId} and ${projectArm(sql, input.projectId)} and revoked_at is null
        and action->>'type' = 'start_flow'
      order by created_at asc, id asc`;
    const used = new Map<string, number>();
    for (const t of rows) {
      const flowName = typeof t.action['flow'] === 'string' ? (t.action['flow'] as string) : 'main';
      if (!landedFlows.has(flowName)) continue;
      // the endpoint token never travels
      const { endpoint: _token, ...spec } = t.spec as Record<string, unknown> & { endpoint?: unknown };
      const base = `${flowName}-${t.kind}`;
      const n = (used.get(base) ?? 0) + 1;
      used.set(base, n);
      entries.push({ kind: 'trigger', name: n === 1 ? base : `${base}-${n}`, role: 'soft', triggerKind: t.kind, spec, action: t.action });
    }
  }
  return { entries, tableRefs: [...tableRefs].sort(), toolRefs: [...toolRefs].sort(), errors };
}

export interface TravelFlowToLand { name: string; doc: FlowDoc }
export interface TravelTriggerToLand { entryName: string; kind: TriggerKind; spec: Record<string, unknown>; action: TriggerAction }

/** Import stage 1: validate every flow/trigger entry with zero writes; collisions follow onCollision. */
export async function validateTravelEntries(
  sql: postgres.Sql,
  input: {
    orgId: string; projectId: string | null; entries: LsgEntry[];
    onCollision: 'refuse' | 'skip-existing' | 'copy-rename'; copySuffix: string;
    /** True when a landing project is resolved or freshly born. */
    projectAssured: boolean;
  },
): Promise<{
  flows: TravelFlowToLand[]; triggers: TravelTriggerToLand[];
  errors: string[]; skipped: string[]; renamed: Array<{ kind: 'flow'; from: string; to: string }>;
  flowRenames: Map<string, string>;
}> {
  const flows: TravelFlowToLand[] = [];
  const triggers: TravelTriggerToLand[] = [];
  const errors: string[] = [];
  const skipped: string[] = [];
  const renamed: Array<{ kind: 'flow'; from: string; to: string }> = [];
  const flowRenames = new Map<string, string>();
  for (const entry of input.entries) {
    if (entry.kind !== 'flow') continue;
    if (!input.projectAssured) { errors.push(`flow ${entry.name}: flows are project citizens - the import needs a project home`); continue; }
    if (!KEBAB_RE.test(entry.name)) { errors.push(`flow ${entry.name}: not a kebab-case flow name`); continue; }
    // re-validate and re-strip whatever door the file arrived by
    const stripped = stripFlowDocForTravel(entry.doc);
    if (!stripped.ok) { errors.push(`flow ${entry.name}: ${stripped.errors.join(' · ')}`); continue; }
    let landName = entry.name;
    if (input.projectId !== null) {
      const [existing] = await sql<{ doc: unknown }[]>`
        select doc from flows
        where org_id = ${input.orgId} and project_id = ${input.projectId} and name = ${entry.name} and deleted_at is null`;
      if (existing) {
        // compare stripped so re-importing your own export never unbinds local connections
        const ours = stripFlowDocForTravel(existing.doc);
        if (ours.ok && canonicalContentHash({ doc: ours.doc }) === canonicalContentHash({ doc: stripped.doc })) continue;
        if (input.onCollision === 'skip-existing') { skipped.push(`flow ${entry.name} (local kept)`); continue; }
        if (input.onCollision === 'copy-rename') {
          landName = `${entry.name}${input.copySuffix}`;
          const [copy] = await sql<{ id: string }[]>`
            select id from flows
            where org_id = ${input.orgId} and project_id = ${input.projectId} and name = ${landName} and deleted_at is null`;
          if (copy) { errors.push(`flow ${entry.name}: the renamed copy ${landName} already exists locally - import never overwrites it`); continue; }
          flowRenames.set(entry.name, landName);
          renamed.push({ kind: 'flow', from: entry.name, to: landName });
        } else {
          errors.push(`flow ${entry.name}: exists locally with different steps - rename the local flow, or import with onCollision 'copy-rename' (import never overwrites local work)`);
          continue;
        }
      }
    }
    flows.push({ name: landName, doc: stripped.doc });
  }
  for (const entry of input.entries) {
    if (entry.kind !== 'trigger') continue;
    if (!input.projectAssured) { errors.push(`trigger ${entry.name}: triggers are project citizens - the import needs a project home`); continue; }
    const kind = entry.triggerKind as TriggerKind;
    const kindSchema = TRIGGER_SPECS[kind];
    if (kindSchema === undefined) { errors.push(`trigger ${entry.name}: unknown trigger kind '${entry.triggerKind}'`); continue; }
    const action = TRIGGER_ACTIONS.safeParse(entry.action);
    if (!action.success) { errors.push(`trigger ${entry.name}: its action does not parse`); continue; }
    // only start-a-flow triggers travel; other actions carry reach and stay home
    if (action.data.type !== 'start_flow') { errors.push(`trigger ${entry.name}: only start-a-flow Watchers travel - a '${action.data.type}' action stays home`); continue; }
    // a foreign endpoint token never lands; a placeholder plugs the hole for validation
    const { endpoint: _foreignToken, ...spec } = entry.spec as Record<string, unknown> & { endpoint?: unknown };
    const specForCheck = kind === 'webhook_in' ? { ...spec, endpoint: 'travel-stripped' } : spec;
    const parsedSpec = kindSchema.safeParse(specForCheck);
    if (!parsedSpec.success) { errors.push(`trigger ${entry.name}: its spec does not parse for kind '${kind}'`); continue; }
    const landSpec = { ...(parsedSpec.data as Record<string, unknown>) };
    if (kind === 'webhook_in') delete landSpec['endpoint'];
    const flowName = flowRenames.get(action.data.flow) ?? action.data.flow;
    triggers.push({ entryName: entry.name, kind, spec: landSpec, action: { ...action.data, flow: flowName } });
  }
  return { flows, triggers, errors, skipped, renamed, flowRenames };
}

/** Import stage 2: flows land through saveFlow, triggers land disabled and endpoint-free; each landing pushes an undo. */
export async function landTravelEntries(
  sql: postgres.Sql,
  input: {
    orgId: string; projectId: string | null; createdBy: string;
    flows: TravelFlowToLand[]; triggers: TravelTriggerToLand[];
    compensations: Array<() => Promise<void>>;
  },
): Promise<{ flows: string[]; triggers: string[] }> {
  const landedFlows: string[] = [];
  const landedTriggers: string[] = [];
  if (input.projectId === null) {
    if (input.flows.length > 0 || input.triggers.length > 0) {
      throw new Error('flows are project citizens - no landing project resolved');
    }
    return { flows: [], triggers: [] };
  }
  const projectId = input.projectId;
  for (const f of input.flows) {
    const saved = await saveFlow(sql, { orgId: input.orgId, projectId, name: f.name, doc: f.doc, by: input.createdBy });
    if (!saved.ok) throw new Error(`flow ${f.name}: ${saved.errors.join(' · ')}`);
    const flowId = saved.flowId;
    input.compensations.push(async () => { await sql`delete from flows where id = ${flowId}`; });
    landedFlows.push(f.name);
  }
  for (const t of input.triggers) {
    const [row] = await sql<{ id: string }[]>`
      insert into triggers (org_id, project_id, kind, spec, action, enabled, created_by)
      values (${input.orgId}, ${projectId}, ${t.kind}, ${sql.json(t.spec as unknown as postgres.JSONValue)},
              ${sql.json(t.action as unknown as postgres.JSONValue)}, false, ${input.createdBy})
      returning id`;
    if (!row) throw new Error(`trigger ${t.entryName}: could not land`);
    const triggerId = row.id;
    input.compensations.push(async () => { await sql`delete from triggers where id = ${triggerId}`; });
    await emitEvent(sql, {
      orgId: input.orgId, actor: 'kernel.scenes', type: 'trigger.created',
      payload: { triggerId, kind: t.kind, spec: t.spec, actionType: t.action.type, imported: true, enabled: false },
    });
    landedTriggers.push(t.entryName);
  }
  return { flows: landedFlows, triggers: landedTriggers };
}
