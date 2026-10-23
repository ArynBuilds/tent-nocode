import { flowDocSchema, flowEnvelopeSchema, flowItemSchema, planPartialRun } from '@tent-nocode/core';
import { z } from 'zod';
import { assertOwnOrg, read, router, write } from './registry.js';
import { getSceneActionExecutionResult } from '../integrations/dispatch.js';
import { listFlowStepDefs } from '../flows/registry.js';
import { getFlow, getSceneActionFlowResult, listFlows, startFlowExecution } from '../flows/store.js';
import { placeFlowStep, removeFlowStep, setFlowStepDisabled, setFlowStepParams, setFlowStepPin, unwireFlowSteps, wireFlowSteps, MAIN_FLOW } from '../flows/authoring.js';

/**
 * THE FLOW PROCEDURES - the workspace wall's mouths for the flow machinery:
 * the step-kind shelf (THE ONE projection every creation surface renders -
 * placeables' steps arm reads THIS), the authoring doors (place · wire ·
 * unwire · remove · params), the manual-test start, and the run reads.
 */

const orgId = z.string();

export const flowsRouter = router({
  /** THE STEP SHELF projection - kind + plain words + the param surface (the
   * browser/palette/+Add render from this one shape; a private copy is the bug). */
  flowStepCatalog: read([], async () => listFlowStepDefs().map((d) => ({
    kind: d.kind,
    displayName: d.displayName,
    blurb: d.blurb,
    outputs: d.outputs === 'dynamic' ? [] : d.outputs,
    inputs: d.inputs,
    params: Object.entries(d.params).map(([name, p]) => ({
      name, type: p.type,
      required: p.required === true,
      pill: p.pill === true,
      ...(p.choices !== undefined ? { choices: p.choices } : {}),
      ...(p.help !== undefined ? { help: p.help } : {}),
      ...(p.showWhen !== undefined ? { showWhen: p.showWhen } : {}),
      ...(p.hint !== undefined ? { hint: p.hint } : {}),
    })),
    ...(d.guidance !== undefined ? { guidance: d.guidance } : {}),
    ...(d.examples !== undefined ? { examples: d.examples } : {}),
  }))),

  flowsList: read([orgId, z.string().optional()], async (ctx, org, projectId) => {
    assertOwnOrg(ctx.identity, org);
    const rows = await listFlows(ctx.sql, ctx.identity.orgId, projectId);
    return rows.map((f) => ({ id: f.id, name: f.name, projectId: f.project_id, enabled: f.enabled, doc: f.doc }));
  }),

  // Optional initial params: the door rows place preconfigured steps.
  flowsPlaceStep: write([orgId, z.string(), z.string(), z.record(z.unknown()).optional()], async (ctx, org, projectId, kind, params) => {
    assertOwnOrg(ctx.identity, org);
    const res = await placeFlowStep(ctx.sql, {
      orgId: ctx.identity.orgId, projectId, kind, by: ctx.identity.userId,
      ...(params !== undefined ? { params } : {}),
    });
    if (!res.ok) throw new Error(res.errors.join('; '));
    return { flowId: res.flowId, stepId: res.stepId };
  }),

  flowsWireSteps: write(
    [orgId, z.string(), z.string(), z.string(), z.object({ port: z.string().optional(), slot: z.string().optional() }).optional()],
    async (ctx, org, flowId, from, to, opts) => {
      assertOwnOrg(ctx.identity, org);
      const res = await wireFlowSteps(ctx.sql, {
        orgId: ctx.identity.orgId, flowId, from, to,
        ...(opts?.port !== undefined ? { port: opts.port } : {}),
        ...(opts?.slot !== undefined ? { slot: opts.slot } : {}),
        by: ctx.identity.userId,
      });
      if (!res.ok) throw new Error(res.errors.join('; '));
      return { port: res.port, slot: res.slot };
    },
  ),

  flowsUnwireSteps: write([orgId, z.string(), z.string(), z.string(), z.string(), z.string()], async (ctx, org, flowId, from, to, port, slot) => {
    assertOwnOrg(ctx.identity, org);
    const res = await unwireFlowSteps(ctx.sql, { orgId: ctx.identity.orgId, flowId, from, to, port, slot, by: ctx.identity.userId });
    if (!res.ok) throw new Error(res.errors.join('; '));
    return undefined;
  }),

  flowsRemoveStep: write([orgId, z.string(), z.string()], async (ctx, org, flowId, stepId) => {
    assertOwnOrg(ctx.identity, org);
    const res = await removeFlowStep(ctx.sql, { orgId: ctx.identity.orgId, flowId, stepId, by: ctx.identity.userId });
    if (!res.ok) throw new Error(res.errors.join('; '));
    return undefined;
  }),

  /** THE PIN: set or clear a step's pinned output (null clears); item shape + the 50 cap validate through saveFlow's one doc parse. */
  flowsPinStep: write([orgId, z.string(), z.string(), z.array(flowItemSchema).nullable()], async (ctx, org, flowId, stepId, pinned) => {
    assertOwnOrg(ctx.identity, org);
    const res = await setFlowStepPin(ctx.sql, { orgId: ctx.identity.orgId, flowId, stepId, pinned, by: ctx.identity.userId });
    if (!res.ok) throw new Error(res.errors.join('; '));
    return undefined;
  }),

  /** The step's Switch off / on - the one honest flip (authoring door). */
  flowsSetStepDisabled: write([orgId, z.string(), z.string(), z.boolean()], async (ctx, org, flowId, stepId, disabled) => {
    assertOwnOrg(ctx.identity, org);
    const res = await setFlowStepDisabled(ctx.sql, { orgId: ctx.identity.orgId, flowId, stepId, disabled, by: ctx.identity.userId });
    if (!res.ok) throw new Error(res.errors.join('; '));
    return undefined;
  }),

  flowsSetStepParams: write([orgId, z.string(), z.string(), z.record(z.unknown())], async (ctx, org, flowId, stepId, params) => {
    assertOwnOrg(ctx.identity, org);
    const res = await setFlowStepParams(ctx.sql, { orgId: ctx.identity.orgId, flowId, stepId, params, by: ctx.identity.userId });
    if (!res.ok) throw new Error(res.errors.join('; '));
    return undefined;
  }),

  /** The manual-test start - one run, entry-scoped when named; the sweeper executes it. */
  flowsStart: write(
    [orgId, z.union([z.string(), z.object({ projectId: z.string() })]),
      z.object({ entry: z.string().optional(), trigger: z.record(z.unknown()).optional(), step: z.string().optional() }).optional()],
    async (ctx, org, flowRef, optsIn) => {
      assertOwnOrg(ctx.identity, org);
      const opts = optsIn ?? {};
      const flow = typeof flowRef === 'string' ? await getFlow(ctx.sql, ctx.identity.orgId, { flowId: flowRef }) : null;
      const home = flow ?? (typeof flowRef === 'object'
        ? await getFlow(ctx.sql, ctx.identity.orgId, { projectId: flowRef.projectId, name: MAIN_FLOW })
        : null);
      if (home === null) return { ok: false as const, refusal: 'that flow is gone' };
      // THE PARTIAL RUN: Test one step - plan against the LATEST execution (any status): boundaries seed
      // (pinned beats prior), steps touched AFTER that run re-run (the dirty trim), the target answers fresh.
      if (opts.step !== undefined) {
        const doc = flowDocSchema.parse(home.doc);
        if (!(opts.step in doc.steps)) return { ok: false as const, refusal: `no step '${opts.step}' in '${home.name}'` };
        const trigger = opts.trigger ?? { kind: 'manual', by: ctx.identity.userId, step: opts.step };
        const [last] = await ctx.sql<Array<{ envelope: unknown; created_at: Date }>>`
          select envelope, created_at from flow_executions
          where org_id = ${ctx.identity.orgId} and flow_id = ${home.id}
          order by created_at desc, id desc limit 1`;
        const env = last !== undefined ? flowEnvelopeSchema.safeParse(last.envelope) : null;
        let prior = env !== null && env.success ? env.data.results : null;
        if (prior !== null && last !== undefined) {
          const runIso = last.created_at instanceof Date ? last.created_at.toISOString() : String(last.created_at);
          prior = Object.fromEntries(Object.entries(prior).filter(([id]) => {
            const t = doc.steps[id]?.touchedAt;
            return !(typeof t === 'string' && t > runIso);
          }));
        }
        const plan = planPartialRun(doc, opts.step, prior, trigger);
        return startFlowExecution(ctx.sql, { orgId: ctx.identity.orgId, flowId: home.id, trigger, seed: plan });
      }
      return startFlowExecution(ctx.sql, {
        orgId: ctx.identity.orgId, flowId: home.id,
        trigger: opts.trigger ?? { kind: 'manual', by: ctx.identity.userId },
        ...(opts.entry !== undefined ? { entry: opts.entry } : {}),
      });
    },
  ),

  /** The run reads - status + the honest envelope. */
  flowsExecutions: read([orgId, z.string().optional(), z.number().optional()], async (ctx, org, projectId, limitIn) => {
    assertOwnOrg(ctx.identity, org);
    const limit = limitIn !== undefined ? Math.min(limitIn, 50) : 20;
    const rows = projectId !== undefined
      ? await ctx.sql<Array<{ id: string; flow_id: string; status: string; error: string | null; steps_run: number; created_at: Date; finished_at: Date | null }>>`
        select id, flow_id, status, error, steps_run, created_at, finished_at from flow_executions
        where org_id = ${ctx.identity.orgId} and project_id = ${projectId} order by created_at desc limit ${limit}`
      : await ctx.sql<Array<{ id: string; flow_id: string; status: string; error: string | null; steps_run: number; created_at: Date; finished_at: Date | null }>>`
        select id, flow_id, status, error, steps_run, created_at, finished_at from flow_executions
        where org_id = ${ctx.identity.orgId} order by created_at desc limit ${limit}`;
    return rows.map((r) => ({
      id: r.id, flowId: r.flow_id, status: r.status, error: r.error, stepsRun: r.steps_run,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      finishedAt: r.finished_at instanceof Date ? r.finished_at.toISOString() : null,
    }));
  }),

  /** THE EFFECT-PARITY READ: the preview polls the result of a start_flow fire its own scene action queued -
   * the integration lane answers first, a miss FALLS THROUGH to the flow lane (disjoint uuid spaces) and a
   * flow answer carries the run's recorded EFFECTS. Both reads scope to scene_action provenance on the named scene. */
  sceneActionResult: read([orgId, z.string(), z.string()], async (ctx, org, sceneSlug, executionId) => {
    assertOwnOrg(ctx.identity, org);
    const input = { orgId: ctx.identity.orgId, sceneSlug, executionId };
    const integration = await getSceneActionExecutionResult(ctx.sql, input);
    if (integration !== null) return integration;
    return getSceneActionFlowResult(ctx.sql, input);
  }),

  /** THE CONFIG CARD's strip: the items ARRIVING at one step from the latest run - field names + a few
   * sample items, read on demand when the card opens. An entry step answers the trigger item; no run answers empty. */
  flowsStepInputSample: read([orgId, z.string(), z.string(), z.number().optional()], async (ctx, org, flowId, stepId, limit) => {
    assertOwnOrg(ctx.identity, org);
    const cap = limit !== undefined ? Math.min(Math.max(1, limit), 10) : 5;
    const flow = await getFlow(ctx.sql, ctx.identity.orgId, { flowId });
    if (flow === null) return { fields: [], items: [], at: null };
    const doc = flowDocSchema.safeParse(flow.doc);
    if (!doc.success || !(stepId in doc.data.steps)) return { fields: [], items: [], at: null };
    const [last] = await ctx.sql<Array<{ envelope: unknown; created_at: Date }>>`
      select envelope, created_at from flow_executions
      where org_id = ${ctx.identity.orgId} and flow_id = ${flowId}
      order by created_at desc, id desc limit 1`;
    const env = last !== undefined ? flowEnvelopeSchema.safeParse(last.envelope) : null;
    if (env === null || !env.success) return { fields: [], items: [], at: null };
    const incoming = doc.data.edges.filter((e) => e.to === stepId).sort((a, b) => a.order - b.order);
    const items: Array<Record<string, unknown>> = [];
    if (incoming.length === 0) {
      if (Object.keys(env.data.trigger).length > 0) items.push(env.data.trigger);
    } else {
      for (const e of incoming) {
        for (const item of env.data.results[e.from]?.[e.port] ?? []) {
          if (items.length >= cap) break;
          items.push(item.json);
        }
      }
    }
    const fields: string[] = [];
    for (const it of items) {
      for (const k of Object.keys(it)) if (!fields.includes(k)) fields.push(k);
    }
    return {
      fields: fields.slice(0, 20), items: items.slice(0, cap),
      at: last!.created_at instanceof Date ? last!.created_at.toISOString() : String(last!.created_at),
    };
  }),

  /** THE RUN-READ FOOD - the latest execution per flow in the project, as COUNTS only (badge/edge words
   * render from this; item arrays NEVER cross to the renderer). A row that fails to parse is skipped honestly. */
  flowsLastRun: read([orgId, z.string()], async (ctx, org, projectId) => {
    assertOwnOrg(ctx.identity, org);
    const rows = await ctx.sql<Array<{ id: string; flow_id: string; status: string; error: string | null; envelope: unknown; created_at: Date }>>`
      select distinct on (flow_id) id, flow_id, status, error, envelope, created_at
      from flow_executions
      where org_id = ${ctx.identity.orgId} and project_id = ${projectId}
      order by flow_id, created_at desc, id desc`;
    const out: Array<{
      flowId: string; executionId: string; status: string; error: string | null; createdAt: string;
      ran: string[]; stepCounts: Record<string, Record<string, number>>;
    }> = [];
    for (const r of rows) {
      const env = flowEnvelopeSchema.safeParse(r.envelope);
      if (!env.success) continue;
      const stepCounts: Record<string, Record<string, number>> = {};
      for (const [step, ports] of Object.entries(env.data.results)) {
        stepCounts[step] = Object.fromEntries(Object.entries(ports).map(([port, items]) => [port, items.length]));
      }
      out.push({
        flowId: r.flow_id, executionId: r.id, status: r.status, error: r.error,
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
        ran: env.data.ran, stepCounts,
      });
    }
    return out;
  }),
});
