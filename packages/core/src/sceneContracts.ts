import { z } from 'zod';
import { KEBAB_RE } from './tabs.js';
import { arrayDescriptorSchema } from './arrayDescriptor.js';
import { datasetQuerySchema, type DatasetQuery } from './datasetQuery.js';
import { flowEffectSchema, type FlowEffect } from './flows.js';

// THE ONE BINDING GRAMMAR (Phase 12, ruling 8) and the action vocabulary (ruling 9).
// A screen's data contract is `query` bindings over datasetQuery's typed grammar (PostgREST's shape:
// one grammar, one SQL statement, every column checked against the row schema), `asset` bindings that
// resolve to a URL, and one `clock`. An action's rules are json-render's three effect arms (navigate,
// set, action) plus start_flow and the row writes; the answer carries its effects.

const name = z.string().regex(KEBAB_RE);

/** The three system tables a query may read beside the project's own tables; their columns are fixed. */
export const SYSTEM_QUERY_TABLES = ['events', 'runs', 'agents'] as const;
export type SystemQueryTable = (typeof SYSTEM_QUERY_TABLES)[number];

export const SYSTEM_TABLE_SCHEMAS: Readonly<Record<SystemQueryTable, Record<string, 'string' | 'number' | 'boolean'>>> = {
  events: { id: 'number', type: 'string', actor: 'string', created_at: 'string' },
  runs: { id: 'string', status: 'string', kind: 'string', prompt: 'string', model: 'string', thread_id: 'string', created_at: 'string', finished_at: 'string' },
  agents: { id: 'string', slug: 'string', status: 'string', current_version: 'number', created_at: 'string' },
};

export function isSystemQueryTable(table: string): table is SystemQueryTable {
  return (SYSTEM_QUERY_TABLES as readonly string[]).includes(table);
}

const rowSchemaSchema = z.record(z.string().min(1).max(64), z.enum(['string', 'number', 'boolean']));

/** Every column a query names must be a declared column; the wrong type refuses naming the column. */
function checkQueryColumns(q: DatasetQuery | undefined, schema: Record<string, 'string' | 'number' | 'boolean'>, ctx: z.RefinementCtx): void {
  if (q === undefined) return;
  const declared = Object.keys(schema);
  const miss = (col: string, path: (string | number)[]): void => {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: `column '${col}' is not in the row schema - declared: ${declared.join(', ') || 'none'}` });
  };
  (q.where ?? []).forEach((w, i) => {
    if (!(w.col in schema)) { miss(w.col, ['query', 'where', i, 'col']); return; }
    if (w.op === 'contains' && schema[w.col] !== 'string') ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['query', 'where', i, 'op'], message: `contains works on string columns - '${w.col}' is ${schema[w.col]}` });
  });
  (q.orderBy ?? []).forEach((o, i) => { if (!(o.col in schema)) miss(o.col, ['query', 'orderBy', i, 'col']); });
  (q.aggregate?.groupBy ?? []).forEach((g, i) => { if (!(g in schema)) miss(g, ['query', 'aggregate', 'groupBy', i]); });
  (q.aggregate?.metrics ?? []).forEach((m, i) => {
    if (m.col === undefined) return;
    if (!(m.col in schema)) { miss(m.col, ['query', 'aggregate', 'metrics', i, 'col']); return; }
    if ((m.fn === 'sum' || m.fn === 'avg') && schema[m.col] !== 'number') ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['query', 'aggregate', 'metrics', i, 'col'], message: `${m.fn}('${m.col}') needs a number column - '${m.col}' is ${schema[m.col]}` });
  });
}

const queryBindingSchema = z.object({
  name,
  kind: z.literal('query'),
  /** A project table by name, or one of the system tables (events, runs, agents). */
  table: name,
  /** The table's columns; a system table's schema is fixed and this field may be left out. */
  rowSchema: rowSchemaSchema.optional(),
  /** where / orderBy / limit / aggregate, pushed into SQL as one statement; absent = every row in creation order, limit 200. */
  query: datasetQuerySchema.optional(),
  /** A detail screen names the column its URL segment addresses; the serve lane composes one eq predicate. */
  rowKey: z.object({ column: z.string().min(1).max(64) }).strict().optional(),
}).strict().superRefine((b, ctx) => {
  const schema = b.rowSchema ?? (isSystemQueryTable(b.table) ? SYSTEM_TABLE_SCHEMAS[b.table] : undefined);
  if (schema === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['rowSchema'], message: `a query over '${b.table}' declares its rowSchema (the system tables events, runs, agents need none)` });
    return;
  }
  checkQueryColumns(b.query, schema, ctx);
  if (b.rowKey !== undefined && !(b.rowKey.column in schema)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['rowKey', 'column'], message: `rowKey column '${b.rowKey.column}' is not in the row schema` });
  }
});

const assetSourceSchema = z.discriminatedUnion('from', [
  /** A granted folder walked by a glob (media). */
  z.object({ from: z.literal('folder'), folder: z.string().min(1), select: z.string().min(1).default('**/*') }).strict(),
  /** A registered derived output by name (array or raster). */
  z.object({ from: z.literal('output'), output: name }).strict(),
  /** One file inside a granted folder (array or raster). */
  z.object({ from: z.literal('file'), folder: z.string().min(1), file: z.string().min(1) }).strict(),
]);

const assetBindingSchema = z.object({
  name,
  kind: z.literal('asset'),
  /** media = files under a folder (each row a file with its URL); array = an .npy read through the projection lane; raster = one web-decodable image. */
  asset: z.enum(['media', 'array', 'raster']),
  source: assetSourceSchema,
  /** array: the authoritative descriptor the file is checked against. */
  descriptor: arrayDescriptorSchema.optional(),
  /** raster: web-decodable only - the runtime draws it, never decodes exotics. */
  format: z.enum(['png', 'jpeg', 'webp']).optional(),
}).strict().superRefine((b, ctx) => {
  if (b.asset === 'media' && b.source.from !== 'folder') ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['source'], message: 'a media asset reads a granted folder: source { from: "folder", folder, select }' });
  if (b.asset !== 'media' && b.source.from === 'folder') ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['source'], message: `an ${b.asset} asset names one output or one file, never a folder` });
  if (b.asset === 'array' && b.descriptor === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['descriptor'], message: 'an array asset declares its descriptor (dtype, shape, axes)' });
  if (b.asset === 'raster' && b.format === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['format'], message: 'a raster asset names its format: png, jpeg or webp' });
});

const clockBindingSchema = z.object({
  name,
  kind: z.literal('clock'),
  /** The host re-mints the now row on this cadence; the floor prevents hot loops. */
  intervalMs: z.number().int().min(1000).max(3_600_000).default(60_000),
}).strict();

export const sceneBindingSchema = z.discriminatedUnion('kind', [queryBindingSchema.sourceType(), assetBindingSchema.sourceType(), clockBindingSchema])
  .superRefine((b, ctx) => {
    // The discriminated union takes the bare objects; the per-kind refinements run here, once.
    const r = b.kind === 'query' ? queryBindingSchema.safeParse(b) : b.kind === 'asset' ? assetBindingSchema.safeParse(b) : null;
    if (r !== null && !r.success) for (const issue of r.error.issues) ctx.addIssue({ code: z.ZodIssueCode.custom, path: issue.path, message: issue.message });
  });
export type SceneBinding = z.infer<typeof sceneBindingSchema>;
export type QueryBinding = Extract<SceneBinding, { kind: 'query' }>;
export type AssetBinding = Extract<SceneBinding, { kind: 'asset' }>;
export type ClockBinding = Extract<SceneBinding, { kind: 'clock' }>;

export const sceneBindingsSchema = z
  .array(sceneBindingSchema)
  .max(12)
  .refine((bs) => new Set(bs.map((b) => b.name)).size === bs.length, { message: 'binding names must be unique' });

/** The row schema a query binding reads against: its own, or the system table's fixed one. */
export function queryRowSchema(b: QueryBinding): Record<string, 'string' | 'number' | 'boolean'> {
  return b.rowSchema ?? (isSystemQueryTable(b.table) ? SYSTEM_TABLE_SCHEMAS[b.table] : {});
}

/** A query binding declaring `rowKey`, served with a URL key, gains one eq predicate on the declared column. */
export function bindingWithRowKey<T extends SceneBinding>(binding: T, key: string | undefined): T {
  if (key === undefined || binding.kind !== 'query' || binding.rowKey === undefined) return binding;
  const col = binding.rowKey.column;
  const t = queryRowSchema(binding)[col];
  const value: string | number | boolean = t === 'number' ? Number(key) : t === 'boolean' ? key === 'true' : key;
  const where = [...(binding.query?.where ?? []), { col, op: 'eq' as const, value }];
  return { ...binding, query: { ...(binding.query ?? {}), where } };
}

/** The table names a binding list reads; the push computer keys on them. */
export function tablesReadBy(bindings: readonly SceneBinding[]): string[] {
  return [...new Set(bindings.filter((b): b is QueryBinding => b.kind === 'query').map((b) => b.table))];
}

// ---------------------------------------------------------------------------
// Actions: the write door as declared grammar; the answer carries its effects.
// ---------------------------------------------------------------------------

export const actionParamSchema = z
  .object({
    type: z.enum(['string', 'number', 'boolean', 'enum']),
    description: z.string().min(1),
    enum: z.array(z.string()).min(1).optional(),
    /** Who fills it - the card can say what is user-chosen vs hardwired. */
    source: z.enum(['user', 'binding', 'static', 'contextual']),
    value: z.unknown().optional(),
    contextual: z.enum(['currentUser', 'now']).optional(),
    required: z.boolean().optional(),
  })
  .strict()
  .refine((p) => p.source !== 'static' || p.value !== undefined, { message: 'static params declare their value' })
  .refine((p) => p.source !== 'contextual' || p.contextual !== undefined, { message: 'contextual params name currentUser or now' });
export type ActionParam = z.infer<typeof actionParamSchema>;

export const valueFromSchema = z
  .object({
    from: z.enum(['param', 'static']),
    param: z.string().optional(),
    value: z.unknown().optional(),
  })
  .strict()
  .refine((v) => (v.from === 'param' ? v.param !== undefined : v.value !== undefined), {
    message: "from 'param' names the param; from 'static' declares the value",
  });
export type ValueFrom = z.infer<typeof valueFromSchema>;

/** The `when` shape: a rule whose when fails is skipped and the decision record says so; absent = always fires. */
export const actionWhenSchema = z
  .object({
    param: z.string().min(1),
    check: z.enum(['is', 'matches', 'includes', 'gte', 'lte', 'nonempty']),
    value: z.unknown().optional(),
  })
  .strict();
export type ActionWhen = z.infer<typeof actionWhenSchema>;

const when = actionWhenSchema.optional();

export const actionRuleSchema = z.discriminatedUnion('rule', [
  // The row writes: rows are addressed by the kernel row id (`_id`), never by value match.
  z.object({
    rule: z.literal('append_row'),
    table: name,
    row: z.record(z.string(), valueFromSchema),
    when,
  }).strict(),
  z.object({
    rule: z.literal('update_row'),
    table: name,
    /** The dataset_rows pk - from a param the widget filled off the row's `_id`. */
    rowId: valueFromSchema,
    set: z.record(z.string(), valueFromSchema)
      .refine((obj) => Object.keys(obj).length >= 1, { message: 'update_row sets at least one column' }),
    when,
  }).strict(),
  z.object({
    rule: z.literal('delete_row'),
    table: name,
    rowId: valueFromSchema,
    when,
  }).strict(),
  // Starts a flow: `flow` names the flow (absent = 'main'), `entry` the entry step; params carry implicitly.
  // The call awaits the run up to a budget and folds its effects into the answer.
  z.object({
    rule: z.literal('start_flow'),
    flow: name.optional(),
    entry: name,
    when,
  }).strict(),
  // json-render's three effect arms: navigate (a goto effect), set (an answer effect the screen reads as a
  // channel), action (another declared action of this screen runs in the same call).
  z.object({
    rule: z.literal('navigate'),
    scene: z.string().min(1).max(80),
    /** A row key for a detail screen. */
    key: valueFromSchema.optional(),
    when,
  }).strict(),
  z.object({
    rule: z.literal('set'),
    key: z.string().min(1).max(80),
    value: valueFromSchema,
    when,
  }).strict(),
  z.object({
    rule: z.literal('action'),
    action: name,
    /** Params handed to the chained action beside the current ones. */
    with: z.record(z.string(), valueFromSchema).default({}),
    when,
  }).strict(),
]);
export type ActionRule = z.infer<typeof actionRuleSchema>;

export const actionCriterionSchema = z
  .object({
    param: z.string().min(1),
    check: z.enum(['is', 'matches', 'includes', 'gte', 'lte', 'nonempty']),
    value: z.unknown().optional(),
    /** Every criterion carries its own human-readable failure message. */
    message: z.string().min(1),
  })
  .strict();
export type ActionCriterion = z.infer<typeof actionCriterionSchema>;

/** Param names allow camelCase - the author is a model and `allDay` is its native tongue. */
const paramName = z.string().regex(/^[a-z][a-zA-Z0-9-]{0,63}$/, 'param names start lowercase: letters/digits/dashes');

export const sceneActionSchema = z
  .object({
    name,
    title: z.string().min(1),
    /** Agent-facing usage note, written at declaration. */
    whenToUse: z.string().min(1),
    params: z.record(paramName, actionParamSchema),
    rules: z.array(actionRuleSchema).min(1).max(4),
    criteria: z.array(actionCriterionSchema).max(8).default([]),
    /** Declared-or-they-don't-happen; an empty array is the only valid declaration. */
    sideEffects: z.array(z.never()).max(0).default([]),
    /** Fires when an input's value changes; `node` names one element, absent = any input in scope. */
    fires: z.object({ on: z.enum(['changed']), node: z.string().max(60).optional() }).strict().optional(),
  })
  .strict();
export type SceneAction = z.infer<typeof sceneActionSchema>;

export const sceneActionsSchema = z
  .array(sceneActionSchema)
  .max(8)
  .refine((as) => new Set(as.map((a) => a.name)).size === as.length, { message: 'action names must be unique' });

/** The effects an action's answer carries: the flow effect vocabulary, one list. */
export const actionEffectSchema = flowEffectSchema;
export type ActionEffect = FlowEffect;

/** A run the answer could not await inside its budget; its effects push over the live channel when it settles. */
export interface ActionExecution {
  id: string;
  status: 'running' | 'waiting' | 'failed';
  error?: string;
}

/** The answer of one submitted action: effects computed in the call, or the execution still running. */
export type ActionAnswer =
  | { ok: true; results: Array<Record<string, unknown>>; effects: ActionEffect[]; execution?: ActionExecution }
  | { ok: false; failures: string[] };

/** The tables an action's rules write; the push computer announces them after a submit. */
export function tablesWrittenBy(action: SceneAction): string[] {
  const out = new Set<string>();
  for (const r of action.rules) if (r.rule === 'append_row' || r.rule === 'update_row' || r.rule === 'delete_row') out.add(r.table);
  return [...out];
}
