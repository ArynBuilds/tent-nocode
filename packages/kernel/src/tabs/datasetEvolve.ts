import { z } from 'zod';
import type postgres from 'postgres';
import { emitEvent } from '../events.js';
import { projectArm } from '../containment.js';

// Schema evolution: add and deprecate are the only moves; rename and retype do not exist, and a deprecated name never returns.

type RowSchema = Record<string, 'string' | 'number' | 'boolean'>;

const evolveSchema = z.object({
  add: z.array(z.object({ col: z.string().min(1).max(64), type: z.enum(['string', 'number', 'boolean']) }).strict()).max(8).optional(),
  deprecate: z.array(z.string().min(1).max(64)).max(8).optional(),
  keyColumns: z.array(z.string().min(1).max(64)).min(1).max(4).optional(),
}).strict();

export type EvolveDatasetResult =
  | { ok: true; rowSchema: RowSchema; deprecatedColumns: string[]; keyColumns: string[] | null }
  | { ok: false; error: string };

export async function evolveDataset(
  sql: postgres.Sql,
  input: { orgId: string; projectId: string | null; name: string; add?: { col: string; type: 'string' | 'number' | 'boolean' }[]; deprecate?: string[]; keyColumns?: string[] },
): Promise<EvolveDatasetResult> {
  const parsed = evolveSchema.safeParse({ add: input.add, deprecate: input.deprecate, keyColumns: input.keyColumns });
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => i.message).join('; ') };
  const { add = [], deprecate = [], keyColumns } = parsed.data;
  if (add.length === 0 && deprecate.length === 0 && keyColumns === undefined) {
    return { ok: false, error: 'nothing to evolve — pass add, deprecate, or keyColumns' };
  }
  const [dataset] = await sql<{ id: string; row_schema: RowSchema; deprecated_columns: string[]; key_columns: unknown; column_order: string[] | null }[]>`
    select id, row_schema, deprecated_columns, key_columns, column_order from datasets
    where org_id = ${input.orgId} and ${projectArm(sql, input.projectId)} and name = ${input.name} and deleted_at is null`;
  if (!dataset) return { ok: false, error: `dataset '${input.name}' is not declared in this project` };

  const schema: RowSchema = { ...dataset.row_schema };
  const deprecatedList = [...(dataset.deprecated_columns ?? [])];

  for (const a of add) {
    if (a.col in schema) {
      return schema[a.col] === a.type
        ? { ok: false, error: `column '${a.col}' is already declared as ${a.type}` }
        : { ok: false, error: `column '${a.col}' is already declared as ${schema[a.col]} — RETYPE does not exist (add a new column)` };
    }
    if (deprecatedList.includes(a.col)) {
      return { ok: false, error: `column '${a.col}' was deprecated — a deprecated name never returns (it would silently retype history); use a new name` };
    }
    schema[a.col] = a.type;
  }
  for (const d of deprecate) {
    if (!(d in schema)) return { ok: false, error: `column '${d}' is not in the declared schema — nothing to deprecate` };
    delete schema[d];
    if (!deprecatedList.includes(d)) deprecatedList.push(d);
  }
  if (Object.keys(schema).length === 0) {
    return { ok: false, error: 'deprecating every column would leave an empty schema — a dataset declares at least one column' };
  }
  const finalKeys = keyColumns ?? (Array.isArray(dataset.key_columns) ? (dataset.key_columns as string[]) : null);
  if (finalKeys !== null) {
    for (const k of finalKeys) {
      if (!(k in schema)) return { ok: false, error: `key column '${k}' is not in the ${keyColumns !== undefined ? 'evolved ' : ''}schema${keyColumns === undefined ? ' — deprecate the key columns last, after re-keying' : ''}` };
    }
  }

  // The declared order is its own record: adds append, deprecates leave.
  const priorOrder = dataset.column_order ?? Object.keys(dataset.row_schema);
  const order = [...priorOrder.filter((c) => c in schema), ...add.map((a) => a.col).filter((c) => !priorOrder.includes(c))];
  await sql`
    update datasets set
      row_schema = ${sql.json(schema as unknown as postgres.JSONValue)},
      deprecated_columns = ${sql.json(deprecatedList as unknown as postgres.JSONValue)},
      key_columns = ${finalKeys === null ? null : sql.json(finalKeys as unknown as postgres.JSONValue)},
      column_order = ${sql.array(order)}
    where id = ${dataset.id}`;
  await emitEvent(sql, {
    orgId: input.orgId, actor: 'kernel.datasets', type: 'dataset.evolved',
    payload: {
      dataset: input.name,
      added: add.map((a) => `${a.col}:${a.type}`), deprecated: deprecate,
      ...(keyColumns !== undefined ? { keyColumns } : {}),
    },
  });
  return { ok: true, rowSchema: schema, deprecatedColumns: deprecatedList, keyColumns: finalKeys };
}
