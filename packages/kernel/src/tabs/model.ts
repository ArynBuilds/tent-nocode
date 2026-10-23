import type postgres from 'postgres';
import { emitEvent } from '../events.js';

// Tab records: a tab row hosts a scene (scene_id set) or is a legacy tombstone (scene_id null).

export interface TabRecord {
  id: string; slug: string; title: string; status: string; currentVersion: number; createdAt: string;
  /** Set when this tab hosts a scene; null for legacy rows. */
  sceneId: string | null;
  /** The hosted scene's slug. */
  sceneSlug: string | null;
  /** The exporting org when the hosted scene arrived by package; null otherwise. */
  sceneImportedFrom: string | null;
  /** The view's project, written at creation. */
  projectId: string | null;
}

const ACTOR = 'kernel.tabs';

export async function requireTab(
  sql: postgres.Sql, orgId: string, tabSlug: string,
): Promise<{ id: string; slug: string; current_version: number; status: string }> {
  const [tab] = await sql<{ id: string; slug: string; current_version: number; status: string }[]>`
    select id, slug, current_version, status from tabs
    where org_id = ${orgId} and slug = ${tabSlug} and status != 'deleted'`;
  if (!tab) throw new Error(`tab not found in org: ${tabSlug}`);
  return tab;
}

export async function deleteTab(
  sql: postgres.Sql, input: { orgId: string; tabSlug: string; reason: string },
): Promise<void> {
  const tab = await requireTab(sql, input.orgId, input.tabSlug);
  await sql`update tabs set status = 'deleted', deleted_at = now() where id = ${tab.id}`;
  await emitEvent(sql, {
    orgId: input.orgId, actor: ACTOR, type: 'tab.deleted',
    payload: { tabId: tab.id, slug: tab.slug, reason: input.reason },
  });
}

export async function renameTab(
  sql: postgres.Sql, input: { orgId: string; tabSlug: string; title: string },
): Promise<void> {
  const tab = await requireTab(sql, input.orgId, input.tabSlug);
  await sql`update tabs set title = ${input.title} where id = ${tab.id}`;
}

export async function listTabs(sql: postgres.Sql, orgId: string): Promise<TabRecord[]> {
  // project_id is written at creation; null means a legacy stray only.
  const rows = await sql<Array<Record<string, unknown>>>`
    select t.id, t.slug, t.title, t.status, t.current_version, t.created_at, t.scene_id,
           s.slug as scene_slug, s.imported_from as scene_imported_from,
           t.project_id as project_id
    from tabs t
    left join scenes s on s.id = t.scene_id
    where t.org_id = ${orgId} and t.status != 'deleted'
    order by t.created_at asc, t.id asc`;
  return rows.map((r) => ({
    id: r['id'] as string, slug: r['slug'] as string, title: r['title'] as string,
    status: r['status'] as string, currentVersion: r['current_version'] as number,
    createdAt: new Date(r['created_at'] as string).toISOString(),
    sceneId: (r['scene_id'] as string | null) ?? null,
    sceneSlug: (r['scene_slug'] as string | null) ?? null,
    sceneImportedFrom: (r['scene_imported_from'] as string | null) ?? null,
    projectId: (r['project_id'] as string | null) ?? null,
  }));
}
