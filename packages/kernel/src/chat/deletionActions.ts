import { z } from 'zod';
import type { ActionSpec } from './actions.js';
import { projectArm, resolveProject } from '../containment.js';
import { deleteDatasetHuman, deleteThreadHuman } from '../human/deletion.js';
import { deleteNote } from '../notes.js';

// The assistant's delete verbs; they call the same human-door tombstones the gestures call.
// The model quotes the citizen's own words and the kernel demands exactly one match — it never picks an id.

export const DELETION_ACTIONS: Record<string, ActionSpec> = {
  delete_dataset: {
    name: 'delete_dataset',
    escalationKind: 'delete_dataset',
    lands: 'exactly one matching Table tombstones; rows survive on the record',
    route: { kind: 'table', verb: 'exists' },
    paramsSchema: z.object({ name: z.string().min(1) }).strict(),
    async execute(sql, ctx, params): Promise<void> {
      const p = z.object({ name: z.string().min(1) }).parse(params);
      // The verb reaches only the asking thread's project.
      const projectId = await resolveProject(sql, { orgId: ctx.orgId, threadId: ctx.threadId });
      const res = await deleteDatasetHuman(sql, {
        orgId: ctx.orgId, projectId, name: p.name, by: ctx.resolvedBy ?? ctx.createdBy,
      });
      if (!res.ok) throw new Error(`delete_dataset: ${res.error}`);
    },
  },
  /** Delete a thread by quoting words from its own title. The CURRENT thread refuses —
   * the desk never deletes the conversation it is speaking in. */
  delete_thread: {
    name: 'delete_thread',
    escalationKind: 'delete_thread',
    lands: 'exactly one matching thread tombstones; the current one refuses',
    route: { kind: 'thread', verb: 'exists' },
    paramsSchema: z.object({ titleContains: z.string().min(3) }).strict(),
    async execute(sql, ctx, params): Promise<void> {
      const p = z.object({ titleContains: z.string().min(3) }).parse(params);
      const projectId = await resolveProject(sql, { orgId: ctx.orgId, threadId: ctx.threadId });
      const matches = await sql<{ id: string }[]>`
        select id from threads
        where org_id = ${ctx.orgId} and ${projectArm(sql, projectId)} and deleted_at is null
          and title ilike ${'%' + p.titleContains + '%'}`;
      if (matches.length === 0) throw new Error(`delete_thread: no thread title matches '${p.titleContains}'`);
      if (matches.length > 1) throw new Error(`delete_thread: '${p.titleContains}' matches ${matches.length} threads — be more specific`);
      if (matches[0]!.id === ctx.threadId) throw new Error('delete_thread: this is the conversation we are in — it cannot delete itself');
      const res = await deleteThreadHuman(sql, {
        orgId: ctx.orgId, threadId: matches[0]!.id, by: ctx.resolvedBy ?? ctx.createdBy,
      });
      if (!res.ok) throw new Error(`delete_thread: ${res.error}`);
    },
  },
  /** Delete a note by quoting words from its own body — the project's unsuperseded
   * notes only (a superseded note is already history, nothing to clean). */
  delete_note: {
    name: 'delete_note',
    escalationKind: 'delete_note',
    lands: 'exactly one matching note is deleted',
    route: { kind: 'note', verb: 'exists' },
    paramsSchema: z.object({ bodyContains: z.string().min(3) }).strict(),
    async execute(sql, ctx, params): Promise<void> {
      const p = z.object({ bodyContains: z.string().min(3) }).parse(params);
      const projectId = await resolveProject(sql, { orgId: ctx.orgId, threadId: ctx.threadId });
      if (projectId === null) throw new Error('delete_note: this thread has no project home');
      const matches = await sql<{ id: string }[]>`
        select id from project_notes
        where org_id = ${ctx.orgId} and project_id = ${projectId} and superseded_by is null
          and body ilike ${'%' + p.bodyContains + '%'}`;
      if (matches.length === 0) throw new Error(`delete_note: no note matches '${p.bodyContains}'`);
      if (matches.length > 1) throw new Error(`delete_note: '${p.bodyContains}' matches ${matches.length} notes — quote more of the one you mean`);
      const res = await deleteNote(sql, {
        orgId: ctx.orgId, noteId: matches[0]!.id, by: ctx.resolvedBy ?? ctx.createdBy,
      });
      if (!res.ok) throw new Error('delete_note: the note vanished before the delete landed');
    },
  },
};
