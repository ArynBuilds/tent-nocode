import type postgres from 'postgres';
import { sceneActionsSchema, type ActionRule, type ActionWhen, type SceneAction } from '@nodeloom/core';

// Projects a scene's declared actions into documentation shapes over the one vocabulary: the row writes,
// start_flow, and the three effect arms (navigate, set, action).

export interface ActionParamDoc {
  name: string;
  type: string;
  /** Who fills it; 'user' params are the widget's ask. */
  source: string;
  required: boolean;
  description: string;
  enum?: string[];
}

export interface ActionWriteDoc {
  kind: ActionRule['rule'];
  /** A row write's table. */
  table?: string;
  /** A start_flow rule's flow name (absent = 'main') plus entry step. */
  flow?: string;
  entry?: string;
  /** navigate: the screen; set: the channel key; action: the chained action. */
  target?: string;
  /** column -> where its value comes from ('param:qty' | 'static'). */
  columns?: Record<string, string>;
  /** The table's LIVE row schema (column -> type) when the table exists. */
  rowSchema?: Record<string, string>;
  /** The rule's `when` clause; absent = the rule always fires. */
  when?: { param: string; check: string; value?: unknown };
}

export interface ActionDoc {
  name: string;
  title: string;
  whenToUse: string;
  params: ActionParamDoc[];
  writes: ActionWriteDoc[];
  criteria: { param: string; check: string; message: string }[];
  /** The Changed trigger this action fires on; absent = button-fired. */
  fires?: { on: 'changed'; node?: string };
}

function sourceOf(v: { from: string; param?: string }): string {
  return v.from === 'param' ? `param:${v.param ?? '?'}` : 'static';
}

function columnsOf(map: Record<string, { from: string; param?: string }>): Record<string, string> {
  return Object.fromEntries(Object.entries(map).map(([k, v]) => [k, sourceOf(v)]));
}

/** Writes project rules 1:1 in order - the index is the rule address. */
function projectWrite(rule: ActionRule): ActionWriteDoc {
  const base = ((): ActionWriteDoc => {
    switch (rule.rule) {
      case 'append_row': return { kind: rule.rule, table: rule.table, columns: columnsOf(rule.row) };
      case 'update_row': return { kind: rule.rule, table: rule.table, columns: { _id: sourceOf(rule.rowId), ...columnsOf(rule.set) } };
      case 'delete_row': return { kind: rule.rule, table: rule.table, columns: { _id: sourceOf(rule.rowId) } };
      // No columns by design: every collected param rides the trigger item.
      case 'start_flow': return { kind: rule.rule, ...(rule.flow !== undefined ? { flow: rule.flow } : {}), entry: rule.entry };
      case 'navigate': return { kind: rule.rule, target: rule.scene, ...(rule.key !== undefined ? { columns: { key: sourceOf(rule.key) } } : {}) };
      case 'set': return { kind: rule.rule, target: rule.key, columns: { value: sourceOf(rule.value) } };
      case 'action': return { kind: rule.rule, target: rule.action, columns: columnsOf(rule.with) };
    }
  })();
  if (rule.when !== undefined) {
    base.when = { param: rule.when.param, check: rule.when.check, ...(rule.when.value !== undefined ? { value: rule.when.value } : {}) };
  }
  return base;
}

/** Project one declared action; live rowSchema enrichment happens in describeSceneAction. */
export function projectActionDoc(action: SceneAction): ActionDoc {
  return {
    name: action.name,
    title: action.title,
    whenToUse: action.whenToUse,
    params: Object.entries(action.params).map(([name, p]) => ({
      name,
      type: p.type,
      source: p.source,
      required: p.required === true,
      description: p.description,
      ...(p.enum !== undefined ? { enum: p.enum } : {}),
    })),
    writes: action.rules.map(projectWrite),
    criteria: action.criteria.map((c) => ({ param: c.param, check: c.check, message: c.message })),
    ...(action.fires !== undefined ? { fires: action.fires } : {}),
  };
}

/** Compact when suffix for a rule's when clause; absent = empty. */
function whenClause(w: ActionWhen | undefined): string {
  if (w === undefined) return '';
  const value = w.value === undefined ? '' : ` ${typeof w.value === 'string' ? w.value : JSON.stringify(w.value)}`;
  return ` when ${w.param} ${w.check}${value}`;
}

/** One line per action: name, user-filled params (* = required), and what its rules do. */
export function actionCatalogLine(action: SceneAction): string {
  const params = Object.entries(action.params)
    .filter(([, p]) => p.source === 'user')
    .map(([k, p]) => `${k}${p.required === true ? '*' : ''}`);
  const writes = action.rules.map((r) => {
    const base = ((): string => {
      switch (r.rule) {
        case 'append_row': return `append_row->${r.table}(${Object.keys(r.row).join(',')})`;
        case 'update_row': return `update_row->${r.table}(${Object.keys(r.set).join(',')})`;
        case 'delete_row': return `delete_row->${r.table}`;
        case 'start_flow': return `start_flow->${r.flow ?? 'main'}:${r.entry}`;
        case 'navigate': return `navigate->${r.scene}`;
        case 'set': return `set->${r.key}`;
        case 'action': return `action->${r.action}`;
      }
    })();
    return `${base}${whenClause(r.when)}`;
  });
  const segs = [
    `- ${action.name} - ${action.title}`,
    ...(params.length > 0 ? [`user params: ${params.join(', ')}`] : []),
    `does: ${writes.join(' + ')}`,
  ];
  return segs.join(' · ');
}

/** All declared actions of one scene, docs-projected. */
export async function listSceneActionDocs(
  sql: postgres.Sql, input: { orgId: string; sceneSlug: string },
): Promise<ActionDoc[]> {
  const [scene] = await sql<{ actions: unknown }[]>`
    select actions from scenes where org_id = ${input.orgId} and slug = ${input.sceneSlug} and status = 'active'`;
  if (!scene) return [];
  return sceneActionsSchema.parse(scene.actions ?? []).map(projectActionDoc);
}

export type DescribeActionResult =
  | { ok: true; doc: ActionDoc }
  | { ok: false; error: string };

/** Full contract for one action, table writes enriched with live row schemas. */
export async function describeSceneAction(
  sql: postgres.Sql, orgId: string, input: { sceneSlug: string; name: string },
): Promise<DescribeActionResult> {
  const [scene] = await sql<{ actions: unknown }[]>`
    select actions from scenes where org_id = ${orgId} and slug = ${input.sceneSlug} and status = 'active'`;
  if (!scene) return { ok: false, error: `no active scene '${input.sceneSlug}'` };
  const actions = sceneActionsSchema.parse(scene.actions ?? []);
  const action = actions.find((a) => a.name === input.name);
  if (!action) {
    const declared = actions.map((a) => a.name);
    return {
      ok: false,
      error: declared.length > 0
        ? `no action named '${input.name}' on scene '${input.sceneSlug}' - its declared actions: ${declared.join(', ')}`
        : `scene '${input.sceneSlug}' declares no actions - the consent card's list is complete`,
    };
  }
  const doc = projectActionDoc(action);
  // Attach each table's current row schema beside its write.
  const tables = [...new Set(doc.writes.map((w) => w.table).filter((d): d is string => d !== undefined))];
  if (tables.length > 0) {
    const rows = await sql<{ name: string; row_schema: Record<string, string> }[]>`
      select name, row_schema from datasets where org_id = ${orgId} and name = any(${sql.array(tables)}) and deleted_at is null`;
    const byName = new Map(rows.map((r) => [r.name, r.row_schema]));
    for (const w of doc.writes) {
      const schema = w.table !== undefined ? byName.get(w.table) : undefined;
      if (schema !== undefined) w.rowSchema = schema;
    }
  }
  return { ok: true, doc };
}
