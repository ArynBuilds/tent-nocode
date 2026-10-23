import { z } from 'zod';

// Flow contracts: the flow doc, execution envelope, pill grammar, and condition evaluator. Items flow on wires; steps are declarations; field references are picked pills, never code eval.

const KEBAB_RE = /^[a-z][a-z0-9-]*$/;
const stepId = z.string().regex(/^[a-z0-9][a-z0-9-]*$/).max(60);

// The item: what flows on a wire ({json} only).

export const flowItemSchema = z.object({
  json: z.record(z.string(), z.unknown()),
  /** Provenance back-pointer; absent = unknown. */
  pairedItem: z.number().int().min(0).optional(),
}).strict();
export type FlowItem = z.infer<typeof flowItemSchema>;

// The pill: the one mapping grammar. A pill names where a value comes from; resolution is engine work at run time.

export const pillSchema = z.discriminatedUnion('from', [
  /** A previous step's item field; `path` walks the item's json (dot path). */
  z.object({ from: z.literal('step'), step: stepId, path: z.string().min(1).max(200) }).strict(),
  /** The trigger's payload field. */
  z.object({ from: z.literal('trigger'), path: z.string().min(1).max(200) }).strict(),
  /** A Table cell: first row of the named column. */
  z.object({ from: z.literal('table'), table: z.string().regex(KEBAB_RE).max(60), column: z.string().max(60) }).strict(),
  /** An on-screen input's collected value. */
  z.object({ from: z.literal('input'), param: z.string().max(60) }).strict(),
  /** The ambient pills. */
  z.object({ from: z.literal('ambient'), name: z.enum(['now', 'today']) }).strict(),
  /** A literal text template: `{{slot}}` holes fill from the named pills, always as text. */
  z.object({
    from: z.literal('template'),
    template: z.string().max(4000),
    slots: z.record(z.string().regex(/^[a-z][a-z0-9_-]*$/i), z.lazy((): z.ZodTypeAny => pillLeafSchema)).default({}),
  }).strict(),
]);
/** Template slots take leaf pills, never nested templates. */
const pillLeafSchema = z.discriminatedUnion('from', [
  z.object({ from: z.literal('step'), step: stepId, path: z.string().min(1).max(200) }).strict(),
  z.object({ from: z.literal('trigger'), path: z.string().min(1).max(200) }).strict(),
  z.object({ from: z.literal('table'), table: z.string().regex(KEBAB_RE).max(60), column: z.string().max(60) }).strict(),
  z.object({ from: z.literal('input'), param: z.string().max(60) }).strict(),
  z.object({ from: z.literal('ambient'), name: z.enum(['now', 'today']) }).strict(),
]);
export type Pill = z.infer<typeof pillSchema>;

/** A step param's value: a plain scalar/json literal OR a pill. */
export const pillValueSchema = z.union([pillSchema, z.string(), z.number(), z.boolean(), z.null()]);
export type PillValue = z.infer<typeof pillValueSchema>;

export function isPill(v: unknown): v is Pill {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && 'from' in v
    && typeof (v as { from: unknown }).from === 'string'
    && ['step', 'trigger', 'table', 'input', 'ambient', 'template'].includes((v as { from: string }).from);
}

// The condition grammar, shared by If / Keep rows / Split by rules and every future conditional step.

export const CONDITION_OPS = [
  // text
  'equals', 'not-equals', 'contains', 'not-contains', 'starts-with', 'ends-with',
  // number
  'greater', 'at-least', 'less', 'at-most',
  // presence
  'empty', 'not-empty',
  // boolean
  'is-true', 'is-false',
  // date (ISO strings compare)
  'before', 'after',
] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];

export const conditionRuleSchema = z.object({
  left: pillSchema,
  op: z.enum(CONDITION_OPS),
  /** Absent for the argument-less ops (empty/not-empty/is-true/is-false). */
  right: pillValueSchema.optional(),
}).strict();

export const conditionSchema = z.object({
  combine: z.enum(['and', 'or']).default('and'),
  rules: z.array(conditionRuleSchema).min(1).max(12),
}).strict();
export type FlowCondition = z.infer<typeof conditionSchema>;

// The flow document: compiled authoring truth. Explicit edge order always, never canvas geometry.

export const flowStepSchema = z.object({
  /** The step-kind registry name. */
  kind: z.string().regex(KEBAB_RE).max(60),
  /** Params by name: literals or pills; the kind's def declares the surface. */
  params: z.record(z.string().regex(/^[a-z][a-z0-9_-]*$/i).max(60), z.unknown()).default({}),
  /** Disabled steps pass items through untouched. */
  disabled: z.boolean().default(false),
  /** Pinned output items: a manual run substitutes these for the step's real execution. */
  pinned: z.array(flowItemSchema).max(50).optional(),
  /** The last authoring touch; the dirty badge compares this against the flow's last run. */
  touchedAt: z.string().optional(),
}).strict();
export type FlowStep = z.infer<typeof flowStepSchema>;

export const flowEdgeSchema = z.object({
  from: stepId,
  /** The source output port ('out' default; If = 'true'/'false'; Split = rule ids). */
  port: z.string().max(40).default('out'),
  to: stepId,
  /** The target input slot ('in' default; Merge names its required inputs). */
  slot: z.string().max(40).default('in'),
  /** Explicit order among siblings, never canvas geometry. */
  order: z.number().int().min(0).default(0),
}).strict();
export type FlowEdge = z.infer<typeof flowEdgeSchema>;

export const FLOW_DOC_VERSION = 1;

export const flowDocSchema = z.object({
  version: z.literal(FLOW_DOC_VERSION),
  steps: z.record(stepId, flowStepSchema),
  edges: z.array(flowEdgeSchema).max(200),
}).strict().superRefine((doc, ctx) => {
  for (let i = 0; i < doc.edges.length; i++) {
    const e = doc.edges[i]!;
    if (!(e.from in doc.steps)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['edges', i, 'from'], message: `edge names no step '${e.from}'` });
    if (!(e.to in doc.steps)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['edges', i, 'to'], message: `edge names no step '${e.to}'` });
  }
});
export type FlowDoc = z.infer<typeof flowDocSchema>;

// The execution envelope: branded, persisted every step so the sweeper resumes from the row alone.

export const FLOW_ENVELOPE_VERSION = 1;

/** Screen effects a settled run asks the starting page to execute; message/answer values are always text, never markup. */
export const flowEffectSchema = z.discriminatedUnion('kind', [
  /** Navigate the page to a scene. */
  z.object({ kind: z.literal('goto'), scene: z.string().min(1).max(80) }).strict(),
  /** One viewport-anchored sentence. */
  z.object({ kind: z.literal('message'), text: z.string().max(500) }).strict(),
  /** Open/dismiss a modal/drawer/fixed-overlay by node name. */
  z.object({ kind: z.literal('overlay'), node: z.string().min(1).max(80), open: z.boolean() }).strict(),
  /** A session-scoped value the page reads as a channel source. */
  z.object({ kind: z.literal('answer'), key: z.string().min(1).max(80), value: z.unknown() }).strict(),
]);
export type FlowEffect = z.infer<typeof flowEffectSchema>;

/** One stack entry: a step ready to run with its input items per slot. */
export const flowStackEntrySchema = z.object({
  step: stepId,
  /** Items per input slot ('in' for single-input steps). */
  inputs: z.record(z.string().max(40), z.array(flowItemSchema)),
}).strict();

export const flowEnvelopeSchema = z.object({
  version: z.literal(FLOW_ENVELOPE_VERSION),
  /** The run's trigger payload. */
  trigger: z.record(z.string(), z.unknown()).default({}),
  /** On-screen collected values; absent resolves empty. */
  inputs: z.record(z.string(), z.unknown()).default({}),
  /** Every settled step's output items per port. */
  results: z.record(stepId, z.record(z.string().max(40), z.array(flowItemSchema))).default({}),
  /** Steps ready to run, persisted every settle. */
  stack: z.array(flowStackEntrySchema).default([]),
  /** Join slots: a multi-input step parks partial inputs here until its required slots fill. */
  waiting: z.record(stepId, z.record(z.string().max(40), z.array(flowItemSchema))).default({}),
  /** Steps already executed this run (loop guard). */
  ran: z.array(z.string()).default([]),
  /** The run's recorded screen effects, in execution order. */
  effects: z.array(flowEffectSchema).max(40).default([]),
  /** Batch loop contexts by step: `remaining` = rows not yet sent, `collected` = rows returned so far. */
  loops: z.record(stepId, z.object({
    remaining: z.array(flowItemSchema),
    collected: z.array(flowItemSchema),
  }).strict()).default({}),
  /** The flow's recorded HTTP answer for the webhook caller; recorded once, first answer-caller step wins; text always. */
  callerAnswer: z.object({
    answer: z.string().max(4000),
    status: z.union([z.literal(200), z.literal(201)]).default(200),
    at: z.string(),
  }).strict().optional(),
  /** The step the run stopped inside; its inputs survive so the resume re-enters exactly there. */
  parked: z.object({
    step: stepId,
    reason: z.enum(['wait', 'flow']),
    inputs: z.record(z.string().max(40), z.array(flowItemSchema)).default({}),
    child: z.string().uuid().optional(),
  }).strict().optional(),
}).strict();
export type FlowEnvelope = z.infer<typeof flowEnvelopeSchema>;

/** The fresh envelope for a new run. */
export function mintFlowEnvelope(input: { trigger?: Record<string, unknown>; inputs?: Record<string, unknown> }): FlowEnvelope {
  return flowEnvelopeSchema.parse({
    version: FLOW_ENVELOPE_VERSION,
    trigger: input.trigger ?? {},
    inputs: input.inputs ?? {},
  });
}

// Pill resolution, pure: a pill reads, a template concatenates, nothing evaluates.

export function walkPath(value: unknown, path: string): unknown {
  let cur: unknown = value;
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(seg);
      cur = Number.isInteger(idx) ? cur[idx] : undefined;
      continue;
    }
    if (typeof cur === 'object') { cur = (cur as Record<string, unknown>)[seg]; continue; }
    return undefined;
  }
  return cur;
}

export interface PillContext {
  /** The current item; null in item-less spots. */
  item: FlowItem | null;
  /** Settled results by step. */
  results: Record<string, Record<string, FlowItem[]>>;
  trigger: Record<string, unknown>;
  inputs: Record<string, unknown>;
  /** Table read (first row's column), injected by the engine. */
  tableCell?: (table: string, column: string) => unknown;
  /** The clock, injected; tests pass a fixed one. */
  nowIso: string;
}

/** Resolve one pill against the run context; missing sources resolve undefined. */
export function resolvePill(pill: Pill, ctx: PillContext): unknown {
  if (pill.from === 'step') {
    // A step pill reads the current item when possible, else the step's first 'out' item.
    if (ctx.item !== null && walkPath(ctx.item.json, pill.path) !== undefined) {
      return walkPath(ctx.item.json, pill.path);
    }
    const first = ctx.results[pill.step]?.['out']?.[0] ?? Object.values(ctx.results[pill.step] ?? {})[0]?.[0];
    return first === undefined ? undefined : walkPath(first.json, pill.path);
  }
  if (pill.from === 'trigger') return walkPath(ctx.trigger, pill.path);
  if (pill.from === 'input') return ctx.inputs[pill.param];
  if (pill.from === 'table') return ctx.tableCell?.(pill.table, pill.column);
  if (pill.from === 'ambient') return pill.name === 'now' ? ctx.nowIso : ctx.nowIso.slice(0, 10);
  // template: concatenate - every slot renders as text.
  return pill.template.replace(/\{\{\s*([a-z0-9_-]+)\s*\}\}/gi, (_, slot: string) => {
    const p = pill.slots[slot];
    if (p === undefined) return '';
    const v = resolvePill(p as Pill, ctx);
    return v === undefined || v === null ? '' : String(v);
  });
}

/** Resolve a param value: pills resolve, literals pass through. */
export function resolvePillValue(v: unknown, ctx: PillContext): unknown {
  return isPill(v) ? resolvePill(v, ctx) : v;
}

// Condition evaluation: the one shared evaluator.

function asNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

export function evalConditionRule(rule: z.infer<typeof conditionRuleSchema>, ctx: PillContext): boolean {
  const left = resolvePill(rule.left, ctx);
  const right = rule.right === undefined ? undefined : resolvePillValue(rule.right, ctx);
  switch (rule.op) {
    case 'equals': return String(left ?? '') === String(right ?? '');
    case 'not-equals': return String(left ?? '') !== String(right ?? '');
    case 'contains': return String(left ?? '').includes(String(right ?? ''));
    case 'not-contains': return !String(left ?? '').includes(String(right ?? ''));
    case 'starts-with': return String(left ?? '').startsWith(String(right ?? ''));
    case 'ends-with': return String(left ?? '').endsWith(String(right ?? ''));
    case 'greater': { const l = asNumber(left); const r = asNumber(right); return l !== null && r !== null && l > r; }
    case 'at-least': { const l = asNumber(left); const r = asNumber(right); return l !== null && r !== null && l >= r; }
    case 'less': { const l = asNumber(left); const r = asNumber(right); return l !== null && r !== null && l < r; }
    case 'at-most': { const l = asNumber(left); const r = asNumber(right); return l !== null && r !== null && l <= r; }
    case 'empty': return left === undefined || left === null || left === '';
    case 'not-empty': return !(left === undefined || left === null || left === '');
    case 'is-true': return left === true;
    case 'is-false': return left === false;
    case 'before': return String(left ?? '') !== '' && String(right ?? '') !== '' && String(left) < String(right);
    case 'after': return String(left ?? '') !== '' && String(right ?? '') !== '' && String(left) > String(right);
  }
}

export function evalCondition(cond: FlowCondition, ctx: PillContext): boolean {
  return cond.combine === 'or'
    ? cond.rules.some((r) => evalConditionRule(r, ctx))
    : cond.rules.every((r) => evalConditionRule(r, ctx));
}

// Partial-run planning, pure: walk backward from the target; predecessors with pinned or prior results are boundaries that seed the envelope; the rest re-run.

export interface PartialRunPlan {
  /** Seeded results - the boundaries alone; pinned beats prior. */
  results: Record<string, Record<string, FlowItem[]>>;
  /** The ready frontier - stack entries exactly as the engine pops them. */
  stack: Array<{ step: string; inputs: Record<string, FlowItem[]> }>;
}

export function planPartialRun(
  doc: FlowDoc,
  target: string,
  prior: Record<string, Record<string, FlowItem[]>> | null,
  trigger: Record<string, unknown> = {},
): PartialRunPlan {
  const incoming = (id: string): FlowEdge[] => doc.edges.filter((e) => e.to === id);
  /** What a step can seed from: its pin (as 'out') beats its prior results. */
  const seedOf = (id: string): Record<string, FlowItem[]> | null => {
    const pinned = doc.steps[id]?.pinned;
    if (pinned !== undefined) return { out: pinned };
    return prior?.[id] ?? null;
  };

  // The backward walk: boundaries stop it; the rest re-run.
  const rerun = new Set<string>([target]);
  const boundaries = new Set<string>();
  const queue = [target];
  while (queue.length > 0) {
    const cur = queue.pop()!;
    for (const e of incoming(cur)) {
      if (rerun.has(e.from) || boundaries.has(e.from)) continue;
      if (seedOf(e.from) !== null) { boundaries.add(e.from); continue; }
      rerun.add(e.from);
      queue.push(e.from);
    }
  }

  // Prior trims to the boundaries alone; re-run steps answer fresh.
  const results: PartialRunPlan['results'] = {};
  for (const b of boundaries) {
    const seed = seedOf(b);
    if (seed !== null) results[b] = seed;
  }

  // The frontier: entry steps seed with the trigger item; steps whose every incoming edge leaves a seeded boundary seed per slot.
  const stack: PartialRunPlan['stack'] = [];
  for (const id of rerun) {
    const edges = incoming(id);
    if (edges.length === 0) {
      stack.push({ step: id, inputs: { in: [{ json: trigger }] } });
      continue;
    }
    if (!edges.every((e) => results[e.from]?.[e.port] !== undefined)) continue;
    const inputs: Record<string, FlowItem[]> = {};
    for (const e of [...edges].sort((a, b) => a.order - b.order)) {
      inputs[e.slot] = [...(inputs[e.slot] ?? []), ...(results[e.from]?.[e.port] ?? [])];
    }
    stack.push({ step: id, inputs });
  }
  if (stack.length > 0) return { results, stack };

  // No runnable frontier: fall back to the target's own entry chain from scratch.
  const ancestors = new Set<string>([target]);
  const walk = [target];
  while (walk.length > 0) {
    for (const e of incoming(walk.pop()!)) {
      if (!ancestors.has(e.from)) { ancestors.add(e.from); walk.push(e.from); }
    }
  }
  const entries = [...ancestors].filter((id) => incoming(id).length === 0);
  const seedsFresh = entries.length > 0 ? entries : [target];
  return { results: {}, stack: seedsFresh.map((id) => ({ step: id, inputs: { in: [{ json: trigger }] } })) };
}
