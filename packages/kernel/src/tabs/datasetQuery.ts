import type postgres from 'postgres';
import { datasetQuerySchema, type DatasetQuery } from '@tent-nocode/core';
import { projectArm } from '../containment.js';

// The one server-side dataset query composer; every column validates against the declared rowSchema, and columns and values alike travel as bound parameters - no raw SQL in this file.

type RowSchema = Record<string, 'string' | 'number' | 'boolean'>;

export type DatasetQueryResult =
  | { ok: true; rows: Record<string, unknown>[]; total: number }
  | { ok: false; error: string };

const DEFAULT_LIMIT = 1000;

/** A jsonb column accessor cast to the declared type; a closed switch, never caller text. */
function accessor(sql: postgres.Sql, col: string, type: 'string' | 'number' | 'boolean'): postgres.PendingQuery<postgres.Row[]> {
  if (type === 'number') return sql`(r.row->>${col})::numeric`;
  if (type === 'boolean') return sql`(r.row->>${col})::boolean`;
  return sql`r.row->>${col}`;
}

export async function queryDatasetRows(
  sql: postgres.Sql,
  input: { orgId: string; projectId: string | null; dataset: string; query?: DatasetQuery },
): Promise<DatasetQueryResult> {
  const parsed = datasetQuerySchema.safeParse(input.query ?? {});
  if (!parsed.success) {
    return { ok: false, error: `invalid query shape: ${parsed.error.issues.map((i) => i.message).join('; ')}` };
  }
  const q = parsed.data;
  const [dataset] = await sql<{ id: string; row_schema: RowSchema }[]>`
    select id, row_schema from datasets
    where org_id = ${input.orgId} and ${projectArm(sql, input.projectId)} and name = ${input.dataset} and deleted_at is null`;
  if (!dataset) return { ok: false, error: `dataset '${input.dataset}' is not declared in this project` };
  const schema = dataset.row_schema;

  // Every named column must be declared; refusal names the valid set.
  const validCols = Object.keys(schema);
  const named = [
    ...(q.where ?? []).map((w) => w.col),
    ...(q.orderBy ?? []).map((o) => o.col),
    ...(q.aggregate?.groupBy ?? []),
    ...(q.aggregate?.metrics ?? []).flatMap((m) => (m.col !== undefined ? [m.col] : [])),
  ];
  for (const col of named) {
    if (!validCols.includes(col)) {
      return { ok: false, error: `column '${col}' is not in the declared schema — declared: ${validCols.join(', ')}` };
    }
  }
  for (const m of q.aggregate?.metrics ?? []) {
    if (m.col !== undefined && m.fn !== 'count' && m.fn !== 'min' && m.fn !== 'max' && schema[m.col] !== 'number') {
      return { ok: false, error: `${m.fn}('${m.col}') needs a number column — '${m.col}' is ${schema[m.col]}` };
    }
  }
  for (const w of q.where ?? []) {
    if (w.op === 'contains' && schema[w.col] !== 'string') {
      return { ok: false, error: `contains works on string columns — '${w.col}' is ${schema[w.col]}` };
    }
  }

  // WHERE fragments: parameterized column and value; null cells never match.
  const cond = (w: NonNullable<DatasetQuery['where']>[number]): postgres.PendingQuery<postgres.Row[]> => {
    const a = accessor(sql, w.col, schema[w.col]!);
    const v = schema[w.col] === 'number' ? Number(w.value) : schema[w.col] === 'boolean' ? w.value === true || w.value === 'true' : String(w.value);
    switch (w.op) {
      case 'eq': return sql`${a} = ${v}`;
      case 'ne': return sql`${a} <> ${v}`;
      case 'gt': return sql`${a} > ${v}`;
      case 'gte': return sql`${a} >= ${v}`;
      case 'lt': return sql`${a} < ${v}`;
      case 'lte': return sql`${a} <= ${v}`;
      case 'contains': return sql`${a} ilike '%' || ${String(w.value)} || '%'`;
    }
  };
  const whereFrag = (q.where ?? []).reduce(
    (acc, w) => sql`${acc} and ${cond(w)}`,
    sql`r.dataset_id = ${dataset.id} and r.org_id = ${input.orgId}`,
  );

  const limit = q.limit ?? DEFAULT_LIMIT;

  if (q.aggregate) {
    const groupBy = q.aggregate.groupBy ?? [];
    // Select list: group cols plus metrics keyed by fn[_col].
    let select = sql``;
    let first = true;
    const comma = (): postgres.PendingQuery<postgres.Row[]> => (first ? sql`` : sql`, `);
    for (const gcol of groupBy) {
      select = sql`${select}${comma()}${accessor(sql, gcol, schema[gcol]!)} as ${sql(gcol)}`;
      first = false;
    }
    for (const m of q.aggregate.metrics) {
      const key = m.col !== undefined ? `${m.fn}_${m.col}` : m.fn;
      const body = m.fn === 'count'
        ? (m.col !== undefined ? sql`count(${accessor(sql, m.col, schema[m.col]!)})` : sql`count(*)`)
        : m.fn === 'sum' ? sql`sum(${accessor(sql, m.col!, 'number')})`
          : m.fn === 'avg' ? sql`avg(${accessor(sql, m.col!, 'number')})`
            : m.fn === 'min' ? sql`min(${accessor(sql, m.col!, schema[m.col!]!)})`
              : sql`max(${accessor(sql, m.col!, schema[m.col!]!)})`;
      select = sql`${select}${comma()}${body} as ${sql(key)}`;
      first = false;
    }
    // Group by ordinal: repeating a parameterized expression gets a fresh $n, so PG cannot match select and group exprs.
    const groupFrag = groupBy.length === 0 ? sql``
      : groupBy.length === 1 ? sql`group by 1`
        : groupBy.length === 2 ? sql`group by 1, 2`
          : groupBy.length === 3 ? sql`group by 1, 2, 3`
            : sql`group by 1, 2, 3, 4`;
    const rows = await sql<Record<string, unknown>[]>`
      select ${select} from dataset_rows r where ${whereFrag} ${groupFrag} limit ${limit}`;
    return { ok: true, rows: rows.map(numericToNumber), total: rows.length };
  }

  // Plain query: full rows plus `_id`, the kernel row id.
  let orderFrag = sql`order by r.created_at asc, r.id asc`;
  if ((q.orderBy ?? []).length > 0) {
    let o = sql``;
    (q.orderBy ?? []).forEach((ob, i) => {
      const dir = ob.dir === 'desc' ? sql`desc` : sql`asc`;
      o = i === 0 ? sql`${accessor(sql, ob.col, schema[ob.col]!)} ${dir}` : sql`${o}, ${accessor(sql, ob.col, schema[ob.col]!)} ${dir}`;
    });
    orderFrag = sql`order by ${o}`;
  }
  const [head] = await sql<{ n: string }[]>`
    select count(*) as n from dataset_rows r where ${whereFrag}`;
  const rows = await sql<{ id: string; row: Record<string, unknown> }[]>`
    select r.id, r.row from dataset_rows r where ${whereFrag} ${orderFrag} limit ${limit}`;
  return {
    ok: true,
    rows: rows.map((r) => ({ _id: r.id, ...r.row })),
    total: Number(head?.n ?? 0),
  };
}

/** postgres.js returns numeric aggregates as strings — display consumers want numbers. */
function numericToNumber(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = typeof v === 'string' && v !== '' && !Number.isNaN(Number(v)) && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
  }
  return out;
}
