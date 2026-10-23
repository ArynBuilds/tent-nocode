import { z } from 'zod';
import type postgres from 'postgres';
import type { ActionSpec } from '../chat/actions.js';
import { resolveProject } from '../containment.js';
import { resolveFlowStepDef, listFlowStepDefs } from './registry.js';
import { checkStepParams } from './validate.js';
import { getFlow } from './store.js';
import {
  MAIN_FLOW, placeFlowStep, removeFlowStep, setFlowStepDisabled, setFlowStepParams,
  unwireFlowSteps, wireFlowSteps,
} from './authoring.js';

// Governed flow-authoring verbs: thin rows over the one authoring door; the registry is the truth at the gate.

type Params = z.ZodType<Record<string, unknown>, z.ZodTypeDef, unknown>;

/** Refuses an unknown step kind naming the real shelf. */
function requireDef(kind: string) {
  const def = resolveFlowStepDef(kind);
  if (def === null) {
    const shelf = listFlowStepDefs().map((d) => d.kind).join(', ');
    throw new Error(`no step kind '${kind}' - the shelf: ${shelf}`);
  }
  return def;
}

/** Refuses ill-declared params naming the step's real ones. */
function requireParams(kind: string, params: Record<string, unknown> | undefined): void {
  if (params === undefined) return;
  const errors = checkStepParams(requireDef(kind), params);
  if (errors.length > 0) throw new Error(errors.join('; '));
}

async function projectOf(sql: postgres.Sql, ctx: { orgId: string; threadId: string }): Promise<string> {
  const projectId = await resolveProject(sql, { orgId: ctx.orgId, threadId: ctx.threadId });
  if (projectId === null || projectId === undefined) throw new Error('this thread has no project - flows live inside a project');
  return projectId;
}

/** The project's one working flow; refuses when it does not exist yet. */
async function mainFlowId(sql: postgres.Sql, orgId: string, projectId: string): Promise<string> {
  const flow = await getFlow(sql, orgId, { projectId, name: MAIN_FLOW });
  if (flow === null) throw new Error('this project has no flow yet - place a step first');
  return flow.id;
}

export const FLOW_ACTIONS: Record<string, ActionSpec> = {
  // Place one step on the project's working flow; params land in the same write.
  flows_place_step: {
    name: 'flows_place_step',
    escalationKind: 'flows_place_step',
    lands: 'the step lands on the working flow of the project; unknown kinds and params refuse naming the real ones',
    route: { kind: 'flow-step', verb: 'exists' },
    paramsSchema: z.object({
      stepKind: z.string().min(1),
      params: z.record(z.string(), z.unknown()).optional(),
    }).strict() as unknown as Params,
    async execute(sql, ctx, params): Promise<void> {
      const p = params as { stepKind: string; params?: Record<string, unknown> };
      requireParams(p.stepKind, p.params);
      const projectId = await projectOf(sql, ctx);
      const placed = await placeFlowStep(sql, {
        orgId: ctx.orgId, projectId, kind: p.stepKind, by: ctx.createdBy,
        ...(p.params !== undefined ? { params: p.params } : {}),
      });
      if (!placed.ok) throw new Error(placed.errors.join('; '));
    },
  },
  // Wire two placed steps; port defaults to the source's first output, slot to the first unfilled required one.
  flows_wire_steps: {
    name: 'flows_wire_steps',
    escalationKind: 'flows_wire_steps',
    lands: 'the wire lands with defaulted port and slot; the same wire twice lands nothing',
    route: { kind: 'flow-step', verb: 'connect' },
    paramsSchema: z.object({
      from: z.string().min(1),
      to: z.string().min(1),
      port: z.string().min(1).optional(),
      slot: z.string().min(1).optional(),
    }).strict() as unknown as Params,
    async execute(sql, ctx, params): Promise<void> {
      const p = params as { from: string; to: string; port?: string; slot?: string };
      const projectId = await projectOf(sql, ctx);
      const flowId = await mainFlowId(sql, ctx.orgId, projectId);
      const wired = await wireFlowSteps(sql, {
        orgId: ctx.orgId, flowId, from: p.from, to: p.to, by: ctx.createdBy,
        ...(p.port !== undefined ? { port: p.port } : {}), ...(p.slot !== undefined ? { slot: p.slot } : {}),
      });
      if (!wired.ok) throw new Error(wired.errors.join('; '));
    },
  },
  // Remove exactly one wire by its full address.
  flows_unwire_steps: {
    name: 'flows_unwire_steps',
    escalationKind: 'flows_unwire_steps',
    lands: 'exactly the addressed wire is removed',
    route: { kind: 'flow-step', verb: 'connect' },
    paramsSchema: z.object({
      from: z.string().min(1),
      to: z.string().min(1),
      port: z.string().min(1),
      slot: z.string().min(1),
    }).strict() as unknown as Params,
    async execute(sql, ctx, params): Promise<void> {
      const p = params as { from: string; to: string; port: string; slot: string };
      const projectId = await projectOf(sql, ctx);
      const flowId = await mainFlowId(sql, ctx.orgId, projectId);
      const res = await unwireFlowSteps(sql, { orgId: ctx.orgId, flowId, from: p.from, to: p.to, port: p.port, slot: p.slot, by: ctx.createdBy });
      if (!res.ok) throw new Error(res.errors.join('; '));
    },
  },
  // Merge params into a placed step; unknown names refuse naming the real ones.
  flows_set_step_params: {
    name: 'flows_set_step_params',
    escalationKind: 'flows_set_step_params',
    lands: 'the params merge into the placed step; unknown names refuse naming the real ones',
    route: { kind: 'flow-step', verb: 'configure' },
    paramsSchema: z.object({
      stepId: z.string().min(1),
      params: z.record(z.string(), z.unknown()),
    }).strict() as unknown as Params,
    async execute(sql, ctx, params): Promise<void> {
      const p = params as { stepId: string; params: Record<string, unknown> };
      const projectId = await projectOf(sql, ctx);
      const flowId = await mainFlowId(sql, ctx.orgId, projectId);
      const flow = await getFlow(sql, ctx.orgId, { flowId });
      const doc = flow?.doc as { steps?: Record<string, { kind?: string }> } | undefined;
      const kind = doc?.steps?.[p.stepId]?.kind;
      if (typeof kind !== 'string') throw new Error(`no step '${p.stepId}' on the flow`);
      requireParams(kind, p.params);
      const res = await setFlowStepParams(sql, { orgId: ctx.orgId, flowId, stepId: p.stepId, params: p.params, by: ctx.createdBy });
      if (!res.ok) throw new Error(res.errors.join('; '));
    },
  },
  // Remove a step; its wires leave with it.
  flows_remove_step: {
    name: 'flows_remove_step',
    escalationKind: 'flows_remove_step',
    lands: 'the step and its wires leave together',
    route: { kind: 'flow-step', verb: 'exists' },
    paramsSchema: z.object({ stepId: z.string().min(1) }).strict() as unknown as Params,
    async execute(sql, ctx, params): Promise<void> {
      const p = params as { stepId: string };
      const projectId = await projectOf(sql, ctx);
      const flowId = await mainFlowId(sql, ctx.orgId, projectId);
      const res = await removeFlowStep(sql, { orgId: ctx.orgId, flowId, stepId: p.stepId, by: ctx.createdBy });
      if (!res.ok) throw new Error(res.errors.join('; '));
    },
  },
  // Switch a step off or on; a disabled step passes items through untouched.
  flows_toggle_step: {
    name: 'flows_toggle_step',
    escalationKind: 'flows_toggle_step',
    lands: 'the step switches off or on; a disabled step passes rows through untouched',
    route: { kind: 'flow-step', verb: 'configure' },
    paramsSchema: z.object({ stepId: z.string().min(1), disabled: z.boolean() }).strict() as unknown as Params,
    async execute(sql, ctx, params): Promise<void> {
      const p = params as { stepId: string; disabled: boolean };
      const projectId = await projectOf(sql, ctx);
      const flowId = await mainFlowId(sql, ctx.orgId, projectId);
      const res = await setFlowStepDisabled(sql, { orgId: ctx.orgId, flowId, stepId: p.stepId, disabled: p.disabled, by: ctx.createdBy });
      if (!res.ok) throw new Error(res.errors.join('; '));
    },
  },
};
