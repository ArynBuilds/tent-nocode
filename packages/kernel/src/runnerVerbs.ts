import type postgres from 'postgres';
import { projectArm } from './containment.js';

// Runner verbs: the small SQL reads and flips the runner needs, one implementation for every mouth.

/** Persist the run's worktree-swapped permission rules. */
export async function persistRunPermissionRules(sql: postgres.Sql, runId: string, rules: unknown): Promise<void> {
  await sql`update runs set permission_rules = ${sql.json(rules as never)}
    where id = ${runId}`;
}

/** Is another live run holding this real folder? */
export async function hasRunningFolderOwner(sql: postgres.Sql, runId: string, realDir: string): Promise<boolean> {
  const [owner] = await sql<{ id: string }[]>`
    select rr.id from runs rr
    where rr.status = 'running' and rr.id <> ${runId}
      and rr.workspace_path is not null
      and lower(rtrim(rr.workspace_path, '\\/')) = lower(rtrim(${realDir}, '\\/'))
    limit 1`;
  return owner !== undefined;
}

export async function clearRunIsolation(sql: postgres.Sql, runId: string): Promise<void> {
  await sql`update runs set isolation = null where id = ${runId}`;
}

export async function stampRunModel(sql: postgres.Sql, runId: string, model: string | null): Promise<void> {
  await sql`update runs set model = ${model} where id = ${runId}`;
}

/** Flip a delivered run to failed with the mechanical evidence. */
export async function failDeliveredRun(sql: postgres.Sql, runId: string, evidence: string): Promise<void> {
  await sql`update runs set status = 'failed', failure = ${evidence.slice(0, 900)}
    where id = ${runId} and status = 'succeeded'`;
}

/** Count the write-class surface tool invocations this run made: edit is the one write door. */
export async function countRunSurfaceWrites(sql: postgres.Sql, orgId: string, runId: string): Promise<number> {
  const [surfaceWrites] = await sql<{ n: string }[]>`
    select count(*) as n from events
    where org_id = ${orgId} and type = 'surface.tool_invoked'
      and payload->>'runId' = ${runId}
      and payload->>'tool' = 'edit'`;
  return Number(surfaceWrites?.n ?? 0);
}

export async function getRunStatus(sql: postgres.Sql, runId: string): Promise<string | null> {
  const [row] = await sql<{ status: string }[]>`select status from runs where id = ${runId}`;
  return row?.status ?? null;
}

/** Append a merge-conflict note to the run's stored output. */
export async function appendMergeConflictNote(sql: postgres.Sql, runId: string, note: string): Promise<void> {
  await sql`
    update runs set output = jsonb_set(coalesce(output, '{}'::jsonb), '{result}',
      to_jsonb(coalesce(output->>'result', '') || ${note}))
    where id = ${runId}`;
}

/** Rewrite pending path_keys from worktree to real path before confirm. */
export async function rewriteDerivedOutputPathKeys(
  sql: postgres.Sql, orgId: string, runId: string, from: string, to: string,
): Promise<void> {
  await sql`update derived_outputs
    set path_key = replace(path_key, ${from}, ${to})
    where org_id = ${orgId} and run_id = ${runId} and status = 'pending'`;
}

/** List every org id for sweep lanes. */
export async function listOrgIds(sql: postgres.Sql): Promise<string[]> {
  const orgRows = await sql<{ id: string }[]>`select id from orgs order by id`;
  return orgRows.map((o) => o.id);
}

/** The run's liveness plus its folder. */
export async function getRunWorkspace(
  sql: postgres.Sql, runId: string,
): Promise<{ status: string; workspacePath: string | null } | null> {
  const [row] = await sql<{ status: string; workspace_path: string | null }[]>`
    select status, workspace_path from runs where id = ${runId}`;
  return row === undefined ? null : { status: row.status, workspacePath: row.workspace_path };
}

/** Count a dataset's rows. */
export async function countDatasetRows(
  sql: postgres.Sql, orgId: string, projectId: string | null, dataset: string,
): Promise<number> {
  const [head] = await sql<{ n: string }[]>`
    select count(*) as n from dataset_rows r join datasets d on d.id = r.dataset_id
    where d.org_id = ${orgId} and ${projectArm(sql, projectId, 'd')} and d.name = ${dataset} and d.deleted_at is null`;
  return Number(head?.n ?? 0);
}

// One keyset page. The cursor keeps created_at as text end to end: a JS Date roundtrip
// truncates microseconds and duplicates rows, and the ::text::timestamptz double cast is load-bearing.
export async function readDatasetRowsPage(
  sql: postgres.Sql, orgId: string, projectId: string | null, dataset: string,
  cursor: { ca: string; id: string } | null, pageSize: number,
): Promise<Array<{ id: string; ca: string; row: unknown }>> {
  return cursor
    ? await sql<{ id: string; ca: string; row: unknown }[]>`
        select r.id, r.created_at::text as ca, r.row
        from dataset_rows r join datasets d on d.id = r.dataset_id
        where d.org_id = ${orgId} and ${projectArm(sql, projectId, 'd')} and d.name = ${dataset} and d.deleted_at is null
          and (r.created_at, r.id) > (${cursor.ca}::text::timestamptz, ${cursor.id}::uuid)
        order by r.created_at asc, r.id asc limit ${pageSize}`
    : await sql<{ id: string; ca: string; row: unknown }[]>`
        select r.id, r.created_at::text as ca, r.row
        from dataset_rows r join datasets d on d.id = r.dataset_id
        where d.org_id = ${orgId} and ${projectArm(sql, projectId, 'd')} and d.name = ${dataset} and d.deleted_at is null
        order by r.created_at asc, r.id asc limit ${pageSize}`;
}

/** The org's active folder grant paths (folder: subjects in the one consent store). */
export async function listFolderGrantPaths(sql: postgres.Sql, orgId: string): Promise<string[]> {
  const grants = await sql<{ subject: string }[]>`
    select subject from consent_grants where org_id = ${orgId} and subject like 'folder:%' and revoked_at is null`;
  return grants.map((g) => g.subject.slice('folder:'.length));
}

/** The open runtime_approval escalation for this run and action, if any. */
export async function findOpenRuntimeApproval(
  sql: postgres.Sql, orgId: string, runId: string, action: string,
): Promise<string | null> {
  const [open] = await sql<{ id: string }[]>`
    select id from messages
    where org_id = ${orgId} and type = 'escalation'
      and payload->>'kind' = 'runtime_approval'
      and payload->>'runId' = ${runId} and payload->>'action' = ${action}
      and answered_at is null
    order by created_at desc limit 1`;
  return open?.id ?? null;
}

/** The thread's project id. */
export async function getThreadProjectId(sql: postgres.Sql, orgId: string, threadId: string): Promise<string | null> {
  const [row] = await sql<{ project_id: string | null }[]>`
    select project_id from threads where id = ${threadId} and org_id = ${orgId}`;
  return row?.project_id ?? null;
}
