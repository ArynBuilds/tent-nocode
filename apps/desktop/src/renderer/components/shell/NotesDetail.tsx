import { useCallback, useEffect, useState } from 'react';
import { desk } from '../../lib/desk.js';
import { useOrg } from '../../lib/OrgContext.js';
import styles from './sidepanel.module.css';
import { EmptyMark } from '../brand/EmptyMark.js';

// Notes detail: append-only list; edit creates superseding note; delete via key press, no button.

export interface NoteRow {
  id: string;
  author: string;
  body: string;
  supersededBy: string | null;
  createdAt: string;
}

/** Pure chain fold: heads (unsuperseded) oldest-root-first, each with its earlier
 * versions oldest-first — the supersede pointers walked backwards. */
export function orderNoteChains(notes: NoteRow[]): Array<{ head: NoteRow; earlier: NoteRow[] }> {
  const preds = new Map<string, NoteRow[]>();
  for (const n of notes) {
    if (n.supersededBy === null) continue;
    const list = preds.get(n.supersededBy) ?? [];
    list.push(n);
    preds.set(n.supersededBy, list);
  }
  const collect = (id: string): NoteRow[] =>
    (preds.get(id) ?? []).flatMap((p) => [...collect(p.id), p]);
  return notes
    .filter((n) => n.supersededBy === null)
    .map((head) => ({
      head,
      earlier: collect(head.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    }))
    .sort((a, b) => {
      const ra = a.earlier[0]?.createdAt ?? a.head.createdAt;
      const rb = b.earlier[0]?.createdAt ?? b.head.createdAt;
      return ra.localeCompare(rb) || a.head.id.localeCompare(b.head.id);
    });
}

const when = (iso: string): string => iso.slice(0, 10);

export function NotesDetail({ projectId }: { projectId: string }) {
  const { orgId } = useOrg();
  const [notes, setNotes] = useState<NoteRow[] | null>(null);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const [selectedNote, setSelectedNote] = useState<string | null>(null);
  const [history, setHistory] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((): void => {
    desk.projectNotes(orgId, projectId)
      .then((rows) => setNotes(rows))
      .catch(() => setNotes([]));
  }, [orgId, projectId]);
  useEffect(() => { load(); }, [load]);

  function afterMutation(res: { ok: boolean; error?: string }): void {
    if (!res.ok) { setError(res.error ?? 'that did not land'); return; }
    setError(null);
    setDraft('');
    setEditing(null);
    setSelectedNote(null);
    load();
  }

  // SELECT + Delete/Backspace (the one-keyboard idiom — text inputs excluded): the
  // selected note deletes SILENTLY through the one door; no button, ever.
  useEffect(() => {
    if (selectedNote === null) return;
    const handler = (e: KeyboardEvent): void => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const tag = (e.target as HTMLElement | null)?.tagName ?? '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      e.preventDefault();
      void desk.deleteProjectNote(orgId, selectedNote).then((r) => afterMutation(r));
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNote, orgId]);

  if (notes === null) return <div className={styles.fileEmpty}>reading the notes…</div>;
  const chains = orderNoteChains(notes);

  return (
    <div className={styles.notesWrap}>
      {chains.length === 0 ? (
        <EmptyMark line="No notes yet. Decisions and lessons from your chats are saved here." />
      ) : (
        <div className={styles.notesList}>
          {chains.map(({ head, earlier }) => (
            <div
              key={head.id}
              className={selectedNote === head.id ? `${styles.noteCard} ${styles.noteCardSelected}` : styles.noteCard}
              onClick={() => setSelectedNote(selectedNote === head.id ? null : head.id)}
            >
              {editing !== null && editing.id === head.id ? (
                <>
                  <textarea
                    className={styles.noteInput}
                    value={editing.body}
                    rows={3}
                    onChange={(e) => setEditing({ id: head.id, body: e.target.value })}
                  />
                  <div className={styles.noteActs}>
                    <button
                      type="button" className={styles.noteBtn}
                      onClick={() => void desk.supersedeProjectNote(orgId, head.id, editing.body).then(afterMutation)}
                    >
                      Save correction
                    </button>
                    <button type="button" className={styles.noteBtn} onClick={() => setEditing(null)}>Cancel</button>
                  </div>
                </>
              ) : (
                <>
                  <div className={styles.noteBody}>{head.body}</div>
                  <div className={styles.noteMeta}>
                    <span>{head.author} · {when(head.createdAt)}</span>
                    {earlier.length > 0 ? (
                      <button
                        type="button" className={styles.noteHistoryBtn}
                        onClick={() => setHistory((h) => {
                          const next = new Set(h);
                          if (next.has(head.id)) next.delete(head.id); else next.add(head.id);
                          return next;
                        })}
                      >
                        {history.has(head.id) ? 'hide history' : `${earlier.length} earlier version${earlier.length === 1 ? '' : 's'}`}
                      </button>
                    ) : null}
                    <span className={styles.noteActsInline}>
                      <button
                        type="button" className={styles.noteBtn}
                        onClick={(e) => { e.stopPropagation(); setEditing({ id: head.id, body: head.body }); }}
                      >
                        Correct
                      </button>
                    </span>
                  </div>
                  {history.has(head.id) ? (
                    <div className={styles.noteHistory}>
                      {earlier.map((e) => (
                        <div key={e.id} className={styles.noteHistoryItem}>
                          <span className={styles.noteHistoryBody}>{e.body}</span>
                          <span className={styles.noteHistoryMeta}>{e.author} · {when(e.createdAt)} · superseded</span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </>
              )}
            </div>
          ))}
        </div>
      )}
      <div className={styles.noteAdd}>
        <textarea
          className={styles.noteInput}
          placeholder="One plain sentence — a decision, lesson, or constraint…"
          value={draft}
          rows={2}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button
          type="button" className={styles.noteBtn}
          disabled={draft.trim().length < 8}
          onClick={() => void desk.saveProjectNote(orgId, projectId, draft).then(afterMutation)}
        >
          Save note
        </button>
      </div>
      {error !== null ? <div className={styles.noteErr}>{error}</div> : null}
    </div>
  );
}
