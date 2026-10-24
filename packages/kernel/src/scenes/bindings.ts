import type postgres from 'postgres';
import {
  SYSTEM_TABLE_SCHEMAS, bindingWithRowKey, isSystemQueryTable,
  type AssetBinding, type DatasetQuery, type QueryBinding, type SceneBinding, type SystemQueryTable,
} from '@nodeloom/core';
import { queryDatasetRows } from '../tabs/datasetQuery.js';
import { resolveMediaFiles } from '../tabs/media.js';

// THE ONE EXECUTOR (Phase 12, ruling 8): query -> datasetQuery (the filter runs in SQL once, never again in
// JS), asset -> the rows a URL is minted for, clock -> the tick. PostgREST's shape: the binding is the plan,
// the executor renders it to one statement per table.

export interface SceneBindingResult {
  binding: string;
  kind: SceneBinding['kind'];
  rows: Record<string, unknown>[];
  /** The honest notice line (a media cap, a missing grant); null when nothing needs saying. */
  text: string | null;
  /** Clock bindings alone: the cadence the host re-mints the now row on. */
  tick?: number;
}

const DEFAULT_LIMIT = 200;

/** Runs one declared binding inside the scene's project; a rowKey folds into a query binding's where. */
export async function executeSceneBinding(
  sql: postgres.Sql, orgId: string, binding: SceneBinding,
  /** The hosting scene's project; null = the serving/whole-account lane. */
  projectId: string | null = null,
  opts: { rowKey?: string } = {},
): Promise<SceneBindingResult> {
  switch (binding.kind) {
    case 'query': return executeQuery(sql, orgId, bindingWithRowKey(binding, opts.rowKey), projectId);
    case 'asset': return executeAsset(sql, orgId, binding);
    case 'clock': return { binding: binding.name, kind: 'clock', rows: [nowRow()], text: null, tick: binding.intervalMs };
  }
}

/** The injected now row; the engine re-mints it on the binding's tick. */
export function nowRow(): Record<string, unknown> {
  const now = new Date();
  return { iso: now.toISOString(), epochMs: now.getTime() };
}

async function executeQuery(sql: postgres.Sql, orgId: string, b: QueryBinding, projectId: string | null): Promise<SceneBindingResult> {
  const query: DatasetQuery = { ...(b.query ?? {}), limit: b.query?.limit ?? DEFAULT_LIMIT };
  if (isSystemQueryTable(b.table)) {
    const rows = await querySystemRows(sql, orgId, b.table, query);
    return { binding: b.name, kind: 'query', rows, text: null };
  }
  const res = await queryDatasetRows(sql, { orgId, projectId, dataset: b.table, query });
  if (!res.ok) return { binding: b.name, kind: 'query', rows: [], text: res.error };
  return { binding: b.name, kind: 'query', rows: res.rows, text: null };
}

/** A system table's accessor map: the closed column set the grammar may name; values stay bound parameters. */
function systemColumn(sql: postgres.Sql, table: SystemQueryTable, col: string): postgres.PendingQuery<postgres.Row[]> {
  // The column names are the fixed schema's keys, checked by the contract before they reach here.
  const c = sql(col);
  if (table === 'runs' && col === 'thread_id') return sql`r.thread_id::text`;
  if (col === 'id' && table !== 'events') return sql`r.id::text`;
  return sql`r.${c}`;
}

/** The one statement over a system table: the same where/orderBy/limit grammar over fixed columns (no aggregate arm - the tables are records, not measures). */
async function querySystemRows(sql: postgres.Sql, orgId: string, table: SystemQueryTable, q: DatasetQuery): Promise<Record<string, unknown>[]> {
  const schema = SYSTEM_TABLE_SCHEMAS[table];
  const cols = Object.keys(schema);
  let where = table === 'agents' ? sql`r.org_id = ${orgId} and r.reserved is null` : sql`r.org_id = ${orgId}`;
  for (const w of q.where ?? []) {
    if (!(w.col in schema)) continue;
    const a = systemColumn(sql, table, w.col);
    const v = schema[w.col] === 'number' ? Number(w.value) : String(w.value);
    switch (w.op) {
      case 'eq': where = sql`${where} and ${a} = ${v}`; break;
      case 'ne': where = sql`${where} and ${a} <> ${v}`; break;
      case 'gt': where = sql`${where} and ${a} > ${v}`; break;
      case 'gte': where = sql`${where} and ${a} >= ${v}`; break;
      case 'lt': where = sql`${where} and ${a} < ${v}`; break;
      case 'lte': where = sql`${where} and ${a} <= ${v}`; break;
      case 'contains': where = sql`${where} and ${a}::text ilike '%' || ${String(w.value)} || '%'`; break;
    }
  }
  let order = table === 'agents' ? sql`order by r.created_at asc, r.id asc` : sql`order by r.created_at desc, r.id desc`;
  const orderBy = (q.orderBy ?? []).filter((o) => o.col in schema);
  if (orderBy.length > 0) {
    let o = sql``;
    orderBy.forEach((ob, i) => {
      const dir = ob.dir === 'desc' ? sql`desc` : sql`asc`;
      o = i === 0 ? sql`${systemColumn(sql, table, ob.col)} ${dir}` : sql`${o}, ${systemColumn(sql, table, ob.col)} ${dir}`;
    });
    order = sql`order by ${o}`;
  }
  const limit = q.limit ?? DEFAULT_LIMIT;
  const select = cols.map((c) => sql`${systemColumn(sql, table, c)} as ${sql(c)}`).reduce((acc, frag, i) => (i === 0 ? frag : sql`${acc}, ${frag}`));
  const rows = table === 'events'
    ? await sql<Record<string, unknown>[]>`select ${select}, r.payload from events r where ${where} ${order} limit ${limit}`
    : table === 'runs'
      ? await sql<Record<string, unknown>[]>`select ${select} from runs r where ${where} ${order} limit ${limit}`
      : await sql<Record<string, unknown>[]>`select ${select} from agents r where ${where} ${order} limit ${limit}`;
  return rows.map(plain);
}

/** Media rows name files under a granted folder (the host mints their URLs); array and raster rows are one summary row each. */
async function executeAsset(sql: postgres.Sql, orgId: string, b: AssetBinding): Promise<SceneBindingResult> {
  if (b.asset === 'media') {
    if (b.source.from !== 'folder') return { binding: b.name, kind: 'asset', rows: [], text: 'a media asset reads a folder' };
    // Names/mime/bytes and the notice only; absolute paths never leave the host process.
    const { files, notice } = await resolveMediaFiles(sql, { orgId, folder: b.source.folder, select: b.source.select });
    return { binding: b.name, kind: 'asset', rows: files.map((f) => ({ file: f.file, bytes: f.bytes, mime: f.mime })), text: notice };
  }
  const source = b.source.from === 'output' ? b.source.output : b.source.from === 'file' ? `${b.source.folder}/${b.source.file}` : b.source.folder;
  if (b.asset === 'array') {
    const d = b.descriptor;
    return {
      binding: b.name, kind: 'asset', text: null,
      rows: [{ source, dtype: d?.dtype ?? null, shape: d?.shape ?? [], axes: d?.axes ?? [], units: d?.units ?? null }],
    };
  }
  return { binding: b.name, kind: 'asset', text: null, rows: [{ source, format: b.format ?? null }] };
}

/** postgres.js row objects are plain enough, but Dates and bigints must serialize deterministically for the port. */
function plain(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = v instanceof Date ? v.toISOString() : typeof v === 'bigint' ? v.toString() : v;
  }
  return out;
}
