// Import doors: pull a service's data once, page by page, and land it as an ordinary Table.
import type postgres from 'postgres';
import { emitEvent } from '../events.js';
import { ensureDataset, landRowsOutput } from '../tabs/datasets.js';
import { resolveIntegrationDef, type IntegrationDef } from './catalog.js';
import { getIntegrationConnection } from './connections.js';
import { runIntegrationCall, type IntegrationExecutionRow } from './dispatch.js';
import { pickPath } from './executor.js';

const ACTOR = 'kernel.integrations';
const KEBAB_RE = /^[a-z][a-z0-9-]*$/;

export interface IntegrationImportRow {
  id: string;
  org_id: string;
  project_id: string;
  connection_id: string;
  integration: string;
  dataset: string;
  params: Record<string, string | number | boolean>;
  status: 'pending' | 'running' | 'done' | 'failed';
  cursor: string | null;
  pages: number;
  rows_landed: number;
  error: string | null;
  created_by: string;
  created_at: Date;
  finished_at: Date | null;
}

export type StartImportResult = { ok: true; importId: string } | { ok: false; refusal: string };

// Start an import: one at a time per connection; the def must declare a door.
export async function startIntegrationImport(
  sql: postgres.Sql,
  input: { orgId: string; connectionId: string; dataset?: string; params?: Record<string, string | number | boolean>; createdBy: string },
): Promise<StartImportResult> {
  const connection = await getIntegrationConnection(sql, input.orgId, input.connectionId);
  if (!connection || connection.revoked_at) return { ok: false, refusal: 'that connection is already gone' };
  if (connection.status !== 'active') return { ok: false, refusal: `${connection.label} is not connected yet - connect it first` };
  const def = resolveIntegrationDef(connection.integration, connection.version);
  if (!def) return { ok: false, refusal: `"${connection.integration}" is not in the integration catalog` };
  if (!def.importDoor) return { ok: false, refusal: `${def.displayName} has no import door` };
  const dataset = input.dataset?.trim() || `${def.name}-imported`;
  if (!KEBAB_RE.test(dataset)) return { ok: false, refusal: 'the table name must be plain kebab words, like imported-orders' };
  const [inFlight] = await sql<{ id: string }[]>`
    select id from integration_imports
    where connection_id = ${connection.id} and status in ('pending', 'running')`;
  if (inFlight) return { ok: false, refusal: `${def.displayName} is already importing - let it finish first` };
  const [row] = await sql<{ id: string }[]>`
    insert into integration_imports (org_id, project_id, connection_id, integration, dataset, params, created_by)
    values (${input.orgId}, ${connection.project_id}, ${connection.id}, ${def.name}, ${dataset},
            ${sql.json((input.params ?? {}) as postgres.JSONValue)}, ${input.createdBy})
    returning id`;
  if (!row) return { ok: false, refusal: 'the import could not be saved' };
  await emitEvent(sql, {
    orgId: input.orgId, actor: ACTOR, type: 'integration.import_started',
    payload: { importId: row.id, integration: def.name, dataset },
  });
  return { ok: true, importId: row.id };
}

export async function listIntegrationImports(
  sql: postgres.Sql,
  input: { orgId: string; connectionId?: string },
): Promise<IntegrationImportRow[]> {
  if (input.connectionId !== undefined) {
    return sql<IntegrationImportRow[]>`
      select * from integration_imports
      where org_id = ${input.orgId} and connection_id = ${input.connectionId}
      order by created_at desc limit 20`;
  }
  return sql<IntegrationImportRow[]>`
    select * from integration_imports where org_id = ${input.orgId} order by created_at desc limit 50`;
}

async function failImport(sql: postgres.Sql, imp: { id: string; org_id: string }, error: string): Promise<void> {
  await sql`
    update integration_imports set status = 'failed', error = ${error.slice(0, 900)}, finished_at = now()
    where id = ${imp.id} and status in ('pending', 'running')`;
  await emitEvent(sql, { orgId: imp.org_id, actor: ACTOR, type: 'integration.import_failed', payload: { importId: imp.id } });
}

// Queue the next page; shared by the sweep and the settle-time chain.
async function queueImportPage(sql: postgres.Sql, imp: IntegrationImportRow, def: IntegrationDef): Promise<boolean> {
  const door = def.importDoor;
  if (!door) return false;
  const params: Record<string, string | number | boolean> = { ...imp.params };
  if (door.page?.kind === 'cursor' && imp.cursor !== null) params[door.page.param] = imp.cursor;
  if (door.page?.kind === 'offset') {
    params[door.page.param] = imp.pages * door.page.size;
    const endpoint = def.endpoints.find((e) => e.id === door.endpoint);
    if (endpoint && 'limit' in endpoint.params && params['limit'] === undefined) params['limit'] = door.page.size;
  }
  const res = await runIntegrationCall(sql, {
    orgId: imp.org_id, connectionId: imp.connection_id, endpoint: door.endpoint,
    params, trigger: { kind: 'import', importId: imp.id }, createdBy: 'import',
  });
  if (!res.ok) {
    await failImport(sql, imp, res.refusal);
    return false;
  }
  return true;
}

// One sweep tick: drive every open import one page forward; returns pages queued.
export async function sweepDueImports(sql: postgres.Sql): Promise<number> {
  const open = await sql<IntegrationImportRow[]>`
    select * from integration_imports where status in ('pending', 'running')`;
  let queued = 0;
  for (const imp of open) {
    const [last] = await sql<{ status: string; error: string | null; n: string }[]>`
      select status, error, count(*) over () as n from integration_executions
      where trigger->>'importId' = ${imp.id}
      order by created_at desc limit 1`;
    if (last?.status === 'pending' || last?.status === 'running') continue; // a page is in flight
    if (last?.status === 'failed') {
      await failImport(sql, imp, last.error ?? 'the pull failed');
      continue;
    }
    // Runaway brake: pull count far past landed pages means the landing keeps stalling.
    if (last && Number(last.n) > imp.pages + 3) {
      await failImport(sql, imp, 'the pull kept answering but nothing landed - the import stopped');
      continue;
    }
    const def = resolveIntegrationDef(imp.integration);
    if (!def || !def.importDoor) {
      await failImport(sql, imp, `"${imp.integration}" no longer declares an import door`);
      continue;
    }
    if (imp.status === 'pending') {
      await sql`update integration_imports set status = 'running' where id = ${imp.id} and status = 'pending'`;
    }
    if (await queueImportPage(sql, imp, def)) queued += 1;
  }
  return queued;
}

const scalar = (v: unknown): v is string | number | boolean =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

// One element to one flat row of scalars; top-level wins on a name clash.
function flattenElement(el: Record<string, unknown>, elementAt?: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (elementAt !== undefined) {
    const nested = pickPath(el, elementAt);
    if (nested !== null && typeof nested === 'object' && !Array.isArray(nested)) {
      for (const [k, v] of Object.entries(nested as Record<string, unknown>)) if (scalar(v)) out[k] = v;
    }
  }
  for (const [k, v] of Object.entries(el)) if (scalar(v)) out[k] = v;
  return out;
}

// Land one page at settle time: extract rows, hold the schema contract, upsert by key, advance or finish.
export async function landImportPage(
  sql: postgres.Sql,
  claim: IntegrationExecutionRow,
  def: IntegrationDef,
  rawBody: unknown,
): Promise<void> {
  const importId = (claim.trigger as Record<string, unknown>)['importId'];
  if (typeof importId !== 'string') return;
  const [imp] = await sql<IntegrationImportRow[]>`
    select * from integration_imports where id = ${importId} and status = 'running'`;
  const door = def.importDoor;
  if (!imp || !door) return;

  const body = rawBody !== null && typeof rawBody === 'object' ? rawBody : null;
  const arr = door.fromArray === '.' ? rawBody : body === null ? null : pickPath(body as Record<string, unknown>, door.fromArray);
  if (!Array.isArray(arr)) {
    await failImport(sql, imp, `${def.displayName} answered without the expected rows`);
    return;
  }
  const elements = arr.filter((el): el is Record<string, unknown> => el !== null && typeof el === 'object' && !Array.isArray(el));
  const flat = elements.map((el) => flattenElement(el, door.elementAt));

  if (flat.length > 0) {
    // Stored schema wins; first contact infers from the rows themselves.
    const [existing] = await sql<{ row_schema: Record<string, 'string' | 'number' | 'boolean'> }[]>`
      select row_schema from datasets
      where org_id = ${imp.org_id} and project_id = ${imp.project_id} and name = ${imp.dataset} and deleted_at is null`;
    let schema = existing?.row_schema;
    if (!schema) {
      const inferred: Record<string, 'string' | 'number' | 'boolean'> = {};
      for (const row of flat) {
        for (const [k, v] of Object.entries(row)) {
          if (inferred[k] === undefined && scalar(v)) inferred[k] = typeof v as 'string' | 'number' | 'boolean';
        }
      }
      if (inferred[door.keyColumn] === undefined) {
        await failImport(sql, imp, `the rows carry no "${door.keyColumn}" column to key on`);
        return;
      }
      await ensureDataset(sql, { orgId: imp.org_id, projectId: imp.project_id, name: imp.dataset, rowSchema: inferred, keyColumns: [door.keyColumn] });
      schema = inferred;
    }
    if (!(door.keyColumn in schema)) {
      await failImport(sql, imp, `the table "${imp.dataset}" has no "${door.keyColumn}" column to key on`);
      return;
    }
    // Rows project onto the contract: mistyped or absent values land as null; undeclared fields drop.
    const projected = flat
      .map((row) => {
        const out: Record<string, unknown> = {};
        for (const [k, t] of Object.entries(schema)) {
          const v = row[k];
          out[k] = v !== undefined && typeof v === t ? v : null;
        }
        return out;
      })
      .filter((row) => row[door.keyColumn] !== undefined && row[door.keyColumn] !== null);
    if (projected.length > 0) {
      const landed = await landRowsOutput(sql, {
        orgId: imp.org_id, projectId: imp.project_id, executionId: claim.id,
        operation: `import:${def.name}`, dataset: imp.dataset, key: door.keyColumn,
        columns: schema, rows: projected,
      });
      if (!landed.ok) {
        await failImport(sql, imp, landed.reason);
        return;
      }
      await sql`
        update integration_imports set rows_landed = rows_landed + ${landed.inserted + landed.updated}
        where id = ${imp.id}`;
    }
  }

  // Advance or finish: empty page, gone cursor, or short offset page ends the import.
  let done = false;
  let cursor: string | null = null;
  if (!door.page || elements.length === 0) done = true;
  else if (door.page.kind === 'cursor') {
    const next = body === null ? null : pickPath(body as Record<string, unknown>, door.page.pick);
    if (next === null || next === undefined || next === '' || next === false) done = true;
    else cursor = String(next);
  } else if (elements.length < door.page.size) done = true;
  if (done) {
    await sql`
      update integration_imports set status = 'done', pages = pages + 1, cursor = null, finished_at = now()
      where id = ${imp.id} and status = 'running'`;
    await emitEvent(sql, {
      orgId: imp.org_id, actor: ACTOR, type: 'integration.import_done',
      payload: { importId: imp.id, integration: def.name, dataset: imp.dataset },
    });
  } else {
    await sql`
      update integration_imports set pages = pages + 1, cursor = ${cursor}
      where id = ${imp.id} and status = 'running'`;
    // Queue the next page immediately so vendor cursors never idle out; the sweep is the recovery lane.
    const [advanced] = await sql<IntegrationImportRow[]>`
      select * from integration_imports where id = ${imp.id} and status = 'running'`;
    if (advanced) await queueImportPage(sql, advanced, def);
  }
}
