import type postgres from 'postgres';
import { emitEvent } from '../events.js';
import { projectArm } from '../containment.js';
import { deleteScene } from '../scenes/store.js';
import { deleteTab } from '../tabs/model.js';

// Human delete doors for tables, threads, and projects: every delete is a tombstone plus an event, never a hard drop.

const ACTOR = 'kernel.human';

/** Tombstones a dataset; its rows survive underneath and the row count is returned. */
export async function deleteDatasetHuman(
  sql: postgres.Sql, input: { orgId: string; projectId: string | null; name: string; by: string },
): Promise<{ ok: true; rows: number } | { ok: false; error: string }> {
  const [d] = await sql<{ id: string }[]>`
    select id from datasets
    where org_id = ${input.orgId} and ${projectArm(sql, input.projectId)} and name = ${input.name} and deleted_at is null`;
  if (!d) return { ok: false, error: `no table named '${input.name}'` };
  // A connection's inside tables cannot be deleted on their own.
  const [owner] = await sql<{ label: string }[]>`
    select label from integration_connections
    where org_id = ${input.orgId} and revoked_at is null
      and exists (
        select 1 from jsonb_each_text(coalesce(inside->'tables', '{}'::jsonb)) kv
        where kv.value = ${input.name})`;
  if (owner) return { ok: false, error: `'${input.name}' belongs to the ${owner.label} connection - delete that node instead` };
  const [cnt] = await sql<{ n: string }[]>`select count(*) as n from dataset_rows where dataset_id = ${d.id}`;
  const rows = Number(cnt?.n ?? 0);
  await sql`update datasets set deleted_at = now() where id = ${d.id}`;
  await emitEvent(sql, {
    orgId: input.orgId, actor: ACTOR, type: 'dataset.deleted',
    payload: { datasetId: d.id, name: input.name, rows, by: input.by },
  });
  return { ok: true, rows };
}

/** Tombstones a scene and every tab hosting it. */
export async function deleteSceneHuman(
  sql: postgres.Sql, input: { orgId: string; sceneSlug: string; by: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const [scene] = await sql<{ id: string }[]>`
    select id from scenes where org_id = ${input.orgId} and slug = ${input.sceneSlug} and status != 'deleted'`;
  if (!scene) return { ok: false, error: `no screen at '${input.sceneSlug}'` };
  const tabs = await sql<{ slug: string }[]>`
    select slug from tabs where org_id = ${input.orgId} and scene_id = ${scene.id} and status != 'deleted'`;
  for (const tab of tabs) {
    await deleteTab(sql, { orgId: input.orgId, tabSlug: tab.slug, reason: 'its screen was deleted' });
  }
  await deleteScene(sql, { orgId: input.orgId, sceneSlug: input.sceneSlug, reason: 'deleted by the user' });
  return { ok: true };
}

/** Tombstones a thread; jobs, runs, and messages stay on the record. */
export async function deleteThreadHuman(
  sql: postgres.Sql, input: { orgId: string; threadId: string; by: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const rows = await sql<{ id: string }[]>`
    update threads set deleted_at = now()
    where id = ${input.threadId} and org_id = ${input.orgId} and deleted_at is null
    returning id`;
  if (!rows[0]) return { ok: false, error: 'thread not found' };
  await emitEvent(sql, {
    orgId: input.orgId, actor: ACTOR, type: 'thread.deleted',
    payload: { threadId: input.threadId, by: input.by },
  });
  return { ok: true };
}

/** Deletes a project and cascades to everything it contains; the manifest on the event lets restore flip back exactly this subtree. */
export async function deleteProjectHuman(
  sql: postgres.Sql, input: { orgId: string; projectId: string; by: string },
): Promise<{ ok: true; scenes: number; threads: number } | { ok: false; error: string }> {
  const [p] = await sql<{ id: string; name: string }[]>`
    select id, name from projects where id = ${input.projectId} and org_id = ${input.orgId} and archived_at is null`;
  if (!p) return { ok: false, error: 'project not found' };

  // Manifest entries restore as 'active' regardless of prior status.
  const tabs = await sql<{ id: string }[]>`
    update tabs set status = 'deleted', deleted_at = now()
    where org_id = ${input.orgId} and project_id = ${input.projectId} and status != 'deleted'
    returning id`;
  const scenes = await sql<{ id: string }[]>`
    update scenes set status = 'deleted', deleted_at = now()
    where org_id = ${input.orgId} and project_id = ${input.projectId} and status != 'deleted'
    returning id`;
  const threads = await sql<{ id: string }[]>`
    update threads set deleted_at = now()
    where org_id = ${input.orgId} and project_id = ${input.projectId} and deleted_at is null
    returning id`;
  const datasets = await sql<{ id: string }[]>`
    update datasets set deleted_at = now()
    where org_id = ${input.orgId} and project_id = ${input.projectId} and deleted_at is null
    returning id`;
  const notes = await sql<{ id: string }[]>`
    update project_notes set deleted_at = now()
    where org_id = ${input.orgId} and project_id = ${input.projectId} and deleted_at is null
    returning id`;
  const triggers = await sql<{ id: string }[]>`
    update triggers set revoked_at = now()
    where org_id = ${input.orgId} and project_id = ${input.projectId} and revoked_at is null
    returning id`;
  const chains = await sql<{ id: string }[]>`
    update reactive_chains set revoked_at = now()
    where org_id = ${input.orgId} and project_id = ${input.projectId} and revoked_at is null
    returning id`;
  const operations = await sql<{ id: string }[]>`
    update operations set status = 'retired'
    where org_id = ${input.orgId} and project_id = ${input.projectId} and status = 'active'
    returning id`;

  await sql`update projects set archived_at = now() where id = ${input.projectId}`;
  await emitEvent(sql, {
    orgId: input.orgId, actor: ACTOR, type: 'project.deleted',
    payload: {
      projectId: input.projectId, name: p.name,
      scenes: scenes.length, threads: threads.length, datasets: datasets.length, by: input.by,
      // Restore manifest read back by human/trash.ts.
      cascade: {
        tabs: tabs.map((t) => ({ id: t.id, status: 'active' })),
        scenes: scenes.map((s) => ({ id: s.id, status: 'active' })),
        threads: threads.map((t) => ({ id: t.id })),
        datasets: datasets.map((d) => ({ id: d.id })),
        notes: notes.map((n) => ({ id: n.id })),
        triggers: triggers.map((t) => ({ id: t.id })),
        chains: chains.map((c) => ({ id: c.id })),
        operations: operations.map((o) => ({ id: o.id })),
      },
    },
  });
  return { ok: true, scenes: scenes.length, threads: threads.length };
}
