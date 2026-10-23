import { MAX_CLAUSES, OP_WORDS } from '../../lib/page-edit/bindingQuestions.js';
import type { BindingDraft, FilterClause, QuestionColumn } from '../../lib/page-edit/bindingQuestions.js';
import styles from './editor.module.css';

// The one binding form (rows / fields / order); untouched means all rows, every field, natural order.

export function BindingQuestions({ columns, draft, onChange }: {
  columns: QuestionColumn[];
  draft: BindingDraft;
  onChange: (next: BindingDraft) => void;
}) {
  const allPicked = draft.picked.length === 0;
  const firstKey = columns[0]?.key ?? '';

  function setClause(i: number, patch: Partial<FilterClause>): void {
    const clauses = draft.clauses.map((c, j) => {
      if (j !== i) return c;
      const next = { ...c, ...patch };
      // Changing the field resets the typed value — it was typed for the old column's type.
      if (patch.field !== undefined && patch.field !== c.field) next.value = '';
      return next;
    });
    onChange({ ...draft, clauses });
  }

  function toggleField(key: string): void {
    const picked = draft.picked.includes(key)
      ? draft.picked.filter((k) => k !== key)
      : [...draft.picked, key];
    onChange({ ...draft, picked });
  }

  function valueInput(clause: FilterClause, i: number) {
    const type = columns.find((c) => c.key === clause.field)?.type ?? 'string';
    if (type === 'boolean') {
      return (
        <select
          className={styles.formSelect}
          value={clause.value}
          onChange={(e) => setClause(i, { value: e.target.value })}
        >
          <option value="">—</option>
          <option value="yes">yes</option>
          <option value="no">no</option>
        </select>
      );
    }
    return (
      <input
        className={styles.pickerInput}
        type={type === 'number' ? 'number' : 'text'}
        placeholder="value"
        value={clause.value}
        onChange={(e) => setClause(i, { value: e.target.value })}
      />
    );
  }

  return (
    <div className={styles.questions}>
      <div className={styles.questionWord}>Which rows?</div>
      {draft.clauses.length === 0 ? <div className={styles.questionQuiet}>all rows</div> : null}
      {draft.clauses.map((clause, i) => (
        // eslint-disable-next-line react/no-array-index-key
        <div key={i} className={styles.formRow}>
          <select
            className={styles.formSelect}
            value={clause.field}
            onChange={(e) => setClause(i, { field: e.target.value })}
          >
            {columns.map((c) => <option key={c.key} value={c.key}>{c.display}</option>)}
          </select>
          <select
            className={styles.formSelect}
            value={clause.op}
            onChange={(e) => setClause(i, { op: e.target.value as FilterClause['op'] })}
          >
            {OP_WORDS.map((o) => <option key={o.op} value={o.op}>{o.word}</option>)}
          </select>
          {valueInput(clause, i)}
          <button
            type="button" className={styles.clauseRemove} aria-label="Remove this rule"
            onClick={() => onChange({ ...draft, clauses: draft.clauses.filter((_, j) => j !== i) })}
          >×</button>
        </div>
      ))}
      {draft.clauses.length < MAX_CLAUSES && columns.length > 0 ? (
        <button
          type="button" className={styles.addRule}
          onClick={() => onChange({
            ...draft,
            clauses: [...draft.clauses, { field: firstKey, op: 'eq', value: '' }],
          })}
        >+ only rows where…</button>
      ) : null}

      <div className={styles.questionWord}>Which fields?</div>
      <div className={styles.pickerChips}>
        {columns.map((c) => (
          <button
            key={c.key}
            type="button"
            className={allPicked || draft.picked.includes(c.key) ? `${styles.chip} ${styles.chipOn}` : styles.chip}
            onClick={() => toggleField(c.key)}
          >
            {c.display}
          </button>
        ))}
      </div>

      {/* Detail arm: the published page serves /<screen>/<key>. */}
      <div className={styles.questionWord}>Which row?</div>
      <div className={styles.formRow}>
        <select
          className={styles.formSelect}
          value={draft.rowKey ?? ''}
          onChange={(e) => onChange({ ...draft, rowKey: e.target.value === '' ? null : e.target.value })}
        >
          <option value="">every row</option>
          {columns.map((c) => <option key={c.key} value={c.key}>{`the one the link names, by ${c.display}`}</option>)}
        </select>
      </div>

      <div className={styles.questionWord}>What order?</div>
      <div className={styles.formRow}>
        <select
          className={styles.formSelect}
          value={draft.order?.col ?? ''}
          onChange={(e) => onChange({
            ...draft,
            order: e.target.value === '' ? null : { col: e.target.value, dir: draft.order?.dir ?? 'asc' },
          })}
        >
          <option value="">as they come</option>
          {columns.map((c) => <option key={c.key} value={c.key}>{`by ${c.display}`}</option>)}
        </select>
        {draft.order !== null ? (
          <select
            className={styles.formSelect}
            value={draft.order.dir}
            onChange={(e) => onChange({ ...draft, order: { col: draft.order!.col, dir: e.target.value as 'asc' | 'desc' } })}
          >
            <option value="asc">low → high</option>
            <option value="desc">high → low</option>
          </select>
        ) : null}
      </div>
    </div>
  );
}
