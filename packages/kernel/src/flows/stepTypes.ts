import type { FlowCondition, FlowItem } from '@nodeloom/core';

/** Step-def types, a leaf module so def files and the registry never cycle. */

export interface FlowStepParamDecl {
  type: 'string' | 'number' | 'boolean' | 'enum' | 'condition' | 'json';
  required?: boolean;
  choices?: string[];
  help?: string;
  /** True = the param is pill-mappable (renders as an IN port beside its row). */
  pill?: boolean;
  /** Renders only while the named param holds one of these values. */
  showWhen?: { param: string; is: string[] };
  /** Builder-facing depth beyond `help` - served through the catalog, never rendered on cards. */
  hint?: string;
}

export interface PureRunInput {
  /** Raw params (pills unresolved — resolve() takes the per-item context). */
  params: Record<string, unknown>;
  /** Items per input slot ('in' for single-input kinds). */
  inputs: Record<string, FlowItem[]>;
  /** Pill-aware value resolution against the run context + the given item. */
  resolve: (value: unknown, item: FlowItem | null) => unknown;
  /** The one shared condition evaluator. */
  evalCondition: (cond: FlowCondition, item: FlowItem | null) => boolean;
}

export interface PureRunOutput {
  /** Items per OUTPUT port ('out' default; If = true/false; Split = rule ids). */
  outputs: Record<string, FlowItem[]>;
  /** A named failure — the run fails with this one sentence. */
  error?: string;
}

/** The effectful step kinds the engine implements; a def only names its arm. */
export type EngineArm =
  | 'wait'              // persisted wait; the sweeper resumes
  | 'batches'           // envelope-held loop over wired-back batches
  | 'run-flow'          // spawn a child execution; the parent parks
  | 'call-integration'  // integration dispatch
  | 'run-tool'          // the sealed executor via runOperation
  | 'get-rows'          // table read as items
  | 'save-rows'         // table upsert
  | 'screen-effect'     // record a screen effect on the envelope
  | 'answer-caller';    // record the webhook caller's answer on the envelope

export interface FlowStepDef {
  kind: string;
  displayName: string;
  blurb: string;
  /** Input slots plus which must all be present before the step runs. */
  inputs: { slots: string[]; required: string[] };
  /** Output ports; 'dynamic' = the ports derive from params. */
  outputs: string[] | 'dynamic';
  params: Record<string, FlowStepParamDecl>;
  exec: { pure: (input: PureRunInput) => PureRunOutput } | { engine: EngineArm };
  /** Builder-facing usage prose: what shapes this step handles, traps, when it composes with siblings. Catalog-served, never on cards. */
  guidance?: string;
  /** Worked examples: params in, what comes out; wrong-vs-right pairs welcome. Catalog-served. */
  examples?: Array<{ title: string; params: Record<string, unknown>; note?: string }>;
}

export const SINGLE_IN = { slots: ['in'], required: ['in'] };
