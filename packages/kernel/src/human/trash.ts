import type postgres from 'postgres';
import { emitEvent } from '../events.js';

// Trash system: tombstones stay restorable for trashDays, then purge hard-deletes content while skeleton rows and events survive.

const ACTOR = 'kernel.trash';

export type TrashKind = 'project' | 'thread' | 'scene' | 'dataset' | 'note';

export interface TrashEntry {
  kind: TrashKind;
  id: string;
  /** Human label for the row: name, title, or body head. */
  label: string;
  deletedAt: string;
}

/** Lists tombstoned items still inside the restore window, newest first; purged skeletons never list. */
export async function listTrash(
  sql: postgres.Sql,
  input: { orgId: string; projectId: string | null; trashDays: number },
): Promise<TrashEntry[]> {
  const days = `${Math.max(1, Math.floor(input.trashDays))} days`;
  const out: TrashEntry[] = [];
  const projects = await sql<{ id: string; name: string; archived_at: Date }[]>`
    select id, name, archived_at from projects
    where org_id = ${input.orgId} and archived_at is not null and purged_at is null
      and archived_at > now() - ${days}::interval`;
  for (const p of projects) out.push({ kind: 'project', id: p.id, label: p.name, deletedAt: p.archived_at.toISOString() });
  if (input.projectId !== null) {
    const threads = await sql<{ id: string; title: string; deleted_at: Date }[]>`
      select id, title, deleted_at from threads
      where org_id = ${input.orgId} and project_id = ${input.projectId}
        and deleted_at is not null and purged_at is null and deleted_at > now() - ${days}::interval`;
    for (const t of threads) out.push({ kind: 'thread', id: t.id, label: t.title, deletedAt: t.deleted_at.toISOString() });
    const scenes = await sql<{ id: string; title: string; deleted_at: Date | null }[]>`
      select id, title, deleted_at from scenes
      where org_id = ${input.orgId} and project_id = ${input.projectId}
        and status = 'deleted' and purged_at is null
        and deleted_at is not null and deleted_at > now() - ${days}::interval`;
    for (const s of scenes) out.push({ kind: 'scene', id: s.id, label: s.title, deletedAt: s.deleted_at!.toISOString() });
    const datasets = await sql<{ id: string; name: string; deleted_at: Date }[]>`
      select id, name, deleted_at from datasets
      where org_id = ${input.orgId} and project_id = ${input.projectId}
        and deleted_at is not null and purged_at is null and deleted_at > now() - ${days}::interval`;
    for (const d of datasets) out.push({ kind: 'dataset', id: d.id, label: d.name, deletedAt: d.deleted_at.toISOString() });
    const notes = await sql<{ id: string; body: string; deleted_at: Date }[]>`
      select id, body, deleted_at from project_notes
      where org_id = ${input.orgId} and project_id = ${input.projectId}
        and deleted_at is not null and purged_at is null and deleted_at > now() - ${days}::interval`;
    for (const n of notes) out.push({ kind: 'note', id: n.id, label: n.body.replace(/\s+/g, ' ').slice(0, 60), deletedAt: n.deleted_at.toISOString() });
  }
  return out.sort((a, b) => (a.deletedAt < b.deletedAt ? 1 : -1));
}

type RestoreResult = { ok: true } | { ok: false; error: string };

/** Flips a tombstone back, refusing past the window; a project restores its whole cascaded subtree. */
export async function restoreCitizenHuman(
  sql: postgres.Sql,
  input: { orgId: string; kind: TrashKind; id: string; by: string; trashDays: number },
): Promise<RestoreResult> {
  const days = `${Math.max(1, Math.floor(input.trashDays))} days`;
  const windowError = 'past the restore window — its content has been (or is about to be) cleaned up';
  const emit = async (type: string, payload: Record<string, unknown>): Promise<void> => {
    await emitEvent(sql, { orgId: input.orgId, actor: ACTOR, type, payload: { ...payload, by: input.by } });
  };

  if (input.kind === 'thread') {
    const rows = await sql<{ id: string }[]>`
      update threads set deleted_at = null
      where id = ${input.id} and org_id = ${input.orgId} and deleted_at is not null
        and purged_at is null and deleted_at > now() - ${days}::interval
      returning id`;
    if (!rows[0]) return { ok: false, error: windowError };
    await emit('thread.restored', { threadId: input.id });
    return { ok: true };
  }

  if (input.kind === 'dataset') {
    try {
      const rows = await sql<{ id: string; name: string }[]>`
        update datasets set deleted_at = null
        where id = ${input.id} and org_id = ${input.orgId} and deleted_at is not null
          and purged_at is null and deleted_at > now() - ${days}::interval
        returning id, name`;
      if (!rows[0]) return { ok: false, error: windowError };
      await emit('dataset.restored', { datasetId: input.id, name: rows[0].name });
      return { ok: true };
    } catch {
      // A live table with the same name blocked the restore.
      return { ok: false, error: 'a live Table already holds this name — rename or delete it first' };
    }
  }

  if (input.kind === 'scene') {
    const rows = await sql<{ id: string; slug: string }[]>`
      update scenes set status = 'active', deleted_at = null
      where id = ${input.id} and org_id = ${input.orgId} and status = 'deleted'
        and purged_at is null and deleted_at is not null and deleted_at > now() - ${days}::interval
      returning id, slug`;
    if (!rows[0]) return { ok: false, error: windowError };
    // The scene's hosting tabs restore with it.
    await sql`
      update tabs set status = 'active', deleted_at = null
      where org_id = ${input.orgId} and scene_id = ${input.id} and status = 'deleted'`;
    await emit('scene.restored', { sceneId: input.id, slug: rows[0].slug });
    return { ok: true };
  }

  if (input.kind === 'note') {
    const rows = await sql<{ id: string }[]>`
      update project_notes set deleted_at = null
      where id = ${input.id} and org_id = ${input.orgId} and deleted_at is not null
        and purged_at is null and deleted_at > now() - ${days}::interval
      returning id`;
    if (!rows[0]) return { ok: false, error: windowError };
    await emit('note.restored', { noteId: input.id });
    return { ok: true };
  }

  // Project: flip back exactly the subtree its delete cascaded.
  const [p] = await sql<{ id: string; name: string }[]>`
    select id, name from projects
    where id = ${input.id} and org_id = ${input.orgId} and archived_at is not null
      and purged_at is null and archived_at > now() - ${days}::interval`;
  if (!p) return { ok: false, error: windowError };
  const [ev] = await sql<{ payload: Record<string, unknown> }[]>`
    select payload from events
    where org_id = ${input.orgId} and type = 'project.deleted'
      and payload->>'projectId' = ${input.id}
    order by id desc limit 1`;
  const cascade = (ev?.payload['cascade'] ?? {}) as Partial<Record<string, Array<{ id: string; status?: string }>>>;
  const ids = (k: string): string[] => (cascade[k] ?? []).map((r) => r.id);
  if (ids('threads').length) await sql`update threads set deleted_at = null where org_id = ${input.orgId} and id = any(${sql.array(ids('threads'))}::uuid[])`;
  if (ids('datasets').length) await sql`update datasets set deleted_at = null where org_id = ${input.orgId} and id = any(${sql.array(ids('datasets'))}::uuid[])`;
  if (ids('notes').length) await sql`update project_notes set deleted_at = null where org_id = ${input.orgId} and id = any(${sql.array(ids('notes'))}::uuid[])`;
  if (ids('triggers').length) await sql`update triggers set revoked_at = null where org_id = ${input.orgId} and id = any(${sql.array(ids('triggers'))}::uuid[])`;
  if (ids('chains').length) await sql`update reactive_chains set revoked_at = null where org_id = ${input.orgId} and id = any(${sql.array(ids('chains'))}::uuid[])`;
  if (ids('operations').length) await sql`update operations set status = 'active' where org_id = ${input.orgId} and id = any(${sql.array(ids('operations'))}::uuid[])`;
  for (const s of cascade['scenes'] ?? []) {
    await sql`update scenes set status = ${s.status ?? 'active'}, deleted_at = null where org_id = ${input.orgId} and id = ${s.id}`;
  }
  for (const t of cascade['tabs'] ?? []) {
    await sql`update tabs set status = ${t.status ?? 'active'}, deleted_at = null where org_id = ${input.orgId} and id = ${t.id}`;
  }
  await sql`update projects set archived_at = null where id = ${input.id}`;
  await emit('project.restored', {
    projectId: input.id, name: p.name,
    threads: ids('threads').length, scenes: (cascade['scenes'] ?? []).length, datasets: ids('datasets').length,
  });
  return { ok: true };
}

/** Hard-deletes content past the window; skeleton rows and events survive, one purged event per item. */
export async function purgeExpiredTrash(
  sql: postgres.Sql, orgId: string, trashDays: number,
): Promise<{ datasets: number; scenes: number; threads: number; notes: number; projects: number }> {
  const days = `${Math.max(1, Math.floor(trashDays))} days`;
  const counts = { datasets: 0, scenes: 0, threads: 0, notes: 0, projects: 0 };

  const datasets = await sql<{ id: string; name: string; project_id: string | null }[]>`
    select id, name, project_id from datasets
    where org_id = ${orgId} and deleted_at is not null and purged_at is null
      and deleted_at <= now() - ${days}::interval`;
  for (const d of datasets) {
    await sql`delete from dataset_rows where dataset_id = ${d.id}`;
    await sql`update datasets set purged_at = now() where id = ${d.id}`;
    await emitEvent(sql, { orgId, actor: ACTOR, type: 'dataset.purged', payload: { datasetId: d.id, name: d.name, projectId: d.project_id } });
    counts.datasets++;
  }

  const scenes = await sql<{ id: string; slug: string; project_id: string | null }[]>`
    select id, slug, project_id from scenes
    where org_id = ${orgId} and status = 'deleted' and purged_at is null
      and deleted_at is not null and deleted_at <= now() - ${days}::interval`;
  for (const s of scenes) {
    await sql`delete from scene_revisions where scene_id = ${s.id}`;
    // The materialized head purges too; the skeleton keeps slug, title, lineage.
    await sql`update scenes set document = '{}'::jsonb, purged_at = now() where id = ${s.id}`;
    await emitEvent(sql, { orgId, actor: ACTOR, type: 'scene.purged', payload: { sceneId: s.id, slug: s.slug, projectId: s.project_id } });
    counts.scenes++;
  }

  const threads = await sql<{ id: string; project_id: string }[]>`
    select id, project_id from threads
    where org_id = ${orgId} and deleted_at is not null and purged_at is null
      and deleted_at <= now() - ${days}::interval`;
  for (const t of threads) {
    await sql`delete from messages where org_id = ${orgId} and payload->>'threadId' = ${t.id}`;
    // Run bodies purge; the run rows themselves stay.
    await sql`
      update runs set input = '{}'::jsonb, output = null
      where org_id = ${orgId} and thread_id = ${t.id}`;
    await sql`update threads set purged_at = now() where id = ${t.id}`;
    await emitEvent(sql, { orgId, actor: ACTOR, type: 'thread.purged', payload: { threadId: t.id, projectId: t.project_id } });
    counts.threads++;
  }

  const notes = await sql<{ id: string; project_id: string }[]>`
    select id, project_id from project_notes
    where org_id = ${orgId} and deleted_at is not null and purged_at is null
      and deleted_at <= now() - ${days}::interval`;
  for (const n of notes) {
    await sql`update project_notes set body = '', purged_at = now() where id = ${n.id}`;
    await emitEvent(sql, { orgId, actor: ACTOR, type: 'note.purged', payload: { noteId: n.id, projectId: n.project_id } });
    counts.notes++;
  }

  // The project purges last; its citizens purge on their own clocks.
  const projects = await sql<{ id: string; name: string }[]>`
    select id, name from projects
    where org_id = ${orgId} and archived_at is not null and purged_at is null
      and archived_at <= now() - ${days}::interval`;
  for (const p of projects) {
    await sql`update projects set purged_at = now() where id = ${p.id}`;
    await emitEvent(sql, { orgId, actor: ACTOR, type: 'project.purged', payload: { projectId: p.id, name: p.name } });
    counts.projects++;
  }

  return counts;
}
