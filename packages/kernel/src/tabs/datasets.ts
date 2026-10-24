import { z } from 'zod';
import type postgres from 'postgres';
import { KEBAB_RE } from '@nodeloom/core';
import { emitEvent } from '../events.js';
import { projectArm } from '../containment.js';

// Dataset writes: every row is verified against the declared schema; same name + different schema over stored rows throws.

type RowSchema = Record<string, 'string' | 'number' | 'boolean'>;

// Datasets are project-scoped; `projectId: null` is the serving/whole-account lane only.

export interface DatasetAppend { dataset: string; rows: Record<string, unknown>[]; schema?: RowSchema }

const rowSchemaSchema = z.record(z.enum(['string', 'number', 'boolean']));

// Per-append bounds: at most 100 rows, 2KB per row.
const MAX_ROWS_PER_APPEND = 100;
const MAX_ROW_BYTES = 2 * 1024;

/** The four-grain vocabulary: who sees a table's rows. */
export type DatasetGrain = 'own' | 'shared' | 'submitted' | 'app';
export const DATASET_GRAINS: readonly DatasetGrain[] = ['own', 'shared', 'submitted', 'app'];

export async function ensureDataset(
  sql: postgres.Sql,
  input: { orgId: string; projectId: string | null; name: string; rowSchema: RowSchema; keyColumns?: string[]; userScope?: DatasetGrain },
): Promise<{ datasetId: string }> {
  const rowSchema = rowSchemaSchema.parse(input.rowSchema);
  // Key columns declare the upsert identity; every key must be a declared column.
  if (input.keyColumns !== undefined) {
    for (const k of input.keyColumns) {
      if (!(k in rowSchema)) throw new Error(`key column '${k}' is not in the declared schema`);
    }
  }
  const setKeys = async (datasetId: string): Promise<void> => {
    if (input.keyColumns === undefined || input.keyColumns.length === 0) return;
    await sql`update datasets set key_columns = ${sql.json(input.keyColumns as unknown as postgres.JSONValue)} where id = ${datasetId}`;
  };
  const [existing] = await sql<{ id: string; row_schema: RowSchema }[]>`
    select id, row_schema from datasets
    where org_id = ${input.orgId} and ${projectArm(sql, input.projectId)} and name = ${input.name} and deleted_at is null`;
  if (existing) {
    const same = JSON.stringify(sortedEntries(existing.row_schema)) === JSON.stringify(sortedEntries(rowSchema));
    if (!same) {
      // An empty dataset has no rows to protect: its schema may be replaced.
      const [cnt] = await sql<{ n: string }[]>`
        select count(*) as n from dataset_rows where dataset_id = ${existing.id}`;
      if (Number(cnt?.n ?? 0) > 0) {
        throw new Error(`dataset '${input.name}' exists with a different row schema and ${cnt!.n} stored rows — a dataset's contract never mutates over data; use a new name`);
      }
      await sql`update datasets set row_schema = ${sql.json(rowSchema as unknown as postgres.JSONValue)} where id = ${existing.id}`;
      await emitEvent(sql, {
        orgId: input.orgId, actor: 'kernel.datasets', type: 'dataset.schema_replaced',
        payload: { dataset: input.name, reason: 'empty dataset — no rows to protect' },
      });
    }
    await setKeys(existing.id);
    return { datasetId: existing.id };
  }
  // Live-name uniqueness comes from the per-project partial index; a create race surfaces the unique violation.
  const [row] = await sql<{ id: string }[]>`
    insert into datasets (org_id, project_id, name, row_schema, user_scope, column_order)
    values (${input.orgId}, ${input.projectId}, ${input.name}, ${sql.json(rowSchema as unknown as postgres.JSONValue)}, ${input.userScope ?? 'own'},
            ${sql.array(Object.keys(input.rowSchema))})
    returning id`;
  await setKeys(row!.id);
  return { datasetId: row!.id };
}

function sortedEntries(schema: RowSchema): Array<[string, string]> {
  return Object.entries(schema).sort(([a], [b]) => a.localeCompare(b));
}


function verifyRow(row: Record<string, unknown>, schema: RowSchema, deprecated: readonly string[] = []): string | null {
  for (const [field, type] of Object.entries(schema)) {
    if (!(field in row)) return `missing field '${field}'`;
    // Null is legal for any declared field; a missing key still rejects above.
    if (row[field] === null) continue;
    if (typeof row[field] !== type) return `field '${field}' must be ${type}, got ${typeof row[field]}`;
  }
  for (const key of Object.keys(row)) {
    // Deprecated columns are tolerated on read-back rows, stored as-is.
    if (!(key in schema) && !deprecated.includes(key)) return `extra key '${key}' not in the declared schema`;
  }
  return null;
}

/** Shared validation core: row cap, byte cap, schema check. */
export function validateRows(
  rows: readonly Record<string, unknown>[], schema: RowSchema, deprecated: readonly string[] = [],
): { accepted: Record<string, unknown>[]; rejected: { index: number; reason: string }[] } {
  const rejected: { index: number; reason: string }[] = [];
  const accepted: Record<string, unknown>[] = [];
  rows.forEach((row, index) => {
    if (index >= MAX_ROWS_PER_APPEND) { rejected.push({ index, reason: `row cap: at most ${MAX_ROWS_PER_APPEND} rows per append` }); return; }
    if (Buffer.byteLength(JSON.stringify(row), 'utf8') > MAX_ROW_BYTES) { rejected.push({ index, reason: `row exceeds ${MAX_ROW_BYTES} bytes` }); return; }
    const reason = verifyRow(row, schema, deprecated);
    if (reason) rejected.push({ index, reason });
    else accepted.push(row);
  });
  return { accepted, rejected };
}

/** Upsert core: key-match update (keeping `_id`) or insert; in-batch duplicate keys collapse keep-last. */
async function upsertRows(
  sql: postgres.Sql,
  input: { orgId: string; runId: string | null; datasetId: string; keyColumns: string[]; rows: Record<string, unknown>[]; baseIndexOffset?: number },
): Promise<{ inserted: number; updated: number; rejected: { index: number; reason: string }[] }> {
  const rejected: { index: number; reason: string }[] = [];
  const offset = input.baseIndexOffset ?? 0;
  const byKey = new Map<string, Record<string, unknown>>();
  let inBatchDupes = 0;
  input.rows.forEach((row, i) => {
    for (const k of input.keyColumns) {
      if (row[k] === undefined || row[k] === null) {
        rejected.push({ index: offset + i, reason: `upsert key '${k}' is missing or null on this row` });
        return;
      }
    }
    const key = JSON.stringify(input.keyColumns.map((k) => row[k]));
    if (byKey.has(key)) inBatchDupes++;
    byKey.set(key, row); // keep-last within the batch
  });
  let inserted = 0;
  let updated = inBatchDupes;
  for (const row of byKey.values()) {
    const keyFrag = input.keyColumns.reduce(
      (acc, k) => sql`${acc} and dr.row->>${k} = ${String(row[k])}`,
      sql`dr.org_id = ${input.orgId} and dr.dataset_id = ${input.datasetId}`,
    );
    const hit = await sql<{ id: string }[]>`
      update dataset_rows dr set row = ${sql.json(row as postgres.JSONValue)}, evidence_run_id = ${input.runId}
      where ${keyFrag} returning dr.id`;
    if (hit.length > 0) updated += hit.length;
    else {
      await sql`
        insert into dataset_rows (org_id, dataset_id, row, evidence_run_id)
        values (${input.orgId}, ${input.datasetId}, ${sql.json(row as postgres.JSONValue)}, ${input.runId})`;
      inserted++;
    }
  }
  return { inserted, updated, rejected };
}

const keyColumnsOf = (raw: unknown): string[] | null =>
  Array.isArray(raw) && raw.length > 0 && raw.every((k) => typeof k === 'string') ? (raw as string[]) : null;

/** Read-only peek at a dataset's schema plus a few sample rows. */
export async function peekDataset(
  sql: postgres.Sql,
  input: { orgId: string; projectId: string | null; name: string; limit?: number },
): Promise<{ exists: boolean; schema?: RowSchema; sampleRows: Record<string, unknown>[] }> {
  const [dataset] = await sql<{ id: string; row_schema: RowSchema }[]>`
    select id, row_schema from datasets
    where org_id = ${input.orgId} and ${projectArm(sql, input.projectId)} and name = ${input.name} and deleted_at is null`;
  if (!dataset) return { exists: false, sampleRows: [] };
  const rows = await sql<{ row: Record<string, unknown> }[]>`
    select row from dataset_rows where org_id = ${input.orgId} and dataset_id = ${dataset.id}
    order by id desc limit ${Math.min(input.limit ?? 5, 5000)}`;
  return { exists: true, schema: dataset.row_schema, sampleRows: rows.map((r) => r.row) };
}

/** Full-contents swap in one transaction; replace never creates a dataset. */
export async function replaceDataset(
  sql: postgres.Sql,
  input: { orgId: string; projectId: string | null; runId: string | null; name: string; rows: Record<string, unknown>[] },
): Promise<{ accepted: number; rejected: { index: number; reason: string }[] }> {
  const [dataset] = await sql<{ id: string; row_schema: RowSchema; deprecated_columns: string[] }[]>`
    select id, row_schema, deprecated_columns from datasets
    where org_id = ${input.orgId} and ${projectArm(sql, input.projectId)} and name = ${input.name} and deleted_at is null`;
  if (!dataset) {
    return { accepted: 0, rejected: input.rows.map((_, index) => ({ index, reason: `dataset '${input.name}' is not declared in this project` })) };
  }
  const rejected: { index: number; reason: string }[] = [];
  const accepted: Record<string, unknown>[] = [];
  input.rows.slice(0, 100).forEach((row, index) => {
    // Replace is a read-back path: deprecated columns on old rows pass.
    const reason = verifyRow(row, dataset.row_schema, dataset.deprecated_columns ?? []);
    if (reason) rejected.push({ index, reason });
    else accepted.push(row);
  });
  // The cap rejects named rather than truncating silently.
  for (let i = 100; i < input.rows.length; i++) {
    rejected.push({ index: i, reason: 'exceeds the 100-row replace cap — split into more datasets or replace in batches' });
  }
  await sql.begin(async (tx) => {
    await tx`delete from dataset_rows where org_id = ${input.orgId} and dataset_id = ${dataset.id}`;
    for (const row of accepted) {
      await tx`
        insert into dataset_rows (org_id, dataset_id, row, evidence_run_id)
        values (${input.orgId}, ${dataset.id}, ${tx.json(row as postgres.JSONValue)}, ${input.runId})`;
    }
  });
  await emitEvent(sql, {
    orgId: input.orgId, actor: 'kernel.tabs', type: 'dataset.replace',
    payload: { dataset: input.name, runId: input.runId, accepted: accepted.length, rejected },
  });
  return { accepted: accepted.length, rejected };
}

/** Lands a package's rows whole, uncapped; any reject aborts the whole landing. */
export async function landDatasetRowsWhole(
  sql: postgres.Sql,
  input: { orgId: string; datasetId: string; rows: Record<string, unknown>[] },
): Promise<{ accepted: number; rejected: { index: number; reason: string }[] }> {
  const [dataset] = await sql<{ row_schema: RowSchema; deprecated_columns: string[] }[]>`
    select row_schema, deprecated_columns from datasets where id = ${input.datasetId} and org_id = ${input.orgId}`;
  if (!dataset) return { accepted: 0, rejected: input.rows.map((_, index) => ({ index, reason: 'dataset row vanished mid-landing' })) };
  const rejected: { index: number; reason: string }[] = [];
  const accepted: Record<string, unknown>[] = [];
  input.rows.forEach((row, index) => {
    const reason = verifyRow(row, dataset.row_schema, dataset.deprecated_columns ?? []);
    if (reason) rejected.push({ index, reason });
    else accepted.push(row);
  });
  if (rejected.length > 0) return { accepted: 0, rejected };
  await sql.begin(async (tx) => {
    const CHUNK = 5000;
    for (let i = 0; i < accepted.length; i += CHUNK) {
      const chunk = accepted.slice(i, i + CHUNK);
      await tx`
        insert into dataset_rows (org_id, dataset_id, row, evidence_run_id)
        select ${input.orgId}, ${input.datasetId}, value, ${null}
        from jsonb_array_elements(${tx.json(chunk as postgres.JSONValue)})`;
    }
  });
  return { accepted: accepted.length, rejected: [] };
}

/** Lands an operation's dataset output all-or-nothing: keyed = upsert into an existing table only; unkeyed = create-if-missing, refuses a table with rows. */
export async function landRowsOutput(
  sql: postgres.Sql,
  input: {
    orgId: string; projectId: string | null; executionId: string; operation: string;
    dataset: string; key?: string;
    columns: Record<string, unknown>; rows: unknown[];
  },
): Promise<{ ok: true; inserted: number; updated: number; created: boolean } | { ok: false; reason: string }> {
  if (!KEBAB_RE.test(input.dataset)) {
    return { ok: false, reason: `dataset name must be kebab-case (got '${input.dataset}')` };
  }
  const parsedCols = rowSchemaSchema.safeParse(input.columns);
  if (!parsedCols.success) {
    return { ok: false, reason: 'the rows file declares an invalid columns map (each column: string|number|boolean)' };
  }
  if (input.rows.length > 100_000) {
    return { ok: false, reason: `the rows file has ${input.rows.length} rows — the 100k landing ceiling; split the work` };
  }
  const select = () => sql<{ id: string; row_schema: RowSchema; deprecated_columns: string[] }[]>`
    select id, row_schema, deprecated_columns from datasets
    where org_id = ${input.orgId} and ${projectArm(sql, input.projectId)} and name = ${input.dataset} and deleted_at is null`;
  let [dataset] = await select();
  let created = false;
  if (input.key !== undefined) {
    if (!dataset) {
      return { ok: false, reason: `no table named '${input.dataset}' in this project — a keyed write-back never creates its table` };
    }
    if (!(input.key in dataset.row_schema)) {
      return { ok: false, reason: `key column '${input.key}' is not one of '${input.dataset}'s declared columns` };
    }
    if (input.rows.length > 10_000) {
      return { ok: false, reason: `keyed write-backs cap at 10k rows (got ${input.rows.length}) — split the work` };
    }
  } else if (!dataset) {
    await ensureDataset(sql, { orgId: input.orgId, projectId: input.projectId, name: input.dataset, rowSchema: parsedCols.data });
    [dataset] = await select();
    if (!dataset) return { ok: false, reason: `table '${input.dataset}' vanished mid-landing` };
    created = true;
  } else {
    const [cnt] = await sql<{ n: string }[]>`select count(*) as n from dataset_rows where dataset_id = ${dataset.id}`;
    if (Number(cnt?.n ?? 0) > 0) {
      return { ok: false, reason: `table '${input.dataset}' already has rows — an unkeyed landing never mixes into existing data; use a fresh name or declare a key` };
    }
  }
  // Verify every row against the target's schema before anything lands.
  const accepted: Record<string, unknown>[] = [];
  for (let i = 0; i < input.rows.length; i++) {
    const row = input.rows[i];
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      return { ok: false, reason: `row ${i} is not a JSON object — nothing landed` };
    }
    const r = row as Record<string, unknown>;
    const reason = verifyRow(r, dataset.row_schema, dataset.deprecated_columns ?? []);
    if (reason !== null) return { ok: false, reason: `row ${i}: ${reason} — nothing landed` };
    if (input.key !== undefined && (r[input.key] === undefined || r[input.key] === null)) {
      return { ok: false, reason: `row ${i}: key column '${input.key}' is missing or null — nothing landed` };
    }
    accepted.push(r);
  }
  let inserted = accepted.length;
  let updated = 0;
  if (input.key !== undefined) {
    const key = input.key;
    const up = await sql.begin(async (tx) => upsertRows(tx as unknown as postgres.Sql, {
      orgId: input.orgId, runId: input.executionId, datasetId: dataset.id, keyColumns: [key], rows: accepted,
    }));
    inserted = up.inserted;
    updated = up.updated;
  } else {
    await sql.begin(async (tx) => {
      const CHUNK = 5000;
      for (let i = 0; i < accepted.length; i += CHUNK) {
        const chunk = accepted.slice(i, i + CHUNK);
        await tx`
          insert into dataset_rows (org_id, dataset_id, row, evidence_run_id)
          select ${input.orgId}, ${dataset.id}, value, ${input.executionId}
          from jsonb_array_elements(${tx.json(chunk as postgres.JSONValue)})`;
      }
    });
  }
  await emitEvent(sql, {
    orgId: input.orgId, actor: 'kernel.tabs', type: 'dataset.rows_landed',
    payload: { dataset: input.dataset, operation: input.operation, executionId: input.executionId, inserted, updated, created },
  });
  return { ok: true, inserted, updated, created };
}

export async function recordDatasetAppend(
  sql: postgres.Sql,
  input: { orgId: string; projectId: string | null; runId: string | null; append: DatasetAppend },
): Promise<{ accepted: number; updated?: number; rejected: { index: number; reason: string }[] }> {
  // Dataset names must be kebab-case.
  if (!KEBAB_RE.test(input.append.dataset)) {
    return { accepted: 0, rejected: input.append.rows.map((_, index) => ({ index, reason: `dataset name must be kebab-case (got '${input.append.dataset}')` })) };
  }
  let [dataset] = await sql<{ id: string; row_schema: RowSchema; deprecated_columns: string[]; key_columns: unknown }[]>`
    select id, row_schema, deprecated_columns, key_columns from datasets
    where org_id = ${input.orgId} and ${projectArm(sql, input.projectId)} and name = ${input.append.dataset} and deleted_at is null`;
  // Self-service create: a missing dataset is created from the append's inline schema.
  if (!dataset && input.append.schema) {
    await ensureDataset(sql, { orgId: input.orgId, projectId: input.projectId, name: input.append.dataset, rowSchema: input.append.schema });
    [dataset] = await sql<{ id: string; row_schema: RowSchema; deprecated_columns: string[]; key_columns: unknown }[]>`
      select id, row_schema, deprecated_columns, key_columns from datasets
      where org_id = ${input.orgId} and ${projectArm(sql, input.projectId)} and name = ${input.append.dataset} and deleted_at is null`;
  }
  if (!dataset) {
    return { accepted: 0, rejected: input.append.rows.map((_, index) => ({ index, reason: `dataset '${input.append.dataset}' is not declared in this project` })) };
  }
  // New writes refuse deprecated columns; only read-back paths tolerate them.
  const { accepted, rejected } = validateRows(input.append.rows, dataset.row_schema);
  // Declared key columns turn the append into an upsert.
  const keyCols = keyColumnsOf(dataset.key_columns);
  let insertedCount = accepted.length;
  let updatedCount: number | undefined;
  if (keyCols) {
    const up = await upsertRows(sql, { orgId: input.orgId, runId: input.runId, datasetId: dataset.id, keyColumns: keyCols, rows: accepted });
    insertedCount = up.inserted;
    updatedCount = up.updated;
    rejected.push(...up.rejected);
  } else {
    for (const row of accepted) {
      await sql`
        insert into dataset_rows (org_id, dataset_id, row, evidence_run_id)
        values (${input.orgId}, ${dataset.id}, ${sql.json(row as postgres.JSONValue)}, ${input.runId})`;
    }
  }
  await emitEvent(sql, {
    orgId: input.orgId, actor: 'kernel.tabs', type: 'dataset.append',
    payload: { dataset: input.append.dataset, runId: input.runId, accepted: insertedCount, ...(updatedCount !== undefined ? { updated: updatedCount } : {}), rejected },
  });
  return { accepted: insertedCount, ...(updatedCount !== undefined ? { updated: updatedCount } : {}), rejected };
}

// The dataset grain door (who sees these rows): one settings column, datasets.user_scope, read by the write wall.

/** Sets a dataset's grain; evented with actor user. */
export async function setDatasetGrain(
  sql: postgres.Sql,
  input: { orgId: string; projectId: string | null; dataset: string; grain: DatasetGrain; by: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!DATASET_GRAINS.includes(input.grain)) return { ok: false, error: 'the grain is own, shared, submitted, or app' };
  const [row] = await sql<{ id: string }[]>`
    update datasets set user_scope = ${input.grain}
    where org_id = ${input.orgId} and ${projectArm(sql, input.projectId)} and name = ${input.dataset} and deleted_at is null
    returning id`;
  if (!row) return { ok: false, error: `no table named '${input.dataset}' here` };
  await emitEvent(sql, {
    orgId: input.orgId, actor: 'user', type: 'dataset.grain_set',
    payload: { dataset: input.dataset, grain: input.grain, by: input.by },
  });
  return { ok: true };
}

/** Reads a dataset's current grain. */
export async function datasetGrain(
  sql: postgres.Sql,
  input: { orgId: string; projectId: string | null; dataset: string },
): Promise<DatasetGrain | null> {
  const [row] = await sql<{ user_scope: DatasetGrain }[]>`
    select user_scope from datasets
    where org_id = ${input.orgId} and ${projectArm(sql, input.projectId)} and name = ${input.dataset} and deleted_at is null`;
  return row?.user_scope ?? null;
}
