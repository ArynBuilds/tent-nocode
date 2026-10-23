import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import { emitEvent } from './events.js';
import { listTabs } from './tabs/model.js';

// Project notes: append-only one-sentence knowledge; corrections supersede, dedup by normalized-body hash.

export interface ProjectNote {
  id: string;
  projectId: string;
  author: string;
  body: string;
  supersededBy: string | null;
  createdAt: string;
}

// Case- and whitespace-insensitive body identity.
export function noteBodyHash(body: string): string {
  return createHash('sha256').update(body.trim().replace(/\s+/g, ' ').toLowerCase()).digest('hex');
}

export interface SaveNoteInput {
  orgId: string;
  projectId: string;
  /** Process-bound at every door: 'user' | 'desk' | 'run:<id>'. */
  author: string;
  body: string;
}

export type SaveNoteResult =
  | { ok: true; noteId: string; deduped: boolean }
  | { ok: false; error: string };

// Save a note; an identical unsuperseded note answers ok with the existing id.
export async function saveNote(sql: postgres.Sql, input: SaveNoteInput): Promise<SaveNoteResult> {
  const body = input.body.trim();
  if (body.length < 8 || body.length > 2000) {
    return { ok: false, error: 'note body must be 8..2000 characters — one plain sentence' };
  }
  const [project] = await sql<{ id: string }[]>`
    select id from projects where id = ${input.projectId} and org_id = ${input.orgId}`;
  if (!project) return { ok: false, error: `project not found: ${input.projectId}` };
  const hash = noteBodyHash(body);
  const existing = await sql<{ id: string; body: string }[]>`
    select id, body from project_notes
    where org_id = ${input.orgId} and project_id = ${input.projectId} and superseded_by is null and deleted_at is null`;
  const dup = existing.find((n) => noteBodyHash(n.body) === hash);
  if (dup) return { ok: true, noteId: dup.id, deduped: true };
  const [row] = await sql<{ id: string }[]>`
    insert into project_notes (org_id, project_id, author, body)
    values (${input.orgId}, ${input.projectId}, ${input.author}, ${body})
    returning id`;
  if (!row) return { ok: false, error: 'note insert returned no row' };
  await emitEvent(sql, {
    orgId: input.orgId, actor: 'kernel.notes', type: 'note.saved',
    payload: { noteId: row.id, projectId: input.projectId, author: input.author },
  });
  return { ok: true, noteId: row.id, deduped: false };
}

// Full bodies, oldest first, paged.
export async function readNotes(
  sql: postgres.Sql,
  input: { orgId: string; projectId: string; limit?: number; offset?: number; includeSuperseded?: boolean },
): Promise<ProjectNote[]> {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  const offset = Math.max(input.offset ?? 0, 0);
  const rows = await sql<{ id: string; project_id: string; author: string; body: string; superseded_by: string | null; created_at: Date }[]>`
    select id, project_id, author, body, superseded_by, created_at from project_notes
    where org_id = ${input.orgId} and project_id = ${input.projectId} and deleted_at is null
      ${input.includeSuperseded === true ? sql`` : sql`and superseded_by is null`}
    order by created_at asc, id asc
    limit ${limit} offset ${offset}`;
  return rows.map((r) => ({
    id: r.id, projectId: r.project_id, author: r.author, body: r.body,
    supersededBy: r.superseded_by, createdAt: r.created_at.toISOString(),
  }));
}

// Correction: a new note lands and the old one points at it; never an in-place edit.
export async function supersedeNote(
  sql: postgres.Sql,
  input: { orgId: string; noteId: string; body: string; author: string },
): Promise<SaveNoteResult> {
  const [old] = await sql<{ id: string; project_id: string; superseded_by: string | null }[]>`
    select id, project_id, superseded_by from project_notes
    where id = ${input.noteId} and org_id = ${input.orgId} and deleted_at is null`;
  if (!old) return { ok: false, error: `note not found: ${input.noteId}` };
  if (old.superseded_by !== null) return { ok: false, error: 'note is already superseded — correct the newest version' };
  const saved = await saveNote(sql, {
    orgId: input.orgId, projectId: old.project_id, author: input.author, body: input.body,
  });
  if (!saved.ok) return saved;
  if (saved.noteId === old.id) return { ok: false, error: 'the correction is identical to the note it corrects' };
  await sql`update project_notes set superseded_by = ${saved.noteId} where id = ${old.id}`;
  await emitEvent(sql, {
    orgId: input.orgId, actor: 'kernel.notes', type: 'note.superseded',
    payload: { noteId: old.id, byNoteId: saved.noteId, author: input.author },
  });
  return saved;
}

// Tombstone a note; the actor is recorded in the event.
export async function deleteNote(
  sql: postgres.Sql, input: { orgId: string; noteId: string; by: string },
): Promise<{ ok: boolean }> {
  const rows = await sql<{ id: string; project_id: string }[]>`
    update project_notes set deleted_at = now()
    where id = ${input.noteId} and org_id = ${input.orgId} and deleted_at is null
    returning id, project_id`;
  if (!rows[0]) return { ok: false };
  await emitEvent(sql, {
    orgId: input.orgId, actor: 'kernel.notes', type: 'note.deleted',
    payload: { noteId: input.noteId, projectId: rows[0].project_id, by: input.by },
  });
  return { ok: true };
}

// Cap on the compiled block; older notes stay behind read_notes.
export const NOTES_BLOCK_CAP = 30;

// Bodies collapse to single lines so a note can never forge a section boundary.
function noteLine(body: string): string {
  return `- ${body.replace(/\s+/g, ' ').trim()}`;
}

// Compiled NOTES half of the project block; byte-stable between writes.
export async function compileNotesBlock(
  sql: postgres.Sql, orgId: string, projectId: string,
): Promise<string> {
  const notes = await readNotes(sql, { orgId, projectId, limit: NOTES_BLOCK_CAP });
  if (notes.length === 0) {
    return 'NOTES: (none yet — when a decision, lesson, or constraint lands, save one plain sentence with save_note)';
  }
  return [
    `NOTES (oldest first, cap ${NOTES_BLOCK_CAP} — full bodies and notes beyond the cap behind read_notes):`,
    ...notes.map((n) => noteLine(n.body)),
  ].join('\n');
}

// Structure half: the project's citizens as name+one-liner lines, read straight from the tables.
export async function compileStructureBlock(
  sql: postgres.Sql, orgId: string, projectId: string,
): Promise<string> {
  const cap = 12;
  const datasets = await sql<{ name: string; n: string }[]>`
    select d.name, count(dr.id) as n
    from datasets d
    left join dataset_rows dr on dr.dataset_id = d.id
    where d.org_id = ${orgId} and d.project_id = ${projectId} and d.deleted_at is null
    group by d.name order by d.name asc limit ${cap}`;
  const ops = await sql<{ name: string; version: number; status: string }[]>`
    select distinct on (o.name) o.name, o.version, o.status
    from operations o
    where o.org_id = ${orgId} and o.project_id = ${projectId}
    order by o.name asc, o.version desc limit ${cap}`;
  const opNames = ops.map((o) => o.name);
  const agents = await sql<{ slug: string }[]>`
    select distinct ag.slug
    from agents ag
    join runs r on r.agent_id = ag.id
    join threads th on th.id = r.thread_id
    where ag.org_id = ${orgId} and th.project_id = ${projectId}
      and ag.reserved is null and ag.status = 'active'
    order by ag.slug asc limit ${cap}`;
  const chains = await sql<{ operation: string }[]>`
    select operation from reactive_chains
    where org_id = ${orgId} and revoked_at is null and enabled
      and operation = any(${opNames}::text[])
    order by operation asc limit ${cap}`;
  const dsNames = datasets.map((d) => d.name);
  const triggers = await sql<{ kind: string; spec: Record<string, unknown>; action: Record<string, unknown> }[]>`
    select kind, spec, action from triggers
    where org_id = ${orgId} and revoked_at is null and enabled
    order by created_at asc, id asc`;
  const projTriggers = triggers.filter((t) =>
    (typeof t.spec['dataset'] === 'string' && dsNames.includes(t.spec['dataset'] as string))
    || (typeof t.action['operation'] === 'string' && opNames.includes(t.action['operation'] as string))).slice(0, cap);
  // Screens ride the record-derived tab-to-project chain in tabs/model.ts.
  const screens = (await listTabs(sql, orgId))
    .filter((t) => t.projectId === projectId)
    .map((t) => `${t.title.replace(/\s+/g, ' ').slice(0, 50)} (${t.sceneSlug ?? t.slug})`)
    .slice(0, cap);
  const line = (label: string, items: string[]): string =>
    `${label}: ${items.length > 0 ? items.join(' · ') : '(none)'}`;
  return [
    'STRUCTURE:',
    line('DATASETS', datasets.map((d) => `${d.name} (${d.n} rows here)`)),
    line('OPERATIONS', ops.map((o) => `${o.name}@${o.version} (${o.status})`)),
    line('SCREENS', screens),
    line('AGENTS', agents.map((a) => a.slug)),
    line('CHAINS', chains.map((c) => `re-runs ${c.operation}`)),
    line('TRIGGERS', projTriggers.map((t) => `${t.kind.replace(/_/g, ' ')}${typeof t.spec['dataset'] === 'string' ? ` on ${t.spec['dataset'] as string}` : ''}`)),
  ].join('\n');
}

// Compiled project block for work-run briefs; null when the project id resolves to nothing.
export async function buildThisProjectBlock(
  sql: postgres.Sql, input: { orgId: string; projectId: string },
): Promise<string | null> {
  const [project] = await sql<{ name: string }[]>`
    select name from projects where id = ${input.projectId} and org_id = ${input.orgId} and archived_at is null`;
  if (!project) return null;
  const [structure, notes] = await Promise.all([
    compileStructureBlock(sql, input.orgId, input.projectId),
    compileNotesBlock(sql, input.orgId, input.projectId),
  ]);
  return [`THIS PROJECT (${project.name.replace(/\s+/g, ' ').slice(0, 80)}):`, structure, notes].join('\n');
}
