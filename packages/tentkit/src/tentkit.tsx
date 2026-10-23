import {
  Fragment, createContext, createElement, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
  type CSSProperties, type ReactElement, type ReactNode,
} from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  SCENE_ROOT_ID, breakpointsOf, channelRefParts, composedChildren, evaluateExpression, expandInstanceNodes, initialValues,
  isChannelRef, isExprValue, primitiveOfNode, sceneDocumentSchema,
  type Breakpoint, type FlowEffect, type LibraryItem, type PrimitiveName, type SceneDocument, type SceneNode,
} from '@tent-nocode/core';

// TENTKIT - THE ENGINE (Phase 12, ruling 7; the 500-line law is waived - one system, one file).
// Typed React source that renders a document of the five primitives from packages/core/src/primitives.ts:
// frame, text, field, chart, instance. The same file mounts in the desktop's frame face and in a published
// page (the served build, tentkit-<hash>.js). One mount: mountScene(host, { document, data, theme, mode }).
// Edit mode exposes the geometry and hit hooks the editor's chrome reads and speaks the SceneScreen port
// grammar; serve mode is the running app. Theme names resolve to var(--name, <house literal>) so the
// project's theme repaints every named surface and an unthemed page keeps the house look.

// ---------------------------------------------------------------------------
// Public types.
// ---------------------------------------------------------------------------

export type Row = Record<string, unknown>;
export type SceneMode = 'serve' | 'edit';

/** The rows and texts every binding delivered, the errors the ones that did not. */
export interface SceneData {
  rows?: Record<string, Row[]>;
  texts?: Record<string, string | null>;
  errors?: Record<string, string>;
}

/** The slice of the project theme the engine reads (colors reach it as CSS vars from the page). */
export interface SceneTheme { breakpoints?: Record<string, Breakpoint> }

export interface SceneInput {
  document: SceneDocument;
  data?: SceneData;
  theme?: SceneTheme | null;
  mode?: SceneMode;
  /** Library items instances expand from; an already expanded document needs none. */
  library?: readonly LibraryItem[];
  /** A declared action fires: the host answers over the data plane. */
  onAction?: (name: string, values: Record<string, unknown>, node: string) => void;
  /** A goto: the host walks to the screen. */
  onNav?: (scene: string, key?: string) => void;
  /** Edit mode, mounted directly in a host page: the host owns every pointer event; the engine keeps measure, hit tests and inline text editing alone. */
  hostEvents?: boolean;
  /** Forced breakpoint: a direct mount narrower than the window applies this named breakpoint's blocks without media queries. */
  breakpoint?: string | null;
  /** The artboard width the document was designed at; the reflow reads it (absent = no reflow, real media queries alone). */
  designWidth?: number;
}

export interface NodeRect { node: string; x: number; y: number; w: number; h: number; r?: string }

export interface EditorEvent {
  hit: { node: string | null; interactive?: boolean; ctrl?: boolean; actionish?: boolean; dbl?: boolean; shift?: boolean; menu?: boolean; x?: number; y?: number };
  move: { x: number; y: number } | null;
  draw: { phase: 'start' | 'move' | 'end'; x: number; y: number; w: number; h: number };
  text: { node: string; text?: string; blocks?: unknown[]; cancel?: boolean };
  sel: { node: string; x: number; y: number; w: number; h: number } | null;
  rects: { rects: NodeRect[]; vw: number; vh: number; ch: number };
  inspect: { node: string };
}

/** The effects an action's answer or a settled run carries: the host applies them through the mount. */
export type SceneEffect = FlowEffect;

export interface SceneMount {
  /** Replaces the document, the data, the theme or the design width; absent fields stay. */
  update(patch: Partial<Pick<SceneInput, 'document' | 'data' | 'theme' | 'library' | 'designWidth'>>): void;
  /** A clock binding's tick re-mints its now row on the cadence until the next rows arrive without one. */
  setRows(binding: string, rows: Row[], text?: string | null, tick?: number): void;
  setError(binding: string, message: string): void;
  /** One quiet sentence at the bottom of the page for six seconds. */
  notice(text: string): void;
  /** goto -> the host's nav; message -> a notice; overlay -> open/close; answer -> a channel and the flow.answer rows. */
  applyEffects(effects: SceneEffect[]): void;
  setChannel(key: string, value: unknown): void;
  /** Opens, closes or toggles a frame. */
  setOpen(node: string, open: boolean | 'toggle'): void;
  /** Fires the node's action as a click would. */
  fire(node: string): void;
  /** Forces a named breakpoint's blocks on (null returns to the window's own width). */
  setBreakpoint(bp: string | null): void;
  /** Answers an action's result: failures show in place. */
  actionResult(name: string, ok: boolean, failures: string[]): void;
  measure(): EditorEvent['rects'];
  hitTest(x: number, y: number): string | null;
  elementOf(node: string): HTMLElement | null;
  /** Edit mode: the events the editor's chrome reads. */
  on<K extends keyof EditorEvent>(kind: K, fn: (e: EditorEvent[K]) => void): () => void;
  /** Edit mode: inline text editing and its commands. */
  editText(node: string): void;
  editCommand(cmd: string, link?: string): void;
  unmount(): void;
}

// ---------------------------------------------------------------------------
// The theme var() mint: a name resolves to var(--name, <house literal>); a literal passes through.
// ---------------------------------------------------------------------------

const HOUSE: Readonly<Record<string, string>> = {
  bg: '#171717', side: '#212121', panel: '#2a2a2a', panel2: '#303030', border: '#3a3a3a', border2: '#4a4a4a',
  t0: '#ffffff', t1: '#ececec', t2: '#a0a0a0', t3: '#7a7a7a', accent: '#ececec',
  green: '#3fb950', amber: '#d29922', red: '#f85149', 'chart-grid': '#2c2c2c', 'chart-axis': '#4a4a4a',
  'series-1': '#d97757', 'series-2': '#8caec9', 'series-3': '#c9a84c', 'series-4': '#86b39c', 'series-5': '#a98fc0', 'series-6': '#97999e',
  background: '#171717', foreground: '#ececec', card: '#2a2a2a', cardForeground: '#ececec', cardRaised: '#303030',
  muted: '#212121', mutedForeground: '#a0a0a0', primary: '#ececec', primaryForeground: '#171717',
  accentForeground: '#171717', ring: '#ececec', glow: '#ececec',
};
const THEME_VAR: Readonly<Record<string, string>> = {
  cardForeground: '--card-foreground', cardRaised: '--card-raised', mutedForeground: '--muted-foreground',
  primaryForeground: '--primary-foreground', accentForeground: '--accent-foreground',
};

export function isThemeColorName(v: unknown): v is string {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(HOUSE, v);
}

/** A color value: a theme or house name -> var(--name, literal); anything else is raw CSS. */
export function colorCss(v: unknown): string {
  if (typeof v !== 'string') return 'transparent';
  return isThemeColorName(v) ? `var(${THEME_VAR[v] ?? `--${v}`}, ${HOUSE[v]})` : v;
}

/** The text side a filled surface carries: the theme's foreground for that surface, or the literal's contrast. */
function foregroundFor(fill: unknown): string | null {
  if (typeof fill !== 'string') return null;
  if (fill === 'primary' || fill === 'accent') return colorCss(`${fill}Foreground`);
  if (fill === 'card' || fill === 'cardRaised' || fill === 'panel' || fill === 'panel2') return colorCss('cardForeground');
  if (fill === 'background' || fill === 'bg') return colorCss('foreground');
  if (fill === 'muted' || fill === 'side') return colorCss('foreground');
  if (isThemeColorName(fill)) return null;
  const rgb = parseRgb(fill);
  if (rgb === null || rgb.a < 0.5) return null;
  const lum = (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
  return lum > 0.55 ? '#1f1f1f' : '#ececec';
}

function parseRgb(c: string): { r: number; g: number; b: number; a: number } | null {
  const s = c.trim();
  const m = /^#([0-9a-fA-F]{3,8})$/.exec(s);
  if (m !== null) {
    const h = m[1]!;
    const hex = (i: number, j: number): number => parseInt(h.slice(i, j), 16);
    if (h.length === 3 || h.length === 4) {
      return { r: hex(0, 1) * 17, g: hex(1, 2) * 17, b: hex(2, 3) * 17, a: h.length === 4 ? hex(3, 4) * 17 / 255 : 1 };
    }
    if (h.length === 6 || h.length === 8) return { r: hex(0, 2), g: hex(2, 4), b: hex(4, 6), a: h.length === 8 ? hex(6, 8) / 255 : 1 };
    return null;
  }
  const m2 = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(s);
  if (m2 !== null) return { r: Number(m2[1]), g: Number(m2[2]), b: Number(m2[3]), a: m2[4] === undefined ? 1 : Number(m2[4]) };
  return null;
}

// ---------------------------------------------------------------------------
// Value helpers.
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;

function isObj(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}
function px(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return `${v}px`;
  if (typeof v === 'string' && /^-?\d+(\.\d+)?%$/.test(v)) return v;
  return null;
}
function sidesCss(v: unknown): string | null {
  if (typeof v === 'number') return `${v}px`;
  if (!isObj(v)) return null;
  const s = (k: string): string => `${num(v[k]) ?? 0}px`;
  return `${s('top')} ${s('right')} ${s('bottom')} ${s('left')}`;
}
/** A value holds an expression or a channel anywhere inside. */
function isDynamic(v: unknown): boolean {
  if (isExprValue(v) || isChannelRef(v)) return true;
  if (Array.isArray(v)) return v.some(isDynamic);
  if (isObj(v)) return Object.values(v).some(isDynamic);
  return false;
}

/** An expression that failed: renders as #ERR in place, mono red, its message on the title. */
export class ExprError {
  constructor(public readonly message: string) {}
}

function cssIdent(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

const camelCache = new Map<string, string>();
function camel(prop: string): string {
  if (prop.startsWith('--')) return prop;
  const hit = camelCache.get(prop);
  if (hit !== undefined) return hit;
  const out = prop.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
  camelCache.set(prop, out);
  return out;
}
function toReactStyle(decls: Record<string, string>): CSSProperties {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(decls)) out[camel(k)] = v;
  return out as CSSProperties;
}

// ---------------------------------------------------------------------------
// Formats: numbers (d3-ish specs and the text format shape), dates (strftime and date-fns tokens), relative.
// ---------------------------------------------------------------------------

export function formatNumber(v: number, spec?: string): string {
  if (!Number.isFinite(v)) return String(v);
  if (spec === undefined || spec === '') return defaultNumber(v);
  const m = /^([^,.%sdf~]*)(,)?(?:\.(\d+))?(~)?([f%sd])?$/.exec(spec);
  if (m === null) return defaultNumber(v);
  const prefix = m[1] ?? '';
  const grouping = m[2] === ',';
  const precision = m[3] !== undefined ? Number(m[3]) : undefined;
  const type = m[5];
  const opts: Intl.NumberFormatOptions = { useGrouping: grouping };
  let value = v;
  let suffix = '';
  if (type === '%') { value = v * 100; suffix = '%'; }
  if (type === 's') { opts.notation = 'compact'; opts.maximumFractionDigits = precision ?? 1; }
  else if (type === 'd') { opts.maximumFractionDigits = 0; }
  else if (precision !== undefined) { opts.minimumFractionDigits = precision; opts.maximumFractionDigits = precision; }
  else opts.maximumFractionDigits = 2;
  return `${prefix}${new Intl.NumberFormat('en-US', opts).format(value)}${suffix}`;
}

function defaultNumber(v: number): string {
  const abs = Math.abs(v);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(v);
}

/** The text format shape {number: {decimals, unit, currency, compact}}. */
function formatNumberShape(v: number, f: Rec): string {
  const decimals = num(f['decimals']);
  const currency = str(f['currency']);
  const compact = f['compact'] === true;
  const opts: Intl.NumberFormatOptions = {};
  if (decimals !== null) { opts.minimumFractionDigits = decimals; opts.maximumFractionDigits = decimals; }
  else opts.maximumFractionDigits = compact ? 1 : Math.abs(v) >= 100 ? 0 : 2;
  if (compact) opts.notation = 'compact';
  if (currency !== null) { opts.style = 'currency'; opts.currency = currency; }
  const out = new Intl.NumberFormat('en-US', opts).format(v);
  const unit = str(f['unit']);
  return unit !== null ? `${out}${unit.length <= 2 ? '' : ' '}${unit}` : out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n));

function toDate(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === 'number') return new Date(v);
  if (typeof v === 'string' && v !== '') {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : new Date(t);
  }
  return null;
}

/** date-fns style tokens: yyyy yy MMMM MMM MM M dd d EEEE EEE HH H hh h mm ss a. */
export function formatDate(d: Date, pattern: string): string {
  if (pattern.includes('%')) return strftime(d, pattern);
  const h12 = d.getHours() % 12 === 0 ? 12 : d.getHours() % 12;
  const map: Record<string, string> = {
    yyyy: String(d.getFullYear()), yy: String(d.getFullYear()).slice(-2),
    MMMM: MONTHS[d.getMonth()]!, MMM: MONTHS[d.getMonth()]!.slice(0, 3), MM: pad2(d.getMonth() + 1), M: String(d.getMonth() + 1),
    dd: pad2(d.getDate()), d: String(d.getDate()), EEEE: DAYS[d.getDay()]!, EEE: DAYS[d.getDay()]!.slice(0, 3),
    HH: pad2(d.getHours()), H: String(d.getHours()), hh: pad2(h12), h: String(h12),
    mm: pad2(d.getMinutes()), ss: pad2(d.getSeconds()), a: d.getHours() < 12 ? 'AM' : 'PM',
  };
  return pattern.replace(/yyyy|yy|MMMM|MMM|MM|M|dd|d|EEEE|EEE|HH|H|hh|h|mm|ss|a/g, (t) => map[t] ?? t);
}

/** strftime tokens: %Y %y %m %b %B %d %e %H %M %S %j %a %A %p. */
function strftime(d: Date, pattern: string): string {
  const map: Record<string, string> = {
    Y: String(d.getFullYear()), y: String(d.getFullYear()).slice(-2), m: pad2(d.getMonth() + 1),
    b: MONTHS[d.getMonth()]!.slice(0, 3), B: MONTHS[d.getMonth()]!, d: pad2(d.getDate()), e: String(d.getDate()),
    H: pad2(d.getHours()), M: pad2(d.getMinutes()), S: pad2(d.getSeconds()),
    a: DAYS[d.getDay()]!.slice(0, 3), A: DAYS[d.getDay()]!, p: d.getHours() < 12 ? 'AM' : 'PM',
    I: pad2(d.getHours() % 12 === 0 ? 12 : d.getHours() % 12),
  };
  return pattern.replace(/%([YymbBdeHMSaApI%])/g, (_, t: string) => (t === '%' ? '%' : map[t] ?? t));
}

export function formatRelative(d: Date, now = Date.now()): string {
  const diff = d.getTime() - now;
  const abs = Math.abs(diff);
  const units: Array<[number, Intl.RelativeTimeFormatUnit]> = [
    [1000 * 60 * 60 * 24 * 365, 'year'], [1000 * 60 * 60 * 24 * 30, 'month'], [1000 * 60 * 60 * 24 * 7, 'week'],
    [1000 * 60 * 60 * 24, 'day'], [1000 * 60 * 60, 'hour'], [1000 * 60, 'minute'],
  ];
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  for (const [ms, unit] of units) if (abs >= ms) return rtf.format(Math.round(diff / ms), unit);
  return abs < 30_000 ? 'just now' : rtf.format(Math.round(diff / 1000), 'second');
}

function formatCountdown(target: Date, now = Date.now()): string {
  let left = Math.max(0, Math.floor((target.getTime() - now) / 1000));
  const days = Math.floor(left / 86_400); left -= days * 86_400;
  const hours = Math.floor(left / 3600); left -= hours * 3600;
  const mins = Math.floor(left / 60); const secs = left - mins * 60;
  return days > 0 ? `${days}d ${pad2(hours)}:${pad2(mins)}:${pad2(secs)}` : `${pad2(hours)}:${pad2(mins)}:${pad2(secs)}`;
}

/** A value shown as words: numbers format, dates read, null is empty. */
function displayValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return defaultNumber(v);
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(displayValue).join(', ');
  return JSON.stringify(v);
}

// ---------------------------------------------------------------------------
// The store: one external record the tree subscribes to (the document, the data, the channels, the open states).
// ---------------------------------------------------------------------------

interface Prim { name: PrimitiveName; payload: Rec }

interface DocIndex {
  doc: SceneDocument;
  nodes: Record<string, SceneNode>;
  childrenOf: Map<string, SceneNode[]>;
  prim: Map<string, Prim>;
  /** The bindings each node reads (queries, expression deps) - the skeleton stamps while they are pending. */
  reads: Map<string, string[]>;
  /** Which fields filter which query (search fields). */
  filters: Map<string, Array<{ field: string; columns: string[] }>>;
}

function indexDocument(doc: SceneDocument): DocIndex {
  const childrenOf = new Map<string, SceneNode[]>();
  const prim = new Map<string, Prim>();
  const reads = new Map<string, string[]>();
  const filters = new Map<string, Array<{ field: string; columns: string[] }>>();
  for (const node of Object.values(doc.nodes)) {
    const p = primitiveOfNode(node);
    if (p !== null) prim.set(node.id, { name: p.name, payload: p.payload });
    else if (node.id === SCENE_ROOT_ID) prim.set(node.id, { name: 'frame', payload: {} });
    childrenOf.set(node.id, composedChildren(doc, node.id));
    const entry = prim.get(node.id);
    if (entry === undefined) continue;
    const list = new Set<string>();
    const py = entry.payload;
    const each = py['each'];
    if (typeof each === 'string') list.add(each);
    else if (isObj(each) && typeof each['query'] === 'string') list.add(each['query']);
    if (entry.name === 'chart') {
      if (typeof py['query'] === 'string') list.add(py['query']);
      if (Array.isArray(py['layers'])) for (const l of py['layers']) if (isObj(l) && typeof l['query'] === 'string') list.add(l['query']);
    }
    if (entry.name === 'field') {
      const f = py['filters'];
      if (isObj(f) && typeof f['query'] === 'string' && Array.isArray(f['columns'])) {
        const cols = f['columns'].filter((c): c is string => typeof c === 'string');
        const arr = filters.get(f['query']) ?? [];
        arr.push({ field: node.id, columns: cols });
        filters.set(f['query'], arr);
      }
      const o = py['options'];
      if (isObj(o) && typeof o['query'] === 'string') list.add(o['query']);
    }
    const walk = (v: unknown): void => {
      if (isExprValue(v)) { for (const d of v.deps ?? []) if (d.startsWith('bindings.')) list.add(d.slice('bindings.'.length)); return; }
      if (Array.isArray(v)) { v.forEach(walk); return; }
      if (isObj(v)) Object.values(v).forEach(walk);
    };
    walk(py);
    reads.set(node.id, [...list]);
  }
  return { doc, nodes: doc.nodes, childrenOf, prim, reads, filters };
}

interface SceneState {
  index: DocIndex;
  rows: Record<string, Row[]>;
  texts: Record<string, string | null>;
  errors: Record<string, string>;
  /** Bindings the document names that no message delivered yet (the skeleton shimmer). */
  pending: Set<string>;
  /** '<node>.<emit>' (row-scoped: '<node>@<row>.<emit>') -> value; open states, field values, picks, host channels. */
  channels: Map<string, unknown>;
  /** The last action result per action name, shown in place until the next fire. */
  results: Map<string, { ok: boolean; failures: string[] }>;
  breakpoints: Record<string, Breakpoint>;
  /** The forced breakpoint (the editor's device row); null = the window's own width decides. */
  forced: string | null;
  /** The design width the reflow measures against; null = no reflow. */
  designWidth: number | null;
  mode: SceneMode;
  library: readonly LibraryItem[];
  /** Ticks once a second while a clock or countdown is on the page. */
  now: number;
  /** The one sentence the notice capsule shows; null = silence. */
  notice: { text: string; at: number } | null;
}

class SceneStore {
  private state: SceneState;
  private listeners = new Set<() => void>();
  private pendingTimers = new Map<string, number>();
  private clockTimers = new Map<string, number>();
  private noticeTimer: number | undefined;
  constructor(input: SceneInput) {
    const library = input.library ?? [];
    this.state = {
      index: indexDocument(expandFor(input.document, library)),
      rows: { ...(input.data?.rows ?? {}) }, texts: { ...(input.data?.texts ?? {}) }, errors: { ...(input.data?.errors ?? {}) },
      pending: new Set(), channels: new Map(), results: new Map(),
      breakpoints: breakpointsOf(input.theme ?? null), forced: input.breakpoint ?? null,
      designWidth: typeof input.designWidth === 'number' ? input.designWidth : null,
      mode: input.mode ?? 'serve', library, now: Date.now(), notice: null,
    };
    this.seedPending();
  }
  get(): SceneState { return this.state; }
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }
  private emit(): void { for (const fn of this.listeners) fn(); }
  private set(patch: Partial<SceneState>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }
  /** Bindings the document reads and no message delivered: pending for at most four seconds, then honestly empty. */
  private seedPending(): void {
    const pending = new Set(this.state.pending);
    for (const names of this.state.index.reads.values()) {
      for (const b of names) {
        if (b in this.state.rows || b in this.state.errors || pending.has(b)) continue;
        pending.add(b);
        if (typeof window !== 'undefined') {
          const t = window.setTimeout(() => { this.deliver(b); }, 4000);
          this.pendingTimers.set(b, t);
        }
      }
    }
    this.state = { ...this.state, pending };
  }
  private deliver(b: string): void {
    const t = this.pendingTimers.get(b);
    if (t !== undefined) { clearTimeout(t); this.pendingTimers.delete(b); }
    if (!this.state.pending.has(b)) return;
    const pending = new Set(this.state.pending);
    pending.delete(b);
    this.set({ pending });
  }
  setDocument(doc: SceneDocument, library?: readonly LibraryItem[]): void {
    const lib = library ?? this.state.library;
    this.state = { ...this.state, index: indexDocument(expandFor(doc, lib)), library: lib };
    this.seedPending();
    this.emit();
  }
  setData(data: SceneData): void {
    const rows = { ...this.state.rows, ...(data.rows ?? {}) };
    const texts = { ...this.state.texts, ...(data.texts ?? {}) };
    const errors = { ...this.state.errors, ...(data.errors ?? {}) };
    this.state = { ...this.state, rows, texts, errors };
    for (const b of [...Object.keys(data.rows ?? {}), ...Object.keys(data.errors ?? {})]) this.deliver(b);
    this.emit();
  }
  setRows(binding: string, rows: Row[], text?: string | null, tick?: number): void {
    const errors = { ...this.state.errors };
    delete errors[binding];
    this.state = { ...this.state, rows: { ...this.state.rows, [binding]: rows }, texts: { ...this.state.texts, [binding]: text ?? null }, errors };
    this.deliver(binding);
    this.setClock(binding, tick);
    this.emit();
  }
  /** A clock binding re-mints its now row on its tick; a delivery without a tick stops it. */
  private setClock(binding: string, tick: number | undefined): void {
    const cur = this.clockTimers.get(binding);
    if (cur !== undefined) { clearInterval(cur); this.clockTimers.delete(binding); }
    if (tick === undefined || typeof window === 'undefined') return;
    const id = window.setInterval(() => {
      const now = new Date();
      this.state = { ...this.state, rows: { ...this.state.rows, [binding]: [{ iso: now.toISOString(), epochMs: now.getTime() }] } };
      this.emit();
    }, Math.max(1000, tick));
    this.clockTimers.set(binding, id);
  }
  setNotice(text: string): void {
    if (typeof window !== 'undefined') {
      if (this.noticeTimer !== undefined) clearTimeout(this.noticeTimer);
      this.noticeTimer = window.setTimeout(() => this.set({ notice: null }), 6000);
    }
    this.set({ notice: { text, at: Date.now() } });
  }
  setError(binding: string, message: string): void {
    this.state = { ...this.state, errors: { ...this.state.errors, [binding]: message } };
    this.deliver(binding);
    this.emit();
  }
  setTheme(theme: SceneTheme | null | undefined): void { this.set({ breakpoints: breakpointsOf(theme ?? null) }); }
  setBreakpoint(bp: string | null): void { this.set({ forced: bp }); }
  setDesignWidth(w: number | null): void { this.set({ designWidth: w }); }
  setChannel(key: string, value: unknown): void {
    const channels = new Map(this.state.channels);
    channels.set(key, value);
    this.set({ channels });
  }
  channel(key: string): unknown { return this.state.channels.get(key); }
  setResult(name: string, ok: boolean, failures: string[]): void {
    const results = new Map(this.state.results);
    results.set(name, { ok, failures });
    this.set({ results });
  }
  clearResult(name: string): void {
    if (!this.state.results.has(name)) return;
    const results = new Map(this.state.results);
    results.delete(name);
    this.set({ results });
  }
  tick(): void { this.set({ now: Date.now() }); }
  dispose(): void {
    for (const t of this.pendingTimers.values()) clearTimeout(t);
    this.pendingTimers.clear();
    for (const t of this.clockTimers.values()) clearInterval(t);
    this.clockTimers.clear();
    if (this.noticeTimer !== undefined) clearTimeout(this.noticeTimer);
    this.listeners.clear();
  }
}

/** Instances expand into their items' trees (Figma's rule); an already expanded document has none left. */
function expandFor(doc: SceneDocument, library: readonly LibraryItem[]): SceneDocument {
  const parsed = sceneDocumentSchema.safeParse(doc);
  const base = parsed.success ? parsed.data : doc;
  if (library.length === 0) return base;
  const byRef = new Map<string, LibraryItem>();
  const latest = new Map<string, LibraryItem>();
  for (const item of library) {
    byRef.set(`${item.name}@${item.version}`, item);
    const cur = latest.get(item.name);
    if (cur === undefined || cur.version < item.version) latest.set(item.name, item);
  }
  return expandInstanceNodes(base, (ref) => byRef.get(ref) ?? latest.get(ref) ?? null).doc;
}

// ---------------------------------------------------------------------------
// Scopes and value resolution: a property is a literal, an expression over the queries, or a channel.
// ---------------------------------------------------------------------------

interface Scope {
  row?: Row;
  rowIndex?: number;
  /** '' at the top; 'r0', 'r0.r3' inside repeaters - row-scoped channels key with it. */
  rowKey: string;
}
const TOP: Scope = { rowKey: '' };

function channelKey(node: string, emit: string, scope: Scope): string {
  return scope.rowKey === '' ? `${node}.${emit}` : `${node}@${scope.rowKey}.${emit}`;
}

/** The rows a query shows: the delivered rows narrowed by every search field filtering it. */
function rowsOf(state: SceneState, query: string, scope?: Scope): Row[] {
  const rows = state.rows[query] ?? [];
  const filters = state.index.filters.get(query);
  if (filters === undefined || filters.length === 0) return rows;
  let out = rows;
  for (const f of filters) {
    const raw = state.channels.get(channelKey(f.field, 'value', scope ?? TOP)) ?? state.channels.get(`${f.field}.value`);
    const words = typeof raw === 'string' ? raw.trim().toLowerCase().split(/\s+/).filter((w) => w !== '') : [];
    if (words.length === 0) continue;
    out = out.filter((row) => words.every((w) => f.columns.some((c) => displayValue(row[c]).toLowerCase().includes(w))));
  }
  return out;
}

function resolveValue(state: SceneState, v: unknown, scope: Scope): unknown {
  if (isExprValue(v)) {
    const r = evaluateExpression(v.$expr, { bindings: state.rows, ...(scope.row !== undefined ? { row: scope.row } : {}) });
    return r.ok ? r.value : new ExprError(r.err);
  }
  if (isChannelRef(v)) {
    const parts = channelRefParts(v.from);
    if (parts === null) return new ExprError(`from('${v.from}') is not '<node>.<emit>'`);
    const scoped = state.channels.get(channelKey(parts.node, parts.emit, scope));
    if (scoped !== undefined) return scoped;
    const top = state.channels.get(`${parts.node}.${parts.emit}`);
    if (top !== undefined) return top;
    return channelDefault(state, parts.node, parts.emit);
  }
  if (Array.isArray(v)) return v.map((x) => resolveValue(state, x, scope));
  if (isObj(v)) {
    const out: Rec = {};
    for (const [k, x] of Object.entries(v)) out[k] = resolveValue(state, x, scope);
    return out;
  }
  return v;
}

/** A channel nobody set yet: the emitting node's own initial (a frame's open, a field's value). */
function channelDefault(state: SceneState, node: string, emit: string): unknown {
  const p = state.index.prim.get(node);
  if (p === undefined) return null;
  if (p.name === 'frame' && emit === 'open') return p.payload['open'] !== false;
  if (p.name === 'field' && emit === 'value') return fieldValueOf(resolveProps(state, p, TOP), undefined, state, TOP);
  return null;
}

/** Every property resolved for one rendered element: the contract's initials under the payload, dynamic values evaluated. */
function resolveProps(state: SceneState, prim: Prim, scope: Scope): Rec {
  const out: Rec = { ...initialValues(prim.name) };
  for (const [k, v] of Object.entries(prim.payload)) {
    if (k === 'states' || k === 'at') continue;
    out[k] = resolveValue(state, v, scope);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The look: property values -> CSS declarations. One function serves the base rule, the state blocks and the
// breakpoint blocks (Webstudio's pseudo-classes and breakpoint records over one property table).
// ---------------------------------------------------------------------------

interface LayoutCtx {
  /** The parent frame's layout word and its literal px size when it has one (the pin math's baseline). */
  parent: { layout: string; width: number | null; height: number | null } | null;
  isRoot: boolean;
}

const SIZE_LADDER: Readonly<Record<string, { css: string; weight: number; lh: number }>> = {
  caption: { css: 'var(--fs-caption, 11px)', weight: 400, lh: 1.4 }, small: { css: 'var(--fs-small, 12px)', weight: 400, lh: 1.45 },
  body: { css: 'var(--fs-body, 13px)', weight: 400, lh: 1.5 }, title: { css: 'var(--fs-title, 14px)', weight: 500, lh: 1.4 },
  heading: { css: 'var(--fs-heading, 16px)', weight: 500, lh: 1.3 }, metric: { css: 'var(--fs-metric, 26px)', weight: 500, lh: 1.15 },
  hero: { css: 'var(--fs-hero, 40px)', weight: 600, lh: 1.1 },
};
const EASING: Readonly<Record<string, string>> = {
  ease: 'ease', 'ease-in': 'cubic-bezier(0.5, 0, 0.75, 0)', 'ease-out': 'cubic-bezier(0.22, 1, 0.36, 1)',
  'ease-in-out': 'cubic-bezier(0.65, 0, 0.35, 1)', linear: 'linear', spring: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
};

function paintLayers(fill: unknown, fit: unknown, position: unknown): { color?: string; images: string[]; sizes: string[]; positions: string[]; repeats: string[]; video: Rec | null; image: Rec | null } {
  const out = { images: [] as string[], sizes: [] as string[], positions: [] as string[], repeats: [] as string[], video: null as Rec | null, image: null as Rec | null, color: undefined as string | undefined };
  const list = Array.isArray(fill) ? fill : fill === undefined || fill === null ? [] : [fill];
  const size = fit === 'contain' ? 'contain' : fit === 'fill' ? '100% 100%' : fit === 'tile' ? 'auto' : 'cover';
  const pos = str(position) ?? 'center';
  // Bottom to top in the document; CSS lists top first.
  for (const paint of [...list].reverse()) {
    if (typeof paint === 'string') {
      if (out.color === undefined && out.images.length === 0) { out.color = colorCss(paint); continue; }
      out.images.push(`linear-gradient(${colorCss(paint)}, ${colorCss(paint)})`);
      out.sizes.push('auto'); out.positions.push('center'); out.repeats.push('no-repeat');
      continue;
    }
    if (!isObj(paint)) continue;
    if (typeof paint['gradient'] === 'string') {
      const stops = [colorCss(paint['from']), ...(paint['via'] !== undefined ? [colorCss(paint['via'])] : []), colorCss(paint['to'])].join(', ');
      const angle = num(paint['angle']) ?? 180;
      const g = paint['gradient'] === 'radial' ? `radial-gradient(circle, ${stops})` : paint['gradient'] === 'conic' ? `conic-gradient(from ${angle}deg, ${stops})` : `linear-gradient(${angle}deg, ${stops})`;
      out.images.push(g); out.sizes.push('auto'); out.positions.push('center'); out.repeats.push('no-repeat');
      continue;
    }
    if (typeof paint['image'] === 'string') {
      out.image = paint;
      out.images.push(`url("${paint['image'].replace(/["\\]/g, '')}")`);
      out.sizes.push(size); out.positions.push(pos); out.repeats.push(fit === 'tile' ? 'repeat' : 'no-repeat');
      continue;
    }
    if (typeof paint['video'] === 'string') out.video = paint;
  }
  return out;
}

/** The CSS a primitive's properties declare; static and dynamic alike (the caller decides where they land). */
function lookDeclarations(name: PrimitiveName, p: Rec, ctx: LayoutCtx): Record<string, string> {
  const d: Record<string, string> = {};
  const parent = ctx.parent;
  const inRow = parent?.layout === 'row';
  const inColumn = parent?.layout === 'column';
  const inGrid = parent?.layout === 'grid';
  // Free = placed by its own x/y: any child of a layout-none frame, or a free: true child of a laid-out one.
  const isFreeChild = !ctx.isRoot && parent !== null && (parent.layout === 'none' || p['free'] === true);

  // fill
  if (name !== 'chart' && p['fill'] !== undefined) {
    const layers = paintLayers(p['fill'], p['object-fit'], p['object-position']);
    const opacity = num(p['fill-opacity']);
    const onLayer = (opacity !== null && opacity < 1) || layers.video !== null;
    if (!onLayer) {
      if (layers.color !== undefined) d['background-color'] = layers.color;
      if (layers.images.length > 0) {
        d['background-image'] = layers.images.join(', ');
        d['background-size'] = layers.sizes.join(', ');
        d['background-position'] = layers.positions.join(', ');
        d['background-repeat'] = layers.repeats.join(', ');
      }
    }
    const fg = foregroundFor(Array.isArray(p['fill']) ? p['fill'][0] : p['fill']);
    if (fg !== null && name === 'frame') {
      d['color'] = fg;
      d['--t0'] = fg; d['--t1'] = fg;
      if (p['fill'] === 'primary' || p['fill'] === 'accent') { d['--t2'] = fg; d['--t3'] = fg; }
    }
  }
  // stroke
  if (p['border-color'] !== undefined) {
    const w = p['border-width'] ?? 1;
    d['border-style'] = str(p['border-style']) ?? 'solid';
    d['border-color'] = colorCss(p['border-color']);
    d['border-width'] = sidesCss(w) ?? '1px';
  }
  const radius = p['border-radius'];
  if (radius !== undefined && radius !== 'theme') {
    if (typeof radius === 'number') d['border-radius'] = `${radius}px`;
    else if (radius === 'capsule') d['border-radius'] = '999px';
    else if (radius === 'circle') d['border-radius'] = '50%';
    else if (isObj(radius)) d['border-radius'] = `${num(radius['top-left']) ?? 0}px ${num(radius['top-right']) ?? 0}px ${num(radius['bottom-right']) ?? 0}px ${num(radius['bottom-left']) ?? 0}px`;
  } else if (radius === 'theme' && name !== 'text' && (p['fill'] !== undefined || p['border-color'] !== undefined || p['box-shadow'] !== undefined)) {
    d['border-radius'] = name === 'field' ? 'var(--r1, 10px)' : 'var(--r2, 14px)';
  }
  if (isObj(p['outline'])) {
    const o = p['outline'];
    d['outline'] = `${num(o['width']) ?? 1}px solid ${colorCss(o['color'])}`;
    if (num(o['offset']) !== null) d['outline-offset'] = `${num(o['offset'])}px`;
  }
  // effects
  const shadow = p['box-shadow'];
  if (shadow === 'theme') d['box-shadow'] = 'var(--shadow, 0 1px 2px rgba(0,0,0,0.35), 0 4px 14px rgba(0,0,0,0.16))';
  else if (shadow !== undefined) d['box-shadow'] = shadowCss(shadow);
  if (isObj(p['filter'])) d['filter'] = filterCss(p['filter']);
  if (isObj(p['backdrop-filter'])) { d['backdrop-filter'] = filterCss(p['backdrop-filter']); d['-webkit-backdrop-filter'] = d['backdrop-filter']; }
  if (typeof p['mix-blend-mode'] === 'string' && p['mix-blend-mode'] !== 'normal') d['mix-blend-mode'] = p['mix-blend-mode'];
  const transforms: string[] = [];
  if (isObj(p['transform'])) {
    const t = p['transform'];
    if (isObj(t['translate'])) transforms.push(`translate(${num(t['translate']['x']) ?? 0}px, ${num(t['translate']['y']) ?? 0}px)`);
    if (typeof t['scale'] === 'number') transforms.push(`scale(${t['scale']})`);
    else if (isObj(t['scale'])) transforms.push(`scale(${num(t['scale']['x']) ?? 1}, ${num(t['scale']['y']) ?? 1})`);
    if (isObj(t['skew'])) transforms.push(`skew(${num(t['skew']['x']) ?? 0}deg, ${num(t['skew']['y']) ?? 0}deg)`);
  }
  if (typeof p['transform-origin'] === 'string' && p['transform-origin'] !== 'center') d['transform-origin'] = p['transform-origin'];
  // size and space ('fill' = grow on the flow axis, stretch across it - ruling 6's standing mapping)
  const sizeAxis = (value: unknown, axis: 'width' | 'height'): void => {
    const isMain = inRow ? axis === 'width' : inColumn ? axis === 'height' : false;
    const isCross = (inRow || inColumn) && !isMain;
    if (value === 'fill') {
      if (isMain) { d['flex'] = '1 1 0%'; d[axis === 'width' ? 'min-width' : 'min-height'] = d[axis === 'width' ? 'min-width' : 'min-height'] ?? '0'; }
      else if (isCross) d['align-self'] = 'stretch';
      else d[axis] = '100%';
      return;
    }
    if (value === 'hug' || value === undefined) {
      // Hug fits the content; a grid cell stretches its child unless a px size or the cell's align says otherwise.
      if (isMain) d['flex'] = '0 0 auto';
      return;
    }
    const css = px(value);
    if (css === null) return;
    d[axis] = css;
    if (isMain) d['flex'] = '0 0 auto';
    if (inGrid && axis === 'width' && !isObj(p['cell'])) d['justify-self'] = 'start';
  };
  if (!ctx.isRoot) { sizeAxis(p['width'], 'width'); sizeAxis(p['height'], 'height'); }
  for (const k of ['min-width', 'max-width', 'min-height', 'max-height'] as const) {
    const css = px(p[k]);
    if (css !== null) d[k] = css;
  }
  if (typeof p['aspect-ratio'] === 'number') d['aspect-ratio'] = String(p['aspect-ratio']);
  else if (typeof p['aspect-ratio'] === 'string') d['aspect-ratio'] = p['aspect-ratio'];
  if (p['padding'] !== undefined && p['padding'] !== 0) { const css = sidesCss(p['padding']); if (css !== null) d['padding'] = css; }
  // position: every node carries x and y; a flow child's are derived by the layout (an authored write is ignored here).
  const rotation = num(p['rotation']);
  if (rotation !== null && rotation !== 0) { transforms.push(`rotate(${rotation}deg)`); d['transform-origin'] = d['transform-origin'] ?? 'top left'; }
  if (isFreeChild) {
    d['position'] = 'absolute';
    const pin = isObj(p['pin']) ? p['pin'] : {};
    // Each axis follows the parent's resize per its pin: a side (the default start side), the far side, the center, both sides, or the parent's scale.
    const placeAxis = (axis: 'x' | 'y', mode: unknown): void => {
      const at = num(p[axis]) ?? 0;
      const [start, end, sizeKey] = axis === 'x' ? (['left', 'right', 'width'] as const) : (['top', 'bottom', 'height'] as const);
      const own = num(p[sizeKey]);
      const box = axis === 'x' ? parent?.width ?? null : parent?.height ?? null;
      if ((mode === 'right' || mode === 'bottom') && box !== null && own !== null) { d[end] = `${box - at - own}px`; return; }
      if (mode === 'center') {
        if (box !== null) { d[start] = `calc(50% + ${at - box / 2}px)`; return; }
        d[start] = '50%'; transforms.unshift(axis === 'x' ? 'translateX(-50%)' : 'translateY(-50%)');
        return;
      }
      if (mode === 'stretch') {
        d[start] = `${at}px`;
        if (box !== null && own !== null) { d[end] = `${box - at - own}px`; delete d[sizeKey]; } else d[end] = '0';
        return;
      }
      if (mode === 'scale' && box !== null && box > 0) {
        d[start] = `${(at / box) * 100}%`;
        if (own !== null) d[sizeKey] = `${(own / box) * 100}%`;
        return;
      }
      d[start] = `${at}px`;
    };
    placeAxis('x', pin['x']);
    placeAxis('y', pin['y']);
  }
  // A grid child's cell: where it sits, how far it spans, how it aligns inside.
  if (inGrid && !isFreeChild && isObj(p['cell'])) {
    const c = p['cell'];
    const track = (at: number | null, span: number | null): string | null =>
      at !== null && span !== null ? `${at} / span ${span}` : at !== null ? String(at) : span !== null ? `span ${span}` : null;
    const col = track(num(c['column']), num(c['column-span']));
    const row = track(num(c['row']), num(c['row-span']));
    if (col !== null) d['grid-column'] = col;
    if (row !== null) d['grid-row'] = row;
    const ax = str(c['align-x']);
    const ay = str(c['align-y']);
    if (ax !== null) d['justify-self'] = ax;
    if (ay !== null) d['align-self'] = ay;
  }
  // stick - the web extension: the node holds at an edge while the page scrolls past.
  const stick = str(p['stick']);
  if (stick !== null && !isFreeChild) { d['position'] = 'sticky'; d[stick === 'top' ? 'top' : 'bottom'] = '0'; d['z-index'] = '20'; }
  if (transforms.length > 0) d['transform'] = transforms.join(' ');
  // motion (transition alone is a declaration; enter/exit/animate ride classes)
  if (isObj(p['transition'])) {
    const t = p['transition'];
    const prop = str(t['property']);
    const props = prop === 'fill' ? 'background-color, color, border-color' : prop ?? 'all';
    d['transition'] = `${props} ${num(t['duration']) ?? 200}ms ${EASING[str(t['easing']) ?? 'ease-out'] ?? 'ease'} ${num(t['delay']) ?? 0}ms`;
  }
  // visibility
  if (p['visible'] === false) d['display'] = 'none';
  if (typeof p['opacity'] === 'number' && p['opacity'] !== 1) d['opacity'] = String(p['opacity']);
  const overflow = p['overflow'];
  if (typeof overflow === 'string' && overflow !== 'visible') d['overflow'] = overflow;
  else if (isObj(overflow)) {
    if (typeof overflow['x'] === 'string') d['overflow-x'] = overflow['x'];
    if (typeof overflow['y'] === 'string') d['overflow-y'] = overflow['y'];
  }
  if (typeof p['cursor'] === 'string') d['cursor'] = p['cursor'];
  if (p['pointer-events'] === 'none') d['pointer-events'] = 'none';
  if (p['user-select'] === false) d['user-select'] = 'none';

  if (name === 'frame') {
    const layout = str(p['layout']) ?? 'none';
    if (layout === 'row' || layout === 'column') {
      d['display'] = 'flex';
      d['flex-direction'] = layout;
      const align = str(p['align']);
      // Figma's default cross alignment is the start; a child stretches by its own 'fill'.
      d['align-items'] = align !== null ? flexWord(align) : 'flex-start';
      const justify = str(p['justify']);
      if (justify !== null && justify !== 'start') d['justify-content'] = flexWord(justify);
      if (p['wrap'] === true) {
        d['flex-wrap'] = 'wrap';
        if (str(p['wrap-align']) === 'between') d['align-content'] = 'space-between';
      }
    } else if (layout === 'grid') {
      d['display'] = 'grid';
      const trackCss = (t: unknown): string => (typeof t === 'number' ? `${t}px` : t === 'hug' ? 'auto' : 'minmax(0, 1fr)');
      const colSizes = Array.isArray(p['column-sizes']) ? p['column-sizes'] : null;
      const cols = num(p['columns']);
      d['grid-template-columns'] = colSizes !== null ? colSizes.map(trackCss).join(' ') : `repeat(${cols ?? 2}, minmax(0, 1fr))`;
      const rowSizes = Array.isArray(p['row-sizes']) ? p['row-sizes'] : null;
      const rows = num(p['rows']);
      if (rowSizes !== null) d['grid-template-rows'] = rowSizes.map(trackCss).join(' ');
      else if (rows !== null) d['grid-template-rows'] = `repeat(${rows}, auto)`;
      // flow 'auto' (the initial) deals children into cells in sibling order; 'manual' means the editor
      // writes each child's cell - CSS still auto-places a child whose cell is unset, the cell prop pins.
      d['grid-auto-flow'] = 'row';
    } else if (layout === 'none') {
      // The artboard feel: every child sits absolute at its own x and y.
      d['position'] = d['position'] ?? 'relative';
      if (!ctx.isRoot && (p['height'] === undefined || p['height'] === 'hug')) d['min-height'] = d['min-height'] ?? '40px';
    }
    const gap = p['gap'];
    if (typeof gap === 'number' && gap > 0) d['gap'] = `${gap}px`;
    else if (isObj(gap)) d['gap'] = `${num(gap['row']) ?? 0}px ${num(gap['column']) ?? 0}px`;
    const snap = str(p['scroll-snap']);
    if (snap !== null && snap !== 'none') {
      d['scroll-snap-type'] = `${snap} mandatory`;
      d[snap === 'y' ? 'overflow-y' : 'overflow-x'] = 'auto';
      d['scroll-behavior'] = 'smooth';
    }
    if (isObj(p['action']) && d['cursor'] === undefined && p['disabled'] !== true) d['cursor'] = 'pointer';
    if (p['disabled'] === true) { d['cursor'] = 'not-allowed'; d['opacity'] = d['opacity'] ?? '0.55'; }
    if (ctx.isRoot) { d['min-height'] = d['min-height'] ?? '100vh'; d['width'] = '100%'; }
  }

  if (name === 'text') {
    const size = p['font-size'];
    const ladder = typeof size === 'string' ? SIZE_LADDER[size] : undefined;
    if (ladder !== undefined) d['font-size'] = ladder.css;
    else if (typeof size === 'number') d['font-size'] = `${size}px`;
    const weight = num(p['font-weight']);
    if (weight !== null && (weight !== 400 || ladder === undefined)) d['font-weight'] = String(weight);
    else if (ladder !== undefined && ladder.weight !== 400) d['font-weight'] = String(ladder.weight);
    const lh = num(p['line-height']);
    d['line-height'] = lh !== null ? String(lh) : String(ladder?.lh ?? (typeof size === 'number' && size >= 24 ? 1.15 : 1.5));
    const family = str(p['font-family']);
    if (family !== null && family !== 'sans') d['font-family'] = family === 'mono' ? 'var(--mono, ui-monospace, monospace)' : `'${family.replace(/'/g, '')}', var(--sans, system-ui, sans-serif)`;
    if (p['font-style'] === 'italic') d['font-style'] = 'italic';
    const ls = num(p['letter-spacing']);
    if (ls !== null && ls !== 0) d['letter-spacing'] = `${ls}px`;
    for (const k of ['text-transform', 'text-decoration', 'text-align', 'white-space'] as const) {
      const v = str(p[k]);
      if (v !== null && v !== 'none' && v !== 'normal' && !(k === 'text-align' && v === 'left')) d[k] = v;
    }
    const wrap = str(p['text-wrap']);
    if (wrap !== null && wrap !== 'wrap') { d['text-wrap'] = wrap; if (wrap === 'nowrap') d['white-space'] = 'nowrap'; }
    if (p['color'] !== undefined && p['color'] !== 'foreground') d['color'] = colorCss(p['color']);
    const clamp = num(p['line-clamp']);
    if (clamp !== null) { d['display'] = '-webkit-box'; d['-webkit-line-clamp'] = String(clamp); d['-webkit-box-orient'] = 'vertical'; d['overflow'] = 'hidden'; }
    if (p['text-shadow'] !== undefined) d['text-shadow'] = shadowCss(p['text-shadow']);
    if (p['tabular'] === true) d['font-variant-numeric'] = 'tabular-nums';
    if (typeof p['href'] === 'string' || p['copy'] === true) d['cursor'] = d['cursor'] ?? 'pointer';
  }
  return d;
}

function flexWord(w: string): string {
  return w === 'start' ? 'flex-start' : w === 'end' ? 'flex-end' : w === 'between' ? 'space-between' : w;
}

function shadowCss(v: unknown): string {
  const one = (s: unknown): string | null => {
    if (!isObj(s)) return null;
    return `${s['inset'] === true ? 'inset ' : ''}${num(s['x']) ?? 0}px ${num(s['y']) ?? 0}px ${num(s['blur']) ?? 0}px ${num(s['spread']) ?? 0}px ${colorCss(s['color'])}`;
  };
  const list = Array.isArray(v) ? v : [v];
  return list.map(one).filter((s): s is string => s !== null).join(', ') || 'none';
}

function filterCss(f: Rec): string {
  const parts: string[] = [];
  const unit: Record<string, string> = { blur: 'px', 'hue-rotate': 'deg' };
  for (const k of ['blur', 'brightness', 'contrast', 'saturate', 'grayscale', 'hue-rotate', 'invert', 'sepia']) {
    const v = num(f[k]);
    if (v !== null) parts.push(`${k}(${v}${unit[k] ?? ''})`);
  }
  return parts.join(' ') || 'none';
}

// ---------------------------------------------------------------------------
// The stylesheet: one rule set per node (base, the four states, the breakpoints) - static values only;
// dynamic values land inline on the element that resolved them.
// ---------------------------------------------------------------------------

const STATE_SELECTORS: Readonly<Record<string, (c: string) => string>> = {
  hover: (c) => `.${c}:hover, .${c}[data-tk-state="hover"]`,
  focus: (c) => `.${c}:focus-visible, .${c}:focus-within, .${c}[data-tk-state="focus"]`,
  pressed: (c) => `.${c}:active, .${c}[data-tk-state="pressed"]`,
  disabled: (c) => `.${c}:disabled, .${c}[data-disabled], .${c}[data-tk-state="disabled"]`,
};

function mediaOf(bp: Breakpoint | undefined): string | null {
  if (bp === undefined) return null;
  const parts: string[] = [];
  if (typeof bp.minWidth === 'number') parts.push(`(min-width: ${bp.minWidth}px)`);
  if (typeof bp.maxWidth === 'number') parts.push(`(max-width: ${bp.maxWidth}px)`);
  return parts.length > 0 ? parts.join(' and ') : null;
}

function declsText(d: Record<string, string>): string {
  return Object.entries(d).map(([k, v]) => `${k}:${v}`).join(';');
}

function staticPayload(payload: Rec): Rec {
  const out: Rec = {};
  for (const [k, v] of Object.entries(payload)) if (k !== 'states' && k !== 'at' && !isDynamic(v)) out[k] = v;
  return out;
}

function layoutCtxOf(index: DocIndex, node: SceneNode): LayoutCtx {
  const isRoot = node.id === SCENE_ROOT_ID;
  const parentPrim = node.parent !== null ? index.prim.get(node.parent) : undefined;
  if (parentPrim === undefined || parentPrim.name !== 'frame') return { parent: null, isRoot };
  const layout = str(parentPrim.payload['layout']) ?? 'none';
  const pw = parentPrim.payload['width'];
  const ph = parentPrim.payload['height'];
  return { parent: { layout, width: typeof pw === 'number' ? pw : null, height: typeof ph === 'number' ? ph : null }, isRoot };
}

/** The forced-mode selector: the host carries data-tk-bp, the rule beats the base by source order. */
function forcedSel(scope: string, bp: string): string {
  return `${scope === '' ? '' : scope}[data-tk-bp="${cssIdent(bp)}"] `;
}

/** The phone edge: the smallest maxWidth any breakpoint names (the grid collapse and the reflow's floor read it). */
function phoneEdgeOf(breakpoints: Record<string, Breakpoint>): number {
  let edge = Number.POSITIVE_INFINITY;
  for (const bp of Object.values(breakpoints)) if (typeof bp.maxWidth === 'number' && bp.maxWidth < edge) edge = bp.maxWidth;
  return Number.isFinite(edge) ? edge : 767;
}

// THE REFLOW v1 (Phase 14A, ruling 3 - band-stack): a free frame rendering below its design width bands its
// children by overlapping y-ranges, stacks the bands in y-order, keeps-or-wraps within a band by x-order
// (flex wrap does the keeping), and clamps widths to the viewport. Pure CSS over the payloads - no DOM read.
// A child whose pin names an axis is skipped whole (its pin wins); a child whose at block speaks the
// breakpoint is silenced for it; a frame whose own at block speaks the breakpoint keeps its word instead.

interface ReflowRule { container: string; children: Array<{ cls: string; decls: string }> }

/** The band-stack declarations for one free frame at one breakpoint, or null when nothing should move. */
function reflowOf(index: DocIndex, node: SceneNode, base: Rec, bp: string, bpDef: Breakpoint, designWidth: number | null): ReflowRule | null {
  if (base['layout'] !== 'none') return null;
  const selfAt = index.prim.get(node.id)?.payload['at'];
  if (isObj(selfAt) && isObj(selfAt[bp]) && Object.keys(selfAt[bp] as Rec).length > 0) return null;
  if (typeof bpDef.maxWidth !== 'number') return null;
  const own = node.id === SCENE_ROOT_ID ? designWidth : num((index.prim.get(node.id)?.payload ?? {})['width']) ?? designWidth;
  if (own === null || bpDef.maxWidth >= own) return null;
  const kids = index.childrenOf.get(node.id) ?? [];
  if (kids.length < 2) return null;
  const parts: Array<{ id: string; x: number; y: number; h: number }> = [];
  for (const k of kids) {
    const p = index.prim.get(k.id)?.payload ?? {};
    const pin = isObj(p['pin']) ? p['pin'] : {};
    if (pin['x'] !== undefined || pin['y'] !== undefined) continue; // the pin names an axis - the reflow skips the child
    const kidAt = isObj(p['at']) ? p['at'] : {};
    if (isObj(kidAt[bp]) && Object.keys(kidAt[bp] as Rec).length > 0) continue; // an at override silences the reflow for this breakpoint
    parts.push({ id: k.id, x: num(p['x']) ?? 0, y: num(p['y']) ?? 0, h: Math.max(1, num(p['height']) ?? 1) });
  }
  if (parts.length < 2) return null;
  // Band by overlapping y-ranges (sweep in y-order), then order within a band by x.
  parts.sort((a, b) => a.y - b.y || a.x - b.x);
  const ordered: Array<{ id: string }> = [];
  let band: typeof parts = [];
  let bandBottom = Number.NEGATIVE_INFINITY;
  const flush = (): void => { band.sort((a, b) => a.x - b.x || a.y - b.y); ordered.push(...band); band = []; };
  for (const c of parts) {
    if (band.length > 0 && c.y >= bandBottom) flush();
    band.push(c);
    bandBottom = Math.max(bandBottom, c.y + c.h);
  }
  flush();
  return {
    container: 'display:flex;flex-direction:row;flex-wrap:wrap;align-items:flex-start;height:auto;max-width:100%',
    // relative (not static) + inset:auto: the child joins the flex flow with its x/y offsets neutralized,
    // yet stays the containing block for its own pinned free children (a pinned badge holds its corner).
    // height:auto - a banded child's authored height served the desktop composition; in the stack it hugs.
    children: ordered.map((c, i) => ({ cls: `tk-n-${cssIdent(c.id)}`, decls: `position:relative;inset:auto;order:${i};max-width:100%;height:auto` })),
  };
}

/** The document's stylesheet: every node's static look, its state blocks, its breakpoint blocks, the reflow, and the forced-breakpoint mirror. */
export function buildStylesheet(index: DocIndex, breakpoints: Record<string, Breakpoint>, scope = '', forced: string | null = null, designWidth: number | null = null, edit = false): string {
  const out: string[] = [];
  const reflow: string[] = [];
  const at = scope === '' ? '' : `${scope} `;
  const phoneEdge = phoneEdgeOf(breakpoints);
  for (const node of Object.values(index.nodes)) {
    const prim = index.prim.get(node.id);
    if (prim === undefined) continue;
    // tk-n- namespaces the per-NODE class apart from the primitive classes: a node whose id
    // is literally 'frame' must never restyle every frame (the root included) through .tk-frame.
    const cls = `tk-n-${cssIdent(node.id)}`;
    const ctx = layoutCtxOf(index, node);
    const base = { ...initialValues(prim.name), ...staticPayload(prim.payload) };
    const baseDecls = lookDeclarations(prim.name, base, ctx);
    // Mode 'edit' switches the root sizing: the direct editor mount fills its HOST, never the window (100vh is the served page's rule).
    if (edit && ctx.isRoot && prim.name === 'frame' && baseDecls['min-height'] === '100vh') baseDecls['min-height'] = '100%';
    if (Object.keys(baseDecls).length > 0) out.push(`${at}.${cls}{${declsText(baseDecls)}}`);
    if (prim.name === 'frame' && base['layout'] === 'grid' && typeof base['columns'] === 'number' && base['columns'] > 1 && !Array.isArray(base['column-sizes'])) {
      out.push(`@media (max-width: ${phoneEdge}px){${at}.${cls}{grid-template-columns:minmax(0,1fr)}}`);
      if (forced !== null && typeof breakpoints[forced]?.maxWidth === 'number' && breakpoints[forced].maxWidth <= phoneEdge) {
        out.push(`${forcedSel(scope, forced)}.${cls}{grid-template-columns:minmax(0,1fr)}`);
      }
    }
    // THE REFLOW: collected apart and appended after the whole node loop - a child's base rule shares the
    // selector's specificity, so the reflow must FOLLOW every base rule or the child's position:absolute wins
    // by source order. An explicit at override still wins: reflowOf silences itself wherever an at block
    // speaks the breakpoint (the child is skipped; the frame keeps its own word).
    if (prim.name === 'frame') {
      for (const [bp, bpDef] of Object.entries(breakpoints)) {
        const media = mediaOf(bpDef);
        if (media === null) continue;
        const rule = reflowOf(index, node, base, bp, bpDef, designWidth);
        if (rule === null) continue;
        const body = [`${at}.${cls}{${rule.container}}`, ...rule.children.map((c) => `${at}.${c.cls}{${c.decls}}`)].join('');
        reflow.push(`@media ${media}{${body}}`);
        if (forced === bp) {
          reflow.push(`${forcedSel(scope, bp)}.${cls}{${rule.container}}`);
          for (const c of rule.children) reflow.push(`${forcedSel(scope, bp)}.${c.cls}{${c.decls}}`);
        }
      }
    }
    // first-on-top flips the paint order among the children (the sibling index rides --tk-i).
    if (prim.name === 'frame' && base['first-on-top'] === true) {
      out.push(`${at}.${cls}>[data-node]{z-index:calc(999 - var(--tk-i, 0))}`);
    }
    if (isObj(prim.payload['states'])) {
      for (const [state, block] of Object.entries(prim.payload['states'])) {
        const sel = STATE_SELECTORS[state];
        if (sel === undefined || !isObj(block)) continue;
        const decls = stateDecls(prim.name, base, staticPayload(block), ctx);
        if (Object.keys(decls).length > 0) out.push(`${sel(cls).split(', ').map((x) => at + x).join(', ')}{${declsText(decls)}}`);
      }
    }
    if (isObj(prim.payload['at'])) {
      for (const [bp, block] of Object.entries(prim.payload['at'])) {
        const media = mediaOf(breakpoints[bp]);
        if (media === null || !isObj(block)) continue;
        const decls = stateDecls(prim.name, base, staticPayload(block), ctx);
        if (Object.keys(decls).length === 0) continue;
        out.push(`@media ${media}{${at}.${cls}{${declsText(decls)}}}`);
        // Forced mode mirrors the block unwrapped: the host's data-tk-bp turns it on where the window cannot.
        if (forced === bp) out.push(`${forcedSel(scope, bp)}.${cls}{${declsText(decls)}}`);
      }
    }
    const enter = prim.payload['enter'];
    if (isObj(enter) && num(enter['stagger']) !== null) out.push(`${at}.${cls}>[data-node]{animation-delay:calc(var(--tk-i, 0) * ${num(enter['stagger'])}ms + ${num(enter['delay']) ?? 0}ms) !important}`);
  }
  out.push(...reflow);
  return out.join('\n');
}

/** A state or breakpoint block's declarations: the block over the base, only what the block names (and what it implies). */
function stateDecls(name: PrimitiveName, base: Rec, block: Rec, ctx: LayoutCtx): Record<string, string> {
  const merged = { ...base, ...block };
  const full = lookDeclarations(name, merged, ctx);
  const before = lookDeclarations(name, base, ctx);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(full)) if (before[k] !== v) out[k] = v;
  for (const k of Object.keys(before)) if (!(k in full)) out[k] = k === 'display' ? 'block' : 'initial';
  return out;
}

const BASE_CSS = `
.tk-host{display:block;min-height:100%}
.tk-host [data-node]{box-sizing:border-box;min-width:0}
.tk-host [data-node][data-tk-pending]{position:relative;color:transparent}
.tk-host [data-node][data-tk-pending]::after{content:"";position:absolute;inset:0;border-radius:var(--r1,10px);background:linear-gradient(100deg,var(--panel,#2a2a2a) 35%,var(--panel2,#303030) 50%,var(--panel,#2a2a2a) 65%);background-size:200% 100%;animation:tk-pending 1.4s linear infinite}
@keyframes tk-pending{from{background-position:180% 0}to{background-position:-80% 0}}
.tk-text{margin:0;overflow-wrap:anywhere}
.tk-text a{color:inherit;text-decoration:underline;text-underline-offset:2px}
.tk-text code{font-family:var(--mono,ui-monospace,monospace);font-size:0.92em;background:var(--panel2,#303030);padding:0 4px;border-radius:4px}
.tk-text pre{margin:0;font-family:var(--mono,ui-monospace,monospace);font-size:var(--fs-small,12px);background:var(--panel,#2a2a2a);padding:var(--s3,12px);border-radius:var(--r1,10px);overflow:auto;white-space:pre}
.tk-text blockquote{margin:0;border-left:2px solid var(--border2,var(--border,#3a3a3a));padding-left:var(--s3,12px);color:var(--t2,#a0a0a0)}
.tk-text ul,.tk-text ol{margin:0;padding-left:1.4em}
.tk-text h1,.tk-text h2,.tk-text h3,.tk-text h4,.tk-text p{margin:0}
.tk-text table{border-collapse:collapse;width:100%}
.tk-text td,.tk-text th{border:1px solid var(--border,#3a3a3a);padding:4px 8px;text-align:left}
.tk-text th{font-weight:600;color:var(--t1,#ececec)}
.tk-rich>*+*{margin-top:0.6em}
.tk-glyph{display:inline-block;width:1em;height:1em;vertical-align:-0.15em;flex:none}
.tk-err{font-family:var(--mono,ui-monospace,monospace);font-size:var(--fs-small,12px);color:var(--red,#f85149)}
.tk-empty{font-size:var(--fs-small,12px);color:var(--t3,#7a7a7a)}
:where(.tk-frame){display:flex;flex-direction:column}
:where(.tk-frame.tk-action){appearance:none;border:0;background:none;font:inherit;color:inherit;text-align:inherit;text-decoration:none;margin:0}
.tk-frame.tk-action:focus-visible{outline:2px solid var(--ring,#ececec);outline-offset:2px}
.tk-paint{position:absolute;inset:0;border-radius:inherit;pointer-events:none;overflow:hidden;z-index:-1}
.tk-paint video,.tk-paint img{width:100%;height:100%;display:block}
.tk-backdrop{position:fixed;inset:0;z-index:999}
.tk-anchored{z-index:1000}
.tk-field{display:flex;flex-direction:column;gap:var(--s1,4px);font-size:var(--fs-body,13px)}
.tk-field-label{font-size:var(--fs-small,12px);color:var(--t2,#a0a0a0)}
.tk-field-hint{font-size:var(--fs-caption,11px);color:var(--t3,#7a7a7a)}
.tk-field-error{font-size:var(--fs-caption,11px);color:var(--red,#f85149)}
.tk-well{display:flex;align-items:center;gap:var(--s2,8px);min-height:36px;padding:0 var(--s3,12px);background:var(--muted,var(--side,#212121));border:1px solid var(--border,#3a3a3a);border-radius:var(--r1,10px);color:var(--t1,#ececec);transition:border-color 120ms ease-out,background 120ms ease-out}
.tk-well:focus-within{border-color:var(--ring,#ececec);outline:2px solid var(--ring,#ececec);outline-offset:-1px}
.tk-well input,.tk-well select,.tk-well textarea{flex:1 1 auto;min-width:0;width:100%;background:transparent;border:0;outline:0;color:inherit;font:inherit;padding:0}
.tk-well textarea{padding:var(--s2,8px) 0;resize:vertical;line-height:1.5}
.tk-well select option{background:var(--panel,#2a2a2a);color:var(--t1,#ececec)}
.tk-well input::placeholder,.tk-well textarea::placeholder{color:var(--t3,#7a7a7a)}
.tk-well input[type=range]{accent-color:var(--primary,#ececec)}
.tk-well input[type=color]{width:32px;height:24px;padding:0;border:0;background:none}
.tk-well input[type=file]{color:var(--t2,#a0a0a0)}
.tk-affix{color:var(--t3,#7a7a7a);flex:none}
.tk-choices{display:flex;flex-wrap:wrap;gap:var(--s2,8px) var(--s4,16px)}
.tk-choice{display:inline-flex;align-items:center;gap:var(--s2,8px);cursor:pointer}
.tk-choice input{accent-color:var(--primary,#ececec);margin:0}
.tk-switch{display:inline-flex;align-items:center;gap:var(--s2,8px);cursor:pointer;min-height:32px}
.tk-switch input{position:absolute;opacity:0;width:0;height:0}
.tk-switch-track{width:36px;height:20px;border-radius:999px;background:var(--border2,#4a4a4a);position:relative;transition:background 150ms ease-out;flex:none}
.tk-switch-track::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--t0,#fff);transition:transform 150ms cubic-bezier(0.22,1,0.36,1)}
.tk-switch input:checked+.tk-switch-track{background:var(--primary,#ececec)}
.tk-switch input:checked+.tk-switch-track::after{transform:translateX(16px);background:var(--primary-foreground,#171717)}
.tk-switch input:focus-visible+.tk-switch-track{outline:2px solid var(--ring,#ececec);outline-offset:2px}
.tk-field[data-disabled]{opacity:0.55;pointer-events:none}
.tk-chart{display:block;position:relative;min-width:0}
.tk-chart svg{display:block;width:100%;height:auto;overflow:visible}
.tk-chart-title{font-size:var(--fs-title,14px);font-weight:500;color:var(--t1,#ececec)}
.tk-chart-subtitle{font-size:var(--fs-small,12px);color:var(--t3,#7a7a7a)}
.tk-legend{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:var(--fs-small,12px);color:var(--t2,#a0a0a0)}
.tk-legend-item{display:inline-flex;align-items:center;gap:6px}
.tk-legend-swatch{width:10px;height:10px;border-radius:2px;flex:none}
.tk-axis-text{font-size:var(--fs-caption,11px);fill:var(--t3,#7a7a7a);font-family:var(--sans,system-ui,sans-serif)}
.tk-mark-text{font-size:var(--fs-caption,11px);fill:var(--t2,#a0a0a0);font-family:var(--sans,system-ui,sans-serif)}
.tk-gauge-value{font-size:20px;font-weight:500;fill:var(--t0,#fff);font-variant-numeric:tabular-nums;font-family:var(--sans,system-ui,sans-serif)}
.tk-pick{cursor:pointer}
.tk-grow{transform-origin:bottom;animation:tk-grow 500ms cubic-bezier(0.22,1,0.36,1) both}
.tk-grow-x{transform-origin:left;animation:tk-grow-x 500ms cubic-bezier(0.22,1,0.36,1) both}
.tk-trace{stroke-dasharray:1;stroke-dashoffset:1;animation:tk-trace 800ms cubic-bezier(0.22,1,0.36,1) forwards}
.tk-fade-in{animation:tk-fade 400ms ease-out both}
@keyframes tk-grow{from{transform:scaleY(0)}to{transform:scaleY(1)}}
@keyframes tk-grow-x{from{transform:scaleX(0)}to{transform:scaleX(1)}}
@keyframes tk-trace{to{stroke-dashoffset:0}}
@keyframes tk-fade{from{opacity:0}to{opacity:1}}
.tk-enter{opacity:0}
.tk-enter[data-tk-in]{animation:var(--tk-enter-name,tk-fade) var(--tk-enter-dur,500ms) cubic-bezier(0.22,1,0.36,1) var(--tk-enter-delay,0ms) both}
@keyframes tk-rise{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}
@keyframes tk-slide-left{from{opacity:0;transform:translateX(24px)}to{opacity:1;transform:none}}
@keyframes tk-slide-right{from{opacity:0;transform:translateX(-24px)}to{opacity:1;transform:none}}
@keyframes tk-scale{from{opacity:0;transform:scale(0.92)}to{opacity:1;transform:none}}
.tk-exit{animation:var(--tk-exit-name,tk-fade-out) var(--tk-exit-dur,200ms) ease-out both;pointer-events:none}
@keyframes tk-fade-out{to{opacity:0}}
@keyframes tk-sink{to{opacity:0;transform:translateY(12px)}}
@keyframes tk-out-left{to{opacity:0;transform:translateX(-24px)}}
@keyframes tk-out-right{to{opacity:0;transform:translateX(24px)}}
@keyframes tk-scale-out{to{opacity:0;transform:scale(0.94)}}
.tk-animate{animation:var(--tk-anim-name) var(--tk-anim-dur,1.6s) var(--tk-anim-ease,ease-in-out) var(--tk-anim-count,infinite)}
@keyframes tk-pulse{0%,100%{opacity:1}50%{opacity:0.55}}
@keyframes tk-spin{to{transform:rotate(360deg)}}
@keyframes tk-float{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}
@keyframes tk-bounce{0%,100%{transform:translateY(0)}40%{transform:translateY(-10px)}60%{transform:translateY(-4px)}}
@keyframes tk-shimmer{from{background-position:180% 0}to{background-position:-80% 0}}
.tk-animate[data-tk-anim="shimmer"]{background-image:linear-gradient(100deg,transparent 35%,rgba(255,255,255,0.12) 50%,transparent 65%);background-size:200% 100%}
.tk-parallax{will-change:transform;transform:translateY(calc(var(--tk-scroll,0) * var(--tk-parallax,0) * 1px))}
.tk-notice{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);max-width:80%;background:var(--panel2,#303030);color:var(--t1,#ececec);padding:10px 16px;border-radius:var(--r1,10px);font-size:var(--fs-body,13px);box-shadow:0 2px 12px rgba(0,0,0,0.25);z-index:2147483000}
.tk-notice[data-tone="failure"]{color:var(--red,#f85149)}
.tk-copied{font-size:var(--fs-caption,11px);color:var(--t3,#7a7a7a);margin-left:6px}
.tk-host[data-tk-editor] *{-webkit-user-select:none;user-select:none}
.tk-host[data-tk-editor] input,.tk-host[data-tk-editor] textarea,.tk-host[data-tk-editor] [contenteditable]{-webkit-user-select:text;user-select:text}
.tk-host[data-tk-editor] ::selection{background:rgba(236,236,236,0.22)}
.tk-host [data-tk-hit]{outline:1px solid var(--t1,#fff);outline-offset:1px}
@media (prefers-reduced-motion: reduce){.tk-host *{animation-duration:1ms !important;transition-duration:1ms !important}}
`;

// ---------------------------------------------------------------------------
// The tree: one React component per primitive over the store (Webstudio's component-generator shape:
// the document walks into elements; props resolve per element).
// ---------------------------------------------------------------------------

interface Runtime {
  store: SceneStore;
  host: HTMLElement | null;
  mode: SceneMode;
  fire: (node: string, scope: Scope, element: HTMLElement | null) => void;
  nav: (scene: string, key?: string) => void;
  setOpen: (node: string, open: boolean | 'toggle', scope?: Scope) => void;
  /** Edit mode: interactive elements report instead of acting. */
  editor: boolean;
  /** The selector that scopes this mount's stylesheet: several mounts on one page never cross-style a shared node id. */
  scope: string;
}

const RuntimeContext = createContext<Runtime | null>(null);
function useRuntime(): Runtime {
  const rt = useContext(RuntimeContext);
  if (rt === null) throw new Error('tentkit: a node rendered outside mountScene');
  return rt;
}
function useSceneState(): SceneState {
  const rt = useRuntime();
  return useSyncExternalStore((fn) => rt.store.subscribe(fn), () => rt.store.get(), () => rt.store.get());
}

interface NodeViewProps { node: SceneNode; scope: Scope; index: number }

/** The Scene component: mountScene renders this; a server render may too (the same tree). */
export function Scene({ runtime }: { runtime: Runtime }): ReactElement {
  return createElement(RuntimeContext.Provider, { value: runtime }, createElement(SceneBody));
}

function SceneBody(): ReactElement | null {
  const state = useSceneState();
  const rt = useRuntime();
  const css = useMemo(
    () => buildStylesheet(state.index, state.breakpoints, rt.scope, state.forced, state.designWidth, rt.editor),
    [state.index, state.breakpoints, rt.scope, state.forced, state.designWidth, rt.editor],
  );
  const root = state.index.nodes[SCENE_ROOT_ID];
  useClock(state);
  useScrollVar(rt.host);
  return createElement(Fragment, null,
    createElement('style', { 'data-tk-base': '' }, BASE_CSS),
    createElement('style', { 'data-tk-doc': '' }, css),
    root !== undefined ? createElement(NodeView, { node: root, scope: TOP, index: 0 }) : null,
    createElement(Notices),
  );
}

/** One tick a second while a clock or a countdown is on the page. */
function useClock(state: SceneState): void {
  const rt = useRuntime();
  const live = useMemo(() => {
    for (const p of state.index.prim.values()) {
      if (p.name !== 'text') continue;
      const f = p.payload['format'];
      if (isObj(f) && (f['clock'] !== undefined || f['countdown'] !== undefined || f['relative'] === true)) return true;
    }
    return false;
  }, [state.index]);
  useEffect(() => {
    if (!live) return;
    const id = window.setInterval(() => rt.store.tick(), 1000);
    return () => window.clearInterval(id);
  }, [live, rt.store]);
}

/** --tk-scroll on the host: parallax elements translate against it. */
function useScrollVar(host: HTMLElement | null): void {
  useEffect(() => {
    if (host === null) return;
    let raf = 0;
    const onScroll = (): void => {
      if (raf !== 0) return;
      raf = window.requestAnimationFrame(() => { raf = 0; host.style.setProperty('--tk-scroll', String(window.scrollY)); });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => { window.removeEventListener('scroll', onScroll); if (raf !== 0) window.cancelAnimationFrame(raf); };
  }, [host]);
}

function Notices(): ReactElement | null {
  const state = useSceneState();
  const failed = [...state.results.entries()].filter(([, r]) => !r.ok && r.failures.length > 0);
  if (failed.length === 0) {
    // A message effect: the one quiet sentence, then silence.
    return state.notice !== null ? createElement('div', { className: 'tk-notice', role: 'status', 'data-notice': '' }, state.notice.text) : null;
  }
  const [name, r] = failed[failed.length - 1]!;
  return createElement('div', { className: 'tk-notice', 'data-tone': 'failure', role: 'alert', 'data-action': name }, r.failures.join(' - '));
}

function NodeView({ node, scope, index }: NodeViewProps): ReactElement | null {
  const state = useSceneState();
  const prim = state.index.prim.get(node.id);
  if (prim === undefined) return null;
  switch (prim.name) {
    case 'frame': return createElement(FrameView, { node, scope, index, prim });
    case 'text': return createElement(TextView, { node, scope, index, prim });
    case 'field': return createElement(FieldView, { node, scope, index, prim });
    case 'chart': return createElement(ChartView, { node, scope, index, prim });
    default: return null;
  }
}

interface PrimProps extends NodeViewProps { prim: Prim }

/** The attributes every rendered primitive carries: the node id, the class, the a11y trio, the inline dynamic look. */
function commonAttrs(node: SceneNode, prim: Prim, props: Rec, state: SceneState, index: number, dynamicDecls: Record<string, string>): Rec {
  const attrs: Rec = {
    'data-node': node.id,
    className: `tk-n-${cssIdent(node.id)} tk-${prim.name}`,
    style: { ...toReactStyle(dynamicDecls), '--tk-i': index } as CSSProperties,
  };
  const label = str(props['aria-label']);
  if (label !== null) attrs['aria-label'] = label;
  const role = str(props['role']);
  if (role !== null) attrs['role'] = role;
  const tab = num(props['tab-index']);
  if (tab !== null) attrs['tabIndex'] = tab;
  const reads = state.index.reads.get(node.id) ?? [];
  if (reads.some((b) => state.pending.has(b))) attrs['data-tk-pending'] = '';
  return attrs;
}

/** The inline declarations an element carries: those from dynamic values (differ per row or per channel). */
function dynamicDeclsOf(prim: Prim, props: Rec, index: DocIndex, node: SceneNode): Record<string, string> {
  const dyn: Rec = {};
  let any = false;
  for (const [k, v] of Object.entries(prim.payload)) if (k !== 'states' && k !== 'at' && isDynamic(v)) { dyn[k] = props[k]; any = true; }
  if (!any) return {};
  const ctx = layoutCtxOf(index, node);
  const base = { ...initialValues(prim.name), ...staticPayload(prim.payload) };
  const before = lookDeclarations(prim.name, base, ctx);
  const after = lookDeclarations(prim.name, { ...base, ...dyn }, ctx);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(after)) if (before[k] !== v) out[k] = v;
  for (const k of Object.keys(before)) if (!(k in after)) out[k] = 'initial';
  return out;
}

/** Motion classes and vars from the motion group (enter, exit, parallax, animate). */
function motionAttrs(props: Rec, mode: SceneMode): { className: string; style: Record<string, string>; enterAt: string | null } {
  const classes: string[] = [];
  const style: Record<string, string> = {};
  let enterAt: string | null = null;
  const enter = props['enter'];
  if (isObj(enter) && enter['effect'] !== 'none' && mode === 'serve') {
    classes.push('tk-enter');
    style['--tk-enter-name'] = `tk-${str(enter['effect']) ?? 'fade'}`;
    if (num(enter['duration']) !== null) style['--tk-enter-dur'] = `${enter['duration']}ms`;
    if (num(enter['delay']) !== null) style['--tk-enter-delay'] = `${enter['delay']}ms`;
    enterAt = str(enter['at']) ?? 'appear';
  }
  const parallax = props['parallax'];
  if (isObj(parallax) && num(parallax['speed']) !== null && mode === 'serve') {
    classes.push('tk-parallax');
    style['--tk-parallax'] = String(-(num(parallax['speed']) ?? 0) * 0.3);
  }
  const animate = props['animate'];
  if (isObj(animate) && typeof animate['effect'] === 'string') {
    classes.push('tk-animate');
    style['--tk-anim-name'] = `tk-${animate['effect']}`;
    if (num(animate['duration']) !== null) style['--tk-anim-dur'] = `${animate['duration']}ms`;
    if (animate['effect'] === 'spin') style['--tk-anim-ease'] = 'linear';
    if (animate['count'] !== undefined) style['--tk-anim-count'] = animate['count'] === 'infinite' ? 'infinite' : String(animate['count']);
  }
  return { className: classes.join(' '), style, enterAt };
}

/** The entrance: on appear it plays at mount; else when the element scrolls into view (once). */
function useEnter(ref: { current: HTMLElement | null }, enterAt: string | null): void {
  useEffect(() => {
    const el = ref.current;
    if (el === null || enterAt === null) return;
    if (enterAt === 'appear' || typeof IntersectionObserver === 'undefined') { el.setAttribute('data-tk-in', ''); return; }
    const threshold = enterAt === 'full' ? 0.95 : enterAt === 'half' ? 0.5 : 0.05;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { el.setAttribute('data-tk-in', ''); io.disconnect(); }
    }, { threshold });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, enterAt]);
}

/** Shown, or leaving: a closed or hidden node with an exit stays mounted for the exit's duration. */
function usePresence(shown: boolean, exit: unknown): { render: boolean; leaving: boolean } {
  const effect = isObj(exit) && exit['effect'] !== 'none' ? str(exit['effect']) : null;
  const duration = isObj(exit) ? num(exit['duration']) ?? 200 : 0;
  const [leaving, setLeaving] = useState(false);
  const was = useRef(shown);
  useEffect(() => {
    if (was.current && !shown && effect !== null) {
      setLeaving(true);
      const t = window.setTimeout(() => setLeaving(false), duration);
      was.current = shown;
      return () => window.clearTimeout(t);
    }
    was.current = shown;
    if (shown) setLeaving(false);
    return undefined;
  }, [shown, effect, duration]);
  return { render: shown || leaving, leaving: !shown && leaving };
}

const EXIT_NAMES: Readonly<Record<string, string>> = { fade: 'tk-fade-out', sink: 'tk-sink', 'slide-left': 'tk-out-left', 'slide-right': 'tk-out-right', scale: 'tk-scale-out' };

function isShown(props: Rec, state: SceneState, scope: Scope): boolean {
  const v = props['visible'];
  if (v === false) return false;
  if (v instanceof ExprError) return true;
  if (isObj(v) && typeof v['field'] === 'string') {
    const cur = state.channels.get(channelKey(v['field'], 'value', scope)) ?? state.channels.get(`${v['field']}.value`) ?? channelDefault(state, v['field'], 'value');
    return cur === v['is'] || (Array.isArray(cur) && cur.includes(v['is']));
  }
  return true;
}

// ---------------------------------------------------------------------------
// Frame.
// ---------------------------------------------------------------------------

const ACTION_TAGS = new Set(['run', 'open', 'close', 'toggle', 'copy']);

function actionTagOf(action: Rec | null, tag: string): string {
  if (tag !== 'div') return tag;
  if (action === null) return 'div';
  if (typeof action['goto'] === 'string' || typeof action['href'] === 'string') return 'a';
  return Object.keys(action).some((k) => ACTION_TAGS.has(k)) ? 'button' : 'div';
}

function FrameView({ node, scope, index, prim }: PrimProps): ReactElement | null {
  const rt = useRuntime();
  const state = useSceneState();
  const props = resolveProps(state, prim, scope);
  const ref = useRef<HTMLElement | null>(null);
  const isRoot = node.id === SCENE_ROOT_ID;
  const openKey = channelKey(node.id, 'open', scope);
  const openState = state.channels.get(openKey) ?? state.channels.get(`${node.id}.open`);
  const open = openState !== undefined ? openState === true : props['open'] !== false;
  const shown = isShown(props, state, scope);
  const anchor = isObj(props['anchor']) ? props['anchor'] : null;
  const presence = usePresence(shown && open, props['exit']);
  const motion = motionAttrs(props, rt.mode);
  useScopeRef(ref, scope);
  useEnter(ref, presence.render && !presence.leaving ? motion.enterAt : null);
  useAnchorPlacement(ref, anchor, presence.render, state.index);
  useAutoplay(ref, props['autoplay'], str(props['scroll-snap']));
  useDismiss(ref, anchor, presence.render && open, () => rt.setOpen(node.id, false, scope));
  if (!presence.render) return null;

  const action = isObj(props['action']) ? props['action'] : null;
  const disabled = props['disabled'] === true;
  const tag = actionTagOf(action, str(props['tag']) ?? 'div');
  const attrs = commonAttrs(node, prim, props, state, index, dynamicDeclsOf(prim, props, state.index, node));
  const classes = [attrs['className'] as string, motion.className];
  if (action !== null) classes.push('tk-action');
  if (anchor !== null) classes.push('tk-anchored');
  if (presence.leaving) { classes.push('tk-exit'); (attrs['style'] as Record<string, string>)['--tk-exit-name'] = EXIT_NAMES[str((props['exit'] as Rec)['effect']) ?? 'fade'] ?? 'tk-fade-out'; }
  attrs['className'] = classes.filter((c) => c !== '').join(' ');
  Object.assign(attrs['style'] as Record<string, string>, motion.style);
  attrs['ref'] = ref;
  if (disabled) { attrs['data-disabled'] = ''; if (tag === 'button') attrs['disabled'] = true; }
  if (tag === 'button') attrs['type'] = 'button';
  if (tag === 'a') {
    if (action !== null && typeof action['href'] === 'string') {
      attrs['href'] = action['href'];
      if (action['new-tab'] === true) { attrs['target'] = '_blank'; attrs['rel'] = 'noopener'; }
    } else attrs['href'] = '#';
  }
  if (anchor !== null) attrs['data-tk-anchor'] = str(anchor['side']) ?? 'bottom';
  if (props['exclusive'] === true) attrs['data-exclusive'] = '';
  if (action !== null) {
    attrs['data-action'] = actionWord(action);
    attrs['onClick'] = (ev: MouseEvent) => {
      if (rt.editor) return;
      if (tag === 'a' && !(typeof action['href'] === 'string')) ev.preventDefault();
      if (disabled) { ev.preventDefault(); return; }
      rt.fire(node.id, scope, ref.current);
    };
  }
  if (anchor !== null && anchor['to'] === 'screen' && str(anchor['side']) === 'center') attrs['role'] = attrs['role'] ?? 'dialog';

  const layers = paintLayers(props['fill'], props['object-fit'], props['object-position']);
  const opacity = num(props['fill-opacity']);
  const paintOnLayer = (opacity !== null && opacity < 1) || layers.video !== null;
  const children: ReactNode[] = [];
  if (paintOnLayer) {
    const style: Record<string, string> = {};
    if (opacity !== null && opacity < 1) style['opacity'] = String(opacity);
    if (layers.color !== undefined) style['backgroundColor'] = layers.color;
    if (layers.images.length > 0) {
      style['backgroundImage'] = layers.images.join(', ');
      style['backgroundSize'] = layers.sizes.join(', ');
      style['backgroundPosition'] = layers.positions.join(', ');
      style['backgroundRepeat'] = layers.repeats.join(', ');
    }
    children.push(createElement('div', { key: 'paint', className: 'tk-paint', 'aria-hidden': true, style },
      layers.video !== null ? createElement('video', {
        src: layers.video['video'], poster: str(layers.video['poster']) ?? undefined,
        autoPlay: layers.video['autoplay'] !== false, loop: layers.video['loop'] !== false, muted: layers.video['muted'] !== false,
        playsInline: true, controls: layers.video['controls'] === true,
        style: { objectFit: (str(props['object-fit']) ?? 'cover') === 'tile' ? 'cover' : str(props['object-fit']) ?? 'cover', objectPosition: str(props['object-position']) ?? 'center' },
      }) : null));
    // The paint layer needs a positioned box; the look already positions free children (absolute), stick (sticky) and layout-none frames (relative).
    const ctxHere = layoutCtxOf(state.index, node);
    const positionedByLook = (ctxHere.parent !== null && !ctxHere.isRoot && (ctxHere.parent.layout === 'none' || props['free'] === true))
      || typeof props['stick'] === 'string' || (str(props['layout']) ?? 'none') === 'none';
    if (!positionedByLook) (attrs['style'] as Record<string, string>)['position'] = 'relative';
    (attrs['style'] as Record<string, string>)['isolation'] = 'isolate';
  }
  if (layers.image !== null && typeof layers.image['alt'] === 'string' && attrs['aria-label'] === undefined) { attrs['role'] = 'img'; attrs['aria-label'] = layers.image['alt']; }
  children.push(...renderChildren(node, scope, state, props));

  const element = createElement(tag, { key: 'el', ...attrs }, ...children);
  if (anchor !== null && anchor['backdrop'] !== undefined && anchor['backdrop'] !== false) {
    const color = anchor['backdrop'] === true ? 'rgba(0,0,0,0.55)' : colorCss(anchor['backdrop']);
    return createElement(Fragment, null,
      createElement('div', { key: 'backdrop', className: 'tk-backdrop', 'data-backdrop-of': node.id, style: { background: color }, onClick: () => { if (anchor['dismiss'] !== false && !rt.editor) rt.setOpen(node.id, false, scope); } }),
      element);
  }
  return element;
}

function actionWord(a: Rec): string {
  for (const k of ['run', 'goto', 'href', 'open', 'close', 'toggle', 'copy']) if (a[k] !== undefined) return k;
  return 'action';
}

/** The children of a frame: once, or once per row of its each query. */
function renderChildren(node: SceneNode, scope: Scope, state: SceneState, props: Rec): ReactNode[] {
  const kids = state.index.childrenOf.get(node.id) ?? [];
  const each = props['each'];
  const query = typeof each === 'string' ? each : isObj(each) && typeof each['query'] === 'string' ? each['query'] : null;
  if (query === null) return kids.map((k, i) => createElement(NodeView, { key: k.id, node: k, scope, index: i }));
  const limit = isObj(each) ? num(each['limit']) : null;
  const keyCol = isObj(each) ? str(each['key']) : null;
  const rows = rowsOf(state, query, scope);
  const shown = limit !== null ? rows.slice(0, limit) : rows;
  if (shown.length === 0) {
    const error = state.errors[query];
    if (error !== undefined) return [createElement('span', { key: 'err', className: 'tk-err', title: error }, '#ERR')];
    if (state.pending.has(query)) return kids.map((k, i) => createElement(NodeView, { key: k.id, node: k, scope: { rowKey: `${scope.rowKey}${scope.rowKey === '' ? '' : '.'}r0`, row: {}, rowIndex: 0 }, index: i }));
    const words = isObj(each) && typeof each['empty'] === 'string' ? each['empty'] : `no rows in '${query}' yet`;
    return [createElement('span', { key: 'empty', className: 'tk-empty' }, words)];
  }
  const out: ReactNode[] = [];
  shown.forEach((row, ri) => {
    const rowScope: Scope = { row, rowIndex: ri, rowKey: `${scope.rowKey}${scope.rowKey === '' ? '' : '.'}r${ri}` };
    const key = keyCol !== null && row[keyCol] !== undefined ? String(row[keyCol]) : typeof row['_id'] === 'string' ? row['_id'] : `r${ri}`;
    kids.forEach((k, i) => out.push(createElement(NodeView, { key: `${key}:${k.id}`, node: k, scope: rowScope, index: ri * kids.length + i })));
  });
  return out;
}

/** An anchored frame floats at its target: the screen (fixed) or a node (fixed at its rect's side). */
function useAnchorPlacement(ref: { current: HTMLElement | null }, anchor: Rec | null, shown: boolean, index: DocIndex): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null || anchor === null || !shown) return;
    const place = (): void => {
      const side = str(anchor['side']) ?? 'bottom';
      const align = str(anchor['align']) ?? 'center';
      const offset = num(anchor['offset']) ?? 8;
      el.style.position = 'fixed';
      el.style.margin = '0';
      if (anchor['to'] === 'screen') {
        el.style.top = ''; el.style.left = ''; el.style.right = ''; el.style.bottom = ''; el.style.transform = '';
        if (side === 'center') { el.style.top = '50%'; el.style.left = '50%'; el.style.transform = 'translate(-50%, -50%)'; el.style.maxWidth = 'calc(100vw - 32px)'; el.style.maxHeight = 'calc(100vh - 32px)'; el.style.overflow = 'auto'; }
        else if (side === 'right' || side === 'left') { el.style.top = '0'; el.style.bottom = '0'; el.style[side] = '0'; el.style.maxWidth = '100vw'; }
        else { el.style.left = '0'; el.style.right = '0'; el.style[side === 'top' ? 'top' : 'bottom'] = '0'; }
        return;
      }
      const target = typeof anchor['to'] === 'string' ? document.querySelector<HTMLElement>(`[data-node="${anchor['to']}"]`) : null;
      if (target === null) return;
      const r = target.getBoundingClientRect();
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      let x = r.left;
      let y = r.bottom + offset;
      if (side === 'top') y = r.top - h - offset;
      if (side === 'left') { x = r.left - w - offset; y = r.top; }
      if (side === 'right') { x = r.right + offset; y = r.top; }
      if (side === 'center') { x = r.left + r.width / 2 - w / 2; y = r.top + r.height / 2 - h / 2; }
      if (side === 'top' || side === 'bottom') {
        if (align === 'center') x = r.left + r.width / 2 - w / 2;
        else if (align === 'end') x = r.right - w;
      } else if (align === 'center') y = r.top + r.height / 2 - h / 2;
      else if (align === 'end') y = r.bottom - h;
      x = Math.max(8, Math.min(x, window.innerWidth - w - 8));
      y = Math.max(8, Math.min(y, window.innerHeight - h - 8));
      el.style.left = `${Math.round(x)}px`;
      el.style.top = `${Math.round(y)}px`;
      el.style.transform = '';
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [ref, anchor, shown, index]);
}

/** Outside click and Esc close a dismissable anchored frame. */
function useDismiss(ref: { current: HTMLElement | null }, anchor: Rec | null, open: boolean, close: () => void): void {
  useEffect(() => {
    const el = ref.current;
    if (el === null || anchor === null || anchor['dismiss'] !== true || !open) return;
    const onKey = (ev: KeyboardEvent): void => { if (ev.key === 'Escape') close(); };
    const onDown = (ev: MouseEvent): void => { if (ev.target instanceof Node && !el.contains(ev.target)) close(); };
    const t = window.setTimeout(() => { document.addEventListener('keydown', onKey); document.addEventListener('mousedown', onDown); }, 0);
    return () => { window.clearTimeout(t); document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown); };
  }, [ref, anchor, open, close]);
}

/** A snapping frame advances by itself. */
function useAutoplay(ref: { current: HTMLElement | null }, autoplay: unknown, snap: string | null): void {
  useEffect(() => {
    const el = ref.current;
    if (el === null || !isObj(autoplay) || snap === null || snap === 'none') return;
    const interval = Math.max(100, num(autoplay['interval']) ?? 4000);
    const loop = autoplay['loop'] !== false;
    let paused = false;
    const horizontal = snap !== 'y';
    const step = (): void => {
      if (paused) return;
      const kids = [...el.children].filter((c): c is HTMLElement => c instanceof HTMLElement && c.hasAttribute('data-node'));
      if (kids.length === 0) return;
      const pos = horizontal ? el.scrollLeft : el.scrollTop;
      const next = kids.find((k) => (horizontal ? k.offsetLeft : k.offsetTop) > pos + 4);
      if (next !== undefined) el.scrollTo(horizontal ? { left: next.offsetLeft, behavior: 'smooth' } : { top: next.offsetTop, behavior: 'smooth' });
      else if (loop) el.scrollTo(horizontal ? { left: 0, behavior: 'smooth' } : { top: 0, behavior: 'smooth' });
    };
    const id = window.setInterval(step, interval);
    const enter = (): void => { if (autoplay['pause-on-hover'] === true) paused = true; };
    const leave = (): void => { paused = false; };
    el.addEventListener('mouseenter', enter);
    el.addEventListener('mouseleave', leave);
    return () => { window.clearInterval(id); el.removeEventListener('mouseenter', enter); el.removeEventListener('mouseleave', leave); };
  }, [ref, autoplay, snap]);
}

// ---------------------------------------------------------------------------
// Text.
// ---------------------------------------------------------------------------

interface GlyphShapes { s: unknown; vb: string; mode: 'stroke' | 'fill' }

/** The glyph shapes the serve seam stamped on the payload (the icon sets are data on the server, never in the build). */
function stampedGlyph(payload: Rec): GlyphShapes | null {
  const s = payload['_svg'];
  if (s === undefined) return null;
  return { s, vb: str(payload['_vb']) ?? '0 0 24 24', mode: payload['_mode'] === 'fill' ? 'fill' : 'stroke' };
}

function Glyph({ shapes, name }: { shapes: GlyphShapes | null; name: string }): ReactElement {
  const common = shapes?.mode === 'fill'
    ? { fill: 'currentColor', stroke: 'none' }
    : { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  const kids: ReactNode[] = [];
  const list = shapes !== null && Array.isArray(shapes.s) ? shapes.s : [];
  list.forEach((entry, i) => {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !isObj(entry[1])) return;
    const tag = entry[0];
    const attrs: Rec = { key: i };
    for (const [k, v] of Object.entries(entry[1])) if (typeof v === 'string' && k !== 'key') attrs[svgAttr(k)] = v;
    kids.push(createElement(tag, attrs));
  });
  return createElement('svg', { className: 'tk-glyph', viewBox: shapes?.vb ?? '0 0 24 24', 'aria-hidden': true, 'data-glyph': name, ...common }, ...kids);
}

const SVG_ATTR: Readonly<Record<string, string>> = {
  'stroke-width': 'strokeWidth', 'stroke-linecap': 'strokeLinecap', 'stroke-linejoin': 'strokeLinejoin', 'fill-rule': 'fillRule', 'clip-rule': 'clipRule',
  'stroke-dasharray': 'strokeDasharray', 'stroke-dashoffset': 'strokeDashoffset', 'fill-opacity': 'fillOpacity', 'stroke-opacity': 'strokeOpacity', class: 'className',
};
function svgAttr(k: string): string { return SVG_ATTR[k] ?? k; }

function formatText(value: unknown, format: unknown, now: number): string {
  if (value instanceof ExprError) return '#ERR';
  if (!isObj(format)) return displayValue(value);
  if (isObj(format['number'])) { const n = typeof value === 'number' ? value : Number(value); return Number.isFinite(n) ? formatNumberShape(n, format['number']) : displayValue(value); }
  if (typeof format['date'] === 'string') { const d = toDate(value); return d === null ? displayValue(value) : formatDate(d, format['date']); }
  if (format['relative'] === true) { const d = toDate(value); return d === null ? displayValue(value) : formatRelative(d, now); }
  if (typeof format['countdown'] === 'string') { const d = toDate(format['countdown']); return d === null ? '#ERR' : formatCountdown(d, now); }
  if (isObj(format['clock'])) {
    const d = new Date(now);
    const hours = format['clock']['hours'] === '12';
    const secs = format['clock']['seconds'] === true;
    return formatDate(d, `${hours ? 'h' : 'HH'}:mm${secs ? ':ss' : ''}${hours ? ' a' : ''}`);
  }
  return displayValue(value);
}

function TextView({ node, scope, index, prim }: PrimProps): ReactElement | null {
  const rt = useRuntime();
  const state = useSceneState();
  const props = resolveProps(state, prim, scope);
  const ref = useRef<HTMLElement | null>(null);
  const shown = isShown(props, state, scope);
  const presence = usePresence(shown, props['exit']);
  const motion = motionAttrs(props, rt.mode);
  useScopeRef(ref, scope);
  useEnter(ref, presence.render && !presence.leaving ? motion.enterAt : null);
  useAutoFit(ref, props['auto-fit'] === true);
  const [copied, setCopied] = useState(false);
  if (!presence.render) return null;
  const attrs = commonAttrs(node, prim, props, state, index, dynamicDeclsOf(prim, props, state.index, node));
  attrs['className'] = [attrs['className'] as string, 'tk-text', motion.className, presence.leaving ? 'tk-exit' : ''].filter((c) => c !== '').join(' ');
  Object.assign(attrs['style'] as Record<string, string>, motion.style);
  attrs['ref'] = ref;
  const value = props['text'];
  const err = value instanceof ExprError ? value : null;
  const tag = str(props['tag']) ?? 'p';
  const glyph = str(props['glyph']);
  const href = str(props['href']);
  const copy = props['copy'] === true;
  let content: ReactNode;
  if (glyph !== null && value === undefined && props['blocks'] === undefined) {
    content = createElement(Glyph, { shapes: stampedGlyph(prim.payload), name: glyph });
    if (attrs['aria-label'] === undefined) attrs['aria-hidden'] = true;
  } else if (Array.isArray(props['blocks']) && value === undefined) {
    content = createElement('div', { className: 'tk-rich', 'data-tk-rich': '' }, ...renderBlocks(props['blocks'], rt));
  } else {
    const words = formatText(value, props['format'], state.now);
    content = err !== null ? createElement('span', { className: 'tk-err', title: err.message }, '#ERR') : words;
    if (glyph !== null) content = createElement(Fragment, null, createElement(Glyph, { shapes: stampedGlyph(prim.payload), name: glyph }), ' ', content);
  }
  if (href !== null) {
    const screen = href.startsWith('screen:') ? href.slice('screen:'.length) : null;
    content = createElement('a', {
      href: screen !== null ? '#' : href,
      onClick: (ev: MouseEvent) => { if (rt.editor) return; if (screen !== null) { ev.preventDefault(); rt.nav(screen); } },
    }, content);
  }
  if (copy) {
    attrs['onClick'] = () => {
      if (rt.editor) return;
      const words = ref.current?.textContent ?? '';
      void navigator.clipboard?.writeText(words.replace(/\s*copied$/, '')).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); });
    };
    attrs['title'] = 'click to copy';
  }
  return createElement(tag, attrs, content, copied ? createElement('span', { className: 'tk-copied' }, 'copied') : null);
}

function renderRuns(runs: unknown, rt: Runtime): ReactNode[] {
  if (!Array.isArray(runs)) return [];
  return runs.map((r, i) => {
    if (typeof r === 'string') return r;
    if (!isObj(r)) return null;
    let el: ReactNode = str(r['text']) ?? '';
    if (r['code'] === true) el = createElement('code', { key: `c${i}` }, el);
    if (r['italic'] === true) el = createElement('em', { key: `i${i}` }, el);
    if (r['bold'] === true) el = createElement('strong', { key: `b${i}` }, el);
    if (typeof r['link'] === 'string') {
      const link = r['link'];
      const screen = link.startsWith('screen:') ? link.slice('screen:'.length) : null;
      el = createElement('a', { key: `a${i}`, href: screen !== null ? '#' : link, 'data-tkref': link, onClick: (ev: MouseEvent) => { if (rt.editor) return; if (screen !== null) { ev.preventDefault(); rt.nav(screen); } } }, el);
    }
    return createElement(Fragment, { key: i }, el);
  });
}

function renderBlocks(blocks: unknown[], rt: Runtime): ReactNode[] {
  return blocks.map((b, i) => {
    if (!isObj(b)) return null;
    const kind = str(b['kind']) ?? 'p';
    if (kind === 'bullets' || kind === 'numbers') {
      const items = Array.isArray(b['items']) ? b['items'] : [];
      return createElement(kind === 'numbers' ? 'ol' : 'ul', { key: i }, ...items.map((it, j) => createElement('li', { key: j }, ...renderRuns(it, rt))));
    }
    if (kind === 'table') {
      const rows = Array.isArray(b['rows']) ? b['rows'] : [];
      return createElement('table', { key: i }, createElement('tbody', null, ...rows.map((row, ri) => createElement('tr', { key: ri },
        ...(Array.isArray(row) ? row : []).map((cell, ci) => createElement(ri === 0 ? 'th' : 'td', { key: ci }, ...(typeof cell === 'string' ? [cell] : renderRuns(cell, rt))))))));
    }
    if (kind === 'code') return createElement('pre', { key: i }, createElement('code', null, ...renderRuns(b['runs'], rt)));
    if (kind === 'quote') return createElement('blockquote', { key: i, 'data-tkb': 'quote' }, ...renderRuns(b['runs'], rt));
    const tag = ['h1', 'h2', 'h3', 'h4'].includes(kind) ? kind : 'p';
    return createElement(tag, { key: i }, ...renderRuns(b['runs'], rt));
  });
}

/** Display headlines shrink until they fit their box. */
function useAutoFit(ref: { current: HTMLElement | null }, on: boolean): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null || !on || typeof ResizeObserver === 'undefined') return;
    const fit = (): void => {
      el.style.fontSize = '';
      const base = parseFloat(getComputedStyle(el).fontSize);
      let size = base;
      el.style.whiteSpace = 'nowrap';
      for (let i = 0; i < 24 && el.scrollWidth > el.clientWidth && size > 10; i++) { size = size * 0.94; el.style.fontSize = `${size.toFixed(1)}px`; }
      el.style.whiteSpace = '';
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el.parentElement ?? el);
    return () => ro.disconnect();
  }, [ref, on]);
}

// ---------------------------------------------------------------------------
// Field.
// ---------------------------------------------------------------------------

const INPUT_TYPES: Readonly<Record<string, string>> = {
  text: 'text', number: 'number', email: 'email', password: 'password', tel: 'tel', url: 'url', date: 'date', time: 'time', search: 'search', file: 'file', range: 'range', color: 'color',
};

function optionsOf(options: unknown, state: SceneState, scope: Scope): Array<{ label: string; value: unknown }> {
  if (Array.isArray(options)) return options.map((o) => (isObj(o) ? { label: str(o['label']) ?? displayValue(o['value']), value: o['value'] } : { label: displayValue(o), value: o }));
  if (isObj(options) && typeof options['query'] === 'string') {
    const label = str(options['label']) ?? 'label';
    const value = str(options['value']) ?? 'value';
    return rowsOf(state, options['query'], scope).map((row) => ({ label: displayValue(row[label]), value: row[value] }));
  }
  return [];
}

/** The value a field holds right now: the stored one, else its starting value, else what its kind shows (a select shows its first option). */
function fieldValueOf(props: Rec, stored: unknown, state: SceneState, scope: Scope): unknown {
  if (stored !== undefined) return stored;
  if (props['value'] !== undefined) return props['value'];
  const kind = str(props['kind']) ?? 'text';
  if (kind === 'toggle') return false;
  if (kind === 'multi-select') return [];
  if (kind === 'select' && str(props['placeholder']) === null) return optionsOf(props['options'], state, scope)[0]?.value ?? '';
  return '';
}

function ptypeOf(kind: string, value: unknown): string {
  if (kind === 'toggle') return 'boolean';
  if (kind === 'number' || kind === 'range') return 'number';
  if (kind === 'multi-select' || Array.isArray(value)) return 'json';
  return 'string';
}

function FieldView({ node, scope, index, prim }: PrimProps): ReactElement | null {
  const rt = useRuntime();
  const state = useSceneState();
  const props = resolveProps(state, prim, scope);
  const ref = useRef<HTMLElement | null>(null);
  const shown = isShown(props, state, scope);
  const presence = usePresence(shown, props['exit']);
  const motion = motionAttrs(props, rt.mode);
  useScopeRef(ref, scope);
  useEnter(ref, presence.render && !presence.leaving ? motion.enterAt : null);
  if (!presence.render) return null;
  const kind = str(props['kind']) ?? 'text';
  const name = str(props['name']) ?? node.id;
  const key = channelKey(node.id, 'value', scope);
  const value = fieldValueOf(props, state.channels.get(key), state, scope);
  const disabled = props['disabled'] === true;
  const readonly = props['readonly'] === true;
  const set = (v: unknown): void => {
    rt.store.setChannel(key, v);
    if (isObj(props['on-change'])) rt.fire(node.id, scope, ref.current);
  };
  const attrs = commonAttrs(node, prim, props, state, index, dynamicDeclsOf(prim, props, state.index, node));
  attrs['className'] = [attrs['className'] as string, 'tk-field', motion.className].filter((c) => c !== '').join(' ');
  Object.assign(attrs['style'] as Record<string, string>, motion.style);
  attrs['ref'] = ref;
  attrs['data-field'] = name;
  attrs['data-kind'] = kind;
  if (disabled) attrs['data-disabled'] = '';
  const errorKey = channelKey(node.id, 'error', scope);
  const error = str(state.channels.get(errorKey));
  const label = str(props['label']);
  const hint = str(props['hint']);
  const placeholder = str(props['placeholder']) ?? undefined;
  const shared = {
    name, disabled, readOnly: readonly, required: props['required'] === true, autoFocus: props['autofocus'] === true,
    autoComplete: str(props['autocomplete']) ?? undefined, 'data-param': name, 'data-ptype': ptypeOf(kind, value),
    'aria-invalid': error !== null ? true : undefined,
  };
  const glyphEl = str(props['glyph']) !== null ? createElement(Glyph, { shapes: glyphShapesOf(prim.payload), name: str(props['glyph']) ?? '' }) : null;
  let control: ReactNode;
  if (kind === 'toggle') {
    control = createElement('label', { className: 'tk-switch' },
      createElement('input', { ...shared, type: 'checkbox', role: 'switch', checked: value === true, onChange: (ev: { target: HTMLInputElement }) => set(ev.target.checked) }),
      createElement('span', { className: 'tk-switch-track', 'aria-hidden': true }),
      label !== null ? createElement('span', null, label) : null);
  } else if (kind === 'radio') {
    control = createElement('div', { className: 'tk-choices', role: 'radiogroup' },
      ...optionsOf(props['options'], state, scope).map((o, i) => createElement('label', { key: i, className: 'tk-choice' },
        createElement('input', { ...shared, type: 'radio', value: String(o.value), checked: value === o.value, onChange: () => set(o.value) }),
        createElement('span', null, o.label))));
  } else if (kind === 'multi-select') {
    const list = Array.isArray(value) ? value : [];
    control = createElement('div', { className: 'tk-choices' },
      ...optionsOf(props['options'], state, scope).map((o, i) => createElement('label', { key: i, className: 'tk-choice' },
        createElement('input', { ...shared, type: 'checkbox', value: String(o.value), checked: list.includes(o.value), onChange: (ev: { target: HTMLInputElement }) => set(ev.target.checked ? [...list, o.value] : list.filter((x) => x !== o.value)) }),
        createElement('span', null, o.label))));
  } else if (kind === 'select') {
    control = createElement('div', { className: 'tk-well' }, glyphEl,
      createElement('select', { ...shared, value: displayValue(value), onChange: (ev: { target: HTMLSelectElement }) => { const opt = optionsOf(props['options'], state, scope)[ev.target.selectedIndex - (placeholder !== undefined ? 1 : 0)]; set(opt !== undefined ? opt.value : ev.target.value); } },
        placeholder !== undefined ? createElement('option', { value: '', disabled: props['required'] === true }, placeholder) : null,
        ...optionsOf(props['options'], state, scope).map((o, i) => createElement('option', { key: i, value: displayValue(o.value) }, o.label))));
  } else if (kind === 'textarea') {
    control = createElement('div', { className: 'tk-well' },
      createElement('textarea', { ...shared, placeholder, rows: num(props['rows']) ?? 3, maxLength: num(props['maxlength']) ?? undefined, value: displayValue(value), onChange: (ev: { target: HTMLTextAreaElement }) => set(ev.target.value) }));
  } else if (kind === 'date-range') {
    const range = isObj(value) ? value : {};
    const setPart = (part: 'from' | 'to', v: string): void => set({ ...range, [part]: v });
    control = createElement('div', { className: 'tk-well' },
      createElement('input', { ...shared, name: `${name}-from`, 'data-param': `${name}-from`, type: 'date', value: str(range['from']) ?? '', min: props['min'] !== undefined ? String(props['min']) : undefined, onChange: (ev: { target: HTMLInputElement }) => setPart('from', ev.target.value) }),
      createElement('span', { className: 'tk-affix' }, 'to'),
      createElement('input', { ...shared, name: `${name}-to`, 'data-param': `${name}-to`, type: 'date', value: str(range['to']) ?? '', max: props['max'] !== undefined ? String(props['max']) : undefined, onChange: (ev: { target: HTMLInputElement }) => setPart('to', ev.target.value) }));
  } else {
    const type = INPUT_TYPES[kind] ?? 'text';
    const isNumber = type === 'number' || type === 'range';
    control = createElement('div', { className: 'tk-well' }, glyphEl,
      str(props['prefix']) !== null ? createElement('span', { className: 'tk-affix' }, props['prefix'] as string) : null,
      createElement('input', {
        ...shared, type, placeholder, pattern: str(props['pattern']) ?? undefined, maxLength: num(props['maxlength']) ?? undefined,
        min: props['min'] !== undefined ? String(props['min']) : undefined, max: props['max'] !== undefined ? String(props['max']) : undefined,
        step: num(props['step']) ?? undefined, accept: str(props['accept']) ?? undefined, multiple: props['multiple'] === true,
        ...(type === 'file' ? {} : { value: displayValue(value) }),
        onChange: (ev: { target: HTMLInputElement }) => {
          if (type === 'file') { set([...(ev.target.files ?? [])].map((f) => f.name)); return; }
          set(isNumber ? (ev.target.value === '' ? '' : Number(ev.target.value)) : ev.target.value);
        },
      }),
      str(props['suffix']) !== null ? createElement('span', { className: 'tk-affix' }, props['suffix'] as string) : null);
  }
  return createElement('div', attrs,
    label !== null && kind !== 'toggle' ? createElement('label', { className: 'tk-field-label' }, label) : null,
    control,
    error !== null ? createElement('span', { className: 'tk-field-error', role: 'alert' }, error) : hint !== null ? createElement('span', { className: 'tk-field-hint' }, hint) : null);
}

function glyphShapesOf(payload: Rec): GlyphShapes | null {
  return stampedGlyph(payload);
}

/** A field's value checked against its own rules; the error words land on its error channel. */
function fieldError(props: Rec, value: unknown): string | null {
  const custom = str(props['error']);
  const empty = value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
  if (props['required'] === true && empty) return custom ?? `${str(props['label']) ?? str(props['name']) ?? 'this'} is required`;
  if (empty) return null;
  const pattern = str(props['pattern']);
  if (pattern !== null && typeof value === 'string') {
    try { if (!new RegExp(`^(?:${pattern})$`).test(value)) return custom ?? 'this does not match the expected form'; } catch { /* a bad pattern never blocks */ }
  }
  if (typeof value === 'number') {
    const min = num(props['min']); const max = num(props['max']);
    if (min !== null && value < min) return custom ?? `the smallest value is ${min}`;
    if (max !== null && value > max) return custom ?? `the largest value is ${max}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Chart: one mark over a query, Vega-Lite's channels on SVG (the layered unit spec; each mark draws its own
// shape on the shared scales).
// ---------------------------------------------------------------------------

interface Channel {
  field?: string; type?: string; aggregate?: string; bin?: boolean | { step?: number; maxbins?: number }; timeUnit?: string;
  sort?: unknown; title?: string; format?: string; scale?: { type?: string; domain?: unknown[]; range?: unknown[]; zero?: boolean; nice?: boolean }; value?: unknown;
}

function channelOf(v: unknown): Channel | null {
  if (typeof v === 'string') return { field: v };
  if (!isObj(v)) return null;
  const c: Channel = {};
  if (typeof v['field'] === 'string') c.field = v['field'];
  if (typeof v['type'] === 'string') c.type = v['type'];
  if (typeof v['aggregate'] === 'string') c.aggregate = v['aggregate'];
  if (v['bin'] === true || isObj(v['bin'])) c.bin = v['bin'] as Channel['bin'];
  if (typeof v['time-unit'] === 'string') c.timeUnit = v['time-unit'];
  if (v['sort'] !== undefined) c.sort = v['sort'];
  if (typeof v['title'] === 'string') c.title = v['title'];
  if (typeof v['format'] === 'string') c.format = v['format'];
  if (isObj(v['scale'])) c.scale = v['scale'] as Channel['scale'];
  if (v['value'] !== undefined) c.value = v['value'];
  return c;
}

type MarkKind = 'line' | 'area' | 'bar' | 'point' | 'arc' | 'rect' | 'rule' | 'text' | 'tick' | 'gauge';
const MARKS: ReadonlySet<string> = new Set(['line', 'area', 'bar', 'point', 'arc', 'rect', 'rule', 'text', 'tick', 'gauge']);

interface LayerSpec {
  mark: MarkKind; rows: Row[]; query: string;
  x: Channel | null; y: Channel | null; x2: Channel | null; y2: Channel | null; theta: Channel | null; radius: Channel | null;
  color: Channel | null; size: Channel | null; opacity: Channel | null; shape: Channel | null; order: Channel | null; detail: Channel | null; text: Channel | null;
  tooltip: Channel[] | false | null; interpolate: string; point: boolean; line: boolean;
}

const TIME_UNIT_MS: Readonly<Record<string, (d: Date) => Date>> = {
  year: (d) => new Date(d.getFullYear(), 0, 1), quarter: (d) => new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1),
  month: (d) => new Date(d.getFullYear(), d.getMonth(), 1), week: (d) => { const w = new Date(d.getFullYear(), d.getMonth(), d.getDate()); w.setDate(w.getDate() - ((w.getDay() + 6) % 7)); return w; },
  day: (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()), hour: (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()),
  minute: (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()),
};

/** time-unit truncation, binning and aggregation over the rows (Vega-Lite's transforms, in encoding order). */
function prepareRows(rows: Row[], channels: Array<[string, Channel | null]>): Row[] {
  let out = rows.map((r) => ({ ...r }));
  for (const [, c] of channels) {
    if (c === null || c.field === undefined) continue;
    const field = c.field;
    if (c.timeUnit !== undefined && TIME_UNIT_MS[c.timeUnit] !== undefined) {
      const trunc = TIME_UNIT_MS[c.timeUnit]!;
      out = out.map((r) => { const d = toDate(r[field]); return d === null ? r : { ...r, [field]: trunc(d).toISOString() }; });
    }
    if (c.bin !== undefined && c.bin !== false) {
      const values = out.map((r) => num(r[field])).filter((v): v is number => v !== null);
      if (values.length > 0) {
        const min = Math.min(...values); const max = Math.max(...values);
        const maxbins = isObj(c.bin) && num(c.bin['maxbins']) !== null ? (num(c.bin['maxbins']) as number) : 10;
        const step = isObj(c.bin) && num(c.bin['step']) !== null ? (num(c.bin['step']) as number) : niceStep(min, max, maxbins);
        out = out.map((r) => { const v = num(r[field]); return v === null ? r : { ...r, [field]: Math.floor(v / step) * step }; });
      }
    }
  }
  const aggregated = channels.filter(([, c]) => c !== null && c.aggregate !== undefined);
  if (aggregated.length === 0) return out;
  const groupFields = channels.filter(([, c]) => c !== null && c.aggregate === undefined && c.field !== undefined).map(([, c]) => c!.field as string);
  const groups = new Map<string, Row[]>();
  for (const r of out) {
    const key = groupFields.map((f) => displayValue(r[f])).join('');
    const g = groups.get(key);
    if (g === undefined) groups.set(key, [r]); else g.push(r);
  }
  const result: Row[] = [];
  for (const g of groups.values()) {
    const row: Row = {};
    for (const f of groupFields) row[f] = g[0]![f];
    for (const [, c] of aggregated) {
      if (c === null) continue;
      const field = c.field ?? '__count';
      const nums = c.field === undefined ? [] : g.map((r) => num(r[c.field as string])).filter((v): v is number => v !== null);
      let v: number | null = null;
      switch (c.aggregate) {
        case 'count': v = g.length; break;
        case 'sum': v = nums.reduce((a, b) => a + b, 0); break;
        case 'mean': v = nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : null; break;
        case 'median': { const s = [...nums].sort((a, b) => a - b); v = s.length > 0 ? s[Math.floor(s.length / 2)]! : null; break; }
        case 'min': v = nums.length > 0 ? Math.min(...nums) : null; break;
        case 'max': v = nums.length > 0 ? Math.max(...nums) : null; break;
        case 'distinct': v = new Set(g.map((r) => displayValue(r[c.field as string]))).size; break;
        default: v = null;
      }
      row[field] = v;
    }
    result.push(row);
  }
  return result;
}

function fieldNameOf(c: Channel | null): string | null {
  if (c === null) return null;
  return c.field ?? (c.aggregate !== undefined ? '__count' : null);
}

function niceStep(min: number, max: number, count: number): number {
  const span = max - min || 1;
  const raw = span / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return step * mag;
}

export function niceTicks(min: number, max: number, count: number): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) return [min];
  const step = niceStep(min, max, count);
  const start = Math.ceil(min / step) * step;
  const out: number[] = [];
  for (let v = start; v <= max + step * 1e-6 && out.length < 50; v += step) out.push(Math.round(v / step) * step);
  return out;
}

function timeTicks(min: number, max: number): { ticks: number[]; format: (t: number) => string } {
  const span = max - min;
  const H = 3_600_000; const D = 24 * H;
  const out: number[] = [];
  const push = (t: number): void => { if (t >= min && t <= max && out.length < 40) out.push(t); };
  if (span <= 2 * H) { const step = 15 * 60_000; for (let t = Math.ceil(min / step) * step; t <= max; t += step) push(t); return { ticks: out, format: (t) => formatDate(new Date(t), 'HH:mm') }; }
  if (span <= 3 * D) { for (let t = Math.ceil(min / (6 * H)) * 6 * H; t <= max; t += 6 * H) push(t); return { ticks: out, format: (t) => formatDate(new Date(t), 'EEE HH:mm') }; }
  if (span <= 45 * D) { const step = span <= 14 * D ? D : 7 * D; const d0 = new Date(min); d0.setHours(0, 0, 0, 0); for (let t = d0.getTime(); t <= max; t += step) push(t); return { ticks: out, format: (t) => formatDate(new Date(t), 'MMM d') }; }
  if (span <= 800 * D) { const d = new Date(min); d.setDate(1); d.setHours(0, 0, 0, 0); const stepM = span <= 200 * D ? 1 : 3; while (d.getTime() <= max) { push(d.getTime()); d.setMonth(d.getMonth() + stepM); } return { ticks: out, format: (t) => formatDate(new Date(t), 'MMM yy') }; }
  const y = new Date(min); y.setMonth(0, 1); y.setHours(0, 0, 0, 0);
  while (y.getTime() <= max) { push(y.getTime()); y.setFullYear(y.getFullYear() + 1); }
  return { ticks: out, format: (t) => formatDate(new Date(t), 'yyyy') };
}

interface Scale {
  kind: 'linear' | 'log' | 'sqrt' | 'time' | 'band';
  domain: [number, number];
  categories: string[];
  range: [number, number];
  map: (v: unknown) => number | null;
  band: number;
  ticks: () => Array<{ v: number; label: string }>;
}

function looksLikeDate(v: unknown): boolean {
  return typeof v === 'string' && /^\d{4}-\d{2}/.test(v) && !Number.isNaN(Date.parse(v));
}

function buildScale(kind: Scale['kind'], values: unknown[], range: [number, number], opts: { zero?: boolean; nice?: boolean; domain?: unknown[]; sort?: unknown; format?: string; count?: number }): Scale {
  if (kind === 'band') {
    let cats = Array.isArray(opts.domain) && opts.domain.length > 0 ? opts.domain.map(displayValue) : [];
    if (cats.length === 0) { const seen = new Set<string>(); for (const v of values) { const s = displayValue(v); if (!seen.has(s)) { seen.add(s); cats.push(s); } } }
    if (opts.sort === 'ascending') cats = [...cats].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    else if (opts.sort === 'descending') cats = [...cats].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    else if (Array.isArray(opts.sort)) { const order = opts.sort.map(displayValue); cats = [...cats].sort((a, b) => order.indexOf(a) - order.indexOf(b)); }
    const band = cats.length > 0 ? (range[1] - range[0]) / cats.length : range[1] - range[0];
    const index = new Map(cats.map((c, i) => [c, i]));
    return {
      kind, domain: [0, cats.length], categories: cats, range, band,
      map: (v) => { const i = index.get(displayValue(v)); return i === undefined ? null : range[0] + i * band + band / 2; },
      ticks: () => cats.map((c, i) => ({ v: range[0] + i * band + band / 2, label: c })),
    };
  }
  const toNum = (v: unknown): number | null => {
    if (kind === 'time') { const d = toDate(v); return d === null ? null : d.getTime(); }
    return num(v) ?? (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
  };
  const nums = values.map(toNum).filter((v): v is number => v !== null);
  let min = Array.isArray(opts.domain) && toNum(opts.domain[0]) !== null ? (toNum(opts.domain[0]) as number) : nums.length > 0 ? Math.min(...nums) : 0;
  let max = Array.isArray(opts.domain) && toNum(opts.domain[1]) !== null ? (toNum(opts.domain[1]) as number) : nums.length > 0 ? Math.max(...nums) : kind === 'time' ? Date.now() : 100;
  if (opts.zero === true && kind !== 'time') { if (min > 0) min = 0; if (max < 0) max = 0; }
  if (min === max) { if (kind === 'time') { min -= 86_400_000; max += 86_400_000; } else { min = min === 0 ? 0 : min - Math.abs(min) * 0.5; max = max === 0 ? 1 : max + Math.abs(max) * 0.5; } }
  const count = opts.count ?? 4;
  let tickValues = kind === 'time' ? timeTicks(min, max).ticks : niceTicks(min, max, count);
  if (opts.nice !== false && kind !== 'time' && tickValues.length > 1) {
    const step = tickValues[1]! - tickValues[0]!;
    min = Math.min(min, Math.floor(min / step) * step);
    max = Math.max(max, Math.ceil(max / step) * step);
    tickValues = niceTicks(min, max, count);
  }
  const tf = kind === 'time' ? timeTicks(min, max).format : (t: number) => formatNumber(t, opts.format);
  const transform = (v: number): number => (kind === 'log' ? Math.log10(Math.max(1e-9, v)) : kind === 'sqrt' ? Math.sqrt(Math.max(0, v)) : v);
  const tmin = transform(min); const tmax = transform(max);
  const scaleMap = (v: unknown): number | null => {
    const n = toNum(v);
    if (n === null) return null;
    const t = transform(n);
    return range[0] + ((t - tmin) / ((tmax - tmin) || 1)) * (range[1] - range[0]);
  };
  return { kind, domain: [min, max], categories: [], range, band: 0, map: scaleMap, ticks: () => tickValues.map((v) => ({ v: scaleMap(v) as number, label: tf(v) })) };
}

const SERIES_DASH = ['', '', '', '6 4', '2 3', '8 4 2 4'];

function schemeColor(scheme: unknown, i: number): string {
  if (scheme === 'status') return colorCss(['green', 'amber', 'red'][i % 3]);
  if (Array.isArray(scheme) && scheme.length > 0) return colorCss(scheme[i % scheme.length]);
  return colorCss(`series-${(i % 6) + 1}`);
}

function inferKind(c: Channel | null, values: unknown[], bandMark: boolean): Scale['kind'] {
  const explicit = c?.scale?.type;
  if (explicit === 'band' || explicit === 'point' || explicit === 'ordinal') return 'band';
  if (explicit === 'time') return 'time';
  if (explicit === 'log') return 'log';
  if (explicit === 'sqrt') return 'sqrt';
  if (explicit === 'linear') return 'linear';
  if (c?.type === 'nominal' || c?.type === 'ordinal') return 'band';
  if (c?.type === 'temporal' || c?.timeUnit !== undefined) return 'time';
  if (c?.type === 'quantitative') return 'linear';
  const sample = values.filter((v) => v !== null && v !== undefined).slice(0, 50);
  if (sample.length === 0) return bandMark ? 'band' : 'linear';
  if (sample.every((v) => typeof v === 'number')) return bandMark ? 'band' : 'linear';
  if (sample.every(looksLikeDate)) return bandMark ? 'band' : 'time';
  return 'band';
}

function linePath(pts: Array<[number, number]>, interpolate: string): string {
  if (pts.length === 0) return '';
  if (pts.length === 1) return `M${pts[0]![0].toFixed(1)} ${pts[0]![1].toFixed(1)}`;
  if (interpolate === 'step') {
    let d = `M${pts[0]![0].toFixed(1)} ${pts[0]![1].toFixed(1)}`;
    for (let i = 1; i < pts.length; i++) { const mx = (pts[i - 1]![0] + pts[i]![0]) / 2; d += `H${mx.toFixed(1)}V${pts[i]![1].toFixed(1)}H${pts[i]![0].toFixed(1)}`; }
    return d;
  }
  if (interpolate === 'linear') return pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join('');
  // monotone (also basis and natural): a monotone cubic through every point, no overshoot.
  const n = pts.length;
  const dx: number[] = []; const dy: number[] = []; const m: number[] = [];
  for (let i = 0; i < n - 1; i++) { dx.push(pts[i + 1]![0] - pts[i]![0]); dy.push(pts[i + 1]![1] - pts[i]![1]); m.push(dx[i] === 0 ? 0 : dy[i]! / dx[i]!); }
  const t: number[] = [m[0]!];
  for (let i = 1; i < n - 1; i++) t.push(m[i - 1]! * m[i]! <= 0 ? 0 : (m[i - 1]! + m[i]!) / 2);
  t.push(m[n - 2]!);
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
    const a = t[i]! / m[i]!; const b = t[i + 1]! / m[i]!; const s = a * a + b * b;
    if (s > 9) { const k = 3 / Math.sqrt(s); t[i] = k * a * m[i]!; t[i + 1] = k * b * m[i]!; }
  }
  let d = `M${pts[0]![0].toFixed(1)} ${pts[0]![1].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i]! / 3;
    d += `C${(pts[i]![0] + h).toFixed(1)} ${(pts[i]![1] + t[i]! * h).toFixed(1)} ${(pts[i + 1]![0] - h).toFixed(1)} ${(pts[i + 1]![1] - t[i + 1]! * h).toFixed(1)} ${pts[i + 1]![0].toFixed(1)} ${pts[i + 1]![1].toFixed(1)}`;
  }
  return d;
}

function arcPath(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number): string {
  const p = (r: number, a: number): [number, number] => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const [x0, y0] = p(r1, a0); const [x1, y1] = p(r1, a1);
  const [x2, y2] = p(r0, a1); const [x3, y3] = p(r0, a0);
  const f = (n: number): string => n.toFixed(2);
  if (r0 <= 0) return `M${f(cx)} ${f(cy)}L${f(x0)} ${f(y0)}A${f(r1)} ${f(r1)} 0 ${large} 1 ${f(x1)} ${f(y1)}Z`;
  return `M${f(x0)} ${f(y0)}A${f(r1)} ${f(r1)} 0 ${large} 1 ${f(x1)} ${f(y1)}L${f(x2)} ${f(y2)}A${f(r0)} ${f(r0)} 0 ${large} 0 ${f(x3)} ${f(y3)}Z`;
}

function symbolPath(shape: string, cx: number, cy: number, r: number): string {
  const f = (n: number): string => n.toFixed(1);
  switch (shape) {
    case 'square': return `M${f(cx - r)} ${f(cy - r)}h${f(2 * r)}v${f(2 * r)}h${f(-2 * r)}Z`;
    case 'triangle': return `M${f(cx)} ${f(cy - r)}L${f(cx + r)} ${f(cy + r)}L${f(cx - r)} ${f(cy + r)}Z`;
    case 'diamond': return `M${f(cx)} ${f(cy - r)}L${f(cx + r)} ${f(cy)}L${f(cx)} ${f(cy + r)}L${f(cx - r)} ${f(cy)}Z`;
    case 'cross': return `M${f(cx - r)} ${f(cy - r / 3)}h${f(r * 2 / 3)}v${f(-r * 2 / 3)}h${f(r * 2 / 3)}v${f(r * 2 / 3)}h${f(r * 2 / 3)}v${f(r * 2 / 3)}h${f(-r * 2 / 3)}v${f(r * 2 / 3)}h${f(-r * 2 / 3)}v${f(-r * 2 / 3)}h${f(-r * 2 / 3)}Z`;
    default: return '';
  }
}

function tooltipWords(row: Row, layer: LayerSpec, fallback: string[]): string {
  if (layer.tooltip === false) return '';
  const fields = layer.tooltip !== null ? layer.tooltip.map((c) => c.field).filter((f): f is string => f !== undefined) : fallback;
  return fields.map((f) => `${f === '__count' ? 'count' : f}: ${displayValue(row[f])}`).join(' · ');
}

function useMeasuredWidth(ref: { current: HTMLElement | null }, fallback: number): number {
  const [w, setW] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const read = (): void => { const cw = el.clientWidth; if (cw > 0) setW(cw); };
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

function ChartView({ node, scope, index, prim }: PrimProps): ReactElement | null {
  const rt = useRuntime();
  const state = useSceneState();
  const props = resolveProps(state, prim, scope);
  const ref = useRef<HTMLElement | null>(null);
  const shown = isShown(props, state, scope);
  const presence = usePresence(shown, props['exit']);
  const motion = motionAttrs(props, rt.mode);
  useScopeRef(ref, scope);
  useEnter(ref, presence.render && !presence.leaving ? motion.enterAt : null);
  const width = useMeasuredWidth(ref, 480);
  if (!presence.render) return null;
  const attrs = commonAttrs(node, prim, props, state, index, dynamicDeclsOf(prim, props, state.index, node));
  attrs['className'] = [attrs['className'] as string, 'tk-chart', motion.className].filter((c) => c !== '').join(' ');
  Object.assign(attrs['style'] as Record<string, string>, motion.style);
  attrs['ref'] = ref;
  delete attrs['data-tk-pending'];
  const query = str(props['query']);
  const animate = props['animation'] !== false;
  const pick = isObj(props['on-pick']) ? (row: Row) => { rt.store.setChannel(channelKey(node.id, 'picked', scope), row); rt.fire(node.id, { ...scope, row }, ref.current); } : null;
  const title = str(props['title']);
  const subtitle = str(props['subtitle']);
  const legendProp = props['legend'];
  const legendOn = legendProp !== false;
  const legendOrient = isObj(legendProp) ? str(legendProp['orient']) ?? 'top' : 'top';
  const heightProp = num(props['height']);
  const height = heightProp !== null ? heightProp : 220;
  const chart = query === null ? null : drawChart(props, state, scope, query, width, height, animate, pick, node.id);
  const pendingNow = query !== null && state.pending.has(query) && (state.rows[query] === undefined);
  const error = query !== null ? state.errors[query] : undefined;
  return createElement('div', attrs,
    title !== null ? createElement('div', { className: 'tk-chart-title' }, title) : null,
    subtitle !== null ? createElement('div', { className: 'tk-chart-subtitle' }, subtitle) : null,
    chart !== null && legendOn && chart.legend.length > 1 && (legendOrient === 'top' || legendOrient === 'left') ? legendEl(chart.legend, isObj(legendProp) ? str(legendProp['title']) : null) : null,
    error !== undefined ? createElement('span', { className: 'tk-err', title: error }, '#ERR') : null,
    pendingNow ? createElement('div', { 'data-tk-pending': '', style: { height } }) : null,
    chart !== null && !pendingNow && error === undefined ? chart.svg : null,
    chart !== null && chart.empty !== null ? createElement('div', { className: 'tk-empty', style: { textAlign: 'center', marginTop: -height / 2 - 6, height: height / 2, pointerEvents: 'none' } }, chart.empty) : null,
    chart !== null && legendOn && chart.legend.length > 1 && (legendOrient === 'bottom' || legendOrient === 'right') ? legendEl(chart.legend, isObj(legendProp) ? str(legendProp['title']) : null) : null);
}

function legendEl(items: Array<{ label: string; color: string; dash: string }>, title: string | null): ReactElement {
  return createElement('div', { className: 'tk-legend', role: 'list' },
    title !== null ? createElement('span', { style: { color: 'var(--t3)' } }, title) : null,
    ...items.map((it, i) => createElement('span', { key: i, className: 'tk-legend-item', role: 'listitem' },
      createElement('span', { className: 'tk-legend-swatch', style: { background: it.color } }), it.label)));
}

interface Drawn { svg: ReactElement; legend: Array<{ label: string; color: string; dash: string }>; empty: string | null }

function layerOf(base: Rec, spec: Rec, rows: Row[], query: string): LayerSpec | null {
  const mark = str(spec['mark']) ?? str(base['mark']) ?? 'bar';
  if (!MARKS.has(mark)) return null;
  // The channels live under the one encoding shape (Vega-Lite's spec shape); a layer carries its own.
  const enc: Rec = isObj(spec['encoding']) ? spec['encoding'] : {};
  const ch = (k: string): Channel | null => channelOf(enc[k]);
  const tooltipRaw = enc['tooltip'];
  const tooltip = tooltipRaw === false ? false : tooltipRaw === undefined ? null : (Array.isArray(tooltipRaw) ? tooltipRaw : [tooltipRaw]).map(channelOf).filter((c): c is Channel => c !== null);
  const channels: Array<[string, Channel | null]> = [['x', ch('x')], ['y', ch('y')], ['x2', ch('x2')], ['y2', ch('y2')], ['theta', ch('theta')], ['radius', ch('radius')], ['color', ch('color')], ['size', ch('size')], ['opacity', ch('opacity')], ['shape', ch('shape')], ['order', ch('order')], ['detail', ch('detail')], ['text', ch('text')]];
  const get = (k: string): Channel | null => channels.find(([n]) => n === k)?.[1] ?? null;
  return {
    mark: mark as MarkKind, rows: prepareRows(rows, channels), query,
    x: get('x'), y: get('y'), x2: get('x2'), y2: get('y2'), theta: get('theta'), radius: get('radius'), color: get('color'), size: get('size'),
    opacity: get('opacity'), shape: get('shape'), order: get('order'), detail: get('detail'), text: get('text'), tooltip,
    interpolate: str(spec['interpolate']) ?? str(base['interpolate']) ?? 'linear', point: (spec['point'] ?? base['point']) === true, line: base['line'] === true,
  };
}

function drawChart(props: Rec, state: SceneState, scope: Scope, query: string, W: number, H: number, animate: boolean, pick: ((row: Row) => void) | null, nodeId: string): Drawn {
  const mark = str(props['mark']) ?? 'bar';
  const baseRows = rowsOf(state, query, scope);
  const layers: LayerSpec[] = [];
  const main = layerOf(props, props, baseRows, query);
  if (main !== null) layers.push(main);
  if (Array.isArray(props['layers'])) {
    for (const l of props['layers']) {
      if (!isObj(l)) continue;
      const q = str(l['query']) ?? query;
      const spec = layerOf(props, l, rowsOf(state, q, scope), q);
      if (spec !== null) layers.push(spec);
    }
  }
  const scheme = props['scheme'];
  const empty = str(props['empty']) ?? 'no data yet';
  const hasRows = layers.some((l) => l.rows.length > 0);
  if (mark === 'gauge') return drawGauge(props, main, W, H, scheme, empty);
  if (mark === 'arc') return drawArc(props, main, W, H, scheme, empty, animate, pick);

  const grid = props['grid'];
  const gridX = grid === true || (isObj(grid) && grid['x'] === true);
  const gridY = grid === true || (isObj(grid) && grid['y'] !== false);
  const xAxis = props['x-axis'] !== false ? (isObj(props['x-axis']) ? props['x-axis'] : {}) : null;
  const yAxis = props['y-axis'] !== false ? (isObj(props['y-axis']) ? props['y-axis'] : {}) : null;
  const orient = str(props['orient']) ?? 'vertical';
  const horizontal = orient === 'horizontal' && (mark === 'bar' || mark === 'tick' || mark === 'area');
  const PL = yAxis !== null && yAxis['labels'] !== false ? 44 : 4;
  const PB = xAxis !== null && xAxis['labels'] !== false ? 22 : 4;
  const PT = 8; const PR = 10;
  const iw = Math.max(20, W - PL - PR); const ih = Math.max(20, H - PT - PB);
  const bandMark = mark === 'bar' || mark === 'tick' || mark === 'rect' || mark === 'text';
  const xValues = layers.flatMap((l) => { const f = fieldNameOf(l.x); return f === null ? [] : l.rows.map((r) => r[f]); });
  const yValues = layers.flatMap((l) => { const f = fieldNameOf(l.y); return f === null ? [] : l.rows.map((r) => r[f]); });
  const xValues2 = layers.flatMap((l) => { const f = fieldNameOf(l.x2); return f === null ? [] : l.rows.map((r) => r[f]); });
  const yValues2 = layers.flatMap((l) => { const f = fieldNameOf(l.y2); return f === null ? [] : l.rows.map((r) => r[f]); });
  const xKind: Scale['kind'] = horizontal ? inferKind(main?.x ?? null, xValues, false) : inferKind(main?.x ?? null, xValues, bandMark || mark === 'rect');
  const yKind: Scale['kind'] = horizontal ? 'band' : mark === 'rect' ? 'band' : inferKind(main?.y ?? null, yValues, false);
  const stackMode = props['stack'] === undefined ? 'zero' : props['stack'];
  const stacked = (mark === 'bar' || mark === 'area') && stackMode !== false;
  // Stacks: rows sharing a category pile by series order; the y domain then spans the piles.
  const stacks = new Map<string, number>();
  const stackedRows: Array<{ layer: LayerSpec; row: Row; y0: number; y1: number }> = [];
  let yValuesForScale: unknown[] = [...yValues, ...yValues2];
  const catField = (l: LayerSpec): string | null => fieldNameOf(horizontal ? l.y : l.x);
  const valField = (l: LayerSpec): string | null => fieldNameOf(horizontal ? l.x : l.y);
  if (stacked) {
    yValuesForScale = [];
    const totals = new Map<string, number>();
    for (const l of layers) {
      const cf = catField(l); const vf = valField(l);
      if (cf === null || vf === null) continue;
      if (stackMode === 'normalize') for (const r of l.rows) totals.set(displayValue(r[cf]), (totals.get(displayValue(r[cf])) ?? 0) + Math.abs(num(r[vf]) ?? 0));
      for (const r of l.rows) {
        const cat = displayValue(r[cf]);
        const raw = num(r[vf]) ?? 0;
        const v = stackMode === 'normalize' ? (totals.get(cat) ?? 1) === 0 ? 0 : raw / (totals.get(cat) ?? 1) : raw;
        const y0 = stacks.get(cat) ?? 0;
        const y1 = y0 + v;
        stacks.set(cat, y1);
        stackedRows.push({ layer: l, row: r, y0, y1 });
        yValuesForScale.push(y0, y1);
      }
    }
    if (stackMode === 'center') {
      const maxTotal = Math.max(0, ...stacks.values());
      for (const s of stackedRows) { const shift = (maxTotal - (stacks.get(displayValue(s.row[catField(s.layer) as string])) ?? 0)) / 2; s.y0 += shift; s.y1 += shift; }
      yValuesForScale = stackedRows.flatMap((s) => [s.y0, s.y1]);
    }
  }
  const xScaleValues = horizontal ? [...yValues, ...(stacked ? yValuesForScale : []), ...xValues2] : [...xValues, ...xValues2];
  const yScaleValues = horizontal ? xValues : (stacked ? yValuesForScale : yValuesForScale);
  const xCh = horizontal ? main?.y ?? null : main?.x ?? null;
  const yCh = horizontal ? main?.x ?? null : main?.y ?? null;
  const zeroX = horizontal && (mark === 'bar' || mark === 'area' || mark === 'tick');
  const zeroY = !horizontal && (mark === 'bar' || mark === 'area' || mark === 'tick');
  const xs = buildScale(xKind, xScaleValues, [PL, PL + iw], { zero: xCh?.scale?.zero ?? zeroX, nice: xCh?.scale?.nice, domain: xCh?.scale?.domain, sort: xCh?.sort, format: xCh?.format ?? str(props['format']) ?? undefined, count: Math.max(2, Math.floor(iw / 90)) });
  const ys = buildScale(yKind, yScaleValues, [PT + ih, PT], { zero: yCh?.scale?.zero ?? zeroY, nice: yCh?.scale?.nice, domain: yCh?.scale?.domain, sort: yCh?.sort, format: yCh?.format ?? str(props['format']) ?? undefined, count: Math.max(2, Math.floor(ih / 45)) });
  const kids: ReactNode[] = [];
  const keyOf = (): number => kids.length;
  // Grid and axes.
  const xTicks = xs.ticks(); const yTicks = ys.ticks();
  if (gridY) for (const t of yTicks) kids.push(createElement('line', { key: `gy${keyOf()}`, x1: PL, x2: PL + iw, y1: t.v, y2: t.v, stroke: colorCss('chart-grid'), strokeWidth: 1 }));
  if (gridX) for (const t of xTicks) kids.push(createElement('line', { key: `gx${keyOf()}`, x1: t.v, x2: t.v, y1: PT, y2: PT + ih, stroke: colorCss('chart-grid'), strokeWidth: 1 }));
  if (yAxis !== null && yAxis['labels'] !== false) {
    const step = Math.max(1, Math.ceil(yTicks.length / Math.max(1, Math.floor(ih / 22))));
    yTicks.forEach((t, i) => { if (i % step === 0) kids.push(createElement('text', { key: `yl${keyOf()}`, x: PL - 6, y: t.v + 3, textAnchor: 'end', className: 'tk-axis-text' }, str(yAxis['format']) !== null && ys.kind !== 'band' ? formatNumber(Number(t.label.replace(/[^\d.-]/g, '')), yAxis['format'] as string) : truncateLabel(t.label, 9))); });
    if (yAxis['domain'] === true) kids.push(createElement('line', { key: 'yd', x1: PL, x2: PL, y1: PT, y2: PT + ih, stroke: colorCss('chart-axis') }));
  }
  if (xAxis !== null && xAxis['labels'] !== false) {
    const maxLabels = Math.max(2, Math.floor(iw / (xs.kind === 'band' ? 56 : 84)));
    const step = Math.max(1, Math.ceil(xTicks.length / maxLabels));
    const angle = num(xAxis['label-angle']) ?? 0;
    xTicks.forEach((t, i) => {
      if (i % step !== 0) return;
      const label = truncateLabel(t.label, Math.max(4, Math.floor((xs.kind === 'band' ? xs.band : 84) / 6.5)));
      kids.push(createElement('text', { key: `xl${keyOf()}`, x: t.v, y: H - 6, textAnchor: angle !== 0 ? 'end' : 'middle', className: 'tk-axis-text', transform: angle !== 0 ? `rotate(${angle} ${t.v} ${H - 6})` : undefined }, createElement('title', null, t.label), label));
    });
    if (xAxis['domain'] === true) kids.push(createElement('line', { key: 'xd', x1: PL, x2: PL + iw, y1: PT + ih, y2: PT + ih, stroke: colorCss('chart-axis') }));
  }
  if (xAxis !== null && typeof xAxis['title'] === 'string') kids.push(createElement('text', { key: 'xt', x: PL + iw / 2, y: H + 12, textAnchor: 'middle', className: 'tk-axis-text' }, xAxis['title']));
  if (yAxis !== null && typeof yAxis['title'] === 'string') kids.push(createElement('text', { key: 'yt', x: 10, y: PT + ih / 2, textAnchor: 'middle', className: 'tk-axis-text', transform: `rotate(-90 10 ${PT + ih / 2})` }, yAxis['title']));

  // Series: the color (or detail) column splits marks; each series takes the next scheme color.
  const legend: Array<{ label: string; color: string; dash: string }> = [];
  const seriesIndex = new Map<string, number>();
  const seriesOf = (l: LayerSpec, row: Row): { key: string; color: string; dash: string; index: number } => {
    const cf = l.color?.field ?? l.detail?.field ?? null;
    const fixed = l.color?.value !== undefined ? colorCss(l.color.value) : null;
    const key = cf !== null ? displayValue(row[cf]) : l.y?.field ?? l.query;
    let i = seriesIndex.get(key);
    if (i === undefined) { i = seriesIndex.size; seriesIndex.set(key, i); legend.push({ label: key, color: fixed ?? schemeColor(scheme, i), dash: SERIES_DASH[Math.min(i, 5)]! }); }
    return { key, color: fixed ?? schemeColor(scheme, i), dash: SERIES_DASH[Math.min(i, 5)]!, index: i };
  };
  const opacityOf = (l: LayerSpec, row: Row): number | undefined => (l.opacity?.value !== undefined ? num(l.opacity.value) ?? undefined : l.opacity?.field !== undefined ? num(row[l.opacity.field]) ?? undefined : undefined);
  const labels = props['labels'];
  const labelFmt = isObj(labels) ? str(labels['format']) : null;
  const cornerRadius = num(props['corner-radius']) ?? 0;
  const strokeWidth = num(props['stroke-width']) ?? 2;
  const dash = Array.isArray(props['stroke-dash']) ? props['stroke-dash'].join(' ') : null;
  const bandShare = num(props['band']) ?? 0.8;
  const animStyle = animate ? { transformBox: 'fill-box' as const } : undefined;
  let drawnAny = false;
  const orderedLayers = [...layers].sort((a, b) => markOrder(a.mark) - markOrder(b.mark));
  for (const l of orderedLayers) {
    const xf = fieldNameOf(l.x); const yf = fieldNameOf(l.y);
    const seriesGroups = new Map<string, Row[]>();
    for (const r of l.rows) { const s = seriesOf(l, r).key; const g = seriesGroups.get(s); if (g === undefined) seriesGroups.set(s, [r]); else g.push(r); }
    const zeroPx = horizontal ? xs.map(0) ?? PL : ys.map(0) ?? PT + ih;
    if (l.mark === 'bar' || l.mark === 'tick') {
      const groups = stackMode === false ? seriesGroups.size : 1;
      const catScale = horizontal ? ys : xs;
      const band = catScale.band > 0 ? catScale.band : (horizontal ? ih : iw) / Math.max(1, l.rows.length);
      const inner = band * (l.mark === 'tick' ? 0.5 : bandShare);
      const sub = inner / groups;
      let gi = 0;
      for (const [, rows] of seriesGroups) {
        for (const r of rows) {
          const s = seriesOf(l, r);
          const cat = catField(l); const vf = valField(l);
          if (cat === null || vf === null) continue;
          const st = stacked ? stackedRows.find((x) => x.row === r && x.layer === l) : null;
          const center = catScale.map(r[cat]);
          if (center === null) continue;
          const v0 = st !== null && st !== undefined ? st.y0 : 0;
          const v1 = st !== null && st !== undefined ? st.y1 : num(r[vf]) ?? 0;
          const valScale = horizontal ? xs : ys;
          const p0 = valScale.map(v0) ?? zeroPx; const p1 = valScale.map(v1) ?? zeroPx;
          const offset = -inner / 2 + gi * sub;
          const words = tooltipWords(r, l, [cat, vf]);
          drawnAny = true;
          if (l.mark === 'tick') {
            const t = 2;
            const attrsT = horizontal
              ? { x: p1 - t / 2, y: center - inner / 2, width: t, height: inner }
              : { x: center - inner / 2, y: p1 - t / 2, width: inner, height: t };
            kids.push(createElement('rect', { key: `t${keyOf()}`, ...attrsT, fill: s.color, opacity: opacityOf(l, r), className: pick !== null ? 'tk-pick' : undefined, onClick: pick !== null ? () => pick(r) : undefined }, words !== '' ? createElement('title', null, words) : null));
            continue;
          }
          const rectAttrs = horizontal
            ? { x: Math.min(p0, p1), y: center + offset, width: Math.max(1, Math.abs(p1 - p0)), height: Math.max(1, sub - (groups > 1 ? 1 : 0)) }
            : { x: center + offset, y: Math.min(p0, p1), width: Math.max(1, sub - (groups > 1 ? 1 : 0)), height: Math.max(1, Math.abs(p1 - p0)) };
          kids.push(createElement('rect', {
            key: `b${keyOf()}`, ...rectAttrs, rx: cornerRadius, fill: s.color, opacity: opacityOf(l, r),
            className: [animate ? (horizontal ? 'tk-grow-x' : 'tk-grow') : '', pick !== null ? 'tk-pick' : ''].filter((c) => c !== '').join(' ') || undefined,
            style: animStyle, onClick: pick !== null ? () => pick(r) : undefined,
          }, words !== '' ? createElement('title', null, words) : null));
          if (labels === true || isObj(labels)) {
            const text = formatNumber(v1 - v0, labelFmt ?? undefined);
            kids.push(horizontal
              ? createElement('text', { key: `bl${keyOf()}`, x: Math.max(p0, p1) + 4, y: center + offset + sub / 2 + 3, className: 'tk-mark-text' }, text)
              : createElement('text', { key: `bl${keyOf()}`, x: center + offset + sub / 2, y: Math.min(p0, p1) - 4, textAnchor: 'middle', className: 'tk-mark-text' }, text));
          }
        }
        gi++;
      }
      continue;
    }
    if (l.mark === 'rect') {
      const cf = fieldNameOf(l.color);
      const colorNums = cf !== null ? l.rows.map((r) => num(r[cf])).filter((v): v is number => v !== null) : [];
      const cmin = colorNums.length > 0 ? Math.min(...colorNums) : 0; const cmax = colorNums.length > 0 ? Math.max(...colorNums) : 1;
      for (const r of l.rows) {
        const cx = xf !== null ? xs.map(r[xf]) : null; const cy = yf !== null ? ys.map(r[yf]) : null;
        if (cx === null || cy === null) continue;
        const bw = xs.band > 0 ? xs.band : iw; const bh = ys.band > 0 ? ys.band : ih;
        const cv = cf !== null ? num(r[cf]) : null;
        const fill = cv !== null && colorNums.length > 0 ? schemeColor(scheme, 0) : seriesOf(l, r).color;
        const op = cv !== null && colorNums.length > 0 ? 0.15 + 0.85 * ((cv - cmin) / ((cmax - cmin) || 1)) : opacityOf(l, r);
        const words = tooltipWords(r, l, [xf ?? '', yf ?? '', cf ?? ''].filter((f) => f !== ''));
        drawnAny = true;
        kids.push(createElement('rect', { key: `r${keyOf()}`, x: cx - bw / 2 + 0.5, y: cy - bh / 2 + 0.5, width: Math.max(1, bw - 1), height: Math.max(1, bh - 1), rx: cornerRadius, fill, opacity: op, className: pick !== null ? 'tk-pick' : undefined, onClick: pick !== null ? () => pick(r) : undefined }, words !== '' ? createElement('title', null, words) : null));
        if ((labels === true || isObj(labels)) && cv !== null) kids.push(createElement('text', { key: `rl${keyOf()}`, x: cx, y: cy + 3, textAnchor: 'middle', className: 'tk-mark-text' }, formatNumber(cv, labelFmt ?? undefined)));
      }
      continue;
    }
    if (l.mark === 'line' || l.mark === 'area') {
      for (const [, rows] of seriesGroups) {
        const s = seriesOf(l, rows[0]!);
        const pts: Array<[number, number, Row]> = [];
        for (const r of rows) {
          const st = stacked && l.mark === 'area' ? stackedRows.find((x) => x.row === r && x.layer === l) : null;
          const px0 = xf !== null ? xs.map(r[xf]) : null;
          const py0 = st !== null && st !== undefined ? ys.map(st.y1) : yf !== null ? ys.map(r[yf]) : null;
          if (px0 === null || py0 === null) continue;
          pts.push([px0, py0, r]);
        }
        if (xs.kind !== 'band') pts.sort((a, b) => a[0] - b[0]);
        if (pts.length === 0) continue;
        drawnAny = true;
        const d = linePath(pts.map((p): [number, number] => [p[0], p[1]]), l.interpolate);
        if (l.mark === 'area') {
          const basePts: Array<[number, number]> = pts.map((p): [number, number] => {
            const st = stacked ? stackedRows.find((x) => x.row === p[2] && x.layer === l) : null;
            return [p[0], st !== null && st !== undefined ? ys.map(st.y0) ?? zeroPx : zeroPx];
          }).reverse();
          const area = `${d}${basePts.map((p) => `L${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join('')}Z`;
          kids.push(createElement('path', { key: `a${keyOf()}`, d: area, fill: s.color, opacity: opacityOf(l, rows[0]!) ?? (stacked && seriesGroups.size > 1 ? 0.85 : 0.22), className: animate ? 'tk-fade-in' : undefined }));
          if (l.line) kids.push(createElement('path', { key: `al${keyOf()}`, d, fill: 'none', stroke: s.color, strokeWidth, strokeLinejoin: 'round', strokeLinecap: 'round', strokeDasharray: dash ?? undefined }));
        } else {
          kids.push(createElement('path', { key: `l${keyOf()}`, d, fill: 'none', stroke: s.color, strokeWidth, strokeLinejoin: 'round', strokeLinecap: 'round', strokeDasharray: dash ?? (s.dash !== '' ? s.dash : undefined), pathLength: animate ? 1 : undefined, className: animate ? 'tk-trace' : undefined, opacity: opacityOf(l, rows[0]!) }));
        }
        if (l.point || pick !== null) {
          for (const p of pts) {
            const words = tooltipWords(p[2], l, [xf ?? '', yf ?? ''].filter((f) => f !== ''));
            kids.push(createElement('circle', { key: `lp${keyOf()}`, cx: p[0], cy: p[1], r: l.point ? 3 : 8, fill: l.point ? s.color : 'transparent', className: pick !== null ? 'tk-pick' : undefined, onClick: pick !== null ? () => pick(p[2]) : undefined }, words !== '' ? createElement('title', null, words) : null));
          }
        }
        if (labels === true || isObj(labels)) for (const p of pts) if (yf !== null) kids.push(createElement('text', { key: `ll${keyOf()}`, x: p[0], y: p[1] - 6, textAnchor: 'middle', className: 'tk-mark-text' }, formatNumber(num(p[2][yf]) ?? 0, labelFmt ?? undefined)));
      }
      continue;
    }
    if (l.mark === 'point' || l.mark === 'text') {
      const sizeNums = l.size?.field !== undefined ? l.rows.map((r) => num(r[l.size!.field as string])).filter((v): v is number => v !== null) : [];
      const smin = sizeNums.length > 0 ? Math.min(...sizeNums) : 0; const smax = sizeNums.length > 0 ? Math.max(...sizeNums) : 1;
      const shapes = new Map<string, string>();
      const SHAPES = ['circle', 'square', 'triangle', 'diamond', 'cross'];
      for (const r of l.rows) {
        const cx = xf !== null ? xs.map(r[xf]) : null; const cy = yf !== null ? ys.map(r[yf]) : null;
        if (cx === null || cy === null) continue;
        const s = seriesOf(l, r);
        drawnAny = true;
        const words = tooltipWords(r, l, [xf ?? '', yf ?? '', l.color?.field ?? ''].filter((f) => f !== ''));
        if (l.mark === 'text') {
          const tf = l.text?.field;
          const text = l.text?.value !== undefined ? displayValue(l.text.value) : tf !== undefined ? displayValue(r[tf]) : '';
          kids.push(createElement('text', { key: `tx${keyOf()}`, x: cx, y: cy + 3, textAnchor: 'middle', className: 'tk-mark-text', fill: s.color, style: { fill: s.color }, onClick: pick !== null ? () => pick(r) : undefined }, createElement('title', null, words), text));
          continue;
        }
        let radius = 3.5;
        if (l.size?.value !== undefined) radius = Math.sqrt(Math.max(1, num(l.size.value) ?? 12) / Math.PI);
        else if (l.size?.field !== undefined) { const v = num(r[l.size.field]); if (v !== null) radius = 3 + 9 * ((v - smin) / ((smax - smin) || 1)); }
        let shape = 'circle';
        if (l.shape?.value !== undefined) shape = displayValue(l.shape.value);
        else if (l.shape?.field !== undefined) { const key = displayValue(r[l.shape.field]); let sh = shapes.get(key); if (sh === undefined) { sh = SHAPES[shapes.size % SHAPES.length]!; shapes.set(key, sh); } shape = sh; }
        const common = { fill: s.color, opacity: opacityOf(l, r) ?? 0.85, className: [animate ? 'tk-fade-in' : '', pick !== null ? 'tk-pick' : ''].filter((c) => c !== '').join(' ') || undefined, onClick: pick !== null ? () => pick(r) : undefined };
        kids.push(shape === 'circle'
          ? createElement('circle', { key: `p${keyOf()}`, cx, cy, r: radius, ...common }, words !== '' ? createElement('title', null, words) : null)
          : createElement('path', { key: `p${keyOf()}`, d: symbolPath(shape, cx, cy, radius), ...common }, words !== '' ? createElement('title', null, words) : null));
        if ((labels === true || isObj(labels)) && yf !== null) kids.push(createElement('text', { key: `pl${keyOf()}`, x: cx + radius + 3, y: cy + 3, className: 'tk-mark-text' }, displayValue(r[yf])));
      }
      continue;
    }
    if (l.mark === 'rule') {
      const x2f = fieldNameOf(l.x2); const y2f = fieldNameOf(l.y2);
      for (const r of l.rows.length > 0 ? l.rows : [{}]) {
        const s = seriesOf(l, r);
        const x1 = xf !== null ? xs.map(r[xf]) : null; const y1 = yf !== null ? ys.map(r[yf]) : null;
        const x2 = x2f !== null ? xs.map(r[x2f]) : null; const y2 = y2f !== null ? ys.map(r[y2f]) : null;
        let line: { x1: number; x2: number; y1: number; y2: number } | null = null;
        if (x1 !== null && y1 !== null && y2 !== null) line = { x1, x2: x1, y1, y2 };
        else if (x1 !== null && y1 !== null && x2 !== null) line = { x1, x2, y1, y2: y1 };
        else if (x1 !== null && y1 === null) line = { x1, x2: x1, y1: PT, y2: PT + ih };
        else if (y1 !== null && x1 === null) line = { x1: PL, x2: PL + iw, y1, y2: y1 };
        else if (x1 !== null && y1 !== null) line = { x1, x2: x1, y1: PT + ih, y2: y1 };
        if (line === null) continue;
        drawnAny = true;
        const words = tooltipWords(r, l, [xf ?? '', yf ?? ''].filter((f) => f !== ''));
        kids.push(createElement('line', { key: `ru${keyOf()}`, ...line, stroke: s.color, strokeWidth, strokeDasharray: dash ?? undefined, opacity: opacityOf(l, r), strokeLinecap: 'round' }, words !== '' ? createElement('title', null, words) : null));
      }
    }
  }
  const svg = createElement('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, preserveAspectRatio: 'none', role: 'img', 'aria-label': str(props['title']) ?? `${mark} chart of ${query}`, 'data-mark': mark }, ...kids);
  return { svg, legend, empty: hasRows && drawnAny ? null : empty };
}

function markOrder(m: MarkKind): number {
  return m === 'rect' ? 0 : m === 'area' ? 1 : m === 'bar' ? 2 : m === 'tick' ? 3 : m === 'line' ? 4 : m === 'rule' ? 5 : m === 'point' ? 6 : 7;
}

function truncateLabel(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, Math.max(1, max - 1))}…` : s;
}

function drawArc(props: Rec, main: LayerSpec | null, W: number, H: number, scheme: unknown, empty: string, animate: boolean, pick: ((row: Row) => void) | null): Drawn {
  const rows = main?.rows ?? [];
  const tf = fieldNameOf(main?.theta ?? null);
  const cf = main?.color?.field ?? null;
  const rf = main?.radius?.field ?? null;
  const cx = W / 2; const cy = H / 2;
  const outerProp = num(props['outer-radius']);
  const R = outerProp ?? Math.max(10, Math.min(W, H) / 2 - 6);
  const inner = Math.min(R - 2, num(props['inner-radius']) ?? 0);
  const pad = ((num(props['pad-angle']) ?? 0) * Math.PI) / 180;
  const legend: Array<{ label: string; color: string; dash: string }> = [];
  const values = rows.map((r) => (tf !== null ? Math.max(0, num(r[tf]) ?? 0) : 0));
  const total = values.reduce((a, b) => a + b, 0);
  const kids: ReactNode[] = [];
  const radiusNums = rf !== null ? rows.map((r) => num(r[rf])).filter((v): v is number => v !== null) : [];
  const rmax = radiusNums.length > 0 ? Math.max(...radiusNums) : 1;
  // One color per category (rows sharing a category share a slice color and one legend entry).
  const categoryIndex = new Map<string, number>();
  let a = -Math.PI / 2;
  rows.forEach((r, i) => {
    const v = values[i] ?? 0;
    if (total <= 0 || v <= 0) return;
    const sweep = (v / total) * Math.PI * 2;
    const label = cf !== null ? displayValue(r[cf]) : `${i + 1}`;
    let ci = categoryIndex.get(label);
    const fresh = ci === undefined;
    if (ci === undefined) { ci = categoryIndex.size; categoryIndex.set(label, ci); }
    const color = main?.color?.value !== undefined ? colorCss(main.color.value) : schemeColor(scheme, ci);
    if (fresh) legend.push({ label, color, dash: '' });
    const r1 = rf !== null ? inner + (R - inner) * Math.sqrt(Math.max(0, num(r[rf]) ?? 0) / rmax) : R;
    const a0 = a + pad / 2; const a1 = a + sweep - pad / 2;
    if (a1 > a0) {
      const words = main !== null ? tooltipWords(r, main, [cf ?? '', tf ?? ''].filter((f) => f !== '')) : '';
      kids.push(createElement('path', { key: `s${i}`, d: arcPath(cx, cy, inner, r1, a0, a1), fill: color, className: [animate ? 'tk-fade-in' : '', pick !== null ? 'tk-pick' : ''].filter((c) => c !== '').join(' ') || undefined, onClick: pick !== null ? () => pick(r) : undefined }, words !== '' ? createElement('title', null, words) : null));
      if (props['labels'] === true || isObj(props['labels'])) {
        const mid = (a0 + a1) / 2; const lr = inner + (r1 - inner) * 0.6;
        kids.push(createElement('text', { key: `sl${i}`, x: cx + lr * Math.cos(mid), y: cy + lr * Math.sin(mid) + 3, textAnchor: 'middle', className: 'tk-mark-text' }, formatNumber(v, isObj(props['labels']) ? str(props['labels']['format']) ?? undefined : undefined)));
      }
    }
    a += sweep;
  });
  if (kids.length === 0) kids.push(createElement('path', { key: 'ring', d: arcPath(cx, cy, inner, R, -Math.PI / 2, Math.PI * 1.5 - 0.0001), fill: colorCss('chart-grid') }));
  const svg = createElement('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': str(props['title']) ?? 'arc chart', 'data-mark': 'arc' }, ...kids);
  return { svg, legend, empty: total > 0 ? null : empty };
}

function drawGauge(props: Rec, main: LayerSpec | null, W: number, H: number, scheme: unknown, empty: string): Drawn {
  const rows = main?.rows ?? [];
  const tf = fieldNameOf(main?.theta ?? null);
  const first = rows[0];
  const value = first !== undefined && tf !== null ? num(first[tf]) : null;
  const domain = main?.theta?.scale?.domain;
  const min = Array.isArray(domain) ? num(domain[0]) ?? 0 : 0;
  const max = Array.isArray(domain) ? num(domain[1]) ?? 100 : 100;
  const frac = value === null ? 0 : Math.max(0, Math.min(1, (value - min) / ((max - min) || 1)));
  let color = schemeColor(scheme, 0);
  if (Array.isArray(props['thresholds']) && value !== null) {
    for (const t of props['thresholds']) if (isObj(t) && num(t['up-to']) !== null && value <= (num(t['up-to']) as number)) { color = colorCss(t['color']); break; }
  }
  const cx = W / 2; const r = Math.max(20, Math.min(W / 2 - 8, H - 24));
  const cy = H / 2 + r / 2;
  const stroke = Math.max(6, Math.min(14, r / 5));
  const polar = (f: number): [number, number] => { const ang = Math.PI + f * Math.PI; return [cx + r * Math.cos(ang), cy + r * Math.sin(ang)]; };
  // A gauge sweeps at most a half circle, so the large-arc flag never sets.
  const arc = (f0: number, f1: number): string => { const [x0, y0] = polar(f0); const [x1, y1] = polar(f1); return `M${x0.toFixed(1)} ${y0.toFixed(1)}A${r} ${r} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`; };
  const kids: ReactNode[] = [
    createElement('path', { key: 'track', d: arc(0, 1), fill: 'none', stroke: colorCss('chart-grid'), strokeWidth: stroke, strokeLinecap: 'round' }),
  ];
  if (frac > 0.005) kids.push(createElement('path', { key: 'value', d: arc(0, frac), fill: 'none', stroke: color, strokeWidth: stroke, strokeLinecap: 'round', pathLength: 1, className: props['animation'] !== false ? 'tk-trace' : undefined }));
  const fmt = str(props['format']);
  kids.push(createElement('text', { key: 'v', x: cx, y: cy - 6, textAnchor: 'middle', className: 'tk-gauge-value' }, value === null ? '-' : formatNumber(value, fmt ?? undefined)));
  if (main?.theta?.title !== undefined) kids.push(createElement('text', { key: 'l', x: cx, y: cy + 14, textAnchor: 'middle', className: 'tk-axis-text' }, main.theta.title));
  const svg = createElement('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': str(props['title']) ?? 'gauge', 'data-mark': 'gauge' }, ...kids);
  return { svg, legend: [], empty: value === null ? empty : null };
}

// ---------------------------------------------------------------------------
// The mount: mountScene(host, input) renders the tree, owns the actions, and in edit mode reads geometry and
// reports the editor's events (Webstudio's canvas: the builder mounts the same renderer and reads real rects).
// ---------------------------------------------------------------------------

type Listener<K extends keyof EditorEvent> = (e: EditorEvent[K]) => void;

class Emitter {
  private map = new Map<string, Set<(e: unknown) => void>>();
  on<K extends keyof EditorEvent>(kind: K, fn: Listener<K>): () => void {
    const set = this.map.get(kind) ?? new Set();
    set.add(fn as (e: unknown) => void);
    this.map.set(kind, set);
    return () => { set.delete(fn as (e: unknown) => void); };
  }
  emit<K extends keyof EditorEvent>(kind: K, e: EditorEvent[K]): void {
    for (const fn of this.map.get(kind) ?? []) fn(e);
  }
  clear(): void { this.map.clear(); }
}

/** The fields an action collects: the action frame's own field descendants, else the nearest ancestor frame holding fields. */
function collectValues(store: SceneStore, nodeId: string, scope: Scope): { values: Record<string, unknown>; errors: Array<{ node: string; message: string }> } {
  const state = store.get();
  const fieldsUnder = (id: string): string[] => {
    const out: string[] = [];
    const walk = (n: string): void => {
      for (const c of state.index.childrenOf.get(n) ?? []) {
        if (state.index.prim.get(c.id)?.name === 'field') out.push(c.id);
        walk(c.id);
      }
    };
    walk(id);
    return out;
  };
  let holder: string | null = nodeId;
  let fields: string[] = [];
  while (holder !== null) {
    fields = fieldsUnder(holder);
    if (fields.length > 0) break;
    holder = state.index.nodes[holder]?.parent ?? null;
  }
  const values: Record<string, unknown> = {};
  const errors: Array<{ node: string; message: string }> = [];
  if (scope.row !== undefined) for (const [k, v] of Object.entries(scope.row)) values[k] = v;
  for (const id of fields) {
    const prim = state.index.prim.get(id);
    if (prim === undefined) continue;
    const props = resolveProps(state, prim, scope);
    const name = str(props['name']) ?? id;
    const kind = str(props['kind']) ?? 'text';
    const value = fieldValueOf(props, state.channels.get(channelKey(id, 'value', scope)), state, scope);
    const err = fieldError(props, value);
    if (err !== null) errors.push({ node: id, message: err });
    if (kind === 'date-range' && isObj(value)) { values[`${name}-from`] = value['from'] ?? ''; values[`${name}-to`] = value['to'] ?? ''; }
    else values[name] = value;
  }
  return { values, errors };
}

/** A runtime without a host: what a server render or a trace hands to <Scene> (the same tree mountScene renders). */
export function createSceneRuntime(input: SceneInput): Runtime {
  const store = new SceneStore(input);
  const mode = input.mode ?? 'serve';
  return {
    store, host: null, mode, editor: mode === 'edit', scope: '',
    fire: () => undefined, nav: (scene, key) => input.onNav?.(scene, key), setOpen: (node, open) => store.setChannel(`${node}.open`, open === 'toggle' ? true : open),
  };
}

export function mountScene(host: HTMLElement, input: SceneInput): SceneMount {
  const store = new SceneStore(input);
  const emitter = new Emitter();
  const mode = input.mode ?? 'serve';
  host.classList.add('tk-host');
  if (mode === 'edit') host.setAttribute('data-tk-editor', '');
  if (typeof input.breakpoint === 'string') host.setAttribute('data-tk-bp', input.breakpoint);
  const scopeId = `tks${++mountSeq}`;
  host.setAttribute('data-tk-scope', scopeId);
  const onAction = input.onAction;
  const onNav = input.onNav;

  const setOpen = (node: string, open: boolean | 'toggle', scope?: Scope): void => {
    const state = store.get();
    const key = channelKey(node, 'open', scope ?? TOP);
    const cur = state.channels.get(key) ?? state.channels.get(`${node}.open`);
    const was = cur !== undefined ? cur === true : channelDefault(state, node, 'open') === true;
    const next = open === 'toggle' ? !was : open;
    store.setChannel(key, next);
    // An exclusive parent keeps one child open at a time.
    const parentId = state.index.nodes[node]?.parent;
    const parent = parentId !== undefined && parentId !== null ? state.index.prim.get(parentId) : undefined;
    if (next && parent !== undefined && parent.payload['exclusive'] === true && parentId !== null && parentId !== undefined) {
      for (const sib of state.index.childrenOf.get(parentId) ?? []) {
        if (sib.id === node || state.index.prim.get(sib.id)?.name !== 'frame') continue;
        store.setChannel(channelKey(sib.id, 'open', scope ?? TOP), false);
      }
    }
  };

  const nav = (scene: string, key?: string): void => { onNav?.(scene, key); };

  const runAction = (action: Rec, nodeId: string, scope: Scope, element: HTMLElement | null): void => {
    if (typeof action['run'] === 'string') {
      const { values, errors } = collectValues(store, nodeId, scope);
      for (const id of Object.keys(store.get().index.nodes)) if (store.get().index.prim.get(id)?.name === 'field') store.setChannel(channelKey(id, 'error', scope), null);
      if (errors.length > 0) {
        for (const e of errors) store.setChannel(channelKey(e.node, 'error', scope), e.message);
        return;
      }
      const withParams = isObj(action['with']) ? action['with'] : {};
      store.clearResult(action['run']);
      onAction?.(action['run'], { ...values, ...withParams }, nodeId);
      return;
    }
    if (typeof action['goto'] === 'string') {
      const keyCol = str(action['key']);
      const key = keyCol !== null && scope.row !== undefined ? displayValue(scope.row[keyCol]) : undefined;
      nav(action['goto'], key);
      return;
    }
    if (typeof action['href'] === 'string') {
      if (action['new-tab'] === true) window.open(action['href'], '_blank', 'noopener');
      else window.location.assign(action['href']);
      return;
    }
    if (typeof action['open'] === 'string') { setOpen(action['open'], true, scope); return; }
    if (action['close'] === true) {
      // Closes the nearest anchored or closable ancestor of the firing node.
      let cur: string | null = nodeId;
      const state = store.get();
      while (cur !== null) {
        const p = state.index.prim.get(cur);
        if (p !== undefined && p.name === 'frame' && (isObj(p.payload['anchor']) || p.payload['open'] !== undefined) && cur !== nodeId) { setOpen(cur, false, scope); return; }
        cur = state.index.nodes[cur]?.parent ?? null;
      }
      return;
    }
    if (typeof action['close'] === 'string') { setOpen(action['close'], false, scope); return; }
    if (typeof action['toggle'] === 'string') { setOpen(action['toggle'], 'toggle', scope); return; }
    if (typeof action['copy'] === 'string') {
      void navigator.clipboard?.writeText(action['copy']);
      if (element !== null) { element.setAttribute('data-copied', ''); window.setTimeout(() => element.removeAttribute('data-copied'), 1500); }
    }
  };

  const fire = (nodeId: string, scope: Scope, element: HTMLElement | null): void => {
    const state = store.get();
    const prim = state.index.prim.get(nodeId);
    if (prim === undefined) return;
    const props = resolveProps(state, prim, scope);
    const action = prim.name === 'field' ? props['on-change'] : prim.name === 'chart' ? props['on-pick'] : props['action'];
    if (!isObj(action) || props['disabled'] === true) return;
    runAction(action, nodeId, scope, element);
  };

  const runtime: Runtime = { store, host, mode, fire, nav, setOpen, editor: mode === 'edit', scope: `[data-tk-scope="${scopeId}"]` };
  const root: Root = createRoot(host);
  root.render(createElement(Scene, { runtime }));

  const editor = mode === 'edit' ? attachEditor(host, store, emitter, fire, input.hostEvents === true) : null;

  const measure = (): EditorEvent['rects'] => measureHost(host);
  const mount: SceneMount = {
    update(patch) {
      if (patch.document !== undefined) store.setDocument(patch.document, patch.library);
      else if (patch.library !== undefined) store.setDocument(store.get().index.doc, patch.library);
      if (patch.data !== undefined) store.setData(patch.data);
      if (patch.theme !== undefined) store.setTheme(patch.theme);
      if (patch.designWidth !== undefined) store.setDesignWidth(patch.designWidth);
    },
    setRows: (binding, rows, text, tick) => store.setRows(binding, rows, text, tick),
    setError: (binding, message) => store.setError(binding, message),
    notice: (text) => store.setNotice(text),
    applyEffects: (effects) => {
      for (const fx of effects) {
        if (fx.kind === 'goto') nav(fx.scene);
        else if (fx.kind === 'message') store.setNotice(fx.text);
        else if (fx.kind === 'overlay') setOpen(fx.node, fx.open);
        else if (fx.kind === 'answer') {
          store.setChannel(`flow.answer.${fx.key}`, fx.value);
          store.setRows('flow.answer', [{ key: fx.key, value: fx.value }], null);
        }
      }
    },
    setChannel: (key, value) => store.setChannel(key, value),
    setOpen: (node, open) => setOpen(node, open),
    fire: (node) => fire(node, scopeOfElement(host, node), host.querySelector(`[data-node="${node}"]`)),
    setBreakpoint(bp) {
      if (bp === null) host.removeAttribute('data-tk-bp'); else host.setAttribute('data-tk-bp', bp);
      store.setBreakpoint(bp);
    },
    actionResult: (name, ok, failures) => store.setResult(name, ok, failures),
    measure,
    hitTest: (x, y) => hitTestHost(host, x, y),
    elementOf: (node) => host.querySelector<HTMLElement>(`[data-node="${node}"]`),
    on: (kind, fn) => emitter.on(kind, fn),
    editText: (node) => editor?.editText(node),
    editCommand: (cmd, link) => editor?.command(cmd, link),
    unmount() {
      editor?.stop();
      root.unmount();
      store.dispose();
      emitter.clear();
      host.classList.remove('tk-host');
      host.removeAttribute('data-tk-editor');
      host.removeAttribute('data-tk-scope');
      host.removeAttribute('data-tk-bp');
    },
  };
  return mount;
}

let mountSeq = 0;

/** Every rendered primitive registers the scope it rendered in, so a fire by node id finds its row. */
const ELEMENT_SCOPE = new WeakMap<Element, Scope>();
function useScopeRef(ref: { current: HTMLElement | null }, scope: Scope): void {
  useLayoutEffect(() => { if (ref.current !== null) ELEMENT_SCOPE.set(ref.current, scope); });
}

/** The scope an element renders in: the row its nearest repeated ancestor carried. */
function scopeOfElement(host: HTMLElement, node: string): Scope {
  const el = host.querySelector(`[data-node="${node}"]`);
  return el !== null ? ELEMENT_SCOPE.get(el) ?? TOP : TOP;
}

function measureHost(host: HTMLElement): EditorEvent['rects'] {
  const rects: NodeRect[] = [];
  const seen = new Set<string>();
  let bottom = 0;
  for (const el of host.querySelectorAll<HTMLElement>('[data-node]')) {
    const id = el.getAttribute('data-node');
    if (id === null) continue;
    const r = el.getBoundingClientRect();
    if (r.bottom > bottom) bottom = r.bottom;
    if (seen.has(id)) continue;
    seen.add(id);
    const rect: NodeRect = { node: id, x: r.x, y: r.y, w: r.width, h: r.height };
    const br = getComputedStyle(el).borderRadius;
    if (br !== '' && br !== '0px') rect.r = br;
    rects.push(rect);
  }
  const body = document.body !== null ? document.body.getBoundingClientRect().height : 0;
  return { rects, vw: window.innerWidth, vh: window.innerHeight, ch: Math.ceil(Math.max(body, bottom)) };
}

function hitTestHost(host: HTMLElement, x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y);
  if (!(el instanceof Element) || !host.contains(el)) return null;
  return el.closest('[data-node]')?.getAttribute('data-node') ?? null;
}

// ---------------------------------------------------------------------------
// The editor: geometry reports, clicks that select instead of act, hold-drag draws, inline text editing.
// ---------------------------------------------------------------------------

interface Editor { stop(): void; editText(node: string): void; command(cmd: string, link?: string): void; ping(): void; fireNode(node: string): void }

const INTERACTIVE = 'button,a,input,select,textarea,label,[contenteditable]';

function attachEditor(host: HTMLElement, store: SceneStore, emitter: Emitter, fire: (node: string, scope: Scope, el: HTMLElement | null) => void, hostEvents = false): Editor {
  let last = '';
  let raf = 0;
  let stopped = false;
  let draw: { sx: number; sy: number; on: boolean } | null = null;
  let drew = false;
  let mx = 0; let my = 0; let moveQueued = false;
  let editing: { node: string; el: HTMLElement; rich: boolean } | null = null;
  let bypass = false;

  const report = (force = false): void => {
    const m = measureHost(host);
    const key = `${JSON.stringify(m.rects)}:${m.ch}`;
    if (force || key !== last) { last = key; emitter.emit('rects', m); }
  };
  const tick = (): void => {
    if (stopped) return;
    report();
    raf = window.requestAnimationFrame(tick);
  };
  raf = window.requestAnimationFrame(tick);

  const inEditing = (ev: Event): boolean => editing !== null && ev.target instanceof Node && editing.el.contains(ev.target);
  const nodeOf = (target: EventTarget | null): string | null => (target instanceof Element ? target.closest('[data-node]')?.getAttribute('data-node') ?? null : null);
  const drawRect = (): { x: number; y: number; w: number; h: number } => ({ x: Math.min(draw!.sx, mx), y: Math.min(draw!.sy, my), w: Math.abs(mx - draw!.sx), h: Math.abs(my - draw!.sy) });

  const onClick = (ev: MouseEvent): void => {
    if (inEditing(ev) || bypass) return;
    if (ev.altKey) {
      const id = nodeOf(ev.target);
      if (id === null) return;
      ev.preventDefault(); ev.stopPropagation();
      for (const el of host.querySelectorAll('[data-tk-hit]')) el.removeAttribute('data-tk-hit');
      (ev.target as Element).closest('[data-node]')?.setAttribute('data-tk-hit', '');
      emitter.emit('inspect', { node: id });
      return;
    }
    if (drew) { ev.preventDefault(); ev.stopPropagation(); return; }
    const target = ev.target instanceof Element ? ev.target : null;
    const id = nodeOf(target);
    const ctrl = ev.ctrlKey || ev.metaKey;
    const field = target?.closest('input,select,textarea,label,[contenteditable]') ?? null;
    const actionish = target?.closest('button,a') ?? null;
    if (field !== null) { emitter.emit('hit', { node: id, interactive: true, ctrl }); return; }
    if (actionish !== null) {
      if (ctrl) { emitter.emit('hit', { node: id, interactive: true, ctrl: true }); return; }
      ev.preventDefault(); ev.stopPropagation();
      emitter.emit('hit', { node: id, interactive: true, actionish: true });
      return;
    }
    ev.preventDefault(); ev.stopPropagation();
    emitter.emit('hit', { node: id, x: ev.clientX, y: ev.clientY, shift: ev.shiftKey });
  };
  const onDbl = (ev: MouseEvent): void => {
    if (inEditing(ev) || ev.altKey) return;
    const id = nodeOf(ev.target);
    if (id !== null) emitter.emit('hit', { node: id, dbl: true });
  };
  const onMenu = (ev: MouseEvent): void => {
    if (inEditing(ev)) return;
    ev.preventDefault(); ev.stopPropagation();
    emitter.emit('hit', { node: nodeOf(ev.target), menu: true, x: ev.clientX, y: ev.clientY });
  };
  const onMove = (ev: MouseEvent): void => {
    mx = ev.clientX; my = ev.clientY;
    if (!moveQueued) {
      moveQueued = true;
      window.requestAnimationFrame(() => { moveQueued = false; emitter.emit('move', { x: mx, y: my }); });
    }
    if (draw !== null) {
      if (!draw.on && Math.hypot(mx - draw.sx, my - draw.sy) >= 8) { draw.on = true; emitter.emit('draw', { phase: 'start', x: draw.sx, y: draw.sy, w: 0, h: 0 }); }
      if (draw.on) emitter.emit('draw', { phase: 'move', ...drawRect() });
    }
  };
  const onLeave = (): void => emitter.emit('move', null);
  const onDown = (ev: MouseEvent): void => {
    if (inEditing(ev) || ev.button !== 0 || ev.altKey || bypass) return;
    if (ev.target instanceof Element && ev.target.closest(INTERACTIVE) !== null) return;
    draw = { sx: ev.clientX, sy: ev.clientY, on: false };
  };
  const onUp = (): void => {
    if (draw === null) return;
    if (draw.on) { emitter.emit('draw', { phase: 'end', ...drawRect() }); drew = true; window.setTimeout(() => { drew = false; }, 0); }
    draw = null;
  };
  const onWheel = (ev: WheelEvent): void => { if (draw !== null && draw.on) ev.preventDefault(); };
  const onKey = (ev: KeyboardEvent): void => {
    if (editing === null) return;
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); endEdit(false); }
    else if (ev.key === 'Enter' && !editing.rich && !ev.shiftKey) { ev.preventDefault(); ev.stopPropagation(); endEdit(true); }
  };
  const onFocusOut = (ev: FocusEvent): void => { if (editing !== null && ev.target === editing.el) endEdit(true); };
  const onSelection = (): void => {
    if (editing === null) return;
    const sel = getSelection();
    const has = sel !== null && sel.rangeCount > 0 && !sel.isCollapsed && sel.anchorNode !== null && editing.el.contains(sel.anchorNode);
    if (!has) { emitter.emit('sel', null); return; }
    const r = sel.getRangeAt(0).getBoundingClientRect();
    emitter.emit('sel', { node: editing.node, x: r.x, y: r.y, w: r.width, h: r.height });
  };

  // A direct mount (hostEvents) leaves every pointer event to the host page; the text-editing keys stay on the host element.
  const opts = { capture: true };
  const keyTarget: EventTarget = hostEvents ? host : document;
  if (!hostEvents) {
    document.addEventListener('click', onClick, opts);
    document.addEventListener('dblclick', onDbl, opts);
    document.addEventListener('contextmenu', onMenu, opts);
    document.addEventListener('mousemove', onMove, opts);
    document.addEventListener('mouseleave', onLeave, opts);
    document.addEventListener('mousedown', onDown, opts);
    document.addEventListener('mouseup', onUp, opts);
    document.addEventListener('wheel', onWheel, { capture: true, passive: false });
  }
  keyTarget.addEventListener('keydown', onKey as EventListener, opts);
  keyTarget.addEventListener('focusout', onFocusOut as EventListener, opts);
  document.addEventListener('selectionchange', onSelection);

  const editText = (node: string): void => {
    const el = host.querySelector<HTMLElement>(`[data-node="${node}"]`);
    if (el === null || editing !== null) return;
    const rich = el.querySelector('[data-tk-rich]') !== null;
    editing = { node, el, rich };
    el.setAttribute('contenteditable', 'true');
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  };
  const endEdit = (commit: boolean): void => {
    if (editing === null) return;
    const e = editing;
    editing = null;
    e.el.removeAttribute('contenteditable');
    const rich = e.el.querySelector<HTMLElement>('[data-tk-rich]') ?? (e.el.firstElementChild instanceof HTMLElement && e.el.firstElementChild.querySelector('b,strong,i,em,a,code,ul,ol,blockquote') !== null ? e.el.firstElementChild : null);
    const text = e.el.textContent ?? '';
    e.el.blur();
    emitter.emit('sel', null);
    if (!commit) emitter.emit('text', { node: e.node, cancel: true });
    else if (rich !== null) emitter.emit('text', { node: e.node, blocks: serializeBlocks(rich) });
    else emitter.emit('text', { node: e.node, text });
  };
  const command = (cmd: string, link?: string): void => {
    if (editing === null) return;
    const exec = (name: string, arg?: string): void => { document.execCommand(name, false, arg); };
    if (cmd === 'bold') exec('bold');
    else if (cmd === 'italic') exec('italic');
    else if (cmd === 'bullets') exec('insertUnorderedList');
    else if (cmd === 'numbers') exec('insertOrderedList');
    else if (cmd === 'quote') exec('formatBlock', 'blockquote');
    else if (cmd === 'code' || cmd === 'link') {
      const sel = getSelection();
      if (sel !== null && sel.rangeCount > 0 && !sel.isCollapsed) {
        const range = sel.getRangeAt(0);
        const wrap = document.createElement(cmd === 'code' ? 'code' : 'a');
        if (cmd === 'link') wrap.setAttribute('data-tkref', link ?? '');
        try { range.surroundContents(wrap); } catch { /* a range across elements stays as it is */ }
      }
    }
    editing.el.focus();
  };

  return {
    stop() {
      stopped = true;
      window.cancelAnimationFrame(raf);
      if (!hostEvents) {
        document.removeEventListener('click', onClick, opts);
        document.removeEventListener('dblclick', onDbl, opts);
        document.removeEventListener('contextmenu', onMenu, opts);
        document.removeEventListener('mousemove', onMove, opts);
        document.removeEventListener('mouseleave', onLeave, opts);
        document.removeEventListener('mousedown', onDown, opts);
        document.removeEventListener('mouseup', onUp, opts);
        document.removeEventListener('wheel', onWheel, opts);
      }
      keyTarget.removeEventListener('keydown', onKey as EventListener, opts);
      keyTarget.removeEventListener('focusout', onFocusOut as EventListener, opts);
      document.removeEventListener('selectionchange', onSelection);
    },
    editText, command,
    ping: () => report(true),
    fireNode(node) {
      bypass = true;
      try { fire(node, TOP, host.querySelector(`[data-node="${node}"]`)); } finally { bypass = false; }
      void store;
    },
  };
}

/** The edited DOM back to blocks and runs: adjacent same-flag runs merge, empty runs fall away. */
function serializeRuns(hostEl: Element): Array<Record<string, unknown>> {
  const out: Array<{ text: string; bold: boolean; italic: boolean; code: boolean; link: string | null }> = [];
  const walk = (n: Node, b: boolean, i: boolean, c: boolean): void => {
    for (const ch of n.childNodes) {
      if (ch.nodeType === Node.TEXT_NODE) { if (ch.textContent !== null && ch.textContent !== '') out.push({ text: ch.textContent, bold: b, italic: i, code: c, link: null }); continue; }
      if (!(ch instanceof Element)) continue;
      const tag = ch.tagName;
      if (tag === 'A') { out.push({ text: ch.textContent ?? '', bold: b, italic: i, code: c, link: ch.getAttribute('data-tkref') ?? ch.getAttribute('href') ?? '' }); continue; }
      walk(ch, b || tag === 'B' || tag === 'STRONG', i || tag === 'I' || tag === 'EM', c || tag === 'CODE');
    }
  };
  walk(hostEl, false, false, false);
  const merged: typeof out = [];
  for (const r of out) {
    const p = merged[merged.length - 1];
    if (p !== undefined && p.bold === r.bold && p.italic === r.italic && p.code === r.code && p.link === null && r.link === null) p.text += r.text;
    else merged.push({ ...r });
  }
  return merged.filter((r) => r.text !== '').map((r) => ({ text: r.text, ...(r.bold ? { bold: true } : {}), ...(r.italic ? { italic: true } : {}), ...(r.code ? { code: true } : {}), ...(r.link !== null && r.link !== '' ? { link: r.link } : {}) }));
}

function serializeBlocks(rich: Element): unknown[] {
  const out: unknown[] = [];
  for (const c of rich.children) {
    const tag = c.tagName;
    if (tag === 'UL' || tag === 'OL') { out.push({ kind: tag === 'OL' ? 'numbers' : 'bullets', items: [...c.querySelectorAll('li')].map(serializeRuns) }); continue; }
    if (tag === 'BLOCKQUOTE' || c.getAttribute('data-tkb') === 'quote') { out.push({ kind: 'quote', runs: serializeRuns(c) }); continue; }
    if (tag === 'PRE') { out.push({ kind: 'code', runs: [{ text: c.textContent ?? '' }] }); continue; }
    if (/^H[1-4]$/.test(tag)) { out.push({ kind: tag.toLowerCase(), runs: serializeRuns(c) }); continue; }
    out.push({ kind: 'p', runs: serializeRuns(c) });
  }
  if (out.length === 0) out.push({ kind: 'p', runs: serializeRuns(rich) });
  return out;
}

// ---------------------------------------------------------------------------
// The port: the host page's one typed channel (the SceneScreen grammar the desktop speaks; the room feeder speaks it too).
// ---------------------------------------------------------------------------

export interface PortMessage { type: string; [k: string]: unknown }

interface FeedPayload {
  document?: unknown;
  results?: Array<{ binding: string; rows?: unknown[]; text?: string | null; error?: string | null; tick?: number }>;
  library?: unknown;
  /** The design size the document was authored at; its width feeds the reflow. */
  targetScreen?: { w?: unknown } | null;
}

/** One live frame: a binding's fresh rows, or the effects of a run that settled after its answer. */
interface LiveFrame {
  kind?: unknown; binding?: unknown; rows?: unknown; text?: unknown; error?: unknown; tick?: unknown; effects?: unknown; status?: unknown; scene?: unknown;
}

function applyLiveFrame(mount: SceneMount, m: LiveFrame): void {
  if (m.kind === 'binding' && typeof m.binding === 'string') {
    if (typeof m.error === 'string' && m.error !== '') mount.setError(m.binding, m.error);
    else mount.setRows(m.binding, (Array.isArray(m.rows) ? m.rows : []) as Row[], typeof m.text === 'string' ? m.text : null, typeof m.tick === 'number' ? m.tick : undefined);
    return;
  }
  if (m.kind === 'effects') {
    if (m.status === 'failed') mount.notice(typeof m.error === 'string' ? m.error : 'the flow failed');
    else mount.applyEffects((Array.isArray(m.effects) ? m.effects : []) as SceneEffect[]);
  }
}

let activePort: { mount: SceneMount; apply: (m: PortMessage) => void } | null = null;

function applyFeed(mount: SceneMount, payload: FeedPayload): void {
  if (payload.document !== undefined) {
    const parsed = sceneDocumentSchema.safeParse(payload.document);
    if (parsed.success) mount.update({ document: parsed.data, ...(Array.isArray(payload.library) ? { library: payload.library as LibraryItem[] } : {}) });
  }
  const dw = payload.targetScreen?.w;
  if (typeof dw === 'number' && Number.isFinite(dw) && dw > 0) mount.update({ designWidth: dw });
  for (const r of payload.results ?? []) {
    if (typeof r.binding !== 'string') continue;
    if (typeof r.error === 'string' && r.error !== '') mount.setError(r.binding, r.error);
    else mount.setRows(r.binding, (Array.isArray(r.rows) ? r.rows : []) as Row[], r.text ?? null, typeof r.tick === 'number' ? r.tick : undefined);
  }
}

/** Mounts on the host and speaks the port grammar: 'init' carries the port; the engine answers 'ready' and takes the feed. */
export function connectScenePort(host: HTMLElement, opts: { mode: SceneMode }): SceneMount {
  let port: MessagePort | null = null;
  const post = (m: PortMessage): void => { port?.postMessage(m); };
  const mount = mountScene(host, {
    document: { schemaVersion: 1, revision: 0, nodes: { root: { id: 'root', parent: null, order: 'a', components: {} } } },
    mode: opts.mode,
    onAction: (name, values) => post({ type: 'action', name, values }),
    onNav: (scene, key) => post({ type: 'nav', scene, ...(key !== undefined ? { key } : {}) }),
  });
  const editor = opts.mode === 'edit';
  if (editor) {
    mount.on('rects', (e) => post({ type: 'edrects', rects: e.rects, slots: [], vw: e.vw, vh: e.vh, ch: e.ch }));
    mount.on('hit', (e) => post({ type: 'edhit', ...e }));
    mount.on('move', (e) => post(e === null ? { type: 'edmove', off: true } : { type: 'edmove', x: e.x, y: e.y }));
    mount.on('draw', (e) => post({ type: 'eddraw', ...e }));
    mount.on('text', (e) => post({ type: 'edtext', ...e }));
    mount.on('sel', (e) => post(e === null ? { type: 'edsel', sel: false } : { type: 'edsel', sel: true, ...e }));
  }
  mount.on('inspect', (e) => post({ type: 'hit', node: e.node }));
  const apply = (m: PortMessage): void => {
    switch (m.type) {
      case 'scene': applyFeed(mount, { document: m['document'], library: m['library'], targetScreen: m['targetScreen'] as FeedPayload['targetScreen'] }); break;
      case 'data': if (typeof m['binding'] === 'string') mount.setRows(m['binding'], (Array.isArray(m['rows']) ? m['rows'] : []) as Row[], typeof m['text'] === 'string' ? m['text'] : null, typeof m['tick'] === 'number' ? m['tick'] : undefined); break;
      case 'error': if (typeof m['binding'] === 'string') mount.setError(m['binding'], typeof m['message'] === 'string' ? m['message'] : 'the feed failed'); break;
      // The answer carries its effects back on the same port; goto rides the host's nav lane.
      case 'action:result':
        if (typeof m['name'] === 'string') mount.actionResult(m['name'], m['ok'] === true, Array.isArray(m['failures']) ? m['failures'].map(String) : []);
        if (Array.isArray(m['effects'])) mount.applyEffects(m['effects'] as SceneEffect[]);
        break;
      case 'effects': applyLiveFrame(mount, { kind: 'effects', effects: m['effects'], status: m['status'], error: m['error'] }); break;
      case 'notice': if (typeof m['text'] === 'string') mount.notice(m['text']); break;
      case 'overlay': if (typeof m['node'] === 'string') mount.setOpen(m['node'], m['open'] !== false); break;
      case 'channel': if (typeof m['key'] === 'string') mount.setChannel(m['key'], m['value']); break;
      case 'edping': { const r = mount.measure(); post({ type: 'edrects', rects: r.rects, slots: [], vw: r.vw, vh: r.vh, ch: r.ch }); break; }
      case 'edfire': if (typeof m['node'] === 'string') mount.fire(m['node']); break;
      case 'edtext': if (typeof m['node'] === 'string') mount.editText(m['node']); break;
      case 'edcmd': if (typeof m['cmd'] === 'string') mount.editCommand(m['cmd'], typeof m['link'] === 'string' ? m['link'] : undefined); break;
      default: break;
    }
  };
  window.addEventListener('message', (ev: MessageEvent) => {
    const data = ev.data as PortMessage | null;
    if (data === null || typeof data !== 'object') return;
    if (data.type === 'init' && ev.ports[0] !== undefined && port === null) {
      port = ev.ports[0];
      port.onmessage = (pm: MessageEvent) => { const m = pm.data as PortMessage | null; if (m !== null && typeof m === 'object' && typeof m.type === 'string') apply(m); };
      port.postMessage({ type: 'ready' });
      return;
    }
    // The host may also speak the editor controls over the window (the old shim's second door).
    if (typeof data.type === 'string' && data.type.startsWith('ed')) apply(data);
  }, true);
  activePort = { mount, apply };
  return mount;
}

/** A capture host feeds the mounted scene directly (the eyes, the mint preview); resolves after two paints. */
export function feedScene(payload: FeedPayload): Promise<boolean> {
  const active = activePort;
  if (active === null) return Promise.resolve(false);
  applyFeed(active.mount, payload);
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'undefined') { resolve(true); return; }
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
  });
}

// ---------------------------------------------------------------------------
// The room lane: a published page is its own host - it fetches the feed, opens the one live stream, posts its
// actions and applies the effects the answer carries. No inline script on the page.
// ---------------------------------------------------------------------------

export interface RoomConfig {
  app: string;
  scene: string;
  key?: string;
  /** The SSE route the page subscribes to; absent = no push. */
  live?: string;
  /** Changed-fired actions: an input change inside the named node (or anywhere) fires them after 500ms. */
  changed?: Array<{ name: string; node?: string }>;
}

const CHANGED_DEBOUNCE_MS = 500;

/** Reads the values the page's inputs hold, scoped to the nearest [data-scope] around the changed input. */
function changedValues(target: Element | null): Record<string, unknown> {
  const scope = target?.closest('[data-scope]') ?? document;
  const values: Record<string, unknown> = {};
  for (const ie of scope.querySelectorAll<HTMLInputElement>('[data-param]')) {
    const k = ie.dataset['param'];
    if (k === undefined) continue;
    const t = ie.dataset['ptype'];
    values[k] = t === 'boolean' ? ie.checked : t === 'number' ? (ie.value === '' ? undefined : Number(ie.value)) : t === 'json' ? (() => { try { return JSON.parse(ie.value) as unknown; } catch { return undefined; } })() : ie.value;
  }
  return values;
}

export function connectRoom(host: HTMLElement, cfg: RoomConfig): SceneMount {
  const q = (extra: Record<string, string | undefined>): string => {
    const p = new URLSearchParams({ app: cfg.app, scene: cfg.scene, ...(cfg.key !== undefined && cfg.key !== '' ? { key: cfg.key } : {}) });
    for (const [k, v] of Object.entries(extra)) if (v !== undefined) p.set(k, v);
    return p.toString();
  };
  const gens = new Map<string, number>();
  const post = (name: string, values: Record<string, unknown>): void => {
    const gen = (gens.get(name) ?? 0) + 1;
    gens.set(name, gen);
    void fetch('/api/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ app: cfg.app, name, values }) })
      .then(async (r) => (await r.json()) as { ok?: boolean; failures?: unknown; effects?: unknown; execution?: { status?: string; error?: string } })
      .then((res) => {
        if (gens.get(name) !== gen) return; // a newer fire discards the stale answer
        mount.actionResult(name, res.ok === true, Array.isArray(res.failures) ? res.failures.map(String) : []);
        if (Array.isArray(res.effects)) mount.applyEffects(res.effects as SceneEffect[]);
      })
      .catch(() => mount.actionResult(name, false, ['the app could not reach its server']));
  };
  const mount = mountScene(host, {
    document: { schemaVersion: 1, revision: 0, nodes: { root: { id: 'root', parent: null, order: 'a', components: {} } } },
    mode: 'serve',
    onAction: (name, values) => post(name, values),
    // A nav message may carry a row key: the path becomes /<scene>/<key>.
    onNav: (scene, key) => {
      if (scene === ':back') { history.back(); return; }
      window.location.assign(`/${encodeURIComponent(scene)}${key !== undefined && key !== '' ? `/${encodeURIComponent(key)}` : ''}`);
    },
  });
  // The first feed: the document and every binding once.
  void fetch(`/api/data?${q({})}`)
    .then(async (r) => (await r.json()) as FeedPayload)
    .then((feed) => applyFeed(mount, feed))
    .catch(() => mount.notice('the app could not load its data'));
  // The one open stream: binding deltas and late effects; the browser reconnects it on its own.
  if (cfg.live !== undefined && typeof EventSource !== 'undefined') {
    const es = new EventSource(`${cfg.live}?${q({})}`);
    const on = (ev: MessageEvent): void => {
      try { applyLiveFrame(mount, JSON.parse(String(ev.data)) as LiveFrame); } catch { /* a malformed frame is dropped */ }
    };
    es.addEventListener('binding', on as EventListener);
    es.addEventListener('effects', on as EventListener);
  }
  // Changed-fired actions: debounced input listeners fire like a button press.
  const changed = cfg.changed ?? [];
  if (changed.length > 0) {
    const timers = new Map<string, number>();
    const onInput = (ev: Event): void => {
      const t = ev.target as HTMLElement | null;
      if (t === null || t.dataset === undefined || t.dataset['param'] === undefined) return;
      for (const c of changed) {
        if (c.node !== undefined) {
          const owner = host.querySelector(`[data-node="${c.node}"]`);
          if (owner === null || (owner !== t && !owner.contains(t))) continue;
        }
        window.clearTimeout(timers.get(c.name));
        timers.set(c.name, window.setTimeout(() => post(c.name, changedValues(t)), CHANGED_DEBOUNCE_MS));
      }
    };
    document.addEventListener('input', onInput, true);
    document.addEventListener('change', onInput, true);
  }
  return mount;
}

/** The page boot: a script tag carrying data-mount mounts on that element; data-app makes it a room page, else the port host speaks. */
function bootFromScript(script: HTMLScriptElement): void {
  const id = script.dataset['mount'] ?? 'scene';
  const mode: SceneMode = script.dataset['mode'] === 'edit' ? 'edit' : 'serve';
  const d = script.dataset;
  const start = (): void => {
    const host = document.getElementById(id);
    if (host === null) return;
    if (d['app'] !== undefined && d['scene'] !== undefined) {
      let changed: RoomConfig['changed'];
      try { changed = d['changed'] !== undefined ? (JSON.parse(d['changed']) as RoomConfig['changed']) : undefined; } catch { changed = undefined; }
      connectRoom(host, { app: d['app'], scene: d['scene'], ...(d['key'] !== undefined ? { key: d['key'] } : {}), ...(d['live'] !== undefined ? { live: d['live'] } : {}), ...(changed !== undefined ? { changed } : {}) });
      return;
    }
    connectScenePort(host, { mode });
  };
  if (document.getElementById(id) !== null) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
}

if (typeof document !== 'undefined' && document.currentScript instanceof HTMLScriptElement && document.currentScript.dataset['mount'] !== undefined) {
  bootFromScript(document.currentScript);
}

export const TENTKIT_VERSION = '1.0.0';
