import type { DatasetQuery, DatasetWhere, SceneBinding } from '@nodeloom/core';

// The three questions over the one query grammar: which rows (where), which fields (the picked columns),
// what order (orderBy), plus the detail arm (rowKey). One model for the wire drop's picker and the
// Properties editor; the compiled answers are exactly a query binding's arms.

export type ColumnType = 'string' | 'number' | 'boolean';
export interface QuestionColumn { key: string; display: string; type: ColumnType }
export type FilterOp = DatasetWhere['op'];

export const OP_WORDS: ReadonlyArray<{ op: FilterOp; word: string }> = [
  { op: 'eq', word: 'is' }, { op: 'ne', word: 'is not' }, { op: 'gt', word: '>' }, { op: 'gte', word: 'at least' },
  { op: 'lt', word: '<' }, { op: 'lte', word: 'at most' }, { op: 'contains', word: 'contains' },
];
export const opWord = (op: FilterOp): string => OP_WORDS.find((o) => o.op === op)?.word ?? op;

export interface FilterClause { field: string; op: FilterOp; value: string }
export interface OrderPick { col: string; dir: 'asc' | 'desc' }

export interface BindingDraft {
  /** Picked field keys; empty = every field. */
  picked: string[];
  /** Row clauses; empty = all rows; the contract caps at 8. */
  clauses: FilterClause[];
  order: OrderPick | null;
  /** The detail arm: the column the link's key addresses; null = every row. */
  rowKey: string | null;
}

export const MAX_CLAUSES = 8;
export const emptyDraft = (): BindingDraft => ({ picked: [], clauses: [], order: null, rowKey: null });

/** Typed per the column's type; null = not a value yet (the clause waits). */
export function coerceValue(text: string, type: ColumnType): string | number | boolean | null {
  const t = text.trim();
  if (t === '') return null;
  if (type === 'number') { const n = Number(t); return Number.isFinite(n) ? n : null; }
  if (type === 'boolean') { if (t === 'yes' || t === 'true') return true; if (t === 'no' || t === 'false') return false; return null; }
  return t;
}

export interface BindingPatch { query?: DatasetQuery; rowKey?: { column: string } }

/** Draft -> the binding's arms; incomplete clauses stay unanswered (the default path is one click). */
export function composeBindingPatch(draft: BindingDraft, columns: QuestionColumn[]): BindingPatch {
  const typeOf = new Map(columns.map((c) => [c.key, c.type]));
  const where: DatasetWhere[] = [];
  for (const cl of draft.clauses.slice(0, MAX_CLAUSES)) {
    const type = typeOf.get(cl.field);
    if (type === undefined) continue;
    const value = coerceValue(cl.value, type);
    if (value === null) continue;
    where.push({ col: cl.field, op: cl.op, value });
  }
  const orderBy = draft.order !== null && draft.order.col !== '' ? [{ col: draft.order.col, dir: draft.order.dir }] : [];
  return {
    ...(where.length > 0 || orderBy.length > 0 ? { query: { ...(where.length > 0 ? { where } : {}), ...(orderBy.length > 0 ? { orderBy } : {}) } } : {}),
    ...(draft.rowKey !== null && typeOf.has(draft.rowKey) ? { rowKey: { column: draft.rowKey } } : {}),
  };
}

/** The stored binding -> a draft (the editor's seed); a non-query binding reads as the empty draft. */
export function draftFromBinding(binding: SceneBinding): BindingDraft {
  if (binding.kind !== 'query') return emptyDraft();
  const first = binding.query?.orderBy?.[0];
  return {
    picked: [],
    clauses: (binding.query?.where ?? []).map((p) => ({ field: p.col, op: p.op, value: String(p.value) })),
    order: first !== undefined ? { col: first.col, dir: first.dir } : null,
    rowKey: binding.rowKey?.column ?? null,
  };
}

/** The picked columns with their display words; no pick = the source's first six. */
export function tableColumnsFor(
  columnDefs: Array<{ key: string; label: string; type?: ColumnType }> | undefined,
  columns: Array<{ key: string; display: string; type?: ColumnType }>,
): Array<{ key: string; label: string; type?: ColumnType }> {
  if (columnDefs !== undefined && columnDefs.length > 0) return columnDefs;
  return columns.slice(0, 6).map((c) => ({ key: c.key, label: c.display, ...(c.type !== undefined ? { type: c.type } : {}) }));
}

/** The landed consumer's node id - deterministic per table (a replay no-ops at the wall). */
export function consumerNodeId(dataset: string): string {
  const base = dataset.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '');
  return `show-${base || 'rows'}`.slice(0, 64);
}
