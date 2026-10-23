import { FLOW_STEP_DEFS } from './steps/index.js';
import type { FlowStepDef } from './stepTypes.js';

// Step-kind registry: one def file per step kind, consumed at module init.

export type { EngineArm, FlowStepDef, FlowStepParamDecl, PureRunInput, PureRunOutput } from './stepTypes.js';
export { SINGLE_IN } from './stepTypes.js';

const registry = new Map<string, FlowStepDef>();
for (const def of FLOW_STEP_DEFS) {
  if (registry.has(def.kind)) throw new Error(`flow step registry: duplicate kind '${def.kind}'`);
  registry.set(def.kind, Object.freeze(def));
}

export function resolveFlowStepDef(kind: string): FlowStepDef | null {
  return registry.get(kind) ?? null;
}

export function listFlowStepDefs(): FlowStepDef[] {
  return [...registry.values()];
}
