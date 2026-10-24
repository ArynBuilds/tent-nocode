import { isPill } from '@nodeloom/core';
import type { FlowDoc } from '@nodeloom/core';
import { resolveFlowStepDef } from './registry.js';
import type { FlowStepDef, FlowStepParamDecl } from './stepTypes.js';

// The flow validator: one programmatic battery over a flow doc; findings name the fix.

export interface FlowFinding {
  level: 'error' | 'note';
  stepId?: string;
  message: string;
}

/** Checks one provided param value against its declaration; null = fine. */
function checkParamValue(name: string, decl: FlowStepParamDecl, value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (isPill(value)) return decl.pill === true || decl.type === 'string' || decl.type === 'json' ? null : `'${name}' does not take a pill`;
  if (decl.type === 'enum') {
    if (typeof value !== 'string' || (decl.choices !== undefined && !decl.choices.includes(value))) {
      return `'${name}' must be one of: ${(decl.choices ?? []).join(', ')}`;
    }
    return null;
  }
  if (decl.type === 'number' && typeof value !== 'number') return `'${name}' takes a number`;
  if (decl.type === 'boolean' && typeof value !== 'boolean') return `'${name}' takes yes/no`;
  if (decl.type === 'string' && typeof value !== 'string') return `'${name}' takes text`;
  if (decl.type === 'json' && (typeof value !== 'object' || Array.isArray(value))) return `'${name}' takes an object map`;
  return null;
}

/** Refuses unknown or ill-typed params, naming the step's real params. */
export function checkStepParams(def: FlowStepDef, params: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const real = Object.keys(def.params);
  for (const [name, value] of Object.entries(params)) {
    const decl = def.params[name];
    if (decl === undefined) {
      errors.push(`'${def.kind}' has no param '${name}' - its params are: ${real.join(', ') || 'none'}`);
      continue;
    }
    const bad = checkParamValue(name, decl, value);
    if (bad !== null) errors.push(bad);
  }
  return errors;
}

/** Validates a whole flow doc; `tables` (when given) checks table params against the real shelf. */
export function validateFlowDoc(doc: FlowDoc, opts?: { tables?: ReadonlySet<string> }): FlowFinding[] {
  const findings: FlowFinding[] = [];
  const stepIds = Object.keys(doc.steps);
  if (stepIds.length === 0) return [{ level: 'note', message: 'the flow is empty' }];

  for (const [stepId, step] of Object.entries(doc.steps)) {
    const def = resolveFlowStepDef(step.kind);
    if (def === null) {
      findings.push({ level: 'error', stepId, message: `no step kind '${step.kind}' on the shelf` });
      continue;
    }
    for (const e of checkStepParams(def, step.params ?? {})) findings.push({ level: 'error', stepId, message: e });
    for (const [name, decl] of Object.entries(def.params)) {
      const v = (step.params ?? {})[name];
      if (decl.required === true && (v === undefined || v === '')) {
        findings.push({ level: 'error', stepId, message: `required param '${name}' is not set` });
      }
    }
    if (opts?.tables !== undefined) {
      const table = (step.params ?? {})['table'];
      if (typeof table === 'string' && table !== '' && !opts.tables.has(table)) {
        findings.push({ level: 'error', stepId, message: `no table named '${table}' in this project` });
      }
    }
  }

  const incoming = new Map<string, Set<string>>();
  for (const edge of doc.edges) {
    const fromStep = doc.steps[edge.from];
    const toStep = doc.steps[edge.to];
    if (fromStep === undefined) { findings.push({ level: 'error', message: `a wire leaves a gone step '${edge.from}'` }); continue; }
    if (toStep === undefined) { findings.push({ level: 'error', message: `a wire lands on a gone step '${edge.to}'` }); continue; }
    const fromDef = resolveFlowStepDef(fromStep.kind);
    if (fromDef !== null && fromDef.outputs !== 'dynamic' && !fromDef.outputs.includes(edge.port)) {
      findings.push({ level: 'error', stepId: edge.from, message: `'${fromStep.kind}' has no output '${edge.port}' - its outputs are: ${fromDef.outputs.join(', ')}` });
    }
    const toDef = resolveFlowStepDef(toStep.kind);
    if (toDef !== null && !toDef.inputs.slots.includes(edge.slot)) {
      findings.push({ level: 'error', stepId: edge.to, message: `'${toStep.kind}' has no input slot '${edge.slot}' - its slots are: ${toDef.inputs.slots.join(', ')}` });
    }
    (incoming.get(edge.to) ?? incoming.set(edge.to, new Set()).get(edge.to)!).add(edge.slot);
  }

  for (const [stepId, step] of Object.entries(doc.steps)) {
    const def = resolveFlowStepDef(step.kind);
    if (def === null) continue;
    const filled = incoming.get(stepId) ?? new Set<string>();
    if (filled.size === 0) {
      findings.push({ level: 'note', stepId, message: 'no incoming wire - fine only when a trigger or a screen action starts the flow at this step' });
      continue;
    }
    for (const slot of def.inputs.required) {
      if (!filled.has(slot)) findings.push({ level: 'error', stepId, message: `required input slot '${slot}' has no wire` });
    }
  }

  return findings;
}
