import { useEffect, useRef, useState } from 'react';
import type { SceneBinding } from '@nodeloom/core';
import { desk } from '../../lib/desk.js';
import { useOrg } from '../../lib/OrgContext.js';
import { useLive } from '../../lib/data/useLive.js';
import { useQuery } from '../../lib/data/useQuery.js';
import type { WireSelection } from '../../lib/canvas/store.js';
import { composeBindingPatch, draftFromBinding } from '../../lib/page-edit/bindingQuestions.js';
import { ruleSentence } from '../../lib/canvas/store.js';
import type { BindingDraft, QuestionColumn } from '../../lib/page-edit/bindingQuestions.js';
import { BindingQuestions } from '../page-edit/BindingQuestions.js';
import styles from './sidepanel.module.css';

/**
 * B1 (spec ②, 2026-08-05): THE CONNECTION PANEL — a selected wire's Properties home.
 * Every wire speaks its sentence; a DATA wire (Table shows on App) additionally renders
 * the SAME three-question form the picker uses, LIVE against the stored binding — edits
 * re-write through humanSetBinding (echo → wall → visible revert + the wall's words).
 * This replaces the read-only-only sentence dead-end (retired in this commit). NOTHING
 * ON WIRE HOVER — hover keeps only splice/delete; all reading/editing lives here.
 */

export function WireConnection({ selection }: { selection: WireSelection }) {
  return (
    <div className={styles.inspector}>
      <div className={styles.inspectorHead}>
        <span className={styles.inspectorScene}>Connection</span>
      </div>
      {selection.actionWire !== undefined ? (
        <ActionWireSentence
          key={`${selection.actionWire.sceneSlug}:${selection.actionWire.action}:${selection.actionWire.rule}`}
          wire={selection.actionWire}
          fallback={selection.sentence}
        />
      ) : (
        <section className={styles.inspectorSection}>
          <div className={styles.contractText}>{selection.sentence}</div>
        </section>
      )}
      {selection.binding !== undefined ? (
        <WireBindingEditor
          key={`${selection.binding.sceneSlug}:${selection.binding.dataset}`}
          sceneSlug={selection.binding.sceneSlug}
          dataset={selection.binding.dataset}
          projectId={selection.binding.projectId}
        />
      ) : null}
    </div>
  );
}

/** F6 (2026-08-16): THE SENTENCE ON SELECT — one plain line from the live
 * projections: the rule's write word + each explicit field feed + the when
 * clause; a Connection rule resolves its door's plain word and label. A gone
 * rule falls back to the quick sentence honestly. */
function ActionWireSentence({ wire, fallback }: {
  wire: NonNullable<WireSelection['actionWire']>;
  fallback: string;
}) {
  const { orgId } = useOrg();
  const [sentence, setSentence] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const actions = await desk.sceneActions(orgId, wire.sceneSlug).catch(() => []);
      const doc = actions.find((a) => a.name === wire.action);
      const write = doc?.writes[wire.rule];
      if (doc === undefined || write === undefined) { if (!cancelled) setSentence(null); return; }
      // The rule kinds carry no integration call (core's ActionRule), so the sentence needs no resolved names.
      if (!cancelled) setSentence(ruleSentence(write, doc.params, undefined));
    })();
    return () => { cancelled = true; };
  }, [orgId, wire]);
  return (
    <section className={styles.inspectorSection}>
      <div className={styles.contractText}>{sentence ?? fallback}</div>
    </section>
  );
}

type DatasetBinding = Extract<SceneBinding, { kind: 'query' }>;

/** Exported for the SECOND mount (B4 ㉖): a data-display node's Data section renders
 * the SAME editor — one implementation, two mounts (the BindingQuestions law). */
export function WireBindingEditor({ sceneSlug, dataset, projectId }: {
  sceneSlug: string; dataset: string; projectId: string | null;
}) {
  const { orgId } = useOrg();
  const bindingsQuery = useQuery(
    `sceneBindings:${sceneSlug}`,
    () => desk.sceneBindings(orgId, sceneSlug),
    [orgId, sceneSlug],
  );
  useLive(['scenes'], bindingsQuery.refetch);
  const briefQuery = useQuery(
    `wire-brief:${dataset}:${projectId ?? ''}`,
    () => desk.datasetBrief(orgId, dataset, projectId ?? undefined),
    [orgId, dataset, projectId],
  );
  const [draft, setDraft] = useState<BindingDraft | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const stored = (bindingsQuery.data ?? []).find(
    (b): b is DatasetBinding => b.kind === 'query' && b.table === dataset,
  );
  const columns: QuestionColumn[] = (briefQuery.data?.columns ?? [])
    .map((c) => ({ key: c.key, display: c.display, type: c.type }));

  // The draft seeds from stored truth once; edits own it after (a live refetch never
  // clobbers what the user is typing).
  useEffect(() => {
    if (stored !== undefined) setDraft((d) => d ?? draftFromBinding(stored));
  }, [stored]);

  async function write(next: BindingDraft): Promise<void> {
    if (stored === undefined) return;
    const patch = composeBindingPatch(next, columns);
    // The unanswered arms CLEAR (back to all rows / own shape / natural order) — the
    // stored identity fields carry over whole; same-named binding replaces at the door.
    const { query: _q, rowKey: _r, ...keep } = stored;
    const res = await desk.humanSetBinding(orgId, sceneSlug, { ...keep, ...patch });
    if (!res.ok) {
      setNotice(res.error);
      setDraft(draftFromBinding(stored)); // the visible revert — truth re-renders
    } else {
      setNotice(null);
    }
    bindingsQuery.refetch();
  }

  /** Edits commit quietly a beat after the last change (never per keystroke). */
  function commit(next: BindingDraft): void {
    setDraft(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { void write(next); }, 500);
  }

  if (stored === undefined) {
    return bindingsQuery.data === undefined ? null : (
      <section className={styles.inspectorSection}>
        <div className={styles.contractText}>this connection carries no data settings anymore</div>
      </section>
    );
  }
  if (draft === null) return null;
  return (
    <section className={styles.inspectorSection}>
      {notice !== null ? <div className={styles.inspectorNotice}>{notice}</div> : null}
      <BindingQuestions columns={columns} draft={draft} onChange={commit} />
    </section>
  );
}
