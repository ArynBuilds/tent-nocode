import type postgres from 'postgres';
import {
  SCENE_SCHEMA_VERSION, emptySceneDocument, primitiveRef, sceneBindingsSchema, sceneDocumentSchema,
  type SceneBinding, type SceneDocument,
} from '@tent-nocode/core';
import { emitEvent } from '../events.js';
import { applyRevision } from './apply.js';
import { projectThemeSchema, type ProjectTheme } from '../projects.js';

// The scene store: `scenes.document` is the materialized head, rebuildable from scene_revisions; delete is a tombstone status flip.

const ACTOR = 'kernel.scenes';

/** The one slug rule: a title's kebab form, 'scene' when nothing survives. */
export function slugify(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'scene';
}

export async function createScene(
  sql: postgres.Sql,
  /** projectId null is the serving/whole-account lane only; the desktop schema refuses it. */
  input: { orgId: string; title: string; createdBy: string; projectId: string | null },
): Promise<{ sceneId: string; slug: string }> {
  const base = slugify(input.title);
  const taken = await sql<{ slug: string }[]>`
    select slug from scenes where org_id = ${input.orgId} and (slug = ${base} or slug like ${base + '-%'})`;
  const takenSet = new Set(taken.map((r) => r.slug));
  let slug = base;
  for (let n = 2; takenSet.has(slug); n++) slug = `${base}-${n}`;

  const document = emptySceneDocument();
  // A scene carries no runtime pin: the engine is the tentkit build every host serves.
  const [row] = await sql<{ id: string }[]>`
    insert into scenes (org_id, project_id, slug, title, document, schema_version, created_by)
    values (${input.orgId}, ${input.projectId}, ${slug}, ${input.title},
            ${sql.json(document as unknown as postgres.JSONValue)}, ${document.schemaVersion}, ${input.createdBy})
    returning id`;
  if (!row) throw new Error('scene insert returned no row');
  await emitEvent(sql, {
    orgId: input.orgId, actor: ACTOR, type: 'scene.created',
    payload: { sceneId: row.id, slug, title: input.title, projectId: input.projectId },
  });
  // A new scene lands its ground root (a frame painted with the theme's background) as revision 1 through the ops wall.
  const ground = await applyRevision(sql, {
    orgId: input.orgId, sceneSlug: slug, actor: ACTOR, mutationId: 1,
    ops: [{ op: 'set_component', node: 'root', component: primitiveRef('frame'), value: { layout: 'none', fill: 'background' } }],
  });
  if (!ground.ok) throw new Error(`the ground root did not land on '${slug}': ${ground.errors[0] ?? 'unknown'}`);
  return { sceneId: row.id, slug };
}

export interface SceneRecord {
  id: string; slug: string; title: string; status: string; headRevision: number; createdAt: string;
  /** The exporting org when this scene arrived by package; null for local scenes. */
  importedFrom: string | null;
  /** The owning project; null only on serving-lane rows. */
  projectId: string | null;
}

export async function listScenes(sql: postgres.Sql, orgId: string): Promise<SceneRecord[]> {
  const rows = await sql<Array<Record<string, unknown>>>`
    select id, slug, title, status, head_revision, created_at, imported_from, project_id
    from scenes where org_id = ${orgId} and status != 'deleted'
    order by created_at asc, id asc`;
  return rows.map((r) => ({
    id: r['id'] as string, slug: r['slug'] as string, title: r['title'] as string,
    status: r['status'] as string, headRevision: r['head_revision'] as number,
    createdAt: new Date(r['created_at'] as string).toISOString(),
    importedFrom: (r['imported_from'] as string | null) ?? null,
    projectId: (r['project_id'] as string | null) ?? null,
  }));
}

export async function requireScene(
  sql: postgres.Sql, orgId: string, sceneSlug: string,
): Promise<{ id: string; slug: string; head_revision: number; status: string }> {
  const [scene] = await sql<{ id: string; slug: string; head_revision: number; status: string }[]>`
    select id, slug, head_revision, status from scenes
    where org_id = ${orgId} and slug = ${sceneSlug} and status != 'deleted'`;
  if (!scene) throw new Error(`scene not found in org: ${sceneSlug}`);
  return scene;
}

export async function getSceneDocument(
  sql: postgres.Sql, input: { orgId: string; sceneId: string },
): Promise<SceneDocument> {
  const [row] = await sql<{ document: unknown }[]>`
    select document from scenes where id = ${input.sceneId} and org_id = ${input.orgId}`;
  if (!row) throw new Error(`scene not found: ${input.sceneId}`);
  const doc = sceneDocumentSchema.parse(row.document);
  // Refuse a newer schema than this build speaks.
  if (doc.schemaVersion > SCENE_SCHEMA_VERSION) {
    throw new Error(`this scene uses schema v${doc.schemaVersion}; this build speaks v${SCENE_SCHEMA_VERSION} — update the app to open it (refuse-newer, D-146)`);
  }
  return doc;
}

/** The scene route's lookup, active scenes only: the title and the project's theme the host page composes from; never the document. */
export async function getSceneForServe(
  sql: postgres.Sql, input: { orgId: string; sceneId: string },
): Promise<{ orgId: string; slug: string; title: string; theme: ProjectTheme | null } | null> {
  // The project's theme rides the serve info: every host composes its :root block from this one field.
  const [row] = await sql<{ org_id: string; slug: string; title: string; theme: unknown }[]>`
    select s.org_id, s.slug, s.title, p.theme
    from scenes s left join projects p on p.id = s.project_id
    where s.id = ${input.sceneId} and s.org_id = ${input.orgId} and s.status = 'active'`;
  if (!row) return null;
  const themeParse = projectThemeSchema.safeParse(row.theme);
  return { orgId: row.org_id, slug: row.slug, title: row.title, theme: themeParse.success ? themeParse.data : null };
}

/** Reads the stored binding declarations; rows that fail the schema read as an empty list, never a throw. */
export async function getSceneBindings(
  sql: postgres.Sql, input: { orgId: string; sceneSlug: string },
): Promise<SceneBinding[]> {
  const scene = await requireScene(sql, input.orgId, input.sceneSlug);
  const [row] = await sql<{ bindings: unknown }[]>`
    select bindings from scenes where id = ${scene.id}`;
  const parsed = sceneBindingsSchema.safeParse(row?.bindings ?? []);
  return parsed.success ? parsed.data : [];
}

/** Everything the scene host needs in one read: the scene row, the document, and the binding declarations. */
export async function getSceneForHost(
  sql: postgres.Sql, input: { orgId: string; sceneId: string },
): Promise<{ scene: SceneRecord; document: SceneDocument; bindings: unknown; actions: unknown; targetScreen: { w: number; h: number } | null } | null> {
  const [row] = await sql<Array<Record<string, unknown>>>`
    select id, slug, title, status, head_revision, created_at, imported_from, project_id, bindings, actions, target_screen
    from scenes where id = ${input.sceneId} and org_id = ${input.orgId} and status != 'deleted'`;
  if (!row) return null;
  const document = await getSceneDocument(sql, { orgId: input.orgId, sceneId: input.sceneId });
  return {
    scene: {
      id: row['id'] as string, slug: row['slug'] as string, title: row['title'] as string,
      status: row['status'] as string, headRevision: row['head_revision'] as number,
      createdAt: new Date(row['created_at'] as string).toISOString(),
      importedFrom: (row['imported_from'] as string | null) ?? null,
      projectId: (row['project_id'] as string | null) ?? null,
    },
    document,
    bindings: row['bindings'],
    actions: row['actions'],
    targetScreen: (row['target_screen'] as { w: number; h: number } | null) ?? null,
  };
}

export async function deleteScene(
  sql: postgres.Sql, input: { orgId: string; sceneSlug: string; reason: string },
): Promise<void> {
  const scene = await requireScene(sql, input.orgId, input.sceneSlug);
  // The restore window and the purge sweep both read deleted_at.
  await sql`update scenes set status = 'deleted', deleted_at = now() where id = ${scene.id}`;
  await emitEvent(sql, {
    orgId: input.orgId, actor: ACTOR, type: 'scene.deleted',
    payload: { sceneId: scene.id, slug: scene.slug, reason: input.reason },
  });
}

/** Create the scene's host tab row; the tab slug suffixes on collision and the project attaches at creation. */
export async function createSceneTab(
  sql: postgres.Sql,
  input: { orgId: string; sceneId: string; sceneSlug: string; title: string; createdBy: string; projectId?: string | null },
): Promise<{ tabId: string }> {
  const taken = await sql<{ slug: string }[]>`
    select slug from tabs where org_id = ${input.orgId} and (slug = ${input.sceneSlug} or slug like ${input.sceneSlug + '-%'})`;
  const takenSet = new Set(taken.map((r) => r.slug));
  let slug = input.sceneSlug;
  for (let n = 2; takenSet.has(slug); n++) slug = `${input.sceneSlug}-${n}`;
  const [row] = await sql<{ id: string }[]>`
    insert into tabs (org_id, slug, title, created_by, scene_id, status, project_id)
    values (${input.orgId}, ${slug}, ${input.title}, ${input.createdBy}, ${input.sceneId}, 'active', ${input.projectId ?? null})
    returning id`;
  if (!row) throw new Error('scene tab insert returned no row');
  await emitEvent(sql, {
    orgId: input.orgId, actor: ACTOR, type: 'tab.created',
    payload: { tabId: row.id, slug, title: input.title, sceneId: input.sceneId, host: 'scene', projectId: input.projectId ?? null },
  });
  return { tabId: row.id };
}
