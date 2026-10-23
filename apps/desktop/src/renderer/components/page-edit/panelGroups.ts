import { PRIMITIVES, SHARED_GROUPS, STATE_NAMES, typeText } from '@tent-nocode/core';
import type { GroupName, PrimitiveName, PropertyDef, PropertyTable, StateName, UnitGroup } from '@tent-nocode/core';

// THE PANEL'S PURE HALF (Phase 12, row 12.16): primitives.ts is the schema, this file turns it into
// sections and rows - one section per shared group plus the primitive's own group, a row kind per
// property type, the dependent visibility (a paint's stops until it is a gradient, a grid's columns
// until the layout is a grid; pin and cell read the PARENT's layout), and the scope math for the
// state and breakpoint dimensions.

export type RowKind = 'paint' | 'color' | 'number' | 'enum' | 'text' | 'toggle' | 'shadows' | 'shape' | 'pin' | 'cell' | 'encoding' | 'component';

export interface RowSpec {
  key: string;
  label: string;
  kind: RowKind;
  unit: UnitGroup | null;
  /** Enum rows: the words; number rows: the words a number may be replaced by ('fill', 'hug', 'theme'). */
  options: string[];
  hint: string;
  /** Structure, never a look: hidden outside the default scope. */
  fixed: boolean;
  /** A fixed row a breakpoint scope may still show and write (layout responds by breakpoint). */
  atOk: boolean;
  /** The type line, for the shape row's placeholder. */
  type: string;
  /** Number rows: the slider's span when the schema bounds it. */
  range: { min: number; max: number; step: number } | null;
}

export interface SectionSpec {
  id: string;
  title: string;
  own: boolean;
  rows: RowSpec[];
}

export type PanelState = 'default' | StateName;
export interface PanelScope { state: PanelState; breakpoint: string | null }

export const PANEL_STATES: readonly PanelState[] = ['default', ...STATE_NAMES];

const LABELS: Readonly<Record<string, string>> = {
  'fill-opacity': 'paint opacity', 'object-fit': 'fit', 'object-position': 'anchor',
  'border-color': 'color', 'border-width': 'width', 'border-style': 'style', 'border-radius': 'radius',
  'box-shadow': 'shadow', 'backdrop-filter': 'backdrop', 'mix-blend-mode': 'blend', 'transform-origin': 'origin',
  'min-width': 'min width', 'max-width': 'max width', 'min-height': 'min height', 'max-height': 'max height',
  'aspect-ratio': 'ratio', 'column-sizes': 'column sizes', 'row-sizes': 'row sizes', 'wrap-align': 'wrap align',
  'first-on-top': 'first on top',
  'font-family': 'family', 'font-size': 'size', 'font-weight': 'weight', 'font-style': 'style', 'line-height': 'leading',
  'letter-spacing': 'tracking', 'text-transform': 'case', 'text-decoration': 'decoration', 'text-align': 'align',
  'text-wrap': 'wrap', 'line-clamp': 'clamp', 'white-space': 'space', 'text-shadow': 'shadow', 'aria-label': 'label',
  'tab-index': 'tab order', 'scroll-snap': 'snap',
  'pointer-events': 'pointer', 'user-select': 'selectable', 'corner-radius': 'corners', 'stroke-width': 'stroke',
  'stroke-dash': 'dash', 'inner-radius': 'inner radius', 'outer-radius': 'outer radius', 'pad-angle': 'pad angle',
  'x-axis': 'x axis', 'y-axis': 'y axis', 'on-change': 'on change', 'on-pick': 'on pick',
};

const NUMBER_UNITS: ReadonlySet<UnitGroup> = new Set(['px', 'percent', 'number', 'ms', 'deg']);
const TEXT_UNITS: ReadonlySet<UnitGroup> = new Set(['text', 'word', 'font', 'ref']);

/** The slider spans the schema knows: opacities are 0..1, weights 100..900, the rest free. */
const RANGES: Readonly<Record<string, { min: number; max: number; step: number }>> = {
  'fill-opacity': { min: 0, max: 1, step: 0.01 }, opacity: { min: 0, max: 1, step: 0.01 },
  'font-weight': { min: 100, max: 900, step: 100 }, 'line-height': { min: 0.8, max: 3, step: 0.05 },
  'letter-spacing': { min: -2, max: 8, step: 0.1 }, 'border-radius': { min: 0, max: 64, step: 1 },
  gap: { min: 0, max: 64, step: 1 }, padding: { min: 0, max: 96, step: 1 }, 'border-width': { min: 0, max: 12, step: 1 },
  'font-size': { min: 8, max: 96, step: 1 }, rotation: { min: -180, max: 180, step: 1 }, band: { min: 0, max: 1, step: 0.05 },
};

/** Top-level union arms of a type line, the braces kept whole. */
function arms(type: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < type.length; i++) {
    const ch = type[i]!;
    if (ch === '{' || ch === '(' || ch === '[') depth += 1;
    if (ch === '}' || ch === ')' || ch === ']') depth -= 1;
    if (depth === 0 && type.startsWith(' | ', i)) { out.push(cur.trim()); cur = ''; i += 2; continue; }
    cur += ch;
  }
  if (cur.trim() !== '') out.push(cur.trim());
  return out;
}

const quoted = (arm: string): string | null => (/^"[^"]*"$/.test(arm) ? arm.slice(1, -1) : null);

export function rowSpecOf(key: string, def: PropertyDef): RowSpec {
  const type = typeText(def.schema);
  const parts = arms(type);
  const words = parts.map(quoted).filter((w): w is string => w !== null);
  const allWords = parts.length > 0 && words.length === parts.length;
  const base = { key, label: LABELS[key] ?? key, hint: def.hint, fixed: def.fixed === true, atOk: def.atOk === true, type, range: RANGES[key] ?? null, unit: def.unit ?? null };
  if (key === 'fill') return { ...base, kind: 'paint', options: [] };
  if (key === 'pin') return { ...base, kind: 'pin', options: [] };
  if (key === 'cell') return { ...base, kind: 'cell', options: [] };
  if (key === 'encoding') return { ...base, kind: 'encoding', options: [] };
  if (key === 'component') return { ...base, kind: 'component', options: [] };
  if (key === 'box-shadow' || key === 'text-shadow') return { ...base, kind: 'shadows', options: [] };
  if (def.unit === 'boolean' && parts.length === 1) return { ...base, kind: 'toggle', options: [] };
  if (allWords) return { ...base, kind: 'enum', options: words };
  if (def.unit === 'color' && (parts.length === 1 || key === 'scheme')) return { ...base, kind: 'color', options: words };
  if (def.unit !== undefined && NUMBER_UNITS.has(def.unit)) return { ...base, kind: 'number', options: words };
  if (def.unit !== undefined && TEXT_UNITS.has(def.unit) && !parts.some((p) => p.startsWith('{') || p.startsWith('('))) return { ...base, kind: 'text', options: words };
  if (def.unit === 'boolean') return { ...base, kind: 'toggle', options: [] };
  return { ...base, kind: 'shape', options: words };
}

function rowsOf(table: PropertyTable): RowSpec[] {
  return Object.entries(table).map(([k, d]) => rowSpecOf(k, d));
}

/** One primitive's sections: its own group first, then its shared groups in the contract's order. */
export function sectionsFor(name: PrimitiveName): SectionSpec[] {
  const def = PRIMITIVES[name];
  return [
    { id: `own:${name}`, title: def.title.toLowerCase(), own: true, rows: rowsOf(def.own) },
    ...def.groups.map((g) => ({ id: g, title: SHARED_GROUPS[g].title, own: false, rows: rowsOf(SHARED_GROUPS[g].properties) })),
  ];
}

// THE SCREEN'S ROOT (user-ruled): selecting the artboard shows the root frame's ruled rows alone -
// the layout family, fill, effects, scroll and visibility; position, size, stroke, a11y, motion and
// the action/each/open/anchor rows stay hidden (the Screen section owns size). The rows come from the
// standing contract tables so the hints and the visibility gates hold.
const ROOT_LAYOUT_KEYS = ['layout', 'padding', 'gap', 'align', 'justify', 'wrap', 'wrap-align', 'columns', 'rows', 'column-sizes', 'row-sizes', 'flow', 'first-on-top'] as const;
const ROOT_SCROLL_KEYS = ['scroll-snap', 'autoplay'] as const;

export function rootSectionsFor(): SectionSpec[] {
  const own = PRIMITIVES.frame.own;
  const pick = (keys: readonly string[]): RowSpec[] => keys.flatMap((k) => { const d = own[k]; return d !== undefined ? [rowSpecOf(k, d)] : []; });
  return [
    { id: 'root:layout', title: 'layout', own: true, rows: pick(ROOT_LAYOUT_KEYS) },
    { id: 'fill', title: SHARED_GROUPS.fill.title, own: false, rows: rowsOf(SHARED_GROUPS.fill.properties) },
    { id: 'effects', title: SHARED_GROUPS.effects.title, own: false, rows: rowsOf(SHARED_GROUPS.effects.properties) },
    { id: 'root:scroll', title: 'scroll', own: true, rows: pick(ROOT_SCROLL_KEYS) },
    { id: 'visibility', title: SHARED_GROUPS.visibility.title, own: false, rows: rowsOf(SHARED_GROUPS.visibility.properties) },
  ];
}

/** A multi-selection renders the shared groups every member takes, and nothing of anyone's own. */
export function sharedSectionsFor(names: readonly PrimitiveName[]): SectionSpec[] {
  if (names.length === 0) return [];
  const groups = (Object.keys(SHARED_GROUPS) as Array<Exclude<GroupName, 'states'>>)
    .filter((g) => names.every((n) => (PRIMITIVES[n].groups as readonly string[]).includes(g)));
  return groups.map((g) => ({ id: g, title: SHARED_GROUPS[g].title, own: false, rows: rowsOf(SHARED_GROUPS[g].properties) }));
}

export type PaintKind = 'none' | 'color' | 'gradient' | 'image' | 'video' | 'list';

export function paintKindOf(v: unknown): PaintKind {
  if (v === undefined || v === null) return 'none';
  if (typeof v === 'string') return 'color';
  if (Array.isArray(v)) return 'list';
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('gradient' in o) return 'gradient';
    if ('image' in o) return 'image';
    if ('video' in o) return 'video';
  }
  return 'none';
}

/** The paint's dependent rows: a gradient's stops and angle, an image's source and alt, a video's source and flags. */
export function paintSubRows(v: unknown): RowSpec[] {
  const kind = paintKindOf(v);
  const row = (key: string, label: string, k: RowKind, extra?: Partial<RowSpec>): RowSpec =>
    ({ key, label, kind: k, unit: null, options: [], hint: '', fixed: false, atOk: false, type: '', range: null, ...extra });
  if (kind === 'gradient') {
    return [
      row('gradient', 'kind', 'enum', { options: ['linear', 'radial', 'conic'] }),
      row('from', 'from', 'color'), row('to', 'to', 'color'), row('via', 'via', 'color'),
      row('angle', 'angle', 'number', { unit: 'deg', range: { min: 0, max: 360, step: 1 } }),
    ];
  }
  if (kind === 'image') return [row('image', 'source', 'text', { unit: 'text' }), row('alt', 'alt', 'text', { unit: 'text' })];
  if (kind === 'video') {
    return [
      row('video', 'source', 'text', { unit: 'text' }), row('poster', 'poster', 'text', { unit: 'text' }),
      row('autoplay', 'autoplay', 'toggle'), row('loop', 'loop', 'toggle'), row('muted', 'muted', 'toggle'), row('controls', 'controls', 'toggle'),
    ];
  }
  return [];
}

/** A fresh paint of a kind, keeping what carries over (a color becomes the gradient's first stop). */
export function paintOfKind(kind: PaintKind, prev: unknown): unknown {
  const prevColor = typeof prev === 'string' ? prev : (prev as { from?: string } | null)?.from ?? 'primary';
  if (kind === 'color') return prevColor;
  if (kind === 'gradient') return { gradient: 'linear', from: prevColor, to: 'accent', angle: 180 };
  if (kind === 'image') return { image: '' };
  if (kind === 'video') return { video: '' };
  if (kind === 'list') return [prevColor];
  return undefined;
}

/** What the panel knows about the selected node's parent (the pin/cell/free gates read it). */
export interface PanelParent { layout: 'none' | 'row' | 'column' | 'grid' }

/** Rows that stand only when another value (or the parent's layout) says so; absent = always. */
const VISIBLE_WHEN: Readonly<Record<string, (values: Record<string, unknown>, parent: PanelParent | null) => boolean>> = {
  'object-fit': (v) => paintKindOf(v['fill']) === 'image' || paintKindOf(v['fill']) === 'video',
  'object-position': (v) => paintKindOf(v['fill']) === 'image' || paintKindOf(v['fill']) === 'video',
  align: (v) => v['layout'] === 'row' || v['layout'] === 'column',
  justify: (v) => v['layout'] === 'row' || v['layout'] === 'column',
  gap: (v) => v['layout'] === 'row' || v['layout'] === 'column' || v['layout'] === 'grid',
  wrap: (v) => v['layout'] === 'row',
  'wrap-align': (v) => v['layout'] === 'row' && v['wrap'] === true,
  columns: (v) => v['layout'] === 'grid',
  rows: (v) => v['layout'] === 'grid' || typeof v['kind'] === 'string',
  'column-sizes': (v) => v['layout'] === 'grid',
  'row-sizes': (v) => v['layout'] === 'grid',
  flow: (v) => v['layout'] === 'grid',
  free: (_v, parent) => parent !== null && parent.layout !== 'none',
  pin: (v, parent) => v['free'] === true || parent === null || parent.layout === 'none',
  cell: (_v, parent) => parent !== null && parent.layout === 'grid',
  'border-style': (v) => v['border-color'] !== undefined,
  'border-width': (v) => v['border-color'] !== undefined,
  autoplay: (v) => v['scroll-snap'] !== undefined && v['scroll-snap'] !== 'none',
  exclusive: (v) => v['open'] !== undefined,
};

/** The rows a section shows for these values in this scope: fixed rows stand in the default scope alone,
 *  except the atOk few (layout) which a breakpoint scope also shows; a state scope never shows them. */
export function visibleRows(rows: readonly RowSpec[], values: Record<string, unknown>, scope: PanelScope, parent: PanelParent | null = null): RowSpec[] {
  const stateScoped = scope.state !== 'default';
  const scoped = stateScoped || scope.breakpoint !== null;
  return rows.filter((r) => (!scoped || !r.fixed || (r.atOk && !stateScoped)) && (VISIBLE_WHEN[r.key]?.(values, parent) ?? true));
}

/** The block a scope reads and writes: the payload itself, states.<state>, or at.<breakpoint>. */
export function scopedBlock(payload: Record<string, unknown>, scope: PanelScope): Record<string, unknown> {
  if (scope.state !== 'default') {
    const states = payload['states'];
    const block = states !== null && typeof states === 'object' ? (states as Record<string, unknown>)[scope.state] : undefined;
    return block !== null && typeof block === 'object' ? (block as Record<string, unknown>) : {};
  }
  if (scope.breakpoint !== null) {
    const at = payload['at'];
    const block = at !== null && typeof at === 'object' ? (at as Record<string, unknown>)[scope.breakpoint] : undefined;
    return block !== null && typeof block === 'object' ? (block as Record<string, unknown>) : {};
  }
  return payload;
}

/** The payload with one key set (undefined clears) inside the scope's block; an emptied block leaves. */
export function withScopedValue(payload: Record<string, unknown>, scope: PanelScope, key: string, value: unknown): Record<string, unknown> {
  const setIn = (block: Record<string, unknown>): Record<string, unknown> => {
    const next = { ...block };
    if (value === undefined) delete next[key]; else next[key] = value;
    return next;
  };
  if (scope.state === 'default' && scope.breakpoint === null) return setIn(payload);
  const dim = scope.state !== 'default' ? 'states' : 'at';
  const name = scope.state !== 'default' ? scope.state : scope.breakpoint!;
  const dims = { ...((payload[dim] as Record<string, unknown> | undefined) ?? {}) };
  const block = setIn(scopedBlock(payload, scope));
  if (Object.keys(block).length === 0) delete dims[name]; else dims[name] = block;
  const out = { ...payload };
  if (Object.keys(dims).length === 0) delete out[dim]; else out[dim] = dims;
  return out;
}

/** The payload with several keys set (undefined clears) inside the scope's block - the geometry writes ride this; an emptied block leaves. */
export function withScopedValues(payload: Record<string, unknown>, scope: PanelScope, patch: Record<string, unknown>): Record<string, unknown> {
  const setIn = (block: Record<string, unknown>): Record<string, unknown> => {
    const next = { ...block };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete next[key]; else next[key] = value;
    }
    return next;
  };
  if (scope.state === 'default' && scope.breakpoint === null) return setIn(payload);
  const dim = scope.state !== 'default' ? 'states' : 'at';
  const name = scope.state !== 'default' ? scope.state : scope.breakpoint!;
  const dims = { ...((payload[dim] as Record<string, unknown> | undefined) ?? {}) };
  const block = setIn(scopedBlock(payload, scope));
  if (Object.keys(block).length === 0) delete dims[name]; else dims[name] = block;
  const out = { ...payload };
  if (Object.keys(dims).length === 0) delete out[dim]; else out[dim] = dims;
  return out;
}

/** Whether a value is a bound expression or a channel ref (the bound row renders it as one). */
export function isBoundValue(v: unknown): v is { $expr: string; deps?: string[] } | { from: string } {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && ('$expr' in (v as object) || 'from' in (v as object));
}

export function boundText(v: { $expr: string } | { from: string }): string {
  return '$expr' in v ? v.$expr : `follows ${v.from}`;
}
