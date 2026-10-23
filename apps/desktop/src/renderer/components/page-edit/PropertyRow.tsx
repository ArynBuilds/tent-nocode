import { useState } from 'react';
import { store, useValue } from '../../lib/canvas/store.js';
import { ColorPicker } from './ColorPicker.js';
import { boundText, isBoundValue, paintKindOf, paintOfKind, paintSubRows } from './panelGroups.js';
import type { PaintKind, RowSpec } from './panelGroups.js';
import styles from './editor.module.css';

// ONE ROW PER SCHEMA TYPE (Phase 12, row 12.16): label left, value right, a ghost "Add" while unset, an x
// that clears; the paint row carries its kind and the kind's sub rows; a bound expression renders as one
// mono line whatever the row's kind. The row never writes - it hands the next value up.


/** Labels read as words in sentence case; the schema keeps its own lowercase keys. */
export const sentence = (s: string): string => (s === '' ? s : s.charAt(0).toUpperCase() + s.slice(1));

export interface RowProps {
  spec: RowSpec;
  /** The value in the panel's scope (undefined = unset here). */
  value: unknown;
  /** The default scope's value, shown quietly when the scope is a state or breakpoint. */
  inherited?: unknown;
  scoped: boolean;
  onChange: (value: unknown) => void;
  sub?: boolean;
}

const asText = (v: unknown): string => (v === undefined || v === null ? '' : typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v));

function parseTyped(raw: string, words: readonly string[]): unknown {
  const t = raw.trim();
  if (t === '') return undefined;
  if (words.includes(t)) return t;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (/^-?\d+(\.\d+)?%$/.test(t)) return t;
  return t;
}

const PAINT_KINDS: readonly PaintKind[] = ['color', 'gradient', 'image', 'video'];

export function PropertyRow({ spec, value, inherited, scoped, onChange, sub = false }: RowProps) {
  const set = value !== undefined;
  const shown = set ? value : inherited;
  const labelClass = `${styles.rowLabel} ${set ? (scoped ? styles.rowScoped : styles.rowSet) : ''}`;
  return (
    <div className={`${styles.row} ${sub ? styles.rowSub : ''}`} title={spec.hint}>
      <span className={labelClass}>
        {sentence(spec.label)}
        {set && scoped ? <span className={styles.rowDot} title="overridden in this view - x clears back to auto" /> : null}
      </span>
      <div className={styles.rowValue}>
        {isBoundValue(shown) ? (
          <span className={styles.bound}><span className={styles.boundMark}>=</span>{boundText(shown)}</span>
        ) : <RowControl spec={spec} value={shown} onChange={onChange} />}
      </div>
      {set ? <button type="button" className={styles.rowClear} aria-label={`Clear ${spec.label}`} onClick={() => onChange(undefined)}>x</button> : <span />}
    </div>
  );
}

function RowControl({ spec, value, onChange }: { spec: RowSpec; value: unknown; onChange: (v: unknown) => void }) {
  switch (spec.kind) {
    case 'toggle': return <ToggleRow value={value} onChange={onChange} />;
    case 'enum': return <EnumRow spec={spec} value={value} onChange={onChange} />;
    case 'number': return <NumberRow spec={spec} value={value} onChange={onChange} />;
    case 'color': return <ColorRow spec={spec} value={value} onChange={onChange} />;
    case 'paint': return <PaintRow spec={spec} value={value} onChange={onChange} />;
    case 'shadows': return <ShadowsRow value={value} onChange={onChange} />;
    case 'pin': return <PinRow value={value} onChange={onChange} />;
    case 'cell': return <CellRow value={value} onChange={onChange} />;
    case 'encoding': return <EncodingRow value={value} onChange={onChange} />;
    case 'component': return <ComponentRow value={value} onChange={onChange} />;
    case 'shape': return <TextRow spec={spec} value={value} onChange={onChange} json />;
    default: return <TextRow spec={spec} value={value} onChange={onChange} />;
  }
}

function TextRow({ spec, value, onChange, json = false }: { spec: RowSpec; value: unknown; onChange: (v: unknown) => void; json?: boolean }) {
  const [draft, setDraft] = useState<string | null>(null);
  if (value === undefined && draft === null) return <button type="button" className={styles.ghost} onClick={() => setDraft('')}>Add</button>;
  const commit = (): void => {
    if (draft === null) return;
    const t = draft.trim();
    if (t === '') { onChange(undefined); setDraft(null); return; }
    if (json) { try { onChange(JSON.parse(t)); } catch { onChange(parseTyped(t, spec.options)); } }
    else onChange(parseTyped(t, spec.options));
    setDraft(null);
  };
  return (
    <input
      className={`${styles.input} ${json ? styles.inputMono : ''}`} value={draft ?? asText(value)} placeholder={json ? spec.type : spec.label}
      autoFocus={draft === '' && value === undefined}
      onChange={(e) => setDraft(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setDraft(null); }}
    />
  );
}

function ToggleRow({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) {
  const on = value === true;
  return <button type="button" role="switch" aria-checked={on} className={`${styles.toggle} ${on ? styles.toggleOn : ''}`} onClick={() => onChange(!on)} />;
}

function EnumRow({ spec, value, onChange }: { spec: RowSpec; value: unknown; onChange: (v: unknown) => void }) {
  if (spec.options.length <= 4) {
    return (
      <span className={styles.segment}>
        {spec.options.map((o) => (
          <button key={o} type="button" className={`${styles.segmentBtn} ${value === o ? styles.segmentOn : ''}`} onClick={() => onChange(o)}>{sentence(o)}</button>
        ))}
      </span>
    );
  }
  return (
    <select className={styles.select} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}>
      <option value="">-</option>
      {spec.options.map((o) => <option key={o} value={o}>{sentence(o)}</option>)}
    </select>
  );
}

function NumberRow({ spec, value, onChange }: { spec: RowSpec; value: unknown; onChange: (v: unknown) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  if (value === undefined && draft === null) return <button type="button" className={styles.ghost} onClick={() => setDraft('')}>Add</button>;
  const num = typeof value === 'number' ? value : null;
  const unitWord = spec.unit === 'px' ? 'px' : spec.unit === 'percent' ? '%' : spec.unit === 'ms' ? 'ms' : spec.unit === 'deg' ? 'deg' : '';
  const commit = (): void => {
    if (draft === null) return;
    onChange(parseTyped(draft, spec.options));
    setDraft(null);
  };
  return (
    <>
      <input
        className={`${styles.input} ${styles.inputNum}`} value={draft ?? asText(value)} placeholder="0" autoFocus={draft === '' && value === undefined}
        onChange={(e) => setDraft(e.target.value)} onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') setDraft(null);
          if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && num !== null) { e.preventDefault(); onChange(num + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : spec.range?.step ?? 1)); }
        }}
      />
      {spec.options.length > 0 ? (
        <select className={styles.select} style={{ flex: 'none', width: 72 }} value={typeof value === 'string' ? value : ''} onChange={(e) => { if (e.target.value !== '') onChange(e.target.value); }}>
          <option value="">{unitWord || 'n'}</option>
          {spec.options.map((o) => <option key={o} value={o}>{sentence(o)}</option>)}
        </select>
      ) : <span className={styles.unit}>{unitWord}</span>}
      {spec.range !== null && num !== null ? (
        <input type="range" className={styles.slider} min={spec.range.min} max={spec.range.max} step={spec.range.step} value={num} onChange={(e) => onChange(Number(e.target.value))} />
      ) : null}
    </>
  );
}

function ColorRow({ spec, value, onChange }: { spec: RowSpec; value: unknown; onChange: (v: unknown) => void }) {
  const [open, setOpen] = useState(false);
  const text = typeof value === 'string' ? value : '';
  return (
    <span className={styles.swatchWrap}>
      <button type="button" className={styles.swatch} style={{ background: text === '' ? undefined : `var(--${text}, ${text})` }} aria-label={`Pick ${spec.label}`} onClick={() => setOpen((o) => !o)} />
      <TextRow spec={spec} value={value} onChange={onChange} />
      {open ? (
        <span className={styles.popover}>
          <ColorPicker word={spec.label} value={text === '' ? '#ececec' : text} onCommit={(v) => onChange(v)} onClose={() => setOpen(false)} />
        </span>
      ) : null}
    </span>
  );
}

function PaintRow({ spec, value, onChange }: { spec: RowSpec; value: unknown; onChange: (v: unknown) => void }) {
  const kind = paintKindOf(value);
  if (kind === 'none') return <button type="button" className={styles.ghost} onClick={() => onChange(paintOfKind('color', undefined))}>Add</button>;
  const obj = value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  const subRows = paintSubRows(value);
  return (
    <span className={styles.list}>
      <span className={styles.listRow}>
        <span className={styles.segment}>
          {PAINT_KINDS.map((k) => (
            <button key={k} type="button" className={`${styles.segmentBtn} ${kind === k ? styles.segmentOn : ''}`} onClick={() => { if (k !== kind) onChange(paintOfKind(k, value)); }}>{sentence(k)}</button>
          ))}
        </span>
      </span>
      {kind === 'color' ? <span className={styles.listRow}><ColorRow spec={spec} value={value} onChange={onChange} /></span> : null}
      {kind === 'list' ? <span className={styles.listRow}><TextRow spec={spec} value={value} onChange={onChange} json /></span> : null}
      {obj !== null ? subRows.map((r) => (
        <span key={r.key} className={styles.listRow}>
          <span className={styles.listWord}>{r.label}</span>
          <RowControl spec={r} value={obj[r.key]} onChange={(v) => { const next = { ...obj }; if (v === undefined) delete next[r.key]; else next[r.key] = v; onChange(next); }} />
        </span>
      )) : null}
    </span>
  );
}

const asRec = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Sets one key inside a shape value; an emptied shape clears the property. */
const patchShape = (obj: Record<string, unknown>, key: string, v: unknown, onChange: (next: unknown) => void): void => {
  const next = { ...obj };
  if (v === undefined || v === '') delete next[key]; else next[key] = v;
  onChange(Object.keys(next).length === 0 ? undefined : next);
};

const PIN_WORDS = { x: ['left', 'right', 'center', 'stretch', 'scale'], y: ['top', 'bottom', 'center', 'stretch', 'scale'] } as const;

/** pin: one compact select per axis - how x and y follow the parent's resize. */
function PinRow({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) {
  const obj = asRec(value);
  return (
    <span className={styles.list}>
      {(['x', 'y'] as const).map((axis) => (
        <span key={axis} className={styles.listRow}>
          <span className={styles.listWord}>{axis}</span>
          <select className={styles.select} value={typeof obj[axis] === 'string' ? (obj[axis] as string) : ''} onChange={(e) => patchShape(obj, axis, e.target.value, onChange)}>
            <option value="">{axis === 'x' ? 'left' : 'top'}</option>
            {PIN_WORDS[axis].map((o) => <option key={o} value={o}>{sentence(o)}</option>)}
          </select>
        </span>
      ))}
    </span>
  );
}

const CELL_NUMBERS = ['column', 'row', 'column-span', 'row-span'] as const;

/** cell: the grid cell this child occupies - column/row/spans as small numbers, the two aligns as selects. */
function CellRow({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) {
  const obj = asRec(value);
  return (
    <span className={styles.list}>
      <span className={styles.listRow}>
        {CELL_NUMBERS.map((k) => (
          <input
            key={k} className={`${styles.input} ${styles.inputNum}`} style={{ width: 44 }} placeholder={k.includes('span') ? 'span' : k.slice(0, 3)}
            title={k} value={asText(obj[k])}
            onChange={(e) => patchShape(obj, k, e.target.value === '' ? undefined : Number(e.target.value), onChange)}
          />
        ))}
      </span>
      {(['align-x', 'align-y'] as const).map((k) => (
        <span key={k} className={styles.listRow}>
          <span className={styles.listWord}>{sentence(k)}</span>
          <select className={styles.select} value={typeof obj[k] === 'string' ? (obj[k] as string) : ''} onChange={(e) => patchShape(obj, k, e.target.value, onChange)}>
            <option value="">-</option>
            {['start', 'center', 'end'].map((o) => <option key={o} value={o}>{sentence(o)}</option>)}
          </select>
        </span>
      ))}
    </span>
  );
}

/** component (Phase 12R, row 12R.14): the org's saved components as a dropdown off the store's live catalog; unset reads "New instance"; a name the list no longer holds stays visible as the resting word. */
function ComponentRow({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) {
  const items = useValue('row.components', () => store.libraryItems.get(), []);
  const text = typeof value === 'string' ? value : '';
  const picked = items.find((i) => i.name === text || `${i.name}@${i.version}` === text);
  return (
    <select
      className={styles.select} value={picked !== undefined ? picked.name : ''}
      onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
    >
      <option value="">{text !== '' ? text : 'New instance'}</option>
      {items.map((i) => <option key={i.name} value={i.name}>{i.title}</option>)}
    </select>
  );
}

const ENCODING_CHANNELS = ['x', 'y', 'color', 'size', 'opacity', 'shape', 'order', 'detail', 'text', 'tooltip', 'theta', 'radius', 'x2', 'y2'] as const;

/** encoding: one row per set Vega channel (a column name or a JSON channel object), plus an add picker. */
function EncodingRow({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) {
  const obj = asRec(value);
  const [draft, setDraft] = useState<{ key: string; text: string } | null>(null);
  const set = ENCODING_CHANNELS.filter((k) => obj[k] !== undefined);
  const unset = ENCODING_CHANNELS.filter((k) => obj[k] === undefined && k !== draft?.key);
  const channelText = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v));
  const parseChannel = (raw: string): unknown => {
    const t = raw.trim();
    if (t === '') return undefined;
    try { return JSON.parse(t); } catch { return t; }
  };
  const commitDraft = (): void => {
    if (draft === null) return;
    const v = parseChannel(draft.text);
    if (v !== undefined) patchShape(obj, draft.key, v, onChange);
    setDraft(null);
  };
  return (
    <span className={styles.list}>
      {set.map((k) => (
        <span key={k} className={styles.listRow}>
          <span className={styles.listWord}>{sentence(k)}</span>
          <input
            className={`${styles.input} ${styles.inputMono}`} value={channelText(obj[k])} placeholder="column or {field, ...}"
            onChange={(e) => patchShape(obj, k, parseChannel(e.target.value), onChange)}
          />
          <button type="button" className={styles.rowClear} style={{ opacity: 1 }} aria-label={`Clear ${k}`} onClick={() => patchShape(obj, k, undefined, onChange)}>x</button>
        </span>
      ))}
      {draft !== null ? (
        <span className={styles.listRow}>
          <span className={styles.listWord}>{draft.key}</span>
          <input
            className={`${styles.input} ${styles.inputMono}`} value={draft.text} placeholder="column or {field, ...}" autoFocus
            onChange={(e) => setDraft({ key: draft.key, text: e.target.value })} onBlur={commitDraft}
            onKeyDown={(e) => { if (e.key === 'Enter') commitDraft(); if (e.key === 'Escape') setDraft(null); }}
          />
        </span>
      ) : null}
      {unset.length > 0 ? (
        <span className={styles.listRow}>
          <select className={styles.select} value="" onChange={(e) => { if (e.target.value !== '') setDraft({ key: e.target.value, text: '' }); }}>
            <option value="">Add channel</option>
            {unset.map((k) => <option key={k} value={k}>{sentence(k)}</option>)}
          </select>
        </span>
      ) : null}
    </span>
  );
}

const SHADOW_KEYS = ['x', 'y', 'blur', 'spread'] as const;

function ShadowsRow({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) {
  const list: Array<Record<string, unknown>> = value === 'theme' ? [] : Array.isArray(value) ? (value as Array<Record<string, unknown>>) : value !== null && typeof value === 'object' ? [value as Record<string, unknown>] : [];
  const emit = (next: Array<Record<string, unknown>>): void => onChange(next.length === 0 ? undefined : next.length === 1 ? next[0] : next);
  return (
    <span className={styles.list}>
      {value === 'theme' ? <span className={styles.listRow}><span className={styles.listWord}>Theme shadow</span></span> : null}
      {list.map((s, i) => (
        <span key={i} className={styles.listRow}>
          {SHADOW_KEYS.map((k) => (
            <input
              key={k} className={`${styles.input} ${styles.inputNum}`} style={{ width: 40 }} placeholder={k} value={asText(s[k])}
              onChange={(e) => { const next = list.map((x, j) => (j === i ? { ...x, [k]: e.target.value === '' ? undefined : Number(e.target.value) } : x)); emit(next); }}
            />
          ))}
          <input className={styles.input} placeholder="Color" value={asText(s['color'])} onChange={(e) => emit(list.map((x, j) => (j === i ? { ...x, color: e.target.value } : x)))} />
          <button type="button" className={styles.rowClear} style={{ opacity: 1 }} aria-label="Remove shadow" onClick={() => emit(list.filter((_, j) => j !== i))}>x</button>
        </span>
      ))}
      <span className={styles.listRow}>
        <button type="button" className={styles.ghost} onClick={() => emit([...list, { x: 0, y: 4, blur: 12, color: 'rgba(0,0,0,.3)' }])}>Add shadow</button>
        {value === undefined ? <button type="button" className={styles.ghost} onClick={() => onChange('theme')}>Use theme shadow</button> : null}
      </span>
    </span>
  );
}
