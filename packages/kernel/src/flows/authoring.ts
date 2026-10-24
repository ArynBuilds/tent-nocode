import type postgres from 'postgres';
import { flowDocSchema, FLOW_DOC_VERSION, type FlowDoc, type FlowItem } from '@nodeloom/core';
import { emitEvent } from '../events.js';
import { resolveFlowStepDef } from './registry.js';
import { getFlow, saveFlow, type FlowRow } from './store.js';

// Flow authoring doors: place, wire, unwire, remove. Every project authors into one working flow named 'main'.

export const MAIN_FLOW = 'main';
const ACTOR = 'user';

async function mainFlow(sql: postgres.Sql, orgId: string, projectId: string, by: string): Promise<FlowRow | { errors: string[] }> {
  const existing = await getFlow(sql, orgId, { projectId, name: MAIN_FLOW });
  if (existing !== null) return existing;
  const doc: FlowDoc = { version: FLOW_DOC_VERSION, steps: {}, edges: [] };
  const saved = await saveFlow(sql, { orgId, projectId, name: MAIN_FLOW, doc, by });
  if (!saved.ok) return { errors: saved.errors };
  const born = await getFlow(sql, orgId, { flowId: saved.flowId });
  return born ?? { errors: ['the flow could not be read back'] };
}

const isFlowRow = (v: FlowRow | { errors: string[] }): v is FlowRow => !('errors' in v);

async function writeDoc(
  sql: postgres.Sql, flow: FlowRow, doc: FlowDoc, orgId: string, by: string, event: string, payload: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; errors: string[] }> {
  const saved = await saveFlow(sql, { orgId, projectId: flow.project_id, name: flow.name, doc, by });
  if (!saved.ok) return saved;
  await emitEvent(sql, { orgId, actor: ACTOR, type: event, payload });
  return { ok: true };
}

// Place a step; ids mint kind-based (if, if-2, ...) and optional params land in the same write.
export async function placeFlowStep(
  sql: postgres.Sql,
  input: { orgId: string; projectId: string; kind: string; by: string; params?: Record<string, unknown> },
): Promise<{ ok: true; flowId: string; stepId: string } | { ok: false; errors: string[] }> {
  const def = resolveFlowStepDef(input.kind);
  if (def === null) return { ok: false, errors: [`no step kind '${input.kind}' on the shelf`] };
  const flow = await mainFlow(sql, input.orgId, input.projectId, input.by);
  if (!isFlowRow(flow)) return { ok: false, errors: flow.errors };
  const doc = flowDocSchema.parse(flow.doc);
  let stepId = input.kind;
  for (let n = 2; stepId in doc.steps; n += 1) stepId = `${input.kind}-${n}`;
  const next: FlowDoc = { ...doc, steps: { ...doc.steps, [stepId]: { kind: input.kind, params: input.params ?? {}, disabled: false } } };
  const res = await writeDoc(sql, flow, next, input.orgId, input.by, 'flow.step_placed', { flowId: flow.id, stepId, kind: input.kind, by: input.by });
  return res.ok ? { ok: true, flowId: flow.id, stepId } : res;
}

// Wire two steps; default port is the source's first output, default slot the first unfilled required slot.
export async function wireFlowSteps(
  sql: postgres.Sql,
  input: { orgId: string; flowId: string; from: string; to: string; port?: string; slot?: string; by: string },
): Promise<{ ok: true; port: string; slot: string } | { ok: false; errors: string[] }> {
  const flow = await getFlow(sql, input.orgId, { flowId: input.flowId });
  if (flow === null) return { ok: false, errors: ['that flow is gone'] };
  const doc = flowDocSchema.parse(flow.doc);
  const fromStep = doc.steps[input.from];
  const toStep = doc.steps[input.to];
  if (fromStep === undefined || toStep === undefined) return { ok: false, errors: ['that step is already gone'] };
  const fromDef = resolveFlowStepDef(fromStep.kind);
  const toDef = resolveFlowStepDef(toStep.kind);
  const port = input.port ?? (fromDef !== null && fromDef.outputs !== 'dynamic' ? fromDef.outputs[0] ?? 'out' : 'out');
  const required = toDef?.inputs.required ?? ['in'];
  const filled = new Set(doc.edges.filter((e) => e.to === input.to).map((e) => e.slot));
  const slot = input.slot ?? required.find((s) => !filled.has(s)) ?? required[0] ?? 'in';
  if (doc.edges.some((e) => e.from === input.from && e.to === input.to && e.port === port && e.slot === slot)) {
    return { ok: true, port, slot }; // the same wire twice lands nothing
  }
  const order = doc.edges.filter((e) => e.from === input.from && e.port === port).length;
  // A wire touches both endpoint steps.
  const stamp = new Date().toISOString();
  const steps = { ...doc.steps, [input.from]: { ...fromStep, touchedAt: stamp }, [input.to]: { ...toStep, touchedAt: stamp } };
  const next: FlowDoc = { ...doc, steps, edges: [...doc.edges, { from: input.from, port, to: input.to, slot, order }] };
  const res = await writeDoc(sql, flow, next, input.orgId, input.by, 'flow.wired', { flowId: flow.id, from: input.from, port, to: input.to, slot, by: input.by });
  return res.ok ? { ok: true, port, slot } : res;
}

// Remove exactly one edge by its {port, slot} address.
export async function unwireFlowSteps(
  sql: postgres.Sql,
  input: { orgId: string; flowId: string; from: string; to: string; port: string; slot: string; by: string },
): Promise<{ ok: true } | { ok: false; errors: string[] }> {
  const flow = await getFlow(sql, input.orgId, { flowId: input.flowId });
  if (flow === null) return { ok: false, errors: ['that flow is gone'] };
  const doc = flowDocSchema.parse(flow.doc);
  const edges = doc.edges.filter((e) => !(e.from === input.from && e.to === input.to && e.port === input.port && e.slot === input.slot));
  if (edges.length === doc.edges.length) return { ok: false, errors: ['that wire is already gone — the map catches up in a beat'] };
  // An unwire touches both endpoint steps too.
  const stamp = new Date().toISOString();
  const steps = { ...doc.steps };
  for (const id of [input.from, input.to]) {
    const s = steps[id];
    if (s !== undefined) steps[id] = { ...s, touchedAt: stamp };
  }
  return writeDoc(sql, flow, { ...doc, steps, edges }, input.orgId, input.by, 'flow.unwired', { flowId: flow.id, from: input.from, to: input.to, by: input.by });
}

// Remove a step; its wires leave with it.
export async function removeFlowStep(
  sql: postgres.Sql,
  input: { orgId: string; flowId: string; stepId: string; by: string },
): Promise<{ ok: true } | { ok: false; errors: string[] }> {
  const flow = await getFlow(sql, input.orgId, { flowId: input.flowId });
  if (flow === null) return { ok: false, errors: ['that flow is gone'] };
  const doc = flowDocSchema.parse(flow.doc);
  if (!(input.stepId in doc.steps)) return { ok: false, errors: ['that step is already gone'] };
  const steps = { ...doc.steps };
  delete steps[input.stepId];
  const edges = doc.edges.filter((e) => e.from !== input.stepId && e.to !== input.stepId);
  return writeDoc(sql, flow, { ...doc, steps, edges }, input.orgId, input.by, 'flow.step_removed', { flowId: flow.id, stepId: input.stepId, by: input.by });
}

// Merge new params into a step.
export async function setFlowStepParams(
  sql: postgres.Sql,
  input: { orgId: string; flowId: string; stepId: string; params: Record<string, unknown>; by: string },
): Promise<{ ok: true } | { ok: false; errors: string[] }> {
  const flow = await getFlow(sql, input.orgId, { flowId: input.flowId });
  if (flow === null) return { ok: false, errors: ['that flow is gone'] };
  const doc = flowDocSchema.parse(flow.doc);
  const step = doc.steps[input.stepId];
  if (step === undefined) return { ok: false, errors: ['that step is already gone'] };
  // A param write stamps the touched step.
  const next: FlowDoc = { ...doc, steps: { ...doc.steps, [input.stepId]: { ...step, params: { ...step.params, ...input.params }, touchedAt: new Date().toISOString() } } };
  return writeDoc(sql, flow, next, input.orgId, input.by, 'flow.step_params_set', { flowId: flow.id, stepId: input.stepId, by: input.by });
}

// Set or clear a step's pinned output; a manual run substitutes the pin for the real execution.
export async function setFlowStepPin(
  sql: postgres.Sql,
  input: { orgId: string; flowId: string; stepId: string; pinned: FlowItem[] | null; by: string },
): Promise<{ ok: true } | { ok: false; errors: string[] }> {
  const flow = await getFlow(sql, input.orgId, { flowId: input.flowId });
  if (flow === null) return { ok: false, errors: ['that flow is gone'] };
  const doc = flowDocSchema.parse(flow.doc);
  const step = doc.steps[input.stepId];
  if (step === undefined) return { ok: false, errors: ['that step is already gone'] };
  const next = { ...step };
  if (input.pinned === null) delete next.pinned;
  else next.pinned = input.pinned;
  return writeDoc(sql, flow, { ...doc, steps: { ...doc.steps, [input.stepId]: next } }, input.orgId, input.by, 'flow.step_pin_set', {
    flowId: flow.id, stepId: input.stepId, pinned: input.pinned !== null, by: input.by,
  });
}

// Flip a step's disabled field; disabled steps pass items through untouched.
export async function setFlowStepDisabled(
  sql: postgres.Sql,
  input: { orgId: string; flowId: string; stepId: string; disabled: boolean; by: string },
): Promise<{ ok: true } | { ok: false; errors: string[] }> {
  const flow = await getFlow(sql, input.orgId, { flowId: input.flowId });
  if (flow === null) return { ok: false, errors: ['that flow is gone'] };
  const doc = flowDocSchema.parse(flow.doc);
  const step = doc.steps[input.stepId];
  if (step === undefined) return { ok: false, errors: ['that step is already gone'] };
  const next: FlowDoc = { ...doc, steps: { ...doc.steps, [input.stepId]: { ...step, disabled: input.disabled } } };
  return writeDoc(sql, flow, next, input.orgId, input.by, 'flow.step_disabled_set', {
    flowId: flow.id, stepId: input.stepId, disabled: input.disabled, by: input.by,
  });
}
