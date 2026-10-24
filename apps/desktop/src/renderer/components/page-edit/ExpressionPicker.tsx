import { useEffect, useState } from 'react';
import type { DatasetWhere } from '@nodeloom/core';
import { desk } from '../../lib/desk.js';
import { useOrg } from '../../lib/OrgContext.js';
import { useFocusedProject } from '../../lib/FocusContext.js';
import { composeBindingPatch, emptyDraft } from '../../lib/page-edit/bindingQuestions.js';
import type { BindingDraft, QuestionColumn } from '../../lib/page-edit/bindingQuestions.js';
import { PRESENT_WORDS, bindableNodesOf } from '../../lib/canvas/tools/create/Drawing.js';
import { BindingQuestions } from './BindingQuestions.js';
import styles from './editor.module.css';

// The wire-drop picker: live sample rows plus the binding questions; one verb lands the wire.

export interface PickerRequest {
  /** binding = Table→App · op-run = Table→Tool · app-action = App→Tool · write-back = Tool→Table. */
  mode: 'binding' | 'op-run' | 'app-action' | 'write-back';
  dataset?: string;
  targetLabel: string;
  verb: string;
  /** binding mode: candidate screens; the question renders only with more than one. */
  screens?: Array<{ slug: string; title: string }>;
  /** The wired screen, pre-picked. */
  preferredScreen?: string;
  /** write-back mode: the operation's rows output the wire lands on. */
  output?: string;
  /** op-run mode: false hides "keep it updated". */
  canChain?: boolean;
}

/** The one verb's mode-shaped payload. */
export interface PickerPayload {
  columns?: string[];
  columnDefs?: Array<{ key: string; label: string; type?: 'string' | 'number' | 'boolean' }>;
  filter?: DatasetWhere[];
  orderBy?: { col: string; dir: 'asc' | 'desc' };
  screenSlug?: string;
  /** How the landed rows render; absent = table. */
  present?: 'table' | 'cards' | 'list' | 'template' | 'existing';
  /** present 'existing': the bound-able node on the chosen screen taking the feed. */
  existingNode?: string;
  keepUpdated?: boolean;
  buttonLabel?: string;
  /** write-back mode: the column rows are matched by. */
  keyColumn?: string;
  /** binding mode: one row of the table, keyed from the link. */
  rowKey?: { column: string };
}

export function ExpressionPicker({ request, onPick, onClose }: {
  request: PickerRequest;
  onPick: (payload: PickerPayload) => void;
  onClose: () => void;
}) {
  const { orgId } = useOrg();
  // The picker's dataset resolves within the focused project.
  const pid = useFocusedProject().focusedProjectId ?? undefined;
  const [brief, setBrief] = useState<Awaited<ReturnType<typeof desk.datasetBrief>> | null>(null);
  const [draft, setDraft] = useState<BindingDraft>(emptyDraft());
  const [screenSlug, setScreenSlug] = useState<string | undefined>(
    request.preferredScreen ?? request.screens?.[0]?.slug,
  );
  const [buttonLabel, setButtonLabel] = useState('');
  // Key column pre-answered with the first string column.
  const [keyColumn, setKeyColumn] = useState<string | undefined>(undefined);
  const [present, setPresent] = useState<string>('table');
  const [bindables, setBindables] = useState<Array<{ id: string; word: string }>>([]);
  // An empty table names its first columns right here, then the questions continue.
  const [firstCols, setFirstCols] = useState('');
  const [shaping, setShaping] = useState<string | null>(null);

  useEffect(() => {
    if (request.dataset === undefined) return;
    desk.datasetBrief(orgId, request.dataset, pid).then(setBrief).catch(() => undefined);
  }, [orgId, request.dataset, pid]);

  // Existing-face candidates belong to their screen; the pick resets when the screen changes.
  useEffect(() => {
    setBindables([]);
    setPresent((s) => (s.startsWith('existing:') ? 'table' : s));
    if (request.mode !== 'binding' || screenSlug === undefined) return;
    setBindables(bindableNodesOf(screenSlug));
  }, [orgId, pid, request.mode, screenSlug]);

  // Esc closes the picker first; capture + stop keeps the press from the bubble fallbacks.
  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [onClose]);

  const columns: QuestionColumn[] = (brief?.columns ?? []).map((c) => ({ key: c.key, display: c.display, type: c.type }));
  // A zero-column table cannot wire yet: the picker asks for its first columns before the questions.
  const shapeless = request.dataset !== undefined && brief !== null && columns.length === 0;
  const giveShape = async (): Promise<void> => {
    const names = firstCols.split(',').map((n) => n.trim()).filter((n) => n !== '');
    if (request.dataset === undefined || names.length === 0) return;
    setShaping('Adding the columns…');
    const keyOf = (n: string): string => n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'column';
    const res = await desk.humanEvolveDataset(orgId, request.dataset, { add: names.map((n) => ({ col: keyOf(n), type: 'string' as const })) }, pid);
    if (!res.ok) { setShaping(res.error); return; }
    await Promise.all(names.filter((n) => keyOf(n) !== n).map((n) => desk.humanSetColumnDisplay(orgId, request.dataset!, keyOf(n), n, pid).catch(() => undefined)));
    setShaping(null);
    setBrief(await desk.datasetBrief(orgId, request.dataset, pid).catch(() => null));
  };
  const allPicked = draft.picked.length === 0; // nothing toggled = everything
  const effKey = keyColumn ?? columns.find((c) => c.type === 'string')?.key ?? columns[0]?.key;
  const screens = request.screens ?? [];
  const askScreen = request.mode === 'binding' && screens.length > 1;
  const screenTitle = screens.find((s) => s.slug === screenSlug)?.title;

  function toggle(key: string): void {
    setDraft((d) => ({
      ...d,
      picked: d.picked.includes(key) ? d.picked.filter((k) => k !== key) : [...d.picked, key],
    }));
  }

  /** Compiles the plain-word answers to the contract shapes and hands them to onPick. */
  function landBinding(): void {
    const patch = composeBindingPatch(draft, columns);
    const byKey = new Map(columns.map((c) => [c.key, c]));
    const defsOf = (keys: string[]) => keys.map((k) => {
      const col = byKey.get(k);
      return { key: k, label: col?.display ?? k, ...(col !== undefined ? { type: col.type } : {}) };
    });
    // Cards/list/template reuse the picked columns; the stored contract stays the three answers.
    const face = present.startsWith('existing:')
      ? { present: 'existing' as const, existingNode: present.slice('existing:'.length) }
      : present !== 'table' ? { present: present as 'cards' | 'list' | 'template' } : {};
    const wantsDefs = present === 'cards' || present === 'list' || present === 'template';
    onPick({
      ...(draft.picked.length > 0
        ? { columns: draft.picked, columnDefs: defsOf(draft.picked) }
        : wantsDefs ? { columnDefs: defsOf(columns.map((c) => c.key)) } : {}),
      ...(patch.query?.where !== undefined ? { filter: patch.query.where } : {}),
      ...(patch.query?.orderBy?.[0] !== undefined ? { orderBy: patch.query.orderBy[0] } : {}),
      ...(patch.rowKey !== undefined ? { rowKey: patch.rowKey } : {}),
      ...(screenSlug !== undefined ? { screenSlug } : {}),
      ...face,
    });
  }

  return (
    <div className={styles.picker}>
      <div className={styles.pickerHead}>
        <span className={styles.pickerVerb}>{request.verb}</span>
        <button type="button" className={styles.pickerClose} aria-label="Close" onClick={onClose}>×</button>
      </div>
      {request.mode === 'binding' && request.dataset !== undefined && !shapeless ? (
        <BindingQuestions columns={columns} draft={draft} onChange={setDraft} />
      ) : null}
      {request.dataset !== undefined ? (
        <>
          {request.mode === 'op-run' ? (
            <div className={styles.pickerChips}>
              {columns.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  className={allPicked || draft.picked.includes(c.key) ? `${styles.chip} ${styles.chipOn}` : styles.chip}
                  onClick={() => toggle(c.key)}
                >
                  {c.display}
                </button>
              ))}
            </div>
          ) : null}
          {brief !== null && brief.sampleRows.length > 0 ? (
            <div className={styles.pickerSample}>
              <table>
                <thead>
                  <tr>{columns.map((c) => <th key={c.key}>{c.display}</th>)}</tr>
                </thead>
                <tbody>
                  {brief.sampleRows.map((r) => (
                    <tr key={r._id}>
                      {columns.map((c) => (
                        <td key={c.key} onClick={() => toggle(c.key)}>{String(r[c.key] ?? '—')}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      ) : null}
      {request.mode === 'binding' && shapeless ? (
        <form className={styles.firstCols} onSubmit={(e) => { e.preventDefault(); void giveShape(); }}>
          <div className={styles.questionWord}>This table has no columns yet</div>
          <div className={styles.pickerQuiet}>Name them to connect it, separated by commas. You can change them later in the rows.</div>
          <div className={styles.formRow}>
            <input
              className={styles.formInput}
              autoFocus
              placeholder="Name, Done, Date"
              aria-label="First columns"
              value={firstCols}
              onChange={(e) => { setFirstCols(e.target.value); setShaping(null); }}
            />
            <button type="submit" className={styles.pickerGo} disabled={firstCols.trim() === '' || shaping === 'Adding the columns…'}>Add</button>
          </div>
          {shaping !== null ? <div className={styles.pickerQuiet}>{shaping}</div> : null}
        </form>
      ) : null}
      {request.dataset !== undefined && !shapeless && brief !== null && brief.sampleRows.length === 0 && columns.length > 0 ? (
        <div className={styles.pickerQuiet}>No rows yet. The connection still works and fills in as rows arrive.</div>
      ) : null}
      {request.mode === 'write-back' && columns.length > 0 ? (
        <>
          <div className={styles.questionWord}>Match rows by</div>
          <div className={styles.formRow}>
            <select
              className={styles.formSelect}
              value={effKey ?? ''}
              onChange={(e) => setKeyColumn(e.target.value)}
            >
              {columns.map((c) => <option key={c.key} value={c.key}>{c.display}</option>)}
            </select>
          </div>
        </>
      ) : null}
      {askScreen ? (
        <>
          <div className={styles.questionWord}>Show on which view?</div>
          <div className={styles.formRow}>
            <select
              className={styles.formSelect}
              value={screenSlug}
              onChange={(e) => setScreenSlug(e.target.value)}
            >
              {screens.map((s) => <option key={s.slug} value={s.slug}>{s.title}</option>)}
            </select>
          </div>
        </>
      ) : null}
      {request.mode === 'binding' && !shapeless ? (
        <>
          <div className={styles.questionWord}>Show it as…</div>
          <div className={styles.formRow}>
            <select
              className={styles.formSelect}
              value={present}
              onChange={(e) => setPresent(e.target.value)}
            >
              {PRESENT_WORDS.map((o) => <option key={o.choice} value={o.choice}>{o.word}</option>)}
              {bindables.map((b) => (
                <option key={b.id} value={`existing:${b.id}`}>{`On the existing ${b.word}`}</option>
              ))}
            </select>
          </div>
        </>
      ) : null}
      {request.mode === 'app-action' ? (
        <input
          className={styles.pickerInput}
          placeholder="What the button says"
          value={buttonLabel}
          onChange={(e) => setButtonLabel(e.target.value)}
        />
      ) : null}
      <div className={styles.pickerVerbs}>
        {request.mode === 'binding' && !shapeless ? (
          <button type="button" className={styles.pickerGo} onClick={landBinding}>
            {`Show on ${screenTitle ?? request.targetLabel}`}
          </button>
        ) : null}
        {request.mode === 'op-run' ? (
          <>
            <button type="button" className={styles.pickerGo} onClick={() => onPick({ keepUpdated: false })}>
              {`Run ${request.targetLabel}`}
            </button>
            {request.canChain !== false ? (
              <button type="button" className={styles.pickerAlt} onClick={() => onPick({ keepUpdated: true })}>
                Run + keep it updated
              </button>
            ) : null}
          </>
        ) : null}
        {request.mode === 'app-action' ? (
          <button
            type="button"
            className={styles.pickerGo}
            disabled={buttonLabel.trim() === ''}
            onClick={() => onPick({ buttonLabel: buttonLabel.trim() })}
          >
            {`Add the button to ${request.targetLabel}`}
          </button>
        ) : null}
        {request.mode === 'write-back' ? (
          <button
            type="button"
            className={styles.pickerGo}
            disabled={effKey === undefined}
            onClick={() => { if (effKey !== undefined) onPick({ keyColumn: effKey }); }}
          >
            {`Keep ${request.targetLabel} updated`}
          </button>
        ) : null}
      </div>
    </div>
  );
}
