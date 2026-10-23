import { useCallback, useEffect, useState } from 'react';
import { desk } from '../../lib/desk.js';
import { useLive } from '../../lib/data/useLive.js';
import { useOrg } from '../../lib/OrgContext.js';
import { useFocusedProject } from '../../lib/FocusContext.js';
import styles from './tablegrid.module.css';

// Spreadsheet grid for a Table node: cell edits, row add/delete, and column rename/add/delete.
// Changing a column's type is not offered; add a new column and delete the old one instead.

type Brief = Awaited<ReturnType<typeof desk.datasetBrief>>;
type Row = Record<string, unknown> & { _id: string };

/** Every landed edit reports its inverse ingredients for undo. */
export interface GridEdit {
  kind: 'row-update' | 'row-delete' | 'row-append';
  dataset: string;
  rowId: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}

export function TableGrid({ dataset, onDidEdit }: {
  dataset: string;
  onDidEdit?: (edit: GridEdit) => void;
}) {
  const { orgId } = useOrg();
  // The grid reads and writes within the focused project.
  const pid = useFocusedProject().focusedProjectId ?? undefined;
  const [brief, setBrief] = useState<Brief | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [editing, setEditing] = useState<{ rowId: string; key: string; value: string } | null>(null);
  const [renaming, setRenaming] = useState<{ key: string; value: string } | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [note, setNote] = useState<string | null>(null);
  const [colMenu, setColMenu] = useState<string | null>(null);
  const [confirmCol, setConfirmCol] = useState<string | null>(null);
  const [addingCol, setAddingCol] = useState<{ name: string; type: 'string' | 'number' | 'boolean' } | null>(null);

  const refetch = useCallback((): void => {
    desk.datasetBrief(orgId, dataset, pid).then(setBrief).catch(() => undefined);
    desk.datasetRows(orgId, dataset, 200, 0, pid).then((p) => { setRows(p.rows); setTotal(p.total); }).catch(() => undefined);
  }, [orgId, dataset, pid]);
  useEffect(refetch, [refetch]);
  useLive(['dataset_rows'], refetch);

  const columns = brief?.columns ?? [];

  function speak(error: string): void {
    setNote(error);
    window.setTimeout(() => setNote(null), 5000);
  }

  // Writes render optimistically; a refusal refetches truth back and speaks.
  async function commitCell(): Promise<void> {
    if (editing === null) return;
    const col = columns.find((c) => c.key === editing.key);
    const before = rows.find((r) => r._id === editing.rowId);
    const value = coerce(editing.value, col?.type ?? 'string');
    setEditing(null);
    if (before === undefined || String(before[editing.key] ?? '') === editing.value) return;
    const { rowId, key } = editing;
    setRows((rs) => rs.map((r) => (r._id === rowId ? { ...r, [key]: value } : r)));
    const res = await desk.humanUpdateRow(orgId, dataset, rowId, { [key]: value }, pid);
    if (!res.ok) { speak(res.error); refetch(); return; }
    onDidEdit?.({
      kind: 'row-update', dataset, rowId,
      before: { [key]: before[key] }, after: { [key]: value },
    });
    refetch();
  }

  async function addRow(): Promise<void> {
    const row: Record<string, unknown> = {};
    for (const c of columns) row[c.key] = coerce(draft[c.key] ?? '', c.type);
    setRows((rs) => [...rs, { ...row, _id: `pending-${Date.now()}` }]);
    setTotal((t) => t + 1);
    setDraft({});
    const res = await desk.humanAppendRow(orgId, dataset, row, pid);
    if (!res.ok) { speak(res.error); refetch(); return; }
    if (res.data) onDidEdit?.({ kind: 'row-append', dataset, rowId: res.data.rowId, after: row });
    refetch();
  }

  async function removeRow(rowId: string): Promise<void> {
    const before = rows.find((r) => r._id === rowId);
    setRows((rs) => rs.filter((r) => r._id !== rowId));
    setTotal((t) => Math.max(0, t - 1));
    const res = await desk.humanDeleteRow(orgId, dataset, rowId, pid);
    if (!res.ok) { speak(res.error); refetch(); return; }
    const { _id, ...rest } = before ?? { _id: rowId };
    onDidEdit?.({ kind: 'row-delete', dataset, rowId, before: rest });
    refetch();
  }

  async function commitRename(): Promise<void> {
    if (renaming === null) return;
    const { key, value } = renaming;
    setRenaming(null);
    const res = await desk.humanSetColumnDisplay(orgId, dataset, key, value.trim() === '' ? null : value.trim(), pid);
    if (!res.ok) { speak(res.error); return; }
    refetch();
  }

  /** Delete column deprecates it: new rows lose it, stored rows keep their values. */
  async function deleteColumn(key: string): Promise<void> {
    setConfirmCol(null);
    const res = await desk.humanEvolveDataset(orgId, dataset, { deprecate: [key] }, pid);
    if (!res.ok) { speak(res.error); return; }
    refetch();
  }

  /** Add column: kebab key never renders; a differing display name lands alongside. */
  async function addColumn(): Promise<void> {
    if (addingCol === null) return;
    const name = addingCol.name.trim();
    if (name === '') { setAddingCol(null); return; }
    const key = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'column';
    const res = await desk.humanEvolveDataset(orgId, dataset, { add: [{ col: key, type: addingCol.type }] }, pid);
    if (!res.ok) { speak(res.error); return; }
    if (name !== key) await desk.humanSetColumnDisplay(orgId, dataset, key, name, pid).catch(() => undefined);
    setAddingCol(null);
    refetch();
  }

  if (brief !== null && !brief.exists) {
    return <div className={styles.quiet}>this table is gone</div>;
  }

  return (
    <div className={styles.grid}>
      <div className={styles.gridMeta}>
        {`${total} row${total === 1 ? '' : 's'}`}
        {note !== null ? <span className={styles.gridNote}>{note}</span> : null}
      </div>
      <div className={styles.gridScroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key} title={c.sentence} className={styles.colHead} onDoubleClick={() => setRenaming({ key: c.key, value: c.display })}>
                  {renaming?.key === c.key ? (
                    <input
                      className={styles.cellInput}
                      autoFocus
                      value={renaming.value}
                      onChange={(e) => setRenaming({ key: c.key, value: e.target.value })}
                      onBlur={() => void commitRename()}
                      onKeyDown={(e) => { if (e.key === 'Enter') void commitRename(); if (e.key === 'Escape') setRenaming(null); }}
                    />
                  ) : (
                    <button
                      type="button" className={styles.colHeadBtn}
                      onClick={() => { setConfirmCol(null); setColMenu(colMenu === c.key ? null : c.key); }}
                    >{c.display}</button>
                  )}
                  {colMenu === c.key ? (
                    <span className={styles.colMenu}>
                      <button
                        type="button" className={styles.colMenuItem}
                        onClick={() => { setColMenu(null); setRenaming({ key: c.key, value: c.display }); }}
                      >Rename</button>
                      <button
                        type="button" className={styles.colMenuItem}
                        onClick={() => { setColMenu(null); setConfirmCol(c.key); }}
                      >Delete column</button>
                    </span>
                  ) : null}
                  {confirmCol === c.key ? (
                    <span className={styles.colConfirm}>
                      <span>New rows lose {c.display}; stored rows keep their old values.</span>
                      <button type="button" className={styles.colConfirmGo} onClick={() => void deleteColumn(c.key)}>Delete</button>
                      <button type="button" className={styles.colConfirmNo} onClick={() => setConfirmCol(null)}>Keep</button>
                    </span>
                  ) : null}
                </th>
              ))}
              <th className={styles.colHead}>
                {addingCol === null ? (
                  <button type="button" className={styles.colAdd} aria-label="Add a column" onClick={() => setAddingCol({ name: '', type: 'string' })}>+</button>
                ) : (
                  <span className={styles.colAddForm}>
                    <input
                      className={styles.cellInput} autoFocus placeholder="Column name"
                      value={addingCol.name}
                      onChange={(e) => setAddingCol({ ...addingCol, name: e.target.value })}
                      onKeyDown={(e) => { if (e.key === 'Enter') void addColumn(); if (e.key === 'Escape') setAddingCol(null); }}
                    />
                    <select
                      className={styles.cellInput} value={addingCol.type} aria-label="Column type"
                      onChange={(e) => setAddingCol({ ...addingCol, type: e.target.value as 'string' | 'number' | 'boolean' })}
                    >
                      <option value="string">words</option>
                      <option value="number">numbers</option>
                      <option value="boolean">yes / no</option>
                    </select>
                    <button type="button" className={styles.colConfirmGo} onClick={() => void addColumn()}>Add</button>
                  </span>
                )}
              </th>
              <th className={styles.rowTools} />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r._id}>
                {columns.map((c) => (
                  <td key={c.key} onClick={() => setEditing({ rowId: r._id, key: c.key, value: String(r[c.key] ?? '') })}>
                    {editing?.rowId === r._id && editing.key === c.key ? (
                      <input
                        className={styles.cellInput}
                        autoFocus
                        value={editing.value}
                        onChange={(e) => setEditing({ ...editing, value: e.target.value })}
                        onBlur={() => void commitCell()}
                        onKeyDown={(e) => { if (e.key === 'Enter') void commitCell(); if (e.key === 'Escape') setEditing(null); }}
                      />
                    ) : (
                      <span className={styles.cellValue}>{r[c.key] === null || r[c.key] === undefined ? '—' : String(r[c.key])}</span>
                    )}
                  </td>
                ))}
                <td />
                <td className={styles.rowTools}>
                  <button type="button" className={styles.rowDelete} aria-label="Delete row" onClick={() => void removeRow(r._id)}>×</button>
                </td>
              </tr>
            ))}
            {columns.length > 0 ? (
              <tr className={styles.draftRow}>
                {columns.map((c) => (
                  <td key={c.key}>
                    <input
                      className={styles.cellInput}
                      placeholder={c.display}
                      value={draft[c.key] ?? ''}
                      onChange={(e) => setDraft({ ...draft, [c.key]: e.target.value })}
                      onKeyDown={(e) => { if (e.key === 'Enter') void addRow(); }}
                    />
                  </td>
                ))}
                <td />
                <td className={styles.rowTools}>
                  <button type="button" className={styles.rowAdd} aria-label="Add row" onClick={() => void addRow()}>+</button>
                </td>
              </tr>
            ) : (
              <tr><td className={styles.quiet}>no columns yet — click + above to add one, or paste rows from the chat</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function coerce(raw: string, type: 'string' | 'number' | 'boolean'): unknown {
  if (raw === '') return null;
  if (type === 'number') {
    const n = Number(raw);
    return Number.isNaN(n) ? raw : n;
  }
  if (type === 'boolean') return raw === 'true' || raw === 'yes' || raw === '1';
  return raw;
}
