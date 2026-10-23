import type postgres from 'postgres';
import { applyOpsToDocument, emptySceneDocument, sceneDocumentSchema, sceneOpsBatchSchema, type SceneDocument } from '@tent-nocode/core';
import { emitEvent } from '../events.js';
import { formatIssues, loadValidateContext, validateScene } from './validate.js';

// The one door every scene edit passes: serialize per scene, dedupe retries, fold the ops,
// validate the folded document ONCE (every issue, one context load), persist atomically.

const ACTOR = 'kernel.scenes';

export type ApplyResult =
  | { ok: true; revisionNo: number; duplicate: boolean; notes: string[] }
  | { ok: false; errors: string[] };

type ParsedOps = ReturnType<typeof sceneOpsBatchSchema.parse>;

function parseOpsBatch(ops: unknown): { ok: true; ops: ParsedOps } | { ok: false; errors: string[] } {
  const parsed = sceneOpsBatchSchema.safeParse(ops);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.slice(0, 10).map((i) => `ops${i.path.length ? `[${i.path.join('][')}]` : ''}: ${i.message}`),
    };
  }
  return { ok: true, ops: parsed.data };
}

interface SceneRow { id: string; slug: string; head_revision: number; document: unknown; actions: unknown; bindings: unknown; project_id: string | null }

/** Fold the ops over the stored document, then the one validation pass; errors refuse, warnings ride as notes. */
async function foldAndValidate(
  db: postgres.Sql, orgId: string, scene: SceneRow, ops: ParsedOps,
): Promise<{ ok: true; doc: SceneDocument; notes: string[] } | { ok: false; errors: string[] }> {
  const folded = applyOpsToDocument(sceneDocumentSchema.parse(scene.document), ops);
  if (!folded.ok) return { ok: false, errors: folded.errors };
  const ctx = await loadValidateContext(db, { orgId, projectId: scene.project_id, doc: folded.doc, bindings: scene.bindings, actions: scene.actions });
  const verdict = validateScene(folded.doc, ctx);
  if (!verdict.ok) return { ok: false, errors: formatIssues(verdict.issues.filter((i) => i.severity === 'error')) };
  return { ok: true, doc: folded.doc, notes: [...folded.notes, ...formatIssues(verdict.issues)] };
}

/** Dry validation: the same steps as applyRevision, without the lock and without the write. */
export async function validateRevisionOps(
  sql: postgres.Sql, input: { orgId: string; sceneSlug: string; ops: unknown },
): Promise<{ ok: true; notes: string[] } | { ok: false; errors: string[] }> {
  const parsed = parseOpsBatch(input.ops);
  if (!parsed.ok) return parsed;
  const [scene] = await sql<SceneRow[]>`
    select id, slug, head_revision, document, actions, bindings, project_id from scenes
    where org_id = ${input.orgId} and slug = ${input.sceneSlug} and status != 'deleted'`;
  if (!scene) return { ok: false, errors: [`scene not found in org: ${input.sceneSlug}`] };
  const res = await foldAndValidate(sql, input.orgId, scene, parsed.ops);
  return res.ok ? { ok: true, notes: res.notes } : res;
}

export async function applyRevision(
  sql: postgres.Sql,
  input: { orgId: string; sceneSlug: string; actor: string; mutationId: number; ops: unknown },
): Promise<ApplyResult> {
  const parsed = parseOpsBatch(input.ops);
  if (!parsed.ok) return parsed;

  return sql.begin(async (tx) => {
    const db = tx as unknown as postgres.Sql;
    const [scene] = await db<SceneRow[]>`
      select id, slug, head_revision, document, actions, bindings, project_id from scenes
      where org_id = ${input.orgId} and slug = ${input.sceneSlug} and status != 'deleted'
      for update`;
    if (!scene) return { ok: false, errors: [`scene not found in org: ${input.sceneSlug}`] } as ApplyResult;

    // The retry wall: at-or-below the actor's high-water mark = a detected duplicate.
    const [dup] = await db<{ revision_no: number }[]>`
      select revision_no from scene_revisions
      where scene_id = ${scene.id} and actor = ${input.actor} and mutation_id = ${input.mutationId}`;
    if (dup) return { ok: true, revisionNo: dup.revision_no, duplicate: true, notes: [] } as ApplyResult;
    const [hw] = await db<{ max: number | null }[]>`
      select max(mutation_id) as max from scene_revisions
      where scene_id = ${scene.id} and actor = ${input.actor}`;
    if (hw?.max !== null && hw !== undefined && input.mutationId <= Number(hw.max)) {
      // Below high-water but unseen: a stale retry of a superseded batch - never applied.
      return { ok: true, revisionNo: scene.head_revision, duplicate: true, notes: [] } as ApplyResult;
    }

    const folded = await foldAndValidate(db, input.orgId, scene, parsed.ops);
    if (!folded.ok) return { ok: false, errors: folded.errors } as ApplyResult;

    const revisionNo = scene.head_revision + 1;
    folded.doc.revision = revisionNo;
    const [parentRev] = await db<{ id: string }[]>`
      select id from scene_revisions where scene_id = ${scene.id} and revision_no = ${scene.head_revision}`;

    await db`
      insert into scene_revisions (scene_id, org_id, revision_no, ops, actor, mutation_id, parent_revision_id, schema_version)
      values (${scene.id}, ${input.orgId}, ${revisionNo}, ${db.json(parsed.ops as unknown as postgres.JSONValue)},
              ${input.actor}, ${input.mutationId}, ${parentRev?.id ?? null}, ${folded.doc.schemaVersion})`;
    await db`
      update scenes set document = ${db.json(folded.doc as unknown as postgres.JSONValue)}, head_revision = ${revisionNo}
      where id = ${scene.id}`;
    await emitEvent(db, {
      orgId: input.orgId, actor: ACTOR, type: 'scene.revised',
      payload: {
        sceneId: scene.id, slug: scene.slug, revisionNo, actor: input.actor,
        opKinds: [...new Set(parsed.ops.map((o) => o.op))],
      },
    });
    return { ok: true, revisionNo, duplicate: false, notes: folded.notes } as ApplyResult;
  }) as Promise<ApplyResult>;
}

/** The human gesture door: same wall, with the mutationId computed and retried for the caller. */
export async function applyUserRevision(
  sql: postgres.Sql,
  input: { orgId: string; sceneSlug: string; actor: string; ops: unknown },
): Promise<ApplyResult> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const [hw] = await sql<{ max: number | null }[]>`
      select max(r.mutation_id) as max from scene_revisions r
      join scenes s on s.id = r.scene_id
      where s.org_id = ${input.orgId} and s.slug = ${input.sceneSlug} and r.actor = ${input.actor}`;
    const mutationId = Number(hw?.max ?? 0) + 1;
    const res = await applyRevision(sql, { ...input, mutationId });
    if (!res.ok || !res.duplicate) return res;
    // duplicate = a racing same-actor gesture claimed this id; our ops never applied, retry.
  }
  return { ok: false, errors: ['the scene is being edited faster than this gesture could land - try again'] };
}

/** Fold every revision's ops from the empty document; must equal the materialized head. */
export async function rebuildSceneDocument(
  sql: postgres.Sql, input: { orgId: string; sceneId: string },
): Promise<SceneDocument> {
  const revisions = await sql<{ revision_no: number; ops: unknown }[]>`
    select revision_no, ops from scene_revisions
    where scene_id = ${input.sceneId} and org_id = ${input.orgId}
    order by revision_no asc`;
  let doc = emptySceneDocument();
  for (const rev of revisions) {
    const ops = sceneOpsBatchSchema.parse(rev.ops);
    const folded = applyOpsToDocument(doc, ops);
    if (!folded.ok) throw new Error(`rebuild: revision ${rev.revision_no} no longer applies: ${folded.errors[0]}`);
    folded.doc.revision = rev.revision_no;
    doc = folded.doc;
  }
  return doc;
}
