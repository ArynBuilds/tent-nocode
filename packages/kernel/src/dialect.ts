import type postgres from 'postgres';
import type { z } from 'zod';
import {
  NODE_ID_RE, PRIMITIVE_NAMES, STATE_NAMES, applyOpsToDocument, breakpointsOf, extractDeps, flowDocSchema, isPill,
  isPrimitiveName, nearestPrimitiveNames, nearestPropertyNames, channelRefParts, parseExpression, payloadSchema,
  primitiveOfNode, primitiveRef, propertiesOf, validateExpression,
  type FlowDoc, type Pill, type PrimitiveName, type SceneDocument, type SceneNode, type SceneOp,
} from '@nodeloom/core';
import { requireScene, getSceneDocument, getSceneBindings, slugify } from './scenes/store.js';
import { projectThemeSchema, THEME_COLOR_NAMES, type ProjectBrief, type ProjectTheme } from './projects.js';
import { listIntegrationDefs, type IntegrationDef } from './integrations/catalog.js';
import { resolveFlowStepDef, listFlowStepDefs } from './flows/registry.js';
import { checkStepParams, validateFlowDoc, type FlowFinding } from './flows/validate.js';
import type { FlowStepDef } from './flows/stepTypes.js';
import { getFlow } from './flows/store.js';
import { MAIN_FLOW } from './flows/authoring.js';
import { consentClassOf } from './consent.js';
import { compileCanvasBlock, loadCanvas, renderCanvasBlock, type CanvasDoor, type CanvasModel } from './canvasLens.js';

// THE DIALECT (AI-surface rebuild, Phase 7; ONE file by ruling - the 500-line law is waived).
// The model writes a compact constrained authoring syntax over the registries' vocabulary;
// a deterministic parser + walker (no eval) compiles it to the eleven-op grammar for screens
// and to the flow authoring verbs for flows. The dialect is a LENS, never storage: the
// document model regenerates as dialect text each turn; truth stays revisions/.tproject.
// Everything downstream is unchanged: gate, consent classes, receipts, revisions, runtime.

export const DIALECT_FIX_SENTENCE =
  'Fix only the errors relevant to the last request - leave untouched parts of the code alone.';

/** One design-lint finding keyed by LOCATION (screen|nodeId|componentKey|param): the same place
 * dedupes across edits while its message may change. The edit door's per-run tracker decides
 * what refuses; the compile itself never fails on a finding. */
export interface LintFinding { key: string; message: string }

/** THE finding constructor - every lint finding is minted here and nowhere else. */
function lintFinding(
  loc: { screen: string; nodeId?: string; componentKey?: string; param?: string }, message: string,
): LintFinding {
  return { key: `${loc.screen}|${loc.nodeId ?? ''}|${loc.componentKey ?? ''}|${loc.param ?? ''}`, message };
}

/** The compiled batch cap: the op grammar's own atomic ceiling. */
const OPS_CAP = 200;
const MAX_CODE_CHARS = 300_000;

// ---------------------------------------------------------------------------
// THE GRAMMAR - the one compact authoring syntax, both halves. This block is
// the teaching text the edit tool serves; the parser below accepts exactly this.
// ---------------------------------------------------------------------------

export const DIALECT_GRAMMAR = `SCREEN DIALECT (the whole screen, or a partial with 'in'):
  screen <slug>
  <primitive> <id> [in <parent-id>] [slot "<name>"] [when <set> = <option>] {
    key: value, key: value                 the node's properties - one primitive per node
    hover { key: value }                   a state block: hover | focus | pressed | disabled
    at phone { key: value }                a breakpoint block: a named width from the theme (phone, tablet)
    variants <set> { options: a, b; default: a; selected: a }
    ref <key> -> <node-id | scene:<slug>>
    <primitive> <child-id> { ... }         children nest inside a frame
    ...                                    a line of three dots = unlisted children stay untouched
  }
  The five primitives, routed by need: frame - any box, group, card, list or layout, and anything clickable
  (a button is a frame with an action) · text - any words, label, icon, or single live number (an expr with
  a format, never a chart) · field - collecting one value from the reader · chart - rows drawn as marks over
  a query · instance - placing a component you already minted (the library starts empty).
  Every property is typed - contract {names:['frame']} lists them with hints; the shared groups (fill,
  stroke, effects, size and space, position - x and y always, free, pin, cell, stick - motion, visibility,
  a11y) belong to every primitive.
  Values: "text", numbers, true/false/null, { objects }, [ arrays ],
  expr("sum('orders','total')") for a computed value, from("node.emit") to consume an emit.
  The text you submit IS the screen: a node you leave out is removed (unless a ... line keeps it);
  'frame x in parent { }' edits one region without echoing the rest; 'frame root { }' speaks the root.
  Ids are yours; slots and variant membership are set at creation and cannot change on a live node.
  A query is a table the screen line names with the query word; each, chart and a search field name it by its name.
FLOW DIALECT (the project's one working flow):
  flow main
  step <id> = <kind> { key: value, ... } [off]
  wire <from>[:port] -> <to>[:slot]
  pin <id> = [ { ...sample output item... } ]    declared sample outputs; a manual run substitutes them
  Param values may be pills: step("id","path"), trigger("path"), table("name","column"),
  input("param"), now(), today(), tmpl("Hi {{name}}", { name: step("id","path") }).
  Branches address the source port: wire gate:true -> save. New step ids may land renamed
  (the kernel mints by kind); the receipt names the real ids.
PROJECT DIALECT (the whole project as one document; read project returns it, edit takes it back):
  project "<name>"
  theme { background: "#..", foreground: "#..", card, cardForeground, cardRaised, muted, mutedForeground, primary, primaryForeground, accent, accentForeground, border, ring, green, amber, red, radius: 10, fontSans: "..", fontMono: "..", glow?, shadow?, signature: "..", density: ".." }
  table <name> { <col>: string|number|boolean, ... }        # rows are never shown; the count rides a comment
  screen <slug> "<Title>" [purpose "..."] [query <table>, ...] { <screen dialect statements> }
  flow main { <flow dialect statements> }
  trigger <id> = <kind> { <spec> } -> flow main at <step> | operation <name> { <inputs> }
                                   | call <service>.<endpoint> { <params> } | dispatch "<goal>" { ... }
  service <name> "<label>" { }
  chain <id> = <operation> { <inputs> }
  note "<text>"
  A block you leave out is removed for every KIND you mention (list one table and the unlisted tables go);
  a top-level ... line keeps everything unlisted; a kind you never mention is untouched.
  Write-only lines (never shown by read, one action each):
  rows <table> [ {...}, ... ]   (<=500 per edit)   |   replace rows <table> [ ... ]   (<=100)
  service <name> keys   |   call <service>.<endpoint> { <params> }   |   run <operation> { <inputs> }
  operation <name> { runtime: "wasm"|"native", code: "...", ioContract: { ... } }
  component <name> { <definition> }   |   import component "<path>"
  plan { tables: [...], screens: [...], flows: [...], services: [...], theme: { ... } }
  dispatch "<goal>" { role: "...", brief: "...", part "<text>": "<acceptance>", ... }
  mission { part "<text>": done "<evidence>" }
  export package "<name>" { scenes: [...], license: "...", workspacePath: "..." }   |   import package "<path>"
  mode ask|auto   |   settings { <patch> }   |   delete thread "<title words>"   |   create project "<name>" at "<path>"`;

// ---------------------------------------------------------------------------
// Tokenizer - shared by both halves. Line-oriented; '#' comments to end of line;
// a run of three dots is the keep-rest marker (its trailing prose is skipped).
// ---------------------------------------------------------------------------

type Tok =
  | { t: 'word'; v: string; line: number }
  | { t: 'str'; v: string; line: number }
  | { t: 'num'; v: number; line: number }
  | { t: 'p'; v: string; line: number }
  | { t: 'nl'; line: number }
  | { t: 'dots'; line: number }
  | { t: 'end'; line: number };

/** Strips the read lens's line-number prefixes so round trips are forgiving. */
function stripLineNumbers(code: string): string {
  return code.split('\n').map((l) => l.replace(/^\s*\d+\|\s?/, '')).join('\n');
}

function tokenize(src: string): Tok[] | string {
  const toks: Tok[] = [];
  let i = 0;
  let line = 1;
  const isWordStart = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  const isWordChar = (c: string): boolean => /[A-Za-z0-9_@.-]/.test(c);
  while (i < src.length) {
    const c = src[i]!;
    if (c === '\n') { toks.push({ t: 'nl', line }); line++; i++; continue; }
    if (c === '\r' || c === ' ' || c === '\t') { i++; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '.' && src[i + 1] === '.' && src[i + 2] === '.') {
      toks.push({ t: 'dots', line });
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '"' || c === "'") {
      let out = '';
      i++;
      for (;;) {
        if (i >= src.length) return `line ${line}: unterminated string`;
        const ch = src[i]!;
        if (ch === '\n') return `line ${line}: unterminated string (strings stay on one line)`;
        if (ch === '\\') {
          const esc = src[i + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === 'u') {
            const hex = src.slice(i + 2, i + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) return `line ${line}: bad \\u escape`;
            out += String.fromCharCode(parseInt(hex, 16));
            i += 4;
          } else out += esc ?? '';
          i += 2;
          continue;
        }
        if (ch === c) { i++; break; }
        out += ch;
        i++;
      }
      toks.push({ t: 'str', v: out, line });
      continue;
    }
    if (c === '-' && src[i + 1] === '>') { toks.push({ t: 'p', v: '->', line }); i += 2; continue; }
    if (/[0-9]/.test(c) || (c === '-' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^-?[0-9]+(\.[0-9]+)?/.exec(src.slice(i))!;
      toks.push({ t: 'num', v: Number(m[0]), line });
      i += m[0].length;
      continue;
    }
    if (isWordStart(c)) {
      let j = i;
      while (j < src.length && isWordChar(src[j]!)) {
        if (src[j] === '-' && src[j + 1] === '>') break;
        j++;
      }
      toks.push({ t: 'word', v: src.slice(i, j), line });
      i = j;
      continue;
    }
    if ('{}[]():,;='.includes(c)) { toks.push({ t: 'p', v: c, line }); i++; continue; }
    return `line ${line}: unexpected character '${c}'`;
  }
  toks.push({ t: 'end', line });
  return toks;
}

/** Thrown inside the parsers; caught at the compile door and turned into a plain error list. */
class DialectError extends Error {}
const err: (line: number, msg: string) => never = (line, msg) => { throw new DialectError(`line ${line}: ${msg}`); };

class Cursor {
  private pos = 0;
  constructor(private readonly toks: Tok[]) {}
  /** The trailing 'end' token repeats forever, so no read ever walks off the stream. */
  private at(p: number): Tok {
    return this.toks[Math.min(p, this.toks.length - 1)]!;
  }
  peek(skipNl = false): Tok {
    let p = this.pos;
    if (skipNl) while (this.at(p).t === 'nl') p++;
    return this.at(p);
  }
  next(skipNl = false): Tok {
    if (skipNl) while (this.at(this.pos).t === 'nl') this.pos++;
    const t = this.at(this.pos);
    if (this.pos < this.toks.length) this.pos++;
    return t;
  }
  expectP(v: string, what: string): void {
    const t = this.next(true);
    if (t.t !== 'p' || t.v !== v) err(t.line, `expected '${v}' ${what}`);
  }
  atP(v: string, skipNl = false): boolean {
    const t = this.peek(skipNl);
    return t.t === 'p' && t.v === v;
  }
  atWord(v: string, skipNl = false): boolean {
    const t = this.peek(skipNl);
    return t.t === 'word' && t.v === v;
  }
  /** The stream position and a token slice - the project half lifts a block's tokens out by these. */
  index(): number {
    return this.pos;
  }
  slice(from: number, to: number): Tok[] {
    return this.toks.slice(from, to);
  }
}

// ---------------------------------------------------------------------------
// Values - writer and parser. expr()/from() are the scene helpers; the pill
// helpers are the flow ones. Everything else is plain JSON-shaped literal.
// ---------------------------------------------------------------------------

const isExprShape = (v: unknown): v is { $expr: string } =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
  && typeof (v as Record<string, unknown>)['$expr'] === 'string';

const isChannelShape = (v: unknown): v is { from: string } => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return typeof r['from'] === 'string' && Object.keys(r).length === 1 && channelRefParts(r['from'] as string) !== null;
};

const bareKey = (k: string): string => (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(k) ? k : JSON.stringify(k));

/** Renders one param value as dialect text; deterministic, always one line. */
export function renderValue(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `[${v.map(renderValue).join(', ')}]`;
  if (isExprShape(v)) return `expr(${JSON.stringify(v.$expr)})`;
  if (isChannelShape(v)) return `from(${JSON.stringify(v.from)})`;
  if (isPill(v)) return renderPill(v);
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>);
    if (entries.length === 0) return '{}';
    return `{ ${entries.map(([k, x]) => `${bareKey(k)}: ${renderValue(x)}`).join(', ')} }`;
  }
  return 'null';
}

function renderPill(p: Pill): string {
  if (p.from === 'step') return `step(${JSON.stringify(p.step)}, ${JSON.stringify(p.path)})`;
  if (p.from === 'trigger') return `trigger(${JSON.stringify(p.path)})`;
  if (p.from === 'table') return `table(${JSON.stringify(p.table)}, ${JSON.stringify(p.column)})`;
  if (p.from === 'input') return `input(${JSON.stringify(p.param)})`;
  if (p.from === 'ambient') return p.name === 'now' ? 'now()' : 'today()';
  const slots = Object.entries(p.slots).map(([k, s]) => `${bareKey(k)}: ${renderPill(s as Pill)}`).join(', ');
  return `tmpl(${JSON.stringify(p.template)}${slots.length > 0 ? `, { ${slots} }` : ''})`;
}

type ValueCtx = 'scene' | 'flow' | 'plain';

function parseHelper(c: Cursor, name: string, line: number, ctx: ValueCtx): unknown {
  const args: unknown[] = [];
  if (ctx === 'plain') err(line, `'${name}(' is not allowed here - plain values only (text, numbers, true/false/null, { }, [ ])`);
  c.expectP('(', `after ${name}`);
  if (!c.atP(')', true)) {
    for (;;) {
      args.push(parseValue(c, ctx));
      if (c.atP(',', true)) { c.next(true); continue; }
      break;
    }
  }
  c.expectP(')', `closing ${name}(...)`);
  const strArg = (i: number, what: string): string => {
    const a = args[i];
    if (typeof a !== 'string') err(line, `${name}() takes ${what} as a quoted string`);
    return a as string;
  };
  if (ctx === 'scene') {
    if (name === 'expr') {
      const src = strArg(0, 'the expression');
      const parsed = parseExpression(src);
      if (!parsed.ok) err(line, `expr(): ${parsed.err}`);
      const deps = parsed.ok ? extractDeps(parsed.ast) : [];
      return deps.length > 0 ? { $expr: src, deps } : { $expr: src };
    }
    if (name === 'from') {
      const ref = strArg(0, "the emit ref ('node.emit')");
      if (channelRefParts(ref) === null) err(line, `from(): '${ref}' is not '<node>.<emit>'`);
      return { from: ref };
    }
    err(line, `'${name}(' is not a screen helper - the screen helpers are expr("...") and from("node.emit")`);
  }
  switch (name) {
    case 'step': {
      if (args.length === 1) {
        const joined = strArg(0, "'id.path'");
        const dot = joined.indexOf('.');
        if (dot <= 0 || dot === joined.length - 1) err(line, "step() with one argument takes 'id.path'");
        return { from: 'step', step: joined.slice(0, dot), path: joined.slice(dot + 1) };
      }
      return { from: 'step', step: strArg(0, 'the step id'), path: strArg(1, 'the field path') };
    }
    case 'trigger': return { from: 'trigger', path: strArg(0, 'the payload path') };
    case 'table': return { from: 'table', table: strArg(0, 'the table name'), column: strArg(1, 'the column') };
    case 'input': return { from: 'input', param: strArg(0, 'the input param') };
    case 'now': return { from: 'ambient', name: 'now' };
    case 'today': return { from: 'ambient', name: 'today' };
    case 'tmpl': {
      const template = strArg(0, 'the template');
      const slots = (args[1] ?? {}) as Record<string, unknown>;
      if (typeof slots !== 'object' || slots === null || Array.isArray(slots)) err(line, 'tmpl() slots are an object of pills');
      for (const [k, s] of Object.entries(slots)) {
        if (!isPill(s)) err(line, `tmpl() slot '${k}' must be a pill helper (step/trigger/table/input/now/today)`);
      }
      return { from: 'template', template, slots };
    }
    default:
      err(line, `'${name}(' is not a helper - the flow helpers are step, trigger, table, input, now, today, tmpl`);
  }
  return null;
}

function parseValue(c: Cursor, ctx: ValueCtx): unknown {
  const t = c.next(true);
  if (t.t === 'str') return t.v;
  if (t.t === 'num') return t.v;
  if (t.t === 'word') {
    if (t.v === 'true') return true;
    if (t.v === 'false') return false;
    if (t.v === 'null') return null;
    if (c.atP('(')) return parseHelper(c, t.v, t.line, ctx);
    err(t.line, `bare word '${t.v}' is not a value - quote text ("${t.v}") or call a helper`);
  }
  if (t.t === 'p' && t.v === '{') {
    const out: Record<string, unknown> = {};
    if (c.atP('}', true)) { c.next(true); return out; }
    for (;;) {
      const k = c.next(true);
      if (k.t !== 'word' && k.t !== 'str') err(k.line, 'expected a key inside { }');
      const key = String((k as { v: string | number }).v);
      c.expectP(':', `after key '${key}'`);
      out[key] = parseValue(c, ctx);
      if (c.atP(',') || c.atP(';')) { c.next(); continue; }
      if (c.peek().t === 'nl') {
        if (c.atP('}', true)) { c.next(true); return out; }
        continue;
      }
      c.expectP('}', 'closing the object');
      return out;
    }
  }
  if (t.t === 'p' && t.v === '[') {
    const out: unknown[] = [];
    if (c.atP(']', true)) { c.next(true); return out; }
    for (;;) {
      out.push(parseValue(c, ctx));
      if (c.atP(',', true)) { c.next(true); continue; }
      c.expectP(']', 'closing the array');
      return out;
    }
  }
  err(t.line, 'expected a value (string, number, true/false/null, { }, [ ], or a helper call)');
  return null;
}

/** Deep equality with the one special case: expression values compare by their $expr text. */
function deepEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (isExprShape(a) && isExprShape(b)) return a.$expr === b.$expr;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEq(x, b[i]));
  }
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = Object.keys(a as Record<string, unknown>);
    const kb = Object.keys(b as Record<string, unknown>);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEq((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

// ---------------------------------------------------------------------------
// SCENE GENERATOR - document -> dialect text. Deterministic: children per
// parent by (order, id) - ALL nodes, unselected variant members included, so
// a round trip can never drop them; properties in the contract's order, then
// the state and breakpoint blocks. Budget overflow emits the keep-rest marker
// with the reference token that re-opens the range.
// ---------------------------------------------------------------------------

/** All children of a parent (variant members included), authoring order. */
function allChildren(doc: SceneDocument, parentId: string): SceneNode[] {
  return Object.values(doc.nodes)
    .filter((n) => n.parent === parentId)
    .sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : a.id < b.id ? -1 : 1));
}

export interface SceneLensOptions {
  slug: string;
  /** Render this subtree only (partial view with 'in' anchoring); default whole screen. */
  rootId?: string;
  depth?: number;
  maxNodes?: number;
  /** Extra '# ...' header lines (the queries the screen names etc.). */
  header?: string[];
}

/** The property lines in the contract's order (own, then the shared groups); a key the contract lacks renders last so an older document still reads. */
function renderProps(name: PrimitiveName, payload: Record<string, unknown>): string {
  const order = Object.keys(propertiesOf(name));
  const rank = new Map(order.map((k, i) => [k, i]));
  return Object.entries(payload)
    .filter(([k]) => k !== 'states' && k !== 'at')
    .sort((a, b) => (rank.get(a[0]) ?? order.length) - (rank.get(b[0]) ?? order.length) || a[0].localeCompare(b[0]))
    .map(([k, v]) => `${bareKey(k)}: ${renderValue(v)}`)
    .join(', ');
}

/** The primitive a node speaks: the root with no components reads as a frame; another component is not readable here. */
function primitiveLine(node: SceneNode): { name: PrimitiveName; payload: Record<string, unknown> } | null {
  const p = primitiveOfNode(node);
  if (p !== null) return { name: p.name, payload: p.payload };
  if (Object.keys(node.components).length === 0 && node.id === 'root') return { name: 'frame', payload: {} };
  return null;
}

export function generateSceneDialect(
  doc: SceneDocument, opts: SceneLensOptions,
): { code: string; truncated: boolean } {
  const depthCap = Math.min(Math.max(opts.depth ?? 6, 1), 12);
  const budget = { left: Math.max(1, opts.maxNodes ?? 200), truncated: false };
  const lines: string[] = [`screen ${opts.slug}`];
  for (const h of opts.header ?? []) lines.push(`# ${h}`);

  /** The node's block: the head line with its properties, the state and breakpoint blocks, variants, refs, children. */
  const renderNode = (node: SceneNode, indent: string, depth: number, explicitParent: string | null): void => {
    const prim = primitiveLine(node);
    if (prim === null) {
      lines.push(`${indent}# ${node.id} carries '${Object.keys(node.components).join(', ')}' - not one of the five; it is unreadable here and leaving it out removes it`);
      return;
    }
    const head = [`${indent}${prim.name} ${node.id}`];
    if (explicitParent !== null) head.push(`in ${explicitParent}`);
    if (node.slot !== undefined) head.push(`slot ${JSON.stringify(node.slot)}`);
    if (node.variantOf !== undefined) head.push(`when ${node.variantOf.set} = ${node.variantOf.option}`);
    const props = renderProps(prim.name, prim.payload);
    const inner: string[] = [];
    const deeper = `${indent}  `;
    const states = isObj(prim.payload['states']) ? prim.payload['states'] : {};
    for (const st of STATE_NAMES) {
      const block = states[st];
      if (isObj(block)) inner.push(`${deeper}${st} { ${renderProps(prim.name, block)} }`);
    }
    const at = isObj(prim.payload['at']) ? prim.payload['at'] : {};
    for (const [bp, block] of Object.entries(at)) {
      if (isObj(block)) inner.push(`${deeper}at ${bp} { ${renderProps(prim.name, block)} }`);
    }
    for (const [set, decl] of Object.entries(node.variants ?? {})) {
      const sel = decl.selection ?? decl.default;
      inner.push(`${deeper}variants ${set} { options: ${decl.options.join(', ')}; default: ${decl.default}; selected: ${sel} }`);
    }
    for (const [key, target] of Object.entries(node.refs ?? {})) inner.push(`${deeper}ref ${key} -> ${target}`);
    const kids = allChildren(doc, node.id);
    const kidLines: (() => void)[] = [];
    if (kids.length > 0) {
      if (depth <= 0) {
        budget.truncated = true;
        inner.push(`${deeper}... ${kids.length} inside '${node.id}' stay untouched - read {scope:'screen', target:'${opts.slug}#${node.id}'}`);
      } else {
        let shown = 0;
        for (const kid of kids) {
          if (budget.left <= 0) {
            budget.truncated = true;
            kidLines.push(() => lines.push(`${deeper}... ${kids.length - shown} more under '${node.id}' stay untouched - read {scope:'screen', target:'${opts.slug}#${node.id}'}`));
            break;
          }
          budget.left--;
          shown++;
          kidLines.push(() => renderNode(kid, deeper, depth - 1, null));
        }
      }
    }
    if (inner.length === 0 && kidLines.length === 0) {
      lines.push(`${head.join(' ')} {${props.length > 0 ? ` ${props} ` : ' '}}`);
      return;
    }
    lines.push(`${head.join(' ')} {${props.length > 0 ? ` ${props}` : ''}`);
    lines.push(...inner);
    for (const k of kidLines) k();
    lines.push(`${indent}}`);
  };

  const rootId = opts.rootId ?? 'root';
  const root = doc.nodes[rootId];
  if (!root) return { code: lines.concat(`# no node '${rootId}' on this screen`).join('\n'), truncated: false };

  lines.push('');
  budget.left--;
  if (rootId === 'root') {
    renderNode(root, '', depthCap, null);
  } else {
    // Partial view: everything outside the subtree is explicitly kept; the block re-anchors with 'in'.
    lines.splice(lines.length - 1, 0, `... the rest of the screen stays untouched (partial view of '${rootId}')`);
    renderNode(root, '', depthCap, root.parent ?? 'root');
  }
  return { code: lines.join('\n'), truncated: budget.truncated };
}

/** Prefixes every line with its number, the read lens format the parser strips back off. */
export function numberLines(code: string): string {
  return code.split('\n').map((l, i) => `${String(i + 1).padStart(3)}| ${l}`).join('\n');
}

// ---------------------------------------------------------------------------
// SCENE PARSER - dialect text -> the target tree. No eval; a recursive-descent
// walk over the token stream. A node is '<primitive> <id> { properties, state
// and breakpoint blocks, children }'; 'in <parent>' re-anchors a block
// explicitly (partial edits); '...' marks unlisted children as kept.
// ---------------------------------------------------------------------------

interface TargetNode {
  id: string;
  primitive: PrimitiveName;
  /** The properties as written, states and at nested under their keys. */
  props: Record<string, unknown>;
  /** Explicit parent from 'in' - partial-edit anchoring; null = nested position decides. */
  explicitParent: string | null;
  slot?: string;
  variantOf?: { set: string; option: string };
  variants: Array<{ set: string; options: string[]; default: string; selected?: string; line: number }>;
  refs: Array<{ key: string; target: string; line: number }>;
  children: TargetNode[];
  keepRest: boolean;
  line: number;
  /** The line each property was written on - a refusal names it. */
  propLines: Record<string, number>;
  /** The implicit root's properties change only when 'frame root { }' is spoken. */
  written: boolean;
}

interface ParsedScene { slug: string | null; root: TargetNode }

const newTarget = (id: string, primitive: PrimitiveName, line: number): TargetNode => ({
  id, primitive, props: {}, explicitParent: null, variants: [], refs: [], children: [], keepRest: false, line, propLines: {}, written: id !== 'root',
});

/** 'scene' ':' 'home' re-joins to a scene ref; anything else is the word itself. */
function joinRefName(c: Cursor, first: string, line: number): string {
  if (c.atP(':')) {
    c.next();
    const tail = c.next();
    if (tail.t !== 'word') err(line, `expected a name after '${first}:'`);
    return `${first}:${(tail as { v: string }).v}`;
  }
  return first;
}

const STATE_SET: ReadonlySet<string> = new Set(STATE_NAMES);

export function parseSceneDialect(code: string): ParsedScene {
  if (code.length > MAX_CODE_CHARS) throw new DialectError(`the code is over ${MAX_CODE_CHARS} characters - edit one region with '<primitive> <id> in <parent>'`);
  const toks = tokenize(stripLineNumbers(code));
  if (typeof toks === 'string') throw new DialectError(toks);
  const c = new Cursor(toks);
  const root = newTarget('root', 'frame', 0);
  let slug: string | null = null;
  const stack: TargetNode[] = [root];
  const seen = new Set<string>(['root']);
  const wordAt = (t: Tok): string | null => (t.t === 'word' ? t.v : null);

  /** A brace block of 'key: value' lines - a state or breakpoint block. */
  const parseBlock = (what: string, line: number): Record<string, unknown> => {
    c.expectP('{', `opening ${what}`);
    const out: Record<string, unknown> = {};
    while (!c.atP('}', true)) {
      const k = c.next(true);
      if (k.t !== 'word' && k.t !== 'str') err(k.line === 0 ? line : k.line, `expected 'key: value' inside ${what}`);
      const key = String((k as { v: string | number }).v);
      c.expectP(':', `after '${key}' in ${what}`);
      out[key] = parseValue(c, 'scene');
      if (c.atP(',') || c.atP(';')) c.next();
    }
    c.next(true); // '}'
    return out;
  };

  for (;;) {
    const t = c.peek(true);
    if (t.t === 'end') break;
    if (t.t === 'dots') { c.next(true); stack[stack.length - 1]!.keepRest = true; continue; }
    if (t.t === 'p' && t.v === '}') {
      c.next(true);
      if (stack.length === 1) err(t.line, "unmatched '}'");
      stack.pop();
      continue;
    }
    if (t.t !== 'word' && t.t !== 'str') err(t.line, `expected a statement (a primitive line, a property, a state block, variants, ref, ...), got '${t.t === 'p' ? (t as { v: string }).v : t.t}'`);
    const cur = stack[stack.length - 1]!;
    const w = c.next(true) as { t: 'word' | 'str'; v: string; line: number };
    const word = w.t === 'word' ? w.v : null;

    // A property: 'key: value' (inside a node block alone).
    if (c.atP(':') && !(word === 'ref' || word === 'variants')) {
      if (stack.length === 1) err(w.line, `'${w.v}' is a property - it lives inside a node block ('frame root { ${w.v}: ... }')`);
      c.next();
      const key = String(w.v);
      if (key in cur.props) err(w.line, `'${key}' appears twice on '${cur.id}' - one value per property`);
      cur.props[key] = parseValue(c, 'scene');
      cur.propLines[key] = w.line;
      if (c.atP(',') || c.atP(';')) c.next();
      continue;
    }
    if (word === 'screen' && stack.length === 1 && slug === null) {
      const s = c.next(true);
      if (s.t !== 'word' && s.t !== 'str') err(w.line, "'screen' takes the slug");
      slug = String((s as { v: string | number }).v);
      continue;
    }
    if (word === 'flow' && stack.length === 1 && slug === null && root.children.length === 0 && Object.keys(root.props).length === 0) {
      err(w.line, "this is flow dialect - it edits the working flow, not a screen (submit it without a screen param)");
    }
    if (word === 'node') err(w.line, "'node' is the old word - a node is written as its primitive: frame <id> { ... }, text <id> { ... }, field, chart, instance");
    if (word !== null && STATE_SET.has(word)) {
      if (stack.length === 1) err(w.line, `a ${word} block lives inside a node block`);
      const states = isObj(cur.props['states']) ? cur.props['states'] : {};
      if (word in states) err(w.line, `'${cur.id}' has two ${word} blocks - one per state`);
      cur.props['states'] = { ...states, [word]: parseBlock(`${word} { }`, w.line) };
      continue;
    }
    if (word === 'at') {
      if (stack.length === 1) err(w.line, 'an at block lives inside a node block');
      const bp = c.next(true);
      if (bp.t !== 'word') err(w.line, "'at' takes the breakpoint name: at phone { ... }");
      const name = (bp as { v: string }).v;
      const at = isObj(cur.props['at']) ? cur.props['at'] : {};
      if (name in at) err(w.line, `'${cur.id}' has two 'at ${name}' blocks - one per breakpoint`);
      cur.props['at'] = { ...at, [name]: parseBlock(`at ${name} { }`, w.line) };
      continue;
    }
    if (word === 'variants') {
      const nameTok = c.next(true);
      if (nameTok.t !== 'word') err(w.line, "'variants' takes the set name");
      const set = (nameTok as { v: string }).v;
      c.expectP('{', `opening variants '${set}'`);
      let options: string[] | null = null;
      let dflt: string | null = null;
      let selected: string | undefined;
      while (!c.atP('}', true)) {
        const kw = c.next(true);
        if (kw.t !== 'word') err(w.line, "variants clauses are 'options:', 'default:', 'selected:'");
        const key = (kw as { v: string }).v;
        c.expectP(':', `after '${key}'`);
        if (key === 'options') {
          options = [];
          for (;;) {
            const o = c.next(true);
            if (o.t !== 'word') err(w.line, "'options:' takes plain option names");
            options.push((o as { v: string }).v);
            if (c.atP(',')) { c.next(); continue; }
            break;
          }
        } else if (key === 'default' || key === 'selected') {
          const o = c.next(true);
          if (o.t !== 'word') err(w.line, `'${key}:' takes one option name`);
          if (key === 'default') dflt = (o as { v: string }).v;
          else selected = (o as { v: string }).v;
        } else err(w.line, `'${key}' is not a variants clause - they are options, default, selected`);
        if (c.atP(';') || c.atP(',')) c.next();
      }
      c.next(true); // '}'
      if (options === null || dflt === null) err(w.line, "variants needs 'options:' and 'default:'");
      const decl: TargetNode['variants'][number] = { set, options: options!, default: dflt!, line: w.line };
      if (selected !== undefined) decl.selected = selected;
      cur.variants.push(decl);
      continue;
    }
    if (word === 'ref') {
      const keyTok = c.next(true);
      if (keyTok.t !== 'word') err(w.line, "'ref' takes the ref key");
      c.expectP('->', "in 'ref <key> -> <target>'");
      const tgt = c.next(true);
      if (tgt.t !== 'word') err(w.line, "a ref target is a node id or scene:<slug>");
      const target = joinRefName(c, (tgt as { v: string }).v, w.line);
      cur.refs.push({ key: (keyTok as { v: string }).v, target, line: w.line });
      continue;
    }
    // A node: '<primitive> <id> [in parent] [slot "x"] [when set = option] {'.
    if (word === null || !isPrimitiveName(word)) {
      const bare = String(w.v).replace(/^[a-z0-9-]+::/, '').replace(/@\d+$/, '');
      err(w.line, `'${w.v}' is not a primitive - a node is one of ${PRIMITIVE_NAMES.join(', ')} (nearest: ${nearestPrimitiveNames(bare).join(', ')}); a property is written 'key: value'`);
    }
    const primitive = word as PrimitiveName;
    const idTok = c.next(true);
    if (wordAt(idTok) === null) err(w.line, `'${primitive}' takes the node id: ${primitive} <id> { ... }`);
    const id = wordAt(idTok)!;
    // The root is implicit; 'frame root { ... }' at the top level speaks it by name and edits it in place.
    if (id === 'root' && stack.length === 1 && !c.atWord('in') && !c.atWord('slot') && !c.atWord('when')) {
      if (primitive !== 'frame') err(w.line, `the root is a frame - '${primitive} root' cannot be`);
      c.expectP('{', "opening 'frame root'");
      root.line = w.line;
      root.written = true;
      stack.push(root);
      continue;
    }
    if (!NODE_ID_RE.test(id)) err(w.line, `'${id}' is not a legal node id (1-64 chars: letters, digits, - and _, starts alphanumeric)`);
    if (seen.has(id)) err(w.line, `node '${id}' appears twice - every node id appears once`);
    seen.add(id);
    const node = newTarget(id, primitive, w.line);
    for (;;) {
      if (c.atWord('in')) {
        c.next();
        const p = c.next();
        if (p.t !== 'word') err(w.line, "'in' takes the parent node id");
        node.explicitParent = (p as { v: string }).v;
        continue;
      }
      if (c.atWord('slot')) {
        c.next();
        const s = c.next();
        if (s.t !== 'str' && s.t !== 'word') err(w.line, "'slot' takes the slot name");
        node.slot = String((s as { v: string | number }).v);
        continue;
      }
      if (c.atWord('when')) {
        c.next();
        const set = c.next();
        if (set.t !== 'word') err(w.line, "'when' takes '<set> = <option>'");
        c.expectP('=', "in 'when <set> = <option>'");
        const opt = c.next();
        if (opt.t !== 'word') err(w.line, "'when' takes '<set> = <option>'");
        node.variantOf = { set: (set as { v: string }).v, option: (opt as { v: string }).v };
        continue;
      }
      break;
    }
    if (node.explicitParent !== null && stack.length > 1) err(w.line, "'in' anchors top-level blocks only - a nested node's parent is its block");
    // An anchored block edits one region: everything else on the screen stays, as the grammar promises.
    if (node.explicitParent !== null) root.keepRest = true;
    c.expectP('{', `opening ${primitive} '${id}'`);
    cur.children.push(node);
    stack.push(node);
  }
  if (stack.length > 1) err(stack[stack.length - 1]!.line, `'${stack[stack.length - 1]!.id}' is never closed - add '}'`);
  return { slug, root };
}

// ---------------------------------------------------------------------------
// SCENE DIFF - target tree vs the live document -> the minimal op batch.
// Every target payload is checked against its primitive's contract first (the
// refusal names the line); every op is applied to a simulation as it is
// emitted, so anchors and variant preconditions are exact; the real apply
// then runs the same fold through the one validator.
// ---------------------------------------------------------------------------

interface SceneCompileOk {
  ok: true; ops: SceneOp[]; warnings: string[]; changedValues: unknown[]; targetDocLike: SceneDocument;
  /** This edit's design-lint findings (the target screen against the live one). */
  findings: LintFinding[];
  /** The live screen's own findings before this edit - the pre-existing set the tracker annotates. */
  preExisting: LintFinding[];
}
export type SceneCompileResult = SceneCompileOk | { ok: false; errors: string[] };

/** Every target payload against its contract: unknown properties name the nearest, bad values name the hint, expressions parse. */
function contractErrors(node: TargetNode, breakpoints: readonly string[]): string[] {
  const errors: string[] = [];
  const lineOf = (key: string | undefined): number => (key !== undefined && node.propLines[key] !== undefined ? node.propLines[key]! : node.line);
  const parsed = payloadSchema(node.primitive, breakpoints).safeParse(node.props);
  if (!parsed.success) {
    for (const issue of parsed.error.issues.slice(0, 12)) {
      const head = typeof issue.path[0] === 'string' ? issue.path[0] : undefined;
      const where = `${node.primitive} '${node.id}'`;
      if (issue.code === 'unrecognized_keys') {
        for (const k of issue.keys) {
          if (head === 'at' && issue.path.length === 1) errors.push(`line ${lineOf('at')}: 'at ${k}' - the breakpoints are ${breakpoints.join(', ')} (the theme names them)`);
          else if (head !== undefined) errors.push(`line ${lineOf(head)}: '${k}' is not a property a ${head === 'states' ? 'state' : 'breakpoint'} block of ${node.primitive} may set (${head === 'at' ? 'structure never varies - layout alone may' : 'structure never varies'}) - nearest: ${nearestPropertyNames(node.primitive, k, 3, head === 'at' ? 'at' : 'block').join(', ')}`);
          else errors.push(`line ${lineOf(k)}: '${k}' is not a property of ${where} - nearest: ${nearestPropertyNames(node.primitive, k).join(', ')}; contract {names:['${node.primitive}']} lists them all`);
        }
        continue;
      }
      const key = String(issue.path[issue.path.length - 1] ?? '');
      const def = propertiesOf(node.primitive)[key];
      if (issue.code === 'invalid_union') {
        errors.push(`line ${lineOf(head)}: ${where}: '${issue.path.join('.')}' does not fit its contract${def !== undefined ? ` - ${def.hint}` : ''}`);
        continue;
      }
      errors.push(`line ${lineOf(head)}: ${where}: ${issue.path.join('.')}: ${issue.message}`);
    }
  }
  const walk = (v: unknown, key: string): void => {
    if (isExprShape(v)) {
      const r = validateExpression(v as { $expr: string; deps?: string[] });
      if (!r.ok) for (const e of r.errors) errors.push(`line ${lineOf(key)}: ${node.primitive} '${node.id}'.${key}: expr(): ${e}`);
      return;
    }
    if (Array.isArray(v)) { for (const x of v) walk(x, key); return; }
    if (isObj(v)) for (const x of Object.values(v)) walk(x, key);
  };
  for (const [k, v] of Object.entries(node.props)) walk(v, k);
  if (node.primitive === 'text' && node.props['text'] === undefined && node.props['blocks'] === undefined && node.props['glyph'] === undefined) {
    errors.push(`line ${node.line}: text '${node.id}' needs text, blocks or a glyph`);
  }
  if (node.primitive === 'chart' && typeof node.props['query'] !== 'string') errors.push(`line ${node.line}: chart '${node.id}' names the query it draws`);
  if (node.primitive === 'instance' && typeof node.props['component'] !== 'string') errors.push(`line ${node.line}: instance '${node.id}' names the library item it places`);
  if (node.primitive === 'field' && typeof node.props['name'] !== 'string') errors.push(`line ${node.line}: field '${node.id}' names the value it fills (name: "customer")`);
  if (node.primitive !== 'frame' && node.children.length > 0) errors.push(`line ${node.line}: ${node.primitive} '${node.id}' takes no children - put them beside it inside a frame`);
  return errors;
}

export function compileSceneDialect(
  current: SceneDocument, code: string,
  opts?: { theme?: ProjectTheme | null; screen?: string },
): SceneCompileResult {
  let parsed: ParsedScene;
  try {
    parsed = parseSceneDialect(code);
  } catch (e) {
    if (e instanceof DialectError) return { ok: false, errors: [e.message] };
    throw e;
  }
  const breakpoints = Object.keys(breakpointsOf(opts?.theme ?? null));
  const ops: SceneOp[] = [];
  const warnings: string[] = [];
  const changedValues: unknown[] = [];
  let sim: SceneDocument = structuredClone(current);

  const apply = (op: SceneOp, line: number): string | null => {
    const res = applyOpsToDocument(sim, [op]);
    if (!res.ok) return `line ${line}: ${res.errors.join('; ')}`;
    sim = res.doc;
    ops.push(op);
    return null;
  };

  try {
    // Index the target: id -> node, plus each node's resolved parent; every payload against its contract.
    const index = new Map<string, { node: TargetNode; parent: string | null }>();
    const contract: string[] = [];
    const walkIndex = (node: TargetNode, parent: string | null): void => {
      index.set(node.id, { node, parent: node.explicitParent ?? parent });
      contract.push(...contractErrors(node, breakpoints));
      for (const kid of node.children) walkIndex(kid, node.id);
    };
    walkIndex(parsed.root, null);
    if (contract.length > 0) return { ok: false, errors: contract };

    // Explicit parents must exist somewhere (live or in the target).
    for (const [, { node }] of index) {
      if (node.explicitParent !== null && !index.has(node.explicitParent) && current.nodes[node.explicitParent] === undefined) {
        err(node.line, `'in ${node.explicitParent}': no such node on this screen - read the screen first`);
      }
    }

    // Removals: a live node unmentioned under a mentioned, unmarked parent is removed.
    for (const cur of Object.values(current.nodes)) {
      if (cur.id === 'root' || index.has(cur.id)) continue;
      const p = cur.parent;
      if (p === null) continue;
      const parentTarget = index.get(p);
      if (parentTarget === undefined || parentTarget.node.keepRest) continue;
      if (sim.nodes[cur.id] === undefined) continue; // an ancestor's removal cascaded already
      const bad = apply({ op: 'remove_node', id: cur.id }, parentTarget.node.line);
      if (bad !== null) return { ok: false, errors: [bad] };
    }

    // The pre-order walk: parents before children, siblings in written order.
    const visit = (node: TargetNode, parentId: string | null): string | null => {
      const existing = sim.nodes[node.id];
      const effectiveParent = node.explicitParent ?? parentId;
      if (node.id !== 'root') {
        if (existing === undefined) {
          changedValues.push(...Object.values(node.props));
          const pos = positionFor(node, effectiveParent!);
          const op: SceneOp = {
            op: 'create_node', id: node.id, parent: effectiveParent!, position: pos,
            ...(node.slot !== undefined ? { slot: node.slot } : {}),
            ...(node.variantOf !== undefined ? { variantOf: node.variantOf } : {}),
            components: { [primitiveRef(node.primitive)]: node.props },
          } as SceneOp;
          const bad = apply(op, node.line);
          if (bad !== null) return bad;
        } else {
          // Kept node: slot and variant membership are creation-time facts.
          if ((existing.slot ?? undefined) !== node.slot) {
            return `line ${node.line}: '${node.id}' cannot change slot on a live node - remove it and recreate under the new slot (fresh id)`;
          }
          if (!deepEq(existing.variantOf ?? undefined, node.variantOf ?? undefined)) {
            return `line ${node.line}: '${node.id}' cannot change variant membership ('when') on a live node - remove and recreate it`;
          }
          const parentChanged = existing.parent !== effectiveParent;
          const orderWrong = node.explicitParent !== null ? false : orderIsWrong(node, parentId!);
          if (parentChanged || orderWrong) {
            const pos = node.explicitParent !== null && !parentChanged
              ? null
              : positionFor(node, effectiveParent!);
            if (pos !== null) {
              const bad = apply({ op: 'move_node', node: node.id, parent: effectiveParent!, position: pos }, node.line);
              if (bad !== null) return bad;
            }
          }
          const bad = diffNodeSurface(node, existing);
          if (bad !== null) return bad;
        }
      } else if (node.written) {
        const bad = diffNodeSurface(node, sim.nodes['root']!);
        if (bad !== null) return bad;
      }
      // Variant sets and refs land after the node exists (creates included); an unspoken root keeps its own.
      const bad2 = node.written ? diffDeclarations(node) : null;
      if (bad2 !== null) return bad2;
      for (const kid of node.children) {
        const bad = visit(kid, node.id);
        if (bad !== null) return bad;
      }
      return null;
    };

    /** Position intent: after the previous target sibling; a first child lands before the current head or at the end. */
    const positionFor = (node: TargetNode, parentId: string): { anchor: 'before' | 'after' | 'end'; ref?: string } => {
      if (node.explicitParent !== null) return { anchor: 'end' };
      const parentTarget = index.get(parentId);
      const siblings = parentTarget?.node.children ?? [];
      const at = siblings.findIndex((s) => s.id === node.id);
      const prev = at > 0 ? siblings[at - 1] : undefined;
      if (prev !== undefined) return { anchor: 'after', ref: prev.id };
      const head = allChildren(sim, parentId).filter((n) => n.id !== node.id)[0];
      return head !== undefined ? { anchor: 'before', ref: head.id } : { anchor: 'end' };
    };

    /** A kept, nested node is in order when it sits right after its previous target sibling (or first). */
    const orderIsWrong = (node: TargetNode, parentId: string): boolean => {
      const siblings = index.get(parentId)?.node.children ?? [];
      const at = siblings.findIndex((s) => s.id === node.id);
      const prev = at > 0 ? siblings[at - 1] : undefined;
      const simKids = allChildren(sim, parentId).map((n) => n.id);
      const idx = simKids.indexOf(node.id);
      if (prev === undefined) return idx !== 0;
      return simKids[idx - 1] !== prev.id;
    };

    /** The one primitive's diff for a kept node: a changed primitive swaps whole; the same one lands per property. */
    const diffNodeSurface = (node: TargetNode, existing: SceneNode): string | null => {
      const ref = primitiveRef(node.primitive);
      const cur = existing.components[ref];
      // Anything else the live node carries (another primitive, an old component) leaves.
      for (const other of Object.keys(existing.components)) {
        if (other === ref) continue;
        const bad = apply({ op: 'remove_component', node: node.id, component: other }, node.line);
        if (bad !== null) return bad;
      }
      if (cur === undefined) {
        // The implicit root carries nothing until a property is written for it.
        if (node.id === 'root' && Object.keys(node.props).length === 0) return null;
        changedValues.push(...Object.values(node.props));
        return apply({ op: 'set_component', node: node.id, component: ref, value: node.props }, node.line);
      }
      const removedKeys = Object.keys(cur).filter((k) => !(k in node.props));
      if (removedKeys.length > 0) {
        if (deepEq(cur, node.props)) return null;
        changedValues.push(...Object.values(node.props));
        return apply({ op: 'set_component', node: node.id, component: ref, value: node.props }, node.line);
      }
      for (const [k, v] of Object.entries(node.props)) {
        if (deepEq(cur[k], v)) continue;
        changedValues.push(v);
        const bad = apply({ op: 'set_property', node: node.id, component: ref, key: k, value: v }, node.propLines[k] ?? node.line);
        if (bad !== null) return bad;
      }
      return null;
    };

    /** Variant sets, selections, and refs - target vs the simulated node. */
    const diffDeclarations = (node: TargetNode): string | null => {
      const simNode = sim.nodes[node.id];
      if (simNode === undefined) return `node '${node.id}' vanished mid-compile`;
      const targetSets = new Set(node.variants.map((v) => v.set));
      for (const v of node.variants) {
        const cur = simNode.variants?.[v.set];
        if (cur === undefined || !deepEq([...cur.options], v.options) || cur.default !== v.default) {
          const bad = apply({ op: 'declare_variant_set', node: node.id, set: v.set, options: v.options, default: v.default }, v.line);
          if (bad !== null) return bad;
        }
        const want = v.selected ?? v.default;
        const now = sim.nodes[node.id]!.variants?.[v.set];
        if (now !== undefined && (now.selection ?? now.default) !== want) {
          const bad = apply({ op: 'set_variant', node: node.id, set: v.set, selection: want }, v.line);
          if (bad !== null) return bad;
        }
      }
      for (const set of Object.keys(simNode.variants ?? {})) {
        if (targetSets.has(set)) continue;
        const bad = apply({ op: 'remove_variant_set', node: node.id, set }, node.line);
        if (bad !== null) return bad;
      }
      const targetRefs = new Set(node.refs.map((r) => r.key));
      for (const r of node.refs) {
        if (simNode.refs?.[r.key] === r.target) continue;
        const bad = apply({ op: 'set_ref', node: node.id, key: r.key, target: r.target }, r.line);
        if (bad !== null) return bad;
      }
      for (const key of Object.keys(simNode.refs ?? {})) {
        if (targetRefs.has(key)) continue;
        const bad = apply({ op: 'remove_ref', node: node.id, key }, node.line);
        if (bad !== null) return bad;
      }
      return null;
    };

    const bad = visit(parsed.root, null);
    if (bad !== null) return { ok: false, errors: [bad] };
  } catch (e) {
    if (e instanceof DialectError) return { ok: false, errors: [e.message] };
    throw e;
  }

  if (ops.length > OPS_CAP) {
    return {
      ok: false,
      errors: [`this change compiles to ${ops.length} ops - the atomic cap is ${OPS_CAP}; edit one region at a time ('node <id> in <parent>'), or dispatch the build (a dispatch line)`],
    };
  }
  // An edit that CHANGES x/y on a flow child lands clean but moves nothing - say so (the invariant
  // keeps x/y present everywhere; only a changed value under a laid-out parent earns the warning).
  for (const op of ops) {
    if (op.op !== 'set_property' || (op.key !== 'x' && op.key !== 'y')) continue;
    const target = sim.nodes[op.node];
    if (target === undefined || target.parent === null) continue;
    const tPrim = primitiveOfNode(target);
    if (tPrim !== null && tPrim.payload['free'] === true) continue;
    const parent = sim.nodes[target.parent];
    const pPrim = parent !== undefined ? primitiveOfNode(parent) : null;
    const pl = pPrim?.name === 'frame' ? pPrim.payload['layout'] : undefined;
    if (pl === 'row' || pl === 'column' || pl === 'grid') {
      warnings.push(`'${op.node}' sits in a ${String(pl)} frame - the flow computes its place and this ${op.key} is ignored; set free: true on it to place it yourself, or move it with the parent's gap, padding or order`);
    }
  }
  // Findings ride beside the ops (n8n's warnings beside the parsed workflow): the edit door's
  // per-run tracker decides what refuses. preExisting = the live screen linted against itself.
  const screen = opts?.screen ?? '';
  const findings = lintSceneChange(screen, current, sim, changedValues, opts?.theme ?? null);
  const preExisting = lintSceneChange(screen, current, current, allParamValues(current), opts?.theme ?? null);
  return { ok: true, ops, warnings, changedValues, targetDocLike: sim, findings, preExisting };
}

// ---------------------------------------------------------------------------
// THE LINT - the design rules as compile errors, read off the contract's typed
// values: a color is a color-unit property (or a color inside a shape), a font
// is font-family, a size is font-size. Bans check the values THIS edit
// introduces; budgets compare the whole target screen against the live one,
// so a batch only fails a budget it worsens.
// ---------------------------------------------------------------------------

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const PURPLE_NAMES = new Set([
  'purple', 'violet', 'indigo', 'orchid', 'magenta', 'fuchsia', 'blueviolet', 'mediumpurple',
  'rebeccapurple', 'darkviolet', 'darkorchid', 'mediumorchid', 'darkmagenta', 'plum', 'thistle', 'mediumslateblue',
]);
/** The theme's color names (the token vocabulary a node may name instead of a literal). */
const THEME_NAME_SET: ReadonlySet<string> = new Set<string>(THEME_COLOR_NAMES);
/** Status hues: outside the color budget (v0 counts brand + neutrals + accents alone). */
const STATUS_NAMES: ReadonlySet<string> = new Set(['green', 'amber', 'red']);
/** The surface ladder: outside the color budget. */
const LADDER_NAMES: ReadonlySet<string> = new Set(['background', 'card', 'cardRaised']);
/** Keys inside a shape whose string value is a color (a shadow's color, an outline's, a threshold's, a gradient's stops). */
const COLOR_KEYS: ReadonlySet<string> = new Set(['color', 'from', 'to', 'via', 'backdrop']);

/** #rgb/#rrggbb -> r/g/b 0-255; null for non-hex. */
function hexRgb(hex: string): { r: number; g: number; b: number } | null {
  if (!HEX_RE.test(hex)) return null;
  let x = hex.slice(1);
  if (x.length === 3) x = x.split('').map((ch) => ch + ch).join('');
  if (x.length === 8) x = x.slice(0, 6);
  return { r: parseInt(x.slice(0, 2), 16), g: parseInt(x.slice(2, 4), 16), b: parseInt(x.slice(4, 6), 16) };
}

/** #rgb/#rrggbb -> hue/sat; null for non-hex. */
function hexHsl(hex: string): { h: number; s: number } | null {
  const rgb = hexRgb(hex);
  if (rgb === null) return null;
  const r = rgb.r / 255;
  const g = rgb.g / 255;
  const b = rgb.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d !== 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  return { h: (h + 360) % 360, s };
}

function isPurpleish(color: string): boolean {
  const low = color.toLowerCase();
  if (PURPLE_NAMES.has(low)) return true;
  const hsl = hexHsl(low);
  return hsl !== null && hsl.h >= 255 && hsl.h <= 300 && hsl.s > 0.15;
}

/** One color-valued string, normalized: a theme name stays, a literal lowercases. */
function noteColor(v: unknown, out: Set<string>): void {
  if (typeof v !== 'string' || v.length === 0) return;
  out.add(THEME_NAME_SET.has(v) ? v : v.toLowerCase());
}

/** The colors a property value carries: a color-unit value (a paint, a list of paints) or the color keys inside a shape. */
function colorsOfValue(v: unknown, unit: string | undefined, out: Set<string>): void {
  if (isExprShape(v) || isChannelShape(v)) return;
  if (typeof v === 'string') { if (unit === 'color') noteColor(v, out); return; }
  if (Array.isArray(v)) { for (const x of v) colorsOfValue(x, unit, out); return; }
  if (!isObj(v)) return;
  for (const [k, x] of Object.entries(v)) {
    if (COLOR_KEYS.has(k)) noteColor(x, out);
    else if (isObj(x) || Array.isArray(x)) colorsOfValue(x, unit === 'color' ? 'shape' : unit, out);
  }
}

/** A finding's address on the contract: node, primitive, property (a state or breakpoint block names its property too). */
interface Site { nodeId: string; primitive: PrimitiveName; key: string; value: unknown; block?: string }

/** Every (node, property, value) site in a document, state and breakpoint blocks unfolded. */
function sitesOf(doc: SceneDocument): Site[] {
  const out: Site[] = [];
  for (const node of Object.values(doc.nodes)) {
    const p = primitiveOfNode(node);
    if (p === null) continue;
    for (const [key, value] of Object.entries(p.payload)) {
      if (key === 'states' || key === 'at') {
        if (!isObj(value)) continue;
        for (const [block, inner] of Object.entries(value)) {
          if (!isObj(inner)) continue;
          for (const [k2, v2] of Object.entries(inner)) out.push({ nodeId: node.id, primitive: p.name, key: k2, value: v2, block: `${key}.${block}` });
        }
        continue;
      }
      out.push({ nodeId: node.id, primitive: p.name, key, value });
    }
  }
  return out;
}

function unitOf(site: Site): string | undefined {
  return propertiesOf(site.primitive)[site.key]?.unit;
}

/** Distinct colors and font families across a whole document, read off the contract's units. */
function docPalette(doc: SceneDocument): { colors: Set<string>; fonts: Set<string> } {
  const colors = new Set<string>();
  const fonts = new Set<string>();
  for (const site of sitesOf(doc)) {
    const unit = unitOf(site);
    if (unit === 'color' || unit === 'shape') colorsOfValue(site.value, unit, colors);
    if (unit === 'font' && typeof site.value === 'string' && site.value.length > 0) fonts.add(site.value.toLowerCase());
  }
  return { colors, fonts };
}

/** v0: "ALWAYS use exactly 3-5 colors total" - 1 primary, 2-3 neutrals, 1-2 accents. */
const COLOR_BUDGET = 5;
/** v0: "ALWAYS limit to maximum 2 font families total"; the theme's own two words never count. */
const FONT_BUDGET = 2;
/** v0: "NEVER use decorative fonts for body text or fonts smaller than 14px"; the floor under any text is 12 px. */
const BODY_FLOOR_PX = 14;
const TEXT_FLOOR_PX = 12;

/** Every property value on a document - the live screen linted against itself. */
function allParamValues(doc: SceneDocument): unknown[] {
  return sitesOf(doc).map((s) => s.value);
}

/** The theme as the lint reads it: name -> value (lowercased), and the value -> names index. */
interface ThemeView {
  names: string[];
  valueOf: Map<string, string>;
  namesOf: Map<string, string[]>;
  /** Ruling 1: gradients only when the brief or the signature asks for them. */
  gradientsAllowed: boolean;
}

function themeView(theme: ProjectTheme | null): ThemeView | null {
  if (theme === null) return null;
  const valueOf = new Map<string, string>();
  const namesOf = new Map<string, string[]>();
  for (const name of THEME_COLOR_NAMES) {
    const v = theme[name];
    if (typeof v !== 'string' || v.length === 0) continue;
    const low = v.toLowerCase();
    valueOf.set(name, low);
    namesOf.set(low, [...(namesOf.get(low) ?? []), name]);
  }
  const spoken = [theme.signature, theme.brief?.mood, theme.brief?.signatureMove, ...(theme.brief?.do ?? [])]
    .filter((s): s is string => typeof s === 'string').join('\n');
  return { names: [...valueOf.keys()], valueOf, namesOf, gradientsAllowed: /\bgradients?\b/i.test(spoken) };
}

/** The theme name whose value sits nearest a literal (RGB distance); null when nothing parses. */
function nearestThemeName(literal: string, view: ThemeView): string | null {
  const rgb = hexRgb(literal);
  if (rgb === null) return null;
  let best: { name: string; d: number } | null = null;
  for (const [name, value] of view.valueOf) {
    const t = hexRgb(value);
    if (t === null) continue;
    const d = (rgb.r - t.r) ** 2 + (rgb.g - t.g) ** 2 + (rgb.b - t.b) ** 2;
    if (best === null || d < best.d) best = { name, d };
  }
  return best?.name ?? null;
}

/** Every gradient paint in a value ({gradient, from, to, via?}) with its stops resolved through the theme. */
function gradientsIn(v: unknown, view: ThemeView | null, out: { stops: string[]; text: string }[]): void {
  const resolve = (c: string): string => (view !== null && view.valueOf.has(c) ? view.valueOf.get(c)! : c.toLowerCase());
  if (Array.isArray(v)) { for (const x of v) gradientsIn(x, view, out); return; }
  if (!isObj(v) || isExprShape(v)) return;
  if (typeof v['gradient'] === 'string') {
    const stops = [v['from'], v['via'], v['to']].filter((s): s is string => typeof s === 'string' && s.length > 0);
    out.push({ stops: stops.map(resolve), text: `${v['gradient']} ${stops.join(' -> ')}` });
    return;
  }
  for (const x of Object.values(v)) gradientsIn(x, view, out);
}

/** True when a node holds a text child that sets no color of its own. */
function textChildrenWithoutColor(doc: SceneDocument, nodeId: string): boolean {
  let bare = false;
  let any = false;
  for (const node of Object.values(doc.nodes)) {
    if (node.parent !== nodeId) continue;
    const p = primitiveOfNode(node);
    if (p === null || p.name !== 'text') continue;
    any = true;
    if (p.payload['color'] === undefined) bare = true;
  }
  return any && bare;
}

/** The design rules as findings (Lovable's design system + v0's Color / Gradient / Typography rules over
 * the project's theme). Bans check the values THIS edit introduces, each keyed at the property carrying it;
 * budgets compare the whole target screen against the live one and key at the screen (a screen already
 * over budget keeps that finding until it shrinks). No theme = the bans and budgets alone. */
export function lintSceneChange(
  screen: string, current: SceneDocument, target: SceneDocument, changedValues: unknown[],
  theme: ProjectTheme | null,
): LintFinding[] {
  const findings: LintFinding[] = [];
  const view = themeView(theme);
  const sites = sitesOf(target);
  const changed = (site: Site): boolean => changedValues.some((v) => deepEq(v, site.value));
  const at = (locs: Site[], message: string): void => {
    if (locs.length === 0) { findings.push(lintFinding({ screen }, message)); return; }
    for (const loc of locs) findings.push(lintFinding({ screen, nodeId: loc.nodeId, componentKey: loc.block ?? loc.primitive, param: loc.key }, message));
  };
  const sitesWithColor = (color: string): Site[] => sites.filter((s) => {
    const unit = unitOf(s);
    if (unit !== 'color' && unit !== 'shape') return false;
    const set = new Set<string>();
    colorsOfValue(s.value, unit, set);
    return set.has(color);
  });
  const themeNames = view === null ? '' : view.names.join(', ');

  // Gradients (ruling 1, v0): avoided entirely unless asked for; when necessary, subtle accents only,
  // analogous colors, 2-3 stops, never opposing temperatures.
  const changedColors = new Set<string>();
  for (const site of sites) {
    if (!changed(site)) continue;
    const unit = unitOf(site);
    if (unit === 'color' || unit === 'shape') colorsOfValue(site.value, unit, changedColors);
    if (unit !== 'color') continue;
    const grads: { stops: string[]; text: string }[] = [];
    gradientsIn(site.value, view, grads);
    for (const grad of grads) {
      if (view === null || !view.gradientsAllowed) {
        at([site], `lint: avoid gradients entirely unless explicitly asked for - '${grad.text}' uses one; use a solid theme color (${themeNames || 'card, primary, accent'})`);
        continue;
      }
      if (grad.stops.length > 3) at([site], `lint: '${grad.text}' has ${grad.stops.length} color stops - maximum 2-3 color stops, no complex gradients`);
      const hues = grad.stops.map((s) => hexHsl(s)).filter((h): h is { h: number; s: number } => h !== null && h.s > 0.15);
      for (let i = 1; i < hues.length; i++) {
        const diff = Math.abs(hues[i]!.h - hues[i - 1]!.h);
        if (Math.min(diff, 360 - diff) > 60) {
          at([site], `lint: '${grad.text}' mixes opposing temperatures - use analogous colors for a gradient (blue to teal, orange to red), and only as a subtle accent, never for primary elements`);
          break;
        }
      }
    }
  }

  // Colors: every literal this edit introduces is a theme value, or it refuses naming the nearest theme name.
  for (const color of changedColors) {
    if (THEME_NAME_SET.has(color)) continue;
    if (view !== null && view.namesOf.has(color)) continue;
    if (isPurpleish(color)) {
      at(sitesWithColor(color), `lint: NEVER use purple or violet prominently, unless explicitly asked for - '${color}' only belongs in a theme that names it`);
    }
    if (view !== null) {
      const nearest = nearestThemeName(color, view);
      at(sitesWithColor(color), `lint: '${color}' is not a theme value - use a theme name${nearest !== null ? ` ('${nearest}' is the nearest)` : ''}: ${themeNames}; or change the theme deliberately`);
    }
  }

  // The budget (v0: "ALWAYS use exactly 3-5 colors total" - brand + neutrals + accents); status hues and the
  // surface ladder are outside it. A theme name (or a theme value) never counts on a screen: the theme block IS
  // the 3-5 colors, every token derives from them; the budget bites on literals a screen adds outside the theme.
  const outside = (c: string): boolean => {
    if (STATUS_NAMES.has(c) || LADDER_NAMES.has(c) || THEME_NAME_SET.has(c)) return true;
    return (view?.namesOf.get(c) ?? []).length > 0;
  };
  const before = docPalette(current);
  const after = docPalette(target);
  const beforeCount = [...before.colors].filter((c) => !outside(c));
  const afterCount = [...after.colors].filter((c) => !outside(c));
  if (afterCount.length > COLOR_BUDGET && afterCount.length >= beforeCount.length) {
    findings.push(lintFinding({ screen, param: 'colors' },
      `lint: this edit takes the screen to ${afterCount.length} colors - ALWAYS use exactly 3-5 colors total: 1 primary brand color, 2-3 neutrals, 1-2 accents (status hues and the surface ladder are outside the count); reuse: ${beforeCount.slice(0, 6).join(', ')}`));
  }
  const family = (s: Set<string>): string[] => [...s].filter((f) => f !== 'sans' && f !== 'mono');
  if (family(after.fonts).length > FONT_BUDGET && family(after.fonts).length >= family(before.fonts).length) {
    findings.push(lintFinding({ screen, param: 'fonts' },
      `lint: this edit takes the screen to ${family(after.fonts).length} font families - ALWAYS limit to maximum 2 font families total (one for headings, one for body); reuse: ${family(before.fonts).join(', ')}`));
  }

  // The typography floor (v0): body text under 14 px, any text under 12 px - on numeric sizes this edit sets.
  // Body = a paragraph (v0's word); a short label, caption or eyebrow at 12-13 px is legal.
  const isParagraph = (text: unknown): boolean => typeof text === 'string' && text.trim().length >= 60;
  for (const node of Object.values(target.nodes)) {
    const p = primitiveOfNode(node);
    if (p === null || p.name !== 'text') continue;
    const size = p.payload['font-size'];
    if (typeof size !== 'number' || !changedValues.includes(size)) continue;
    const tag = p.payload['tag'];
    if (size < TEXT_FLOOR_PX) {
      findings.push(lintFinding({ screen, nodeId: node.id, componentKey: 'text', param: 'font-size' },
        `lint: ${size} px is under the floor - no text under ${TEXT_FLOOR_PX} px; use 'small' (12) or a larger size`));
    } else if (size < BODY_FLOOR_PX && (tag === undefined || tag === 'p') && isParagraph(p.payload['text'])) {
      findings.push(lintFinding({ screen, nodeId: node.id, componentKey: 'text', param: 'font-size' },
        `lint: body text at ${size} px is under the floor - NEVER use fonts smaller than ${BODY_FLOOR_PX} px for body text; a label is 'small' (12), body is 'body' or 14+`));
    }
  }

  // Contrast (v0): "If you override a components background color, you MUST override its text color" -
  // a frame this edit fills with a literal, holding text children that set no color.
  for (const node of Object.values(target.nodes)) {
    const p = primitiveOfNode(node);
    if (p === null || p.name !== 'frame') continue;
    const fill = p.payload['fill'];
    if (fill === undefined || !changedValues.some((v) => deepEq(v, fill))) continue;
    // A theme NAME carries its own foreground in the engine; a literal (a theme value spelled out included) does not.
    const literal = typeof fill === 'string' ? fill.length > 0 && !THEME_NAME_SET.has(fill) : isObj(fill) && typeof fill['gradient'] === 'string';
    if (!literal || !textChildrenWithoutColor(target, node.id)) continue;
    findings.push(lintFinding({ screen, nodeId: node.id, componentKey: 'frame', param: 'fill' },
      `lint: '${node.id}' overrides its background and holds text with no color - if you override a background color, you MUST override its text color: set color on each text (a theme name like cardForeground or primaryForeground)`));
  }
  return findings;
}

// ---------------------------------------------------------------------------
// FLOW GENERATOR - the flow doc -> dialect text. Steps in stored order, wires
// sorted (from, port, order), pins last. Triggers ride as read-only comments.
// ---------------------------------------------------------------------------

export function generateFlowDialect(doc: FlowDoc, opts?: { header?: string[] }): string {
  const lines: string[] = [`flow ${MAIN_FLOW}`];
  for (const h of opts?.header ?? []) lines.push(`# ${h}`);
  lines.push('');
  for (const [id, step] of Object.entries(doc.steps)) {
    const inner = Object.entries(step.params ?? {}).map(([k, v]) => `${bareKey(k)}: ${renderValue(v)}`).join(', ');
    lines.push(`step ${id} = ${step.kind} {${inner.length > 0 ? ` ${inner} ` : ' '}}${step.disabled === true ? ' off' : ''}`);
  }
  const edges = [...doc.edges].sort((a, b) =>
    a.from.localeCompare(b.from) || a.port.localeCompare(b.port) || a.order - b.order || a.to.localeCompare(b.to));
  if (edges.length > 0) lines.push('');
  for (const e of edges) {
    lines.push(`wire ${e.from}${e.port !== 'out' ? `:${e.port}` : ''} -> ${e.to}${e.slot !== 'in' ? `:${e.slot}` : ''}`);
  }
  const pinned = Object.entries(doc.steps).filter(([, s]) => s.pinned !== undefined);
  if (pinned.length > 0) lines.push('');
  for (const [id, s] of pinned) {
    lines.push(`pin ${id} = [${(s.pinned ?? []).map((it) => renderValue(it.json)).join(', ')}]`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// FLOW PARSER + DIFF - dialect text -> the flow authoring calls. New steps
// land through flows_place_step, which mints ids BY KIND - the compile
// simulates the mint so wires land on the real ids, and reports the renames.
// ---------------------------------------------------------------------------

const STEP_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

interface TargetFlowStep { id: string; kind: string; params: Record<string, unknown>; off: boolean; line: number }
interface TargetFlowWire { from: string; port: string | null; to: string; slot: string | null; line: number }
interface ParsedFlow {
  steps: TargetFlowStep[];
  wires: TargetFlowWire[];
  pins: Array<{ id: string; items: Record<string, unknown>[]; line: number }>;
  keepRest: boolean;
}

export function parseFlowDialect(code: string): ParsedFlow {
  if (code.length > MAX_CODE_CHARS) throw new DialectError(`the code is over ${MAX_CODE_CHARS} characters`);
  const toks = tokenize(stripLineNumbers(code));
  if (typeof toks === 'string') throw new DialectError(toks);
  const c = new Cursor(toks);
  const out: ParsedFlow = { steps: [], wires: [], pins: [], keepRest: false };
  const seen = new Set<string>();

  const stepRef = (what: string): { id: string; part: string | null } => {
    const t = c.next(true);
    if (t.t !== 'word') err(t.line, `expected ${what}`);
    const id = (t as { v: string }).v;
    if (c.atP(':')) {
      c.next();
      const p = c.next();
      if (p.t !== 'word') err(t.line, `expected a port/slot name after '${id}:'`);
      return { id, part: (p as { v: string }).v };
    }
    return { id, part: null };
  };

  for (;;) {
    const t = c.peek(true);
    if (t.t === 'end') break;
    if (t.t === 'dots') { c.next(true); out.keepRest = true; continue; }
    if (t.t !== 'word') err(t.line, "expected a statement: step / wire / pin / 'flow main'");
    const w = c.next(true) as { t: 'word'; v: string; line: number };
    if (w.v === 'flow') { c.next(true); continue; } // header; the name is decorative - every project has ONE working flow
    if (w.v === 'screen') err(w.line, 'this is screen dialect - submit it with the screen named');
    if (w.v === 'step') {
      const idTok = c.next(true);
      if (idTok.t !== 'word') err(w.line, "'step' takes an id");
      const id = (idTok as { v: string }).v;
      if (!STEP_ID_RE.test(id) || id.length > 60) err(w.line, `'${id}' is not a legal step id (a-z 0-9 -, starts alphanumeric)`);
      if (seen.has(id)) err(w.line, `step '${id}' appears twice`);
      seen.add(id);
      c.expectP('=', "in 'step <id> = <kind> { ... }'");
      const kindTok = c.next(true);
      if (kindTok.t !== 'word') err(w.line, "expected the step kind after '='");
      const kind = (kindTok as { v: string }).v;
      c.expectP('{', `opening step '${id}'`);
      const params: Record<string, unknown> = {};
      while (!c.atP('}', true)) {
        const k = c.next(true);
        if (k.t !== 'word' && k.t !== 'str') err(w.line, `expected a param key inside step '${id}'`);
        const key = String((k as { v: string | number }).v);
        c.expectP(':', `after '${key}'`);
        params[key] = parseValue(c, 'flow');
        if (c.atP(',') || c.atP(';')) c.next();
      }
      c.next(true); // '}'
      let off = false;
      if (c.atWord('off')) { c.next(); off = true; }
      out.steps.push({ id, kind, params, off, line: w.line });
      continue;
    }
    if (w.v === 'wire') {
      const from = stepRef('the source step id');
      c.expectP('->', "in 'wire <from> -> <to>'");
      const to = stepRef('the target step id');
      out.wires.push({ from: from.id, port: from.part, to: to.id, slot: to.part, line: w.line });
      continue;
    }
    if (w.v === 'pin') {
      const idTok = c.next(true);
      if (idTok.t !== 'word') err(w.line, "'pin' takes the step id");
      c.expectP('=', "in 'pin <id> = [ ... ]'");
      const items = parseValue(c, 'flow');
      if (!Array.isArray(items) || items.some((it) => typeof it !== 'object' || it === null || Array.isArray(it))) {
        err(w.line, 'a pin is an array of sample output objects');
      }
      out.pins.push({ id: (idTok as { v: string }).v, items: items as Record<string, unknown>[], line: w.line });
      continue;
    }
    err(w.line, `'${w.v}' is not a flow statement - they are: step, wire, pin`);
  }
  return out;
}

/** One authoring call the executor lands through the standing flow verbs. */
export interface FlowDialectCall { verb: string; params: Record<string, unknown>; says: string }

export interface FlowCompileOk {
  ok: true;
  calls: FlowDialectCall[];
  /** Pins land through setFlowStepPin after the calls; items null clears. */
  pins: Array<{ stepId: string; items: Record<string, unknown>[] | null }>;
  /** declared id -> the id the kernel will mint (place mints by kind). */
  renames: Record<string, string>;
  warnings: string[];
}
export type FlowCompileResult = FlowCompileOk | { ok: false; errors: string[] };

export function compileFlowDialect(current: FlowDoc, code: string): FlowCompileResult {
  let parsed: ParsedFlow;
  try {
    parsed = parseFlowDialect(code);
  } catch (e) {
    if (e instanceof DialectError) return { ok: false, errors: [e.message] };
    throw e;
  }
  const errors: string[] = [];
  const warnings: string[] = [];
  const calls: FlowDialectCall[] = [];
  const renames: Record<string, string> = {};
  const used = new Set(Object.keys(current.steps));
  const actualId = new Map<string, string>();
  const at = (line: number, msg: string): void => { errors.push(`line ${line}: ${msg}`); };

  // Steps: validate against the registry, split kept vs new, simulate the mint.
  for (const s of parsed.steps) {
    const def = resolveFlowStepDef(s.kind);
    if (def === null) {
      at(s.line, `no step kind '${s.kind}' - the shelf: ${listFlowStepDefs().map((d) => d.kind).join(', ')}`);
      continue;
    }
    for (const e of checkStepParams(def, s.params)) at(s.line, e);
    const cur = current.steps[s.id];
    if (cur !== undefined) {
      if (cur.kind !== s.kind) {
        at(s.line, `step '${s.id}' is '${cur.kind}' on the live flow - a kind never changes; remove it and place a fresh step`);
        continue;
      }
      actualId.set(s.id, s.id);
    } else {
      let minted = s.kind;
      for (let n = 2; used.has(minted); n += 1) minted = `${s.kind}-${n}`;
      used.add(minted);
      actualId.set(s.id, minted);
      if (minted !== s.id) renames[s.id] = minted;
    }
  }
  if (errors.length > 0) return { ok: false, errors: [...errors, DIALECT_FIX_SENTENCE] };

  // Wires: resolve default ports/slots deterministically, validate against the defs.
  const defOf = (id: string): FlowStepDef | null => {
    const declared = parsed.steps.find((s) => actualId.get(s.id) === id || s.id === id);
    const kind = declared?.kind ?? current.steps[id]?.kind;
    return kind === undefined ? null : resolveFlowStepDef(kind);
  };
  const filled = new Map<string, Set<string>>();
  const targetWires: Array<{ from: string; port: string; to: string; slot: string }> = [];
  for (const wr of parsed.wires) {
    const from = actualId.get(wr.from) ?? (current.steps[wr.from] !== undefined ? wr.from : null);
    const to = actualId.get(wr.to) ?? (current.steps[wr.to] !== undefined ? wr.to : null);
    if (from === null) { at(wr.line, `wire names no step '${wr.from}' - declare it above or read the flow first`); continue; }
    if (to === null) { at(wr.line, `wire names no step '${wr.to}'`); continue; }
    const fromDef = defOf(from);
    const toDef = defOf(to);
    const port = wr.port ?? (fromDef !== null && fromDef.outputs !== 'dynamic' ? fromDef.outputs[0] ?? 'out' : 'out');
    if (fromDef !== null && fromDef.outputs !== 'dynamic' && !fromDef.outputs.includes(port)) {
      at(wr.line, `'${fromDef.kind}' has no output '${port}' - its outputs are: ${fromDef.outputs.join(', ')}`);
      continue;
    }
    const required = toDef?.inputs.required ?? ['in'];
    const already = filled.get(to) ?? new Set(current.edges.filter((e) => e.to === to).map((e) => e.slot));
    const slot = wr.slot ?? required.find((sl) => !already.has(sl)) ?? required[0] ?? 'in';
    if (toDef !== null && !toDef.inputs.slots.includes(slot)) {
      at(wr.line, `'${toDef.kind}' has no input slot '${slot}' - its slots are: ${toDef.inputs.slots.join(', ')}`);
      continue;
    }
    already.add(slot);
    filled.set(to, already);
    targetWires.push({ from, port, to, slot });
  }
  if (errors.length > 0) return { ok: false, errors: [...errors, DIALECT_FIX_SENTENCE] };

  // The call plan: places, params, toggles, unwires, wires, removes; pins after.
  for (const s of parsed.steps) {
    const cur = current.steps[s.id];
    if (cur === undefined) {
      calls.push({
        verb: 'flows_place_step',
        params: { stepKind: s.kind, ...(Object.keys(s.params).length > 0 ? { params: s.params } : {}) },
        says: `place ${actualId.get(s.id)} (${s.kind})`,
      });
      if (s.off) calls.push({ verb: 'flows_toggle_step', params: { stepId: actualId.get(s.id), disabled: true }, says: `switch ${actualId.get(s.id)} off` });
      continue;
    }
    const changed: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(s.params)) {
      if (!deepEq(cur.params?.[k], v)) changed[k] = v;
    }
    for (const k of Object.keys(cur.params ?? {})) {
      if (!(k in s.params)) {
        changed[k] = null;
        warnings.push(`step '${s.id}': param '${k}' was dropped - it lands as null (the merge door cannot unset a key)`);
      }
    }
    if (Object.keys(changed).length > 0) {
      calls.push({ verb: 'flows_set_step_params', params: { stepId: s.id, params: changed }, says: `set ${s.id} params` });
    }
    if ((cur.disabled === true) !== s.off) {
      calls.push({ verb: 'flows_toggle_step', params: { stepId: s.id, disabled: s.off }, says: `switch ${s.id} ${s.off ? 'off' : 'on'}` });
    }
  }
  const targetIds = new Set(parsed.steps.map((s) => actualId.get(s.id)!));
  const wireKey = (e: { from: string; port: string; to: string; slot: string }): string => `${e.from}\u0000${e.port}\u0000${e.to}\u0000${e.slot}`;
  const currentWireKeys = new Map(current.edges.map((e) => [wireKey(e), e]));
  const targetWireKeys = new Set(targetWires.map(wireKey));
  for (const [key, e] of currentWireKeys) {
    if (targetWireKeys.has(key)) continue;
    if (parsed.keepRest) continue;
    if (!targetIds.has(e.from) || !targetIds.has(e.to)) continue; // a removed step takes its wires with it
    calls.push({ verb: 'flows_unwire_steps', params: { from: e.from, to: e.to, port: e.port, slot: e.slot }, says: `unwire ${e.from} -> ${e.to}` });
  }
  for (const e of targetWires) {
    if (currentWireKeys.has(wireKey(e))) continue;
    calls.push({ verb: 'flows_wire_steps', params: { from: e.from, to: e.to, port: e.port, slot: e.slot }, says: `wire ${e.from}:${e.port} -> ${e.to}:${e.slot}` });
  }
  if (!parsed.keepRest) {
    for (const id of Object.keys(current.steps)) {
      if (targetIds.has(id)) continue;
      calls.push({ verb: 'flows_remove_step', params: { stepId: id }, says: `remove ${id}` });
    }
  }

  // Pins: declared sample outputs; a kept step losing its pin line clears it.
  const pins: FlowCompileOk['pins'] = [];
  const pinIds = new Set<string>();
  for (const p of parsed.pins) {
    const id = actualId.get(p.id) ?? (current.steps[p.id] !== undefined ? p.id : null);
    if (id === null) { at(p.line, `pin names no step '${p.id}'`); continue; }
    pinIds.add(id);
    const cur = current.steps[id]?.pinned;
    const curItems = cur?.map((it) => it.json);
    if (!deepEq(curItems, p.items)) pins.push({ stepId: id, items: p.items });
  }
  if (!parsed.keepRest) {
    for (const [id, s] of Object.entries(current.steps)) {
      if (s.pinned !== undefined && targetIds.has(id) && !pinIds.has(id)) pins.push({ stepId: id, items: null });
    }
  }
  if (errors.length > 0) return { ok: false, errors: [...errors, DIALECT_FIX_SENTENCE] };
  return { ok: true, calls, pins, renames, warnings };
}

// ---------------------------------------------------------------------------
// THE PATTERN SHELF - curated per-category pattern lines (n8n's suggested-nodes
// shape), validated against the live registries at render so no line can name a
// dead kind or component. Served through describe {thing:'shelf'}; compact.
// ---------------------------------------------------------------------------

interface FlowPattern { hint: string; chain: string[]; note?: string }

const FLOW_PATTERNS: FlowPattern[] = [
  { hint: 'copy the rows that match', chain: ['get-rows', 'keep-rows', 'save-rows'] },
  { hint: 'branch on a value', chain: ['get-rows', 'if', 'save-rows'], note: "if outputs true/false - wire each: 'wire gate:true -> a', 'wire gate:false -> stop'" },
  { hint: 'pull a service and store the result', chain: ['call-integration', 'edit-fields', 'save-rows'] },
  { hint: 'digest a table into numbers', chain: ['get-rows', 'aggregate', 'save-rows'] },
  { hint: 'watch a feed without duplicates', chain: ['read-feed', 'dedupe', 'save-rows'] },
  { hint: 'work a big table in chunks', chain: ['get-rows', 'batches', 'edit-fields'], note: 'wire the work back into batches - it loops the envelope until the rows run out' },
  { hint: 'join two sources', chain: ['get-rows', 'merge'], note: "merge names its input slots - wire both sources: 'wire a -> merge:a', 'wire b -> merge:b'" },
  { hint: 'route rows down different lanes', chain: ['get-rows', 'split-by-rules'], note: 'the rule ids are the output ports' },
  { hint: 'run sealed code over rows', chain: ['get-rows', 'run-tool', 'save-rows'] },
  { hint: 'answer the webhook caller', chain: ['make-text', 'answer-caller'] },
  { hint: 'summarize text into a field', chain: ['get-rows', 'summarize', 'save-rows'] },
];

interface ScreenPattern { hint: string; line: string }

/** The five's shapes; every line names primitives and properties the contract carries (checked at render). */
const SCREEN_PATTERNS: ScreenPattern[] = [
  { hint: 'a free hero on the artboard', line: 'the root is layout: "none" - a child sits at its own x and y (every node always carries them; a laid-out parent derives them)' },
  { hint: 'free placement inside a laid-out parent', line: 'a child with free: true leaves its row, column or grid parent\'s flow and sits at its own x and y while still nesting inside' },
  { hint: 'a badge pinned to a corner', line: 'frame { free: true, x: 260, y: -8, pin: { x: "right", y: "top" } } holds that corner while the parent resizes' },
  { hint: 'pin a child into a grid cell', line: 'inside a frame { layout: "grid" } a child with cell: { column: 2, row: 1, column-span: 2 } occupies that cell; omit cell and the grid deals children in order' },
  { hint: 'the phone reflow', line: 'free screens reflow at phone by the engine; override with at phone { } only what reads wrong - a stacking row is at phone { layout: "column" }' },
  { hint: 'a list over a table', line: "frame { layout: \"column\", each: \"orders\" } with the row template as its children; row('col') reads the row" },
  { hint: 'a form that appends a row', line: 'field siblings (name: the action param) inside a frame whose action: { run: "<declared action>" } - the frame collects its fields' },
  { hint: 'a metric header', line: "frame { layout: \"grid\", columns: 4, gap: 12 } of metric frames - a quiet label text over a value text with expr(\"count('orders')\")" },
  { hint: 'a chart', line: 'chart { query: "revenue", mark: "bar", encoding: { x: "month", y: { field: "amount", aggregate: "sum" } } }; a second mark rides layers' },
  { hint: 'a row that opens its detail', line: 'frame { action: { goto: "<screen>", key: "_id" } } as the each template carries the row along' },
  { hint: 'a button', line: 'frame { layout: "row", align: "center", padding: 8, fill: "primary", border-radius: "capsule", action: { run: "add" } } hover { fill: "accent" } with a text child' },
  { hint: 'a modal or drawer', line: 'frame { open: false, anchor: { to: "screen", side: "center", backdrop: true, dismiss: true } } opened by a trigger frame { action: { open: "<node>" } }' },
  { hint: 'a responsive layout', line: 'frame { layout: "row", wrap: true, gap: 12 } whose children set min-width and width: "fill" - the row folds at small widths; a grid folds to one column by itself' },
  { hint: 'state looks on one node', line: "variants <set> { options: ...; default: ... } on the parent + 'when <set> = <option>' members" },
];

const SHELF_GOTCHAS = [
  'a step with no incoming wire runs only when a trigger or a screen action starts the flow there',
  'params take pills: step("id","path") reads an upstream field; tmpl("Hi {{n}}", { n: ... }) templates text',
  'pin <id> = [ { ...sample item... } ] declares a step\'s sample output so downstream mapping is checkable before a run',
  'triggers are separate citizens - a trigger line in the project dialect (the clock kind is the cadence); they never appear inside the flow block',
  'contract before placing anything whose params you have not seen - guessing params is the one reliable failure',
];

/** The shelf: one patternHint line per common shape + gotchas; category 'flows' | 'screens' | 'services' | 'all'. */
export function patternShelf(category = 'all'): string {
  const cat = category.toLowerCase();
  const lines: string[] = [];
  if (cat === 'all' || cat === 'flows' || cat === 'flow') {
    lines.push("FLOW PATTERNS (wire left to right; contract {names:['<step kind>']} for params):");
    for (const p of FLOW_PATTERNS) {
      if (p.chain.some((k) => resolveFlowStepDef(k) === null)) continue; // never name a dead kind
      lines.push(`- ${p.hint}: ${p.chain.join(' -> ')}${p.note !== undefined ? ` (${p.note})` : ''}`);
    }
  }
  if (cat === 'all' || cat === 'screens' || cat === 'screen') {
    // Every word a line speaks as a primitive or a property must be in the contract - a line naming a dead one never renders.
    const known = new Set<string>([...PRIMITIVE_NAMES, ...PRIMITIVE_NAMES.flatMap((n) => Object.keys(propertiesOf(n)))]);
    lines.push('SCREEN PATTERNS (dialect shapes; contract the primitive before writing a property you have not seen):');
    for (const p of SCREEN_PATTERNS) {
      const words = [...p.line.matchAll(/\b([a-z][a-z-]*)(?=:| \{)/g)].map((m) => m[1]!).filter((w) => !['options', 'default', 'variants', 'when', 'hover', 'at', 'phone', 'field', 'run', 'goto', 'key', 'to', 'side', 'backdrop', 'dismiss', 'open', 'aggregate', 'column', 'row', 'column-span'].includes(w));
      if (words.some((w) => !known.has(w))) continue;
      lines.push(`- ${p.hint}: ${p.line}`);
    }
  }
  if (cat === 'all' || cat === 'services' || cat === 'service') {
    const byCat = new Map<string, string[]>();
    for (const d of listIntegrationDefs()) {
      (byCat.get(d.category) ?? byCat.set(d.category, []).get(d.category)!).push(d.name);
    }
    lines.push("SERVICE CATEGORIES (contract {names:['<word>']} searches; an exact name answers endpoints):");
    for (const [c, names] of [...byCat.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      lines.push(`- ${c} (${names.length}): ${names.slice(0, 5).join(', ')}${names.length > 5 ? ', ...' : ''}`);
    }
  }
  if (lines.length === 0) return `no shelf category '${category}' - the categories are flows, screens, services, all`;
  lines.push('GOTCHAS:');
  for (const g of SHELF_GOTCHAS) lines.push(`- ${g}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// TYPED DEFINITIONS - the registries rendered as compact typedefs with hint
// comments, on demand (describe serves these; no build-time files).
// ---------------------------------------------------------------------------

const tdType = (p: { type: string; enum?: string[] }): string =>
  p.type === 'enum' ? (p.enum ?? []).map((e) => JSON.stringify(e)).join(' | ')
    : p.type === 'json' ? 'object' : p.type;

// The five's typedefs render from the contract itself: renderPrimitiveTypedef / renderSharedGroupsTypedef in @nodeloom/core.

export function renderStepTypedef(def: FlowStepDef): string {
  const lines: string[] = [];
  lines.push(`// ${def.displayName} - ${def.blurb}`);
  lines.push(`step <id> = ${def.kind} {`);
  for (const [name, p] of Object.entries(def.params)) {
    const hints: string[] = [];
    if (p.help !== undefined) hints.push(p.help);
    if (p.hint !== undefined) hints.push(p.hint);
    if (p.pill === true) hints.push('takes a pill');
    if (p.showWhen !== undefined) hints.push(`only while ${p.showWhen.param} is ${p.showWhen.is.join('/')}`);
    lines.push(`  ${bareKey(name)}${p.required === true ? '' : '?'}: ${tdType({ type: p.type, ...(p.choices !== undefined ? { enum: p.choices } : {}) })}${hints.length > 0 ? `   // ${hints.join('; ')}` : ''}`);
  }
  lines.push('}');
  const outs = def.outputs === 'dynamic' ? 'dynamic (derived from params)' : def.outputs.join(', ');
  lines.push(`// inputs: ${def.inputs.slots.map((s) => `${s}${def.inputs.required.includes(s) ? '' : '?'}`).join(', ')} | outputs: ${outs} - wire <from>:<port> -> <to>:<slot>`);
  if (def.guidance !== undefined) lines.push(`// ${def.guidance}`);
  for (const ex of def.examples?.slice(0, 2) ?? []) {
    lines.push(`// example (${ex.title}): step x = ${def.kind} ${renderValue(ex.params)}${ex.note !== undefined ? ` - ${ex.note}` : ''}`);
  }
  return lines.join('\n');
}

// A governed verb's params contract rendered live from its zod schema: nested objects,
// arrays of objects, enums in full, optional marks, hint comments, one example payload.
interface ZodDefView {
  typeName?: string;
  description?: string;
  shape?: () => Record<string, z.ZodTypeAny>;
  type?: z.ZodTypeAny;
  innerType?: z.ZodTypeAny;
  schema?: z.ZodTypeAny;
  keyType?: z.ZodTypeAny;
  valueType?: z.ZodTypeAny;
  values?: string[];
  options?: z.ZodTypeAny[];
  items?: z.ZodTypeAny[];
  value?: unknown;
  defaultValue?: () => unknown;
  minLength?: { value: number } | null;
  maxLength?: { value: number } | null;
  checks?: Array<{ kind: string; value?: unknown }>;
}

const zdef = (s: z.ZodTypeAny): ZodDefView => (s as unknown as { _def: ZodDefView })._def;

/** Peels Optional / Nullable / Default / Effects; reports the marks they carried. */
function zPeel(s: z.ZodTypeAny): { inner: z.ZodTypeAny; optional: boolean; nullable: boolean; hints: string[] } {
  let inner = s;
  let optional = false;
  let nullable = false;
  const hints: string[] = [];
  for (;;) {
    const d = zdef(inner);
    if (d.typeName === 'ZodOptional' && d.innerType !== undefined) { optional = true; inner = d.innerType; continue; }
    if (d.typeName === 'ZodNullable' && d.innerType !== undefined) { nullable = true; inner = d.innerType; continue; }
    if (d.typeName === 'ZodDefault' && d.innerType !== undefined) {
      optional = true;
      if (d.defaultValue !== undefined) hints.push(`default ${JSON.stringify(d.defaultValue())}`);
      inner = d.innerType; continue;
    }
    if (d.typeName === 'ZodEffects' && d.schema !== undefined) { inner = d.schema; continue; }
    return { inner, optional, nullable, hints };
  }
}

/** The hint words a leaf's checks carry (lengths, ranges, formats). */
function zHints(s: z.ZodTypeAny): string[] {
  const d = zdef(s);
  const out: string[] = [];
  if (typeof d.description === 'string' && d.description.length > 0) out.push(d.description);
  for (const c of d.checks ?? []) {
    if (c.kind === 'min' && d.typeName === 'ZodString') out.push(c.value === 1 ? 'non-empty' : `min ${String(c.value)} chars`);
    else if (c.kind === 'max' && d.typeName === 'ZodString') out.push(`max ${String(c.value)} chars`);
    else if (c.kind === 'min' && d.typeName === 'ZodNumber') out.push(`min ${String(c.value)}`);
    else if (c.kind === 'max' && d.typeName === 'ZodNumber') out.push(`max ${String(c.value)}`);
    else if (c.kind === 'int') out.push('integer');
    else if (c.kind === 'uuid' || c.kind === 'url' || c.kind === 'email' || c.kind === 'regex') out.push(c.kind);
  }
  if (d.typeName === 'ZodArray' && (d.minLength || d.maxLength)) out.push(`${d.minLength?.value ?? ''}..${d.maxLength?.value ?? ''} items`);
  return out;
}

/** The type text of one schema at an indent; objects open multi-line blocks in the typedef register. */
function zType(s: z.ZodTypeAny, indent: string): string {
  const { inner, nullable } = zPeel(s);
  const d = zdef(inner);
  const orNull = nullable ? ' | null' : '';
  switch (d.typeName) {
    case 'ZodString': return `string${orNull}`;
    case 'ZodNumber': return `number${orNull}`;
    case 'ZodBoolean': return `boolean${orNull}`;
    case 'ZodLiteral': return `${JSON.stringify(d.value)}${orNull}`;
    case 'ZodEnum': return `${(d.values ?? []).map((v) => JSON.stringify(v)).join(' | ')}${orNull}`;
    case 'ZodNativeEnum': return `${Object.values((d as unknown as { values: Record<string, unknown> }).values).map((v) => JSON.stringify(v)).join(' | ')}${orNull}`;
    case 'ZodArray': return `${d.type !== undefined ? zType(d.type, indent) : 'any'}[]${orNull}`;
    case 'ZodRecord': return `{ [key: ${d.keyType !== undefined ? zType(d.keyType, indent) : 'string'}]: ${d.valueType !== undefined ? zType(d.valueType, indent) : 'any'} }${orNull}`;
    case 'ZodTuple': return `[${(d.items ?? []).map((i) => zType(i, indent)).join(', ')}]${orNull}`;
    case 'ZodUnion': case 'ZodDiscriminatedUnion': return `${(d.options ?? []).map((o) => zType(o, indent)).join(' | ')}${orNull}`;
    case 'ZodObject': return `${zObjectBlock(inner, indent)}${orNull}`;
    default: return `any${orNull}`;
  }
}

/** `{ field?: type   // hints ... }` across lines; nested objects indent one step deeper. */
function zObjectBlock(s: z.ZodTypeAny, indent: string): string {
  const shape = zdef(s).shape?.() ?? {};
  const deeper = `${indent}  `;
  const lines: string[] = ['{'];
  for (const [name, field] of Object.entries(shape)) {
    const peeled = zPeel(field);
    const hints = [...peeled.hints, ...zHints(peeled.inner)];
    const type = zType(field, deeper);
    lines.push(`${deeper}${bareKey(name)}${peeled.optional ? '?' : ''}: ${type}${hints.length > 0 ? `   // ${hints.join('; ')}` : ''}`);
  }
  lines.push(`${indent}}`);
  return lines.join('\n');
}

/** One example value in the schema's shape; required fields only, one item per array. */
function zExample(s: z.ZodTypeAny, name: string): unknown {
  const { inner } = zPeel(s);
  const d = zdef(inner);
  switch (d.typeName) {
    case 'ZodString': {
      const c = d.checks ?? [];
      if (c.some((k) => k.kind === 'uuid')) return '00000000-0000-4000-8000-000000000000';
      if (c.some((k) => k.kind === 'url')) return 'https://example.com';
      if (c.some((k) => k.kind === 'email')) return 'name@example.com';
      return name;
    }
    case 'ZodNumber': {
      const min = (d.checks ?? []).find((k) => k.kind === 'min');
      return typeof min?.value === 'number' ? min.value : 1;
    }
    case 'ZodBoolean': return true;
    case 'ZodLiteral': return d.value;
    case 'ZodEnum': return d.values?.[0] ?? name;
    case 'ZodNativeEnum': return Object.values((d as unknown as { values: Record<string, unknown> }).values)[0];
    case 'ZodArray': return d.type !== undefined ? [zExample(d.type, name)] : [];
    case 'ZodRecord': return { key: d.valueType !== undefined ? zExample(d.valueType, 'value') : 'value' };
    case 'ZodTuple': return (d.items ?? []).map((i, n) => zExample(i, `${name}${n}`));
    case 'ZodUnion': case 'ZodDiscriminatedUnion': return d.options?.[0] !== undefined ? zExample(d.options[0], name) : name;
    case 'ZodObject': {
      const out: Record<string, unknown> = {};
      for (const [k, f] of Object.entries(zdef(inner).shape?.() ?? {})) {
        if (!zPeel(f).optional) out[k] = zExample(f, k);
      }
      return out;
    }
    default: return name;
  }
}

export function renderActionTypedef(name: string, schema: z.ZodTypeAny, opts?: { lands?: string; consent?: string }): string {
  const lines: string[] = [];
  lines.push(`// ${name} - ${opts?.lands ?? 'a governed verb'}${opts?.consent !== undefined ? ` [consent ${opts.consent}]` : ''}`);
  const { inner } = zPeel(schema);
  lines.push(`${name} ${zdef(inner).typeName === 'ZodObject' ? zObjectBlock(inner, '') : zType(schema, '')}`);
  lines.push(`// example params: ${renderValue(zExample(schema, name))}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// SQL wrappers - the lens doors and the compile-at-the-door entries the tool
// surface and the scene_revise executor call.
// ---------------------------------------------------------------------------

export async function sceneDialectLens(
  sql: postgres.Sql,
  input: { orgId: string; sceneSlug: string; nodeId?: string; depth?: number; maxNodes?: number },
): Promise<{ ok: true; revision: number; code: string; truncated: boolean } | { ok: false; error: string }> {
  const scene = await requireScene(sql, input.orgId, input.sceneSlug);
  const doc = await getSceneDocument(sql, { orgId: input.orgId, sceneId: scene.id });
  if (input.nodeId !== undefined && doc.nodes[input.nodeId] === undefined) {
    return { ok: false, error: `no node '${input.nodeId}' on screen '${input.sceneSlug}'` };
  }
  // The queries the screen names ride as a header so each / chart / a search field can name them.
  const header = (await getSceneBindings(sql, { orgId: input.orgId, sceneSlug: input.sceneSlug }))
    .map((b) => `query ${b.name} reads ${b.kind === 'query' ? `table ${b.table} (limit ${b.query?.limit ?? 200})` : b.kind === 'asset' ? `the ${b.asset} asset` : 'the clock'}`);
  const { code, truncated } = generateSceneDialect(doc, {
    slug: input.sceneSlug,
    ...(header.length > 0 ? { header } : {}),
    ...(input.nodeId !== undefined && input.nodeId !== 'root' ? { rootId: input.nodeId } : {}),
    ...(input.depth !== undefined ? { depth: input.depth } : {}),
    ...(input.maxNodes !== undefined ? { maxNodes: input.maxNodes } : {}),
  });
  return { ok: true, revision: doc.revision, code, truncated };
}

export async function flowDialectLens(
  sql: postgres.Sql, input: { orgId: string; projectId: string },
): Promise<{ ok: true; flowId: string | null; code: string; findings: FlowFinding[] } | { ok: false; error: string }> {
  const flow = await getFlow(sql, input.orgId, { projectId: input.projectId, name: MAIN_FLOW });
  const header: string[] = [];
  try {
    // Lazy import: triggers.ts reaches consent.ts, and a static edge here would close a module cycle.
    const { listTriggers } = await import('./triggers.js');
    const triggers = (await listTriggers(sql, input.orgId))
      .filter((t) => t.projectId === input.projectId && t.revokedAt === null);
    for (const t of triggers.slice(0, 12)) {
      header.push(`trigger ${t.kind}${t.enabled ? '' : ' (off)'}: ${JSON.stringify(t.action).slice(0, 120)} - triggers ride the project dialect's trigger lines, never this text`);
    }
  } catch { /* triggers are a comment, never a gate */ }
  if (flow === null) {
    return {
      ok: true, flowId: null, findings: [],
      code: [`flow ${MAIN_FLOW}`, ...header.map((h) => `# ${h}`), '# empty - declare steps and wires; submitting this text builds the flow'].join('\n'),
    };
  }
  const doc = flowDocSchema.parse(flow.doc);
  const tables = await sql<{ name: string }[]>`
    select name from datasets where org_id = ${input.orgId} and project_id = ${input.projectId} and deleted_at is null`;
  const findings = validateFlowDoc(doc, { tables: new Set(tables.map((t) => t.name)) });
  return { ok: true, flowId: flow.id, code: generateFlowDialect(doc, { header }), findings };
}

/** Compile screen dialect against the live document; the executor and the deep-validate both
 * enter here. The project's theme (when one is stored) feeds the lint. */
export async function compileSceneDialectAt(
  sql: postgres.Sql, input: { orgId: string; sceneSlug: string; code: string },
): Promise<SceneCompileResult> {
  let scene: Awaited<ReturnType<typeof requireScene>>;
  try {
    scene = await requireScene(sql, input.orgId, input.sceneSlug);
  } catch (e) {
    return { ok: false, errors: [e instanceof Error ? e.message : String(e)] };
  }
  const doc = await getSceneDocument(sql, { orgId: input.orgId, sceneId: scene.id });
  let theme: ProjectTheme | null = null;
  try {
    const [row] = await sql<{ theme: unknown }[]>`
      select p.theme from scenes s join projects p on p.id = s.project_id
      where s.org_id = ${input.orgId} and s.slug = ${input.sceneSlug}`;
    const parsed = projectThemeSchema.safeParse(row?.theme);
    if (parsed.success) theme = parsed.data;
  } catch { /* no theme = the bans and budgets alone */ }
  return compileSceneDialect(doc, input.code, { screen: input.sceneSlug, theme });
}

/** Compile flow dialect against the project's working flow (an absent flow compiles from empty). */
export async function compileFlowDialectAt(
  sql: postgres.Sql, input: { orgId: string; projectId: string; code: string },
): Promise<FlowCompileResult & { flowId?: string | null }> {
  const flow = await getFlow(sql, input.orgId, { projectId: input.projectId, name: MAIN_FLOW });
  const doc: FlowDoc = flow === null ? { version: 1, steps: {}, edges: [] } : flowDocSchema.parse(flow.doc);
  const res = compileFlowDialect(doc, input.code);
  return { ...res, flowId: flow?.id ?? null };
}

/** The ops one landed revision carried - the receipt reads these instead of re-compiling. */
export async function landedRevisionOps(
  sql: postgres.Sql, input: { orgId: string; sceneSlug: string; revisionNo: number },
): Promise<SceneOp[]> {
  const rows = await sql<{ ops: unknown }[]>`
    select r.ops from scene_revisions r
    join scenes s on s.id = r.scene_id
    where s.org_id = ${input.orgId} and s.slug = ${input.sceneSlug} and r.revision_no = ${input.revisionNo}`;
  const raw = rows[0]?.ops;
  return Array.isArray(raw) ? (raw as SceneOp[]) : [];
}

// ===========================================================================
// THE PROJECT DIALECT (AI-surface rebuild, Phase 9C) - the third half beside
// screens and flows. The whole project is ONE document: the generator renders
// the project lens from the live model (rows never render; commands never
// render), the interpreter diffs the submitted text against it and emits one
// op per changed construct in dependency order. Every op maps to a standing
// registry row (raised through the consent gate) or a standing kernel door
// (the free data/notes/mission doors); the registries do not change.
// ===========================================================================

// ---------------------------------------------------------------------------
// The construct table (ruling 6): every governed verb spoken as its construct.
// __ALWAYS_WAITS__ and the card's construct line derive from this, never prose.
// ---------------------------------------------------------------------------

export type ConstructKind =
  | 'project' | 'theme' | 'table' | 'rows' | 'screen' | 'flow' | 'trigger' | 'service' | 'call'
  | 'chain' | 'operation' | 'run' | 'component' | 'plan' | 'dispatch' | 'mission'
  | 'package' | 'note' | 'mode' | 'settings' | 'thread' | 'create-project' | 'canvas';

/** verb -> the construct it compiles from and the plain words a card or a list speaks. */
export const CONSTRUCT_OF_VERB: Record<string, { construct: ConstructKind; says: string }> = {
  rename_project: { construct: 'project', says: 'renaming the project' },
  app_plan: { construct: 'plan', says: 'the plan' },
  create_project: { construct: 'create-project', says: 'creating a project' },
  org_settings: { construct: 'settings', says: 'settings' },
  thread_mode: { construct: 'mode', says: 'mode' },
  connect_service: { construct: 'service', says: 'keys' },
  component_proposal: { construct: 'component', says: 'a new component' },
  import_component: { construct: 'component', says: 'importing a component' },
  scene_revise: { construct: 'screen', says: 'editing a screen' },
  create_view: { construct: 'screen', says: 'a new screen' },
  revise_view: { construct: 'screen', says: 'binding a screen' },
  delete_view: { construct: 'screen', says: 'deleting a screen' },
  rename_view: { construct: 'screen', says: 'renaming a screen' },
  operation_proposal: { construct: 'operation', says: 'a new operation' },
  run_operation: { construct: 'run', says: 'running an operation' },
  create_reactive_chain: { construct: 'chain', says: 'a chain' },
  revoke_reactive_chain: { construct: 'chain', says: 'removing a chain' },
  create_trigger: { construct: 'trigger', says: 'arming a trigger' },
  delete_trigger: { construct: 'trigger', says: 'deleting a trigger' },
  flows_place_step: { construct: 'flow', says: 'editing the flow' },
  flows_wire_steps: { construct: 'flow', says: 'editing the flow' },
  flows_unwire_steps: { construct: 'flow', says: 'editing the flow' },
  flows_set_step_params: { construct: 'flow', says: 'editing the flow' },
  flows_remove_step: { construct: 'flow', says: 'editing the flow' },
  flows_toggle_step: { construct: 'flow', says: 'editing the flow' },
  integrations_place: { construct: 'service', says: 'placing a service' },
  integrations_connect: { construct: 'service', says: 'keys' },
  call_integration: { construct: 'call', says: 'calling a service' },
  import_package: { construct: 'package', says: 'importing a package' },
  export_package: { construct: 'package', says: 'exporting a package' },
  delete_dataset: { construct: 'table', says: 'deleting a table' },
  delete_thread: { construct: 'thread', says: 'deleting a thread' },
  delete_note: { construct: 'note', says: 'deleting a note' },
  work_proposal: { construct: 'dispatch', says: 'dispatching a run' },
};

/** The always-ask list spoken as constructs, read from the consent policy table; deduped, registry order. */
export function alwaysWaitsSentence(registry: Record<string, { name: string }>): string {
  const words: string[] = [];
  for (const spec of Object.values(registry)) {
    if (consentClassOf(spec) !== 'always-ask') continue;
    const said = CONSTRUCT_OF_VERB[spec.name]?.says ?? spec.name.replace(/_/g, ' ');
    if (!words.includes(said)) words.push(said);
  }
  return words.join(', ');
}

/** The construct line a consent card speaks: the verb's words plus the one name the params carry. */
export function cardConstructLine(verb: string, params: Record<string, unknown>): string {
  const said = CONSTRUCT_OF_VERB[verb]?.says ?? verb.replace(/_/g, ' ');
  const principal = ['name', 'viewSlug', 'sceneSlug', 'appTitle', 'service', 'operation', 'goal', 'fileName', 'filePath', 'titleContains', 'specContains', 'mode']
    .map((k) => params[k])
    .find((v): v is string => typeof v === 'string' && v.length > 0);
  return principal !== undefined ? `${said} - ${principal.slice(0, 80)}` : said;
}

/** Budget findings key at the screen alone (colors / fonts); every other finding is a ban. */
export function isBudgetFinding(key: string): boolean {
  return /\|\|\|(colors|fonts)$/.test(key);
}

// ---------------------------------------------------------------------------
// THE PROJECT MODEL - what the generator renders and the interpreter diffs.
// ---------------------------------------------------------------------------

type ColType = 'string' | 'number' | 'boolean';

export interface ProjectTableModel { name: string; columns: Record<string, ColType>; deprecated: string[]; keyColumns: string[] | null; rowCount: number }
export interface ProjectScreenModel { slug: string; title: string; status: string; bindings: Record<string, unknown>[]; document: SceneDocument | null; revision: number }
export interface ProjectTriggerModel { id: string; kind: string; spec: Record<string, unknown>; action: Record<string, unknown>; enabled: boolean }
export interface ProjectServiceModel { id: string; integration: string; label: string; status: string }
export interface ProjectChainModel { id: string; operation: string; inputs: Record<string, unknown>; enabled: boolean }

export interface ProjectModel {
  name: string;
  theme: ProjectTheme | null;
  tables: ProjectTableModel[];
  screens: ProjectScreenModel[];
  flow: FlowDoc | null;
  flowId: string | null;
  triggers: ProjectTriggerModel[];
  services: ProjectServiceModel[];
  chains: ProjectChainModel[];
  operations: Array<{ name: string; version: number; runtime: string; outputs: string[] }>;
  components: Array<{ name: string; version: number }>;
  notes: Array<{ id: string; body: string }>;
  /** Where each card sits on the canvas and which rest folded together; absent when not loaded. */
  canvas?: CanvasModel;
}

const shortId = (id: string): string => id.slice(0, 8);

/** A live citizen id matches its full uuid or its 8-char short form. */
const idMatches = (live: string, written: string): boolean => live === written || shortId(live) === written;

/** Note identity: whitespace- and case-insensitive body text. */
const noteKey = (body: string): string => body.trim().replace(/\s+/g, ' ').toLowerCase();

function renderTriggerAction(a: Record<string, unknown>): string {
  const type = String(a['type'] ?? '');
  if (type === 'start_flow') return `flow ${String(a['flow'] ?? MAIN_FLOW)} at ${String(a['entry'] ?? '')}`;
  if (type === 'run_operation') return `operation ${String(a['operation'] ?? '')} ${renderValue(a['inputs'] ?? {})}`;
  if (type === 'call_integration') return `call ${String(a['connection'] ?? '')}.${String(a['endpoint'] ?? '')} ${renderValue(a['params'] ?? {})}`;
  if (type === 'propose_work') {
    const rest: Record<string, unknown> = {};
    for (const k of ['brief', 'role', 'threadId']) if (a[k] !== undefined) rest[k] = a[k];
    return `dispatch ${JSON.stringify(String(a['goal'] ?? ''))} ${renderValue(rest)}`;
  }
  return renderValue(a);
}

/** The screen body: the standing screen dialect minus its header line, indented for the project block. */
function screenBodyLines(doc: SceneDocument, slug: string, depth: number, maxNodes: number): string[] {
  const { code } = generateSceneDialect(doc, { slug, depth, maxNodes });
  return code.split('\n').slice(1).filter((l, i) => !(i === 0 && l.trim().length === 0)).map((l) => `  ${l}`);
}

export interface ProjectLensOptions {
  /** Screen body depth and node budget inside the project document (the screen lens goes deeper). */
  screenDepth?: number;
  screenNodes?: number;
}

/** The theme block in its dialect form (the brief never renders inside it - it rides beside as text). */
export function renderThemeBlock(theme: ProjectTheme): string {
  const { brief: _brief, ...rest } = theme;
  return `theme ${renderValue(rest)}`;
}

/** The stored brief as text - the tool's reply and the run tail's second block. */
export function renderBriefText(brief: ProjectBrief): string {
  const palette = Object.entries(brief.palette).map(([k, v]) => `${k}: ${String(v)}`).join(', ');
  return [
    'THE BRIEF (follow it):',
    `mood: ${brief.mood}`,
    `palette: ${palette}`,
    `type pair: ${brief.typePair}`,
    `density: ${brief.density}`,
    `layout anchor: ${brief.layoutAnchor}`,
    `signature move: ${brief.signatureMove}`,
    `imagery: ${brief.imageryStance}`,
    `content tone: ${brief.contentTone}`,
    ...(brief.do.length > 0 ? [`do: ${brief.do.join('; ')}`] : []),
    ...(brief.dont.length > 0 ? [`don't: ${brief.dont.join('; ')}`] : []),
  ].join('\n');
}

/** The project lens: one document, every citizen; rows and commands never render. */
export function generateProjectDialect(m: ProjectModel, opts?: ProjectLensOptions): string {
  const depth = Math.min(Math.max(opts?.screenDepth ?? 1, 1), 12);
  const maxNodes = Math.min(Math.max(opts?.screenNodes ?? 12, 1), 200);
  const out: string[] = [`project ${JSON.stringify(m.name)}`];
  if (m.theme !== null) out.push(renderThemeBlock(m.theme));
  if (m.tables.length > 0) out.push('');
  for (const t of m.tables) {
    const cols = Object.entries(t.columns).map(([k, v]) => `${bareKey(k)}: ${v}`).join(', ');
    const notes = [`${t.rowCount} rows`];
    if (t.keyColumns !== null && t.keyColumns.length > 0) notes.push(`keys: ${t.keyColumns.join(', ')}`);
    if (t.deprecated.length > 0) notes.push(`deprecated: ${t.deprecated.join(', ')}`);
    out.push(`table ${t.name} { ${cols} }   # ${notes.join('; ')}`);
  }
  for (const s of m.screens) {
    out.push('');
    const datasets = s.bindings.filter((b) => b['kind'] === 'query').map((b) => String(b['table']));
    const others = s.bindings.filter((b) => b['kind'] !== 'query');
    const head = [`screen ${s.slug} ${JSON.stringify(s.title)}`];
    if (datasets.length > 0) head.push(`query ${datasets.join(', ')}`);
    if (s.document === null) {
      out.push(`${head.join(' ')} { }   # built on an older system - no document; recreate it to edit`);
      continue;
    }
    out.push(`${head.join(' ')} {`);
    for (const b of others) out.push(`  # binding ${String(b['name'])} (${String(b['kind'])}) - not expressible here`);
    out.push(...screenBodyLines(s.document, s.slug, depth, maxNodes));
    out.push('}');
  }
  out.push('');
  if (m.flow === null) {
    out.push(`flow ${MAIN_FLOW} { }   # empty - declare steps and wires inside`);
  } else {
    out.push(`flow ${MAIN_FLOW} {`);
    out.push(...generateFlowDialect(m.flow).split('\n').slice(1).filter((l) => l.trim().length > 0).map((l) => `  ${l}`));
    out.push('}');
  }
  if (m.triggers.length > 0 || m.services.length > 0 || m.chains.length > 0) out.push('');
  for (const t of m.triggers) {
    // A uuid prefix can start with a digit, which the reader takes as a number: such ids ride quoted.
    const tid = /^[A-Za-z_]/.test(shortId(t.id)) ? shortId(t.id) : JSON.stringify(shortId(t.id));
    out.push(`trigger ${tid} = ${t.kind} ${renderValue(t.spec)} -> ${renderTriggerAction(t.action)}${t.enabled ? '' : ' off'}`);
  }
  for (const s of m.services) {
    out.push(`service ${s.integration} ${JSON.stringify(s.label)} { }   # ${s.status}`);
  }
  for (const c of m.chains) {
    out.push(`chain ${shortId(c.id)} = ${c.operation} ${renderValue(c.inputs)}${c.enabled ? '' : ' off'}`);
  }
  if (m.operations.length > 0 || m.components.length > 0) out.push('');
  for (const o of m.operations) out.push(`# operation ${o.name}@${o.version} (${o.runtime}) outputs: ${o.outputs.join(', ') || 'none'} - propose a version with an operation line`);
  for (const c of m.components) out.push(`# component ${c.name}@${c.version} - contract {names:['${c.name}']} serves it`);
  if (m.notes.length > 0) out.push('');
  for (const n of m.notes) out.push(`note ${JSON.stringify(n.body)}`);
  if (m.canvas !== undefined) out.push('', ...renderCanvasBlock(m.canvas));
  return out.join('\n');
}

/** One table as its own lens block, with the count and (when asked) a sample. */
export function generateTableDialect(t: ProjectTableModel, sample?: Record<string, unknown>[]): string {
  const cols = Object.entries(t.columns).map(([k, v]) => `${bareKey(k)}: ${v}`).join(', ');
  const lines = [`table ${t.name} { ${cols} }   # ${t.rowCount} rows${t.keyColumns !== null && t.keyColumns.length > 0 ? `; keys: ${t.keyColumns.join(', ')}` : ''}${t.deprecated.length > 0 ? `; deprecated: ${t.deprecated.join(', ')}` : ''}`];
  if (sample !== undefined && sample.length > 0) {
    lines.push(`# sample (${sample.length} of ${t.rowCount}; rows never edit here - a rows line appends, rows {} queries):`);
    for (const r of sample) lines.push(`#   ${renderValue(r)}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// PROJECT PARSER - dialect text -> the parsed document. Screen and flow bodies
// are lifted out as token slices and re-rendered for their own halves with the
// document's line numbers intact, so every error names the line the model wrote.
// ---------------------------------------------------------------------------

interface ParsedTable { name: string; columns: Record<string, ColType>; line: number }
interface ParsedScreen { slug: string; title?: string; purpose?: string; query?: string[]; body: string | null; line: number }
interface ParsedTrigger { id: string; kind: string; spec: Record<string, unknown>; action: Record<string, unknown>; off: boolean; line: number }
interface ParsedService { name: string; label?: string; line: number }
interface ParsedChain { id: string; operation: string; inputs: Record<string, unknown>; line: number }

type ParsedCommand =
  | { kind: 'rows'; table: string; rows: Record<string, unknown>[]; replace: boolean; line: number }
  | { kind: 'keys'; service: string; line: number }
  | { kind: 'call'; service: string; endpoint: string; params: Record<string, unknown>; line: number }
  | { kind: 'run'; operation: string; inputs: Record<string, unknown>; line: number }
  | { kind: 'operation'; name: string; params: Record<string, unknown>; line: number }
  | { kind: 'component'; name: string; definition: Record<string, unknown>; line: number }
  | { kind: 'import-component'; path: string; params: Record<string, unknown>; line: number }
  | { kind: 'plan'; params: Record<string, unknown>; line: number }
  | { kind: 'dispatch'; goal: string; params: Record<string, unknown>; parts: { text: string; acceptance: string }[]; line: number }
  | { kind: 'mission'; marks: { text: string; status: string; evidence?: string }[]; line: number }
  | { kind: 'export-package'; name: string; params: Record<string, unknown>; line: number }
  | { kind: 'import-package'; path: string; params: Record<string, unknown>; line: number }
  | { kind: 'mode'; mode: string; line: number }
  | { kind: 'settings'; patch: Record<string, unknown>; line: number }
  | { kind: 'delete-thread'; words: string; line: number }
  | { kind: 'create-project'; name: string; path: string; line: number };

type MentionKind = 'table' | 'screen' | 'trigger' | 'chain' | 'note' | 'service';

interface ParsedProject {
  keepRest: boolean;
  name?: { value: string; line: number };
  theme?: { value: Record<string, unknown>; line: number };
  tables: ParsedTable[];
  screens: ParsedScreen[];
  flow?: { body: string; line: number };
  triggers: ParsedTrigger[];
  services: ParsedService[];
  chains: ParsedChain[];
  notes: Array<{ text: string; line: number }>;
  canvas?: { body: string; line: number };
  commands: ParsedCommand[];
  mentioned: Set<MentionKind>;
}

/** Tokens back to text, one space apart, newlines kept - the sub-halves re-tokenize it losslessly. */
function renderTokens(toks: Tok[]): string {
  let out = '';
  let space = false;
  for (const t of toks) {
    if (t.t === 'nl') { out += '\n'; space = false; continue; }
    if (t.t === 'end') break;
    const s = t.t === 'word' ? t.v : t.t === 'str' ? JSON.stringify(t.v) : t.t === 'num' ? String(t.v) : t.t === 'dots' ? '...' : t.v;
    out += (space ? ' ' : '') + s;
    space = true;
  }
  return out;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function parseProjectDialect(code: string): ParsedProject {
  if (code.length > MAX_CODE_CHARS) throw new DialectError(`the code is over ${MAX_CODE_CHARS} characters - submit one kind at a time`);
  const toks = tokenize(stripLineNumbers(code));
  if (typeof toks === 'string') throw new DialectError(toks);
  const c = new Cursor(toks);
  const out: ParsedProject = { keepRest: false, tables: [], screens: [], triggers: [], services: [], chains: [], notes: [], commands: [], mentioned: new Set() };

  const word = (what: string): { v: string; line: number } => {
    const t = c.next(true);
    if (t.t !== 'word') err(t.line, `expected ${what}`);
    return { v: (t as { v: string }).v, line: t.line };
  };
  const str = (what: string): string => {
    const t = c.next(true);
    if (t.t !== 'str') err(t.line, `expected ${what} as a quoted string`);
    return (t as { v: string }).v;
  };
  const wordOrStr = (what: string): string => {
    const t = c.next(true);
    if (t.t !== 'word' && t.t !== 'str') err(t.line, `expected ${what}`);
    return String((t as { v: string | number }).v);
  };
  const objectValue = (what: string, line: number): Record<string, unknown> => {
    const v = parseValue(c, 'plain');
    if (!isObj(v)) err(line, `${what} takes an object { ... }`);
    return v as Record<string, unknown>;
  };
  const optionalObject = (): Record<string, unknown> => (c.atP('{', true) ? objectValue('this block', c.peek(true).line) : {});
  /** Lifts a brace block's tokens (after the opening '{') and renders them with the document's line numbers. */
  const liftBlock = (header: string, line: number): string => {
    c.expectP('{', `opening the ${header.split(' ')[0]} block on line ${line}`);
    const start = c.index();
    let depth = 1;
    for (;;) {
      const t = c.next();
      if (t.t === 'end') err(line, `the block opened on line ${line} is never closed - add '}'`);
      if (t.t === 'p' && t.v === '{') depth++;
      if (t.t === 'p' && t.v === '}') { depth--; if (depth === 0) break; }
    }
    const body = c.slice(start, c.index() - 1);
    const first = body.find((t) => t.t !== 'nl');
    const firstLine = first?.line ?? line;
    return `${header}${firstLine > 1 ? '\n'.repeat(firstLine - 1) : ' '}${renderTokens(body)}`;
  };
  /** A block's tokens as text, each on its own document line, so the reader's line numbers stay exact. */
  const linedBlock = (line: number): string => {
    c.expectP('{', `opening the block on line ${line}`);
    const rows: string[][] = [];
    let depth = 1;
    for (;;) {
      const t = c.next();
      if (t.t === 'end') err(line, `the block opened on line ${line} is never closed - add '}'`);
      if (t.t === 'p' && t.v === '{') depth++;
      if (t.t === 'p' && t.v === '}') { depth--; if (depth === 0) break; }
      if (t.t === 'nl') continue;
      (rows[t.line - 1] ??= []).push(renderTokens([t]));
    }
    return Array.from({ length: rows.length }, (_, i) => (rows[i] ?? []).join(' ')).join('\n');
  };
  const wordList = (what: string): string[] => {
    const list: string[] = [];
    for (;;) {
      list.push(wordOrStr(what));
      if (c.atP(',')) { c.next(); continue; }
      break;
    }
    return list;
  };
  const bracketWords = (what: string): string[] => {
    c.expectP('[', `opening ${what}`);
    const list: string[] = [];
    while (!c.atP(']', true)) {
      list.push(wordOrStr(what));
      if (c.atP(',', true)) c.next(true);
    }
    c.next(true);
    return list;
  };
  const parseTableBlock = (name: string, line: number): { columns: Record<string, ColType> } => {
    c.expectP('{', `opening table '${name}'`);
    const columns: Record<string, ColType> = {};
    while (!c.atP('}', true)) {
      const k = c.next(true);
      if (k.t !== 'word' && k.t !== 'str') err(line, `expected a column name inside table '${name}'`);
      const key = String((k as { v: string | number }).v);
      // A table line carries columns alone: provenance refuses here, never parsed-and-ignored.
      if (key === 'provenance') err(line, `table '${name}': provenance is a plan word - put it on the plan block's table row; a table line carries columns alone`);
      c.expectP(':', `after column '${key}'`);
      const v = c.next(true);
      if (v.t !== 'word') err(line, `column '${key}' takes a type word: string, number, boolean`);
      const type = (v as { v: string }).v;
      if (type === 'string' || type === 'number' || type === 'boolean') columns[key] = type;
      else err(line, `column '${key}': '${type}' is not a type - string, number, boolean`);
      if (c.atP(',') || c.atP(';')) c.next();
    }
    c.next(true);
    return { columns };
  };
  const parseTriggerAction = (line: number): Record<string, unknown> => {
    const head = word("the trigger's action: flow / operation / call / dispatch");
    if (head.v === 'flow') {
      const flow = c.atWord('at') ? MAIN_FLOW : word('the flow name').v;
      const at = word("'at'");
      if (at.v !== 'at') err(line, "a flow action reads 'flow main at <entry step>'");
      return { type: 'start_flow', flow, entry: word('the entry step id').v };
    }
    if (head.v === 'operation') return { type: 'run_operation', operation: word('the operation name').v, inputs: optionalObject() };
    if (head.v === 'call') {
      const target = word('<service>.<endpoint>').v;
      const dot = target.lastIndexOf('.');
      if (dot <= 0 || dot === target.length - 1) err(line, "a call action reads 'call <service>.<endpoint> { params }'");
      return { type: 'call_integration', connection: target.slice(0, dot), endpoint: target.slice(dot + 1), params: optionalObject() };
    }
    if (head.v === 'dispatch') return { type: 'propose_work', goal: str('the goal'), ...optionalObject() };
    err(line, `'${head.v}' is not a trigger action - flow main at <step> / operation <name> { } / call <service>.<endpoint> { } / dispatch "<goal>" { }`);
    return {};
  };

  for (;;) {
    const t = c.peek(true);
    if (t.t === 'end') break;
    if (t.t === 'dots') { c.next(true); out.keepRest = true; continue; }
    if (t.t !== 'word') err(t.line, `expected a construct (project / theme / table / rows / screen / flow / trigger / service / call / run / chain / operation / component / import / plan / dispatch / mission / export / note / canvas / mode / settings / delete / create), got '${t.t === 'p' ? (t as { v: string }).v : t.t}'`);
    const w = c.next(true) as { t: 'word'; v: string; line: number };
    const line = w.line;
    switch (w.v) {
      case 'project': out.name = { value: str('the project name'), line }; break;
      case 'theme': out.theme = { value: objectValue('theme', line), line }; break;
      case 'table': {
        const name = word('the table name').v;
        const block = parseTableBlock(name, line);
        out.tables.push({ name, ...block, line });
        out.mentioned.add('table');
        break;
      }
      case 'rows': {
        const table = word('the table name').v;
        const rows = parseValue(c, 'plain');
        if (!Array.isArray(rows) || !rows.every(isObj)) err(line, 'rows takes an array of row objects: rows <table> [ { ... }, ... ]');
        out.commands.push({ kind: 'rows', table, rows: rows as Record<string, unknown>[], replace: false, line });
        break;
      }
      case 'replace': {
        if (word("'rows'").v !== 'rows') err(line, "'replace' reads 'replace rows <table> [ ... ]'");
        const table = word('the table name').v;
        const rows = parseValue(c, 'plain');
        if (!Array.isArray(rows) || !rows.every(isObj)) err(line, 'replace rows takes an array of row objects');
        out.commands.push({ kind: 'rows', table, rows: rows as Record<string, unknown>[], replace: true, line });
        break;
      }
      case 'screen': {
        const slug = wordOrStr('the screen slug');
        const s: ParsedScreen = { slug, body: null, line };
        if (c.peek().t === 'str') s.title = str('the title');
        for (;;) {
          if (c.atWord('purpose')) { c.next(); s.purpose = str('the purpose'); continue; }
          if (c.atWord('query')) { c.next(); s.query = wordList('a table name'); continue; }
          break;
        }
        if (!c.atP('{', true)) err(line, `screen '${slug}' opens a block with '{' (an empty { } declares it without a body)`);
        const body = liftBlock(`screen ${slug}`, line);
        s.body = body.replace(/^screen \S+/, '').trim().length > 0 ? body : null;
        out.screens.push(s);
        out.mentioned.add('screen');
        break;
      }
      case 'flow': {
        if (c.peek().t === 'word' && !c.atP('{')) c.next();
        out.flow = { body: liftBlock(`flow ${MAIN_FLOW}`, line), line };
        break;
      }
      case 'trigger': {
        const idTok = c.next(true);
        if (idTok.t !== 'word' && idTok.t !== 'str') err(idTok.line, 'expected the trigger id');
        const id = String((idTok as { v: string }).v);
        c.expectP('=', "in 'trigger <id> = <kind> { spec } -> <action>'");
        const kind = word('the trigger kind').v;
        const spec = objectValue(`trigger '${id}' spec`, line);
        c.expectP('->', "before the trigger's action");
        const action = parseTriggerAction(line);
        let off = false;
        if (c.atWord('off')) { c.next(); off = true; }
        out.triggers.push({ id, kind, spec, action, off, line });
        out.mentioned.add('trigger');
        break;
      }
      case 'service': {
        const name = word('the service name').v;
        if (c.atWord('keys')) { c.next(); out.commands.push({ kind: 'keys', service: name, line }); break; }
        const s: ParsedService = { name, line };
        if (c.peek().t === 'str') s.label = str('the label');
        c.expectP('{', `opening service '${name}' (an empty { } places it)`);
        c.expectP('}', `closing service '${name}'`);
        out.services.push(s);
        out.mentioned.add('service');
        break;
      }
      case 'call': {
        const target = word('<service>.<endpoint>').v;
        const dot = target.lastIndexOf('.');
        if (dot <= 0 || dot === target.length - 1) err(line, "'call' reads 'call <service>.<endpoint> { params }'");
        out.commands.push({ kind: 'call', service: target.slice(0, dot), endpoint: target.slice(dot + 1), params: optionalObject(), line });
        break;
      }
      case 'run': out.commands.push({ kind: 'run', operation: word('the operation name').v, inputs: optionalObject(), line }); break;
      case 'chain': {
        const id = word('the chain id').v;
        c.expectP('=', "in 'chain <id> = <operation> { inputs }'");
        const operation = word('the operation name').v;
        out.chains.push({ id, operation, inputs: optionalObject(), line });
        out.mentioned.add('chain');
        break;
      }
      case 'operation': out.commands.push({ kind: 'operation', name: word('the operation name').v, params: objectValue('operation', line), line }); break;
      case 'component': {
        const first = word('the component name (kebab words)');
        const name = joinRefName(c, first.v, line);
        out.commands.push({ kind: 'component', name, definition: objectValue(`component '${name}'`, line), line });
        break;
      }
      case 'import': {
        const what = word("'component' or 'package'").v;
        if (what === 'component') out.commands.push({ kind: 'import-component', path: str('the file path'), params: optionalObject(), line });
        else if (what === 'package') out.commands.push({ kind: 'import-package', path: str('the file path'), params: optionalObject(), line });
        else err(line, "'import' reads 'import component \"<path>\"' or 'import package \"<path>\"'");
        break;
      }
      case 'plan': out.commands.push({ kind: 'plan', params: objectValue('plan', line), line }); break;
      case 'dispatch': {
        const goal = str('the goal');
        const params: Record<string, unknown> = {};
        const parts: { text: string; acceptance: string }[] = [];
        c.expectP('{', "opening the dispatch block (an empty { } dispatches the goal alone)");
        while (!c.atP('}', true)) {
          if (c.atWord('part', true)) {
            c.next(true);
            const text = str('the part text');
            c.expectP(':', `after part ${JSON.stringify(text)}`);
            parts.push({ text, acceptance: str('the acceptance sentence') });
          } else {
            const k = c.next(true);
            if (k.t !== 'word' && k.t !== 'str') err(line, "a dispatch entry is 'key: value' or 'part \"text\": \"acceptance\"'");
            const key = String((k as { v: string | number }).v);
            c.expectP(':', `after '${key}'`);
            params[key] = parseValue(c, 'plain');
          }
          if (c.atP(',') || c.atP(';')) c.next();
        }
        c.next(true);
        out.commands.push({ kind: 'dispatch', goal, params, parts, line });
        break;
      }
      case 'mission': {
        const marks: { text: string; status: string; evidence?: string }[] = [];
        c.expectP('{', 'opening the mission block');
        while (!c.atP('}', true)) {
          const p = word("'part'");
          if (p.v !== 'part') err(line, "a mission entry reads 'part \"text\": done \"evidence\"'");
          const text = str('the part text');
          c.expectP(':', `after part ${JSON.stringify(text)}`);
          const status = word('the status: done / blocked / dropped / pending / in_flight').v;
          const mark: { text: string; status: string; evidence?: string } = { text, status };
          if (c.peek().t === 'str') mark.evidence = str('the evidence');
          marks.push(mark);
          if (c.atP(',') || c.atP(';')) c.next();
        }
        c.next(true);
        out.commands.push({ kind: 'mission', marks, line });
        break;
      }
      case 'export': {
        if (word("'package'").v !== 'package') err(line, "'export' reads 'export package \"<name>\" { ... }'");
        out.commands.push({ kind: 'export-package', name: str('the package name'), params: optionalObject(), line });
        break;
      }
      case 'note': out.notes.push({ text: str('the note text'), line }); out.mentioned.add('note'); break;
      case 'canvas': out.canvas = { body: linedBlock(line), line }; break;
      case 'mode': out.commands.push({ kind: 'mode', mode: word('ask or auto').v, line }); break;
      case 'settings': out.commands.push({ kind: 'settings', patch: objectValue('settings', line), line }); break;
      case 'delete': {
        if (word("'thread'").v !== 'thread') err(line, "'delete' reads 'delete thread \"<title words>\"' - tables and screens delete by leaving their block out");
        out.commands.push({ kind: 'delete-thread', words: str('words from the thread title'), line });
        break;
      }
      case 'create': {
        if (word("'project'").v !== 'project') err(line, "'create' reads 'create project \"<name>\" at \"<path>\"'");
        const name = str('the project name');
        if (word("'at'").v !== 'at') err(line, "'create project' reads 'create project \"<name>\" at \"<path>\"'");
        out.commands.push({ kind: 'create-project', name, path: str('the folder path'), line });
        break;
      }
      case 'node': case 'variants': case 'ref':
        err(line, `'${w.v}' belongs inside a screen block - wrap it: screen <slug> { ... }`);
        break;
      case 'step': case 'wire': case 'pin':
        err(line, `'${w.v}' belongs inside the flow block - wrap it: flow main { ... }`);
        break;
      default:
        err(line, `'${w.v}' is not a construct - the document reads project / theme / table / rows / screen / flow / trigger / service / call / run / chain / operation / component / import / plan / dispatch / mission / export / note / canvas / mode / settings / delete / create`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// PROJECT COMPILER - the parsed document against the live model -> one op per
// changed construct, in dependency order: tables before screens that bind
// them, services before calls, flow before triggers; deletions last.
// ---------------------------------------------------------------------------

export type ProjectDoor =
  | { kind: 'raise'; verb: string; params: Record<string, unknown> }
  /** The theme block: setProjectTheme, free. */
  | { kind: 'theme-set'; theme: ProjectTheme }
  /** The canvas block: moved cards merge into the saved layout, the groups replace the saved ones; free. */
  | CanvasDoor
  | { kind: 'table-create'; name: string; rowSchema: Record<string, ColType> }
  | { kind: 'table-evolve'; name: string; add: { col: string; type: ColType }[]; deprecate: string[] }
  | { kind: 'rows-append'; table: string; rows: Record<string, unknown>[] }
  | { kind: 'rows-replace'; table: string; rows: Record<string, unknown>[] }
  | { kind: 'note-save'; text: string }
  | { kind: 'mission-set'; parts: { text: string; acceptance: string }[] }
  | { kind: 'mission-mark'; marks: { partIdx: number; status: string; evidence?: string }[] }
  | { kind: 'flow-pin'; stepId: string; items: Record<string, unknown>[] | null }
  /** A new screen's body: compiles against the minted slug once create_view has landed. */
  | { kind: 'screen-body'; declaredSlug: string; title: string; code: string };

export interface ProjectOp { construct: ConstructKind; says: string; line: number; door: ProjectDoor }

export interface ProjectCompileOk {
  ok: true;
  ops: ProjectOp[];
  warnings: string[];
  /** Per edited live screen: this edit's findings and the screen's pre-existing ones (the tracker's inputs). */
  screens: Record<string, { findings: LintFinding[]; preExisting: LintFinding[] }>;
  /** declared flow step id -> the id the kernel mints. */
  renames: Record<string, string>;
}
/** A refusal names every issue and the construct kinds the failing lines belong to (the stop counts per kind). */
export type ProjectCompileResult = ProjectCompileOk | { ok: false; errors: string[]; constructs: ConstructKind[] };

export interface ProjectCompileDeps {
  compileScreen: (slug: string, code: string) => Promise<SceneCompileResult>;
  compileFlow: (code: string) => Promise<FlowCompileResult>;
  /** The open mission's part texts, in order; a mission line marks by text. */
  missionParts: string[];
  /** The asking thread (a dispatch trigger action needs it). */
  threadId: string | null;
  /** Reads a component or package file for the import lines. */
  readJsonFile: (path: string) => unknown;
  /** Every registry verb's contract: issues for a payload, or none. */
  validate: (verb: string, params: Record<string, unknown>) => string[];
}

const ROWS_PER_EDIT = 500;
const ROWS_PER_APPEND = 100;
const ROWS_PER_REPLACE = 100;

/** A screen's query bindings from its query list; kept asset and clock bindings ride through. */
function bindingsFor(
  query: string[], live: Record<string, unknown>[], tables: ProjectTableModel[], parsedTables: ParsedTable[],
): { bindings: Record<string, unknown>[]; unknown: string[] } {
  const unknown: string[] = [];
  const kept = live.filter((b) => b['kind'] !== 'query' || query.includes(String(b['table'])));
  const out = [...kept];
  for (const name of query) {
    if (kept.some((b) => b['kind'] === 'query' && b['table'] === name)) continue;
    const t = parsedTables.find((p) => p.name === name);
    const l = tables.find((p) => p.name === name);
    const rowSchema = t?.columns ?? l?.columns;
    if (rowSchema === undefined) { unknown.push(name); continue; }
    out.push({ name, kind: 'query', table: name, rowSchema });
  }
  return { bindings: out, unknown };
}

/** delete_trigger addresses by words in the spec: the longest string leaf, else the first number. */
function triggerSpecWords(spec: Record<string, unknown>): string {
  let best = '';
  const walk = (v: unknown): void => {
    if (typeof v === 'string') { if (v.length > best.length) best = v; return; }
    if (typeof v === 'number' && best.length === 0) { best = String(v); return; }
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (isObj(v)) for (const x of Object.values(v)) walk(x);
  };
  walk(spec);
  return best.length >= 3 ? best : JSON.stringify(spec);
}

export async function compileProjectDialect(
  model: ProjectModel, code: string, deps: ProjectCompileDeps,
): Promise<ProjectCompileResult> {
  let parsed: ParsedProject;
  try {
    parsed = parseProjectDialect(code);
  } catch (e) {
    if (e instanceof DialectError) return { ok: false, errors: [e.message], constructs: ['project'] };
    throw e;
  }
  const errors: string[] = [];
  const warnings: string[] = [];
  const at = (line: number, msg: string): void => { errors.push(`line ${line}: ${msg}`); };
  /** line -> the construct written there, so a refusal counts against the right kind. */
  const kindAtLine = new Map<number, ConstructKind>();
  if (parsed.name !== undefined) kindAtLine.set(parsed.name.line, 'project');
  if (parsed.theme !== undefined) kindAtLine.set(parsed.theme.line, 'theme');
  if (parsed.canvas !== undefined) kindAtLine.set(parsed.canvas.line, 'canvas');
  for (const t of parsed.tables) kindAtLine.set(t.line, 'table');
  for (const s of parsed.screens) kindAtLine.set(s.line, 'screen');
  if (parsed.flow !== undefined) kindAtLine.set(parsed.flow.line, 'flow');
  for (const t of parsed.triggers) kindAtLine.set(t.line, 'trigger');
  for (const s of parsed.services) kindAtLine.set(s.line, 'service');
  for (const ch of parsed.chains) kindAtLine.set(ch.line, 'chain');
  for (const n of parsed.notes) kindAtLine.set(n.line, 'note');
  for (const cmd of parsed.commands) {
    kindAtLine.set(cmd.line, cmd.kind === 'keys' ? 'service' : cmd.kind === 'import-component' ? 'component'
      : cmd.kind === 'export-package' || cmd.kind === 'import-package' ? 'package' : cmd.kind === 'delete-thread' ? 'thread' : cmd.kind);
  }
  const refuse = (): ProjectCompileResult => {
    const constructs = new Set<ConstructKind>();
    for (const e of errors) {
      const m = /^line (\d+):/.exec(e);
      const line = m !== null ? Number(m[1]) : NaN;
      // A screen or flow body error names a line inside the block: the nearest construct above it.
      let hit: ConstructKind | undefined;
      let best = -1;
      for (const [l, k] of kindAtLine) if (l <= line && l > best) { best = l; hit = k; }
      constructs.add(hit ?? 'project');
    }
    return { ok: false, errors: [...errors, DIALECT_FIX_SENTENCE], constructs: [...constructs] };
  };
  const creates: ProjectOp[] = [];
  const bodies: ProjectOp[] = [];
  const commands: ProjectOp[] = [];
  const deletions: ProjectOp[] = [];
  const screens: ProjectCompileOk['screens'] = {};
  let renames: Record<string, string> = {};
  const raise = (construct: ConstructKind, says: string, line: number, verb: string, params: Record<string, unknown>): ProjectOp => {
    for (const issue of deps.validate(verb, params)) at(line, `${says}: ${issue}`);
    return { construct, says, line, door: { kind: 'raise', verb, params } };
  };
  const serviceOf = (name: string, line: number): string | null => {
    if (UUID_LIKE.test(name)) return name;
    const hits = model.services.filter((s) => s.integration === name || s.label === name || idMatches(s.id, name));
    const active = hits.filter((s) => s.status === 'active');
    const pick = active[0] ?? hits[0];
    if (pick === undefined) { at(line, `no service '${name}' is placed on this project - place it with a service line first`); return null; }
    if ((active.length > 1) || (active.length === 0 && hits.length > 1)) { at(line, `'${name}' names ${hits.length} service nodes - use the node id`); return null; }
    return pick.id;
  };

  // project name
  if (parsed.name !== undefined && parsed.name.value !== model.name) {
    creates.push(raise('project', `rename the project to ${JSON.stringify(parsed.name.value)}`, parsed.name.line, 'rename_project', { name: parsed.name.value }));
  }
  // theme: the block IS the theme - it lands through setProjectTheme (free); the stored brief rides along.
  if (parsed.theme !== undefined) {
    const { brief: _liveBrief, ...liveTheme } = model.theme ?? ({} as Partial<ProjectTheme>);
    if (!deepEq(parsed.theme.value, liveTheme)) {
      const themeParse = projectThemeSchema.safeParse(parsed.theme.value);
      if (!themeParse.success) {
        for (const issue of themeParse.error.issues.slice(0, 12)) at(parsed.theme.line, `theme: ${issue.path.join('.') || 'block'}: ${issue.message}`);
      } else {
        creates.push({ construct: 'theme', says: 'set the theme', line: parsed.theme.line, door: { kind: 'theme-set', theme: themeParse.data } });
      }
    }
  }
  // canvas: listed cards move, unlisted ones stay; the groups are exactly the listed ones.
  if (parsed.canvas !== undefined) {
    if (model.canvas === undefined) at(parsed.canvas.line, 'canvas: the layout is not loaded here');
    else {
      const canvas = compileCanvasBlock(model.canvas, parsed.canvas.body, 1);
      errors.push(...canvas.errors);
      if (canvas.door !== null) creates.push({ construct: 'canvas', says: 'arrange the canvas', line: parsed.canvas.line, door: canvas.door });
    }
  }
  // tables
  if (parsed.mentioned.has('table')) {
    for (const t of parsed.tables) {
      const live = model.tables.find((x) => x.name === t.name);
      if (live === undefined) {
        if (Object.keys(t.columns).length === 0) { at(t.line, `table '${t.name}' declares no columns`); continue; }
        creates.push({ construct: 'table', says: `create table ${t.name}`, line: t.line, door: { kind: 'table-create', name: t.name, rowSchema: t.columns } });
        continue;
      }
      const add: { col: string; type: ColType }[] = [];
      const deprecate: string[] = [];
      for (const [col, type] of Object.entries(t.columns)) {
        const cur = live.columns[col];
        if (cur === undefined) {
          if (live.deprecated.includes(col)) at(t.line, `table '${t.name}': column '${col}' was deprecated - a deprecated name never returns; use a new name`);
          else add.push({ col, type });
        } else if (cur !== type) at(t.line, `table '${t.name}': column '${col}' is ${cur} - retype does not exist; add a new column`);
      }
      for (const col of Object.keys(live.columns)) if (!(col in t.columns)) deprecate.push(col);
      if (add.length > 0 || deprecate.length > 0) {
        creates.push({ construct: 'table', says: `evolve table ${t.name}${add.length > 0 ? ` +${add.map((a) => a.col).join(',')}` : ''}${deprecate.length > 0 ? ` -${deprecate.join(',')}` : ''}`, line: t.line, door: { kind: 'table-evolve', name: t.name, add, deprecate } });
      }
    }
    if (!parsed.keepRest) {
      for (const live of model.tables) {
        if (parsed.tables.some((t) => t.name === live.name)) continue;
        deletions.push(raise('table', `delete table ${live.name}`, 0, 'delete_dataset', { name: live.name }));
      }
    }
  }
  // rows (write-only; the 500 cap names the dispatch lane)
  {
    const total = parsed.commands.reduce((n, cmd) => (cmd.kind === 'rows' ? n + cmd.rows.length : n), 0);
    if (total > ROWS_PER_EDIT) at(parsed.commands.find((cmd) => cmd.kind === 'rows')?.line ?? 0, `${total} rows in one edit - the cap is ${ROWS_PER_EDIT}; bigger loads ride a dispatched run holding a folder`);
  }
  // services (placements) and keys
  if (parsed.mentioned.has('service')) {
    for (const s of parsed.services) {
      const live = model.services.find((x) => x.integration === s.name && (s.label === undefined || x.label === s.label));
      if (live !== undefined) continue;
      creates.push(raise('service', `place service ${s.name}`, s.line, 'integrations_place', { service: s.name, ...(s.label !== undefined ? { label: s.label } : {}) }));
    }
    if (!parsed.keepRest) {
      for (const live of model.services) {
        if (parsed.services.some((s) => s.name === live.integration && (s.label === undefined || s.label === live.label))) continue;
        warnings.push(`service ${live.integration} ${JSON.stringify(live.label)} is not listed - service nodes leave from the canvas, never from this document`);
      }
    }
  }
  // screens
  if (parsed.mentioned.has('screen')) {
    for (let s of parsed.screens) {
      // A screen is found by its slug, else by its title: the kernel mints the slug from the title, so a
      // re-submitted 'screen home "Ember Coffee"' is the live 'ember-coffee', never a duplicate.
      const bySlug = model.screens.find((x) => x.slug === s.slug);
      const byTitle = bySlug === undefined && s.title !== undefined
        ? model.screens.find((x) => x.status !== 'deleted' && x.title.trim().toLowerCase() === s.title!.trim().toLowerCase())
        : undefined;
      const live = bySlug ?? byTitle;
      if (byTitle !== undefined) {
        renames[s.slug] = byTitle.slug;
        s = { ...s, slug: byTitle.slug, body: s.body === null ? null : s.body.replace(/^screen \S+/, `screen ${byTitle.slug}`) };
      }
      if (live === undefined) {
        const title = s.title ?? s.slug.replace(/-+/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());
        const { bindings, unknown } = bindingsFor(s.query ?? [], [], model.tables, parsed.tables);
        for (const u of unknown) at(s.line, `screen '${s.slug}' queries '${u}' - no such table; declare it above`);
        creates.push(raise('screen', `create screen ${s.slug} ${JSON.stringify(title)}`, s.line, 'create_view', {
          title, purpose: s.purpose ?? `the ${JSON.stringify(title)} screen`, bindings, actions: [],
        }));
        if (s.body !== null) bodies.push({ construct: 'screen', says: `build screen ${s.slug}`, line: s.line, door: { kind: 'screen-body', declaredSlug: s.slug, title, code: s.body } });
        continue;
      }
      if (s.title !== undefined && s.title !== live.title) {
        bodies.push(raise('screen', `rename screen ${s.slug} to ${JSON.stringify(s.title)}`, s.line, 'rename_view', { viewSlug: s.slug, title: s.title }));
      }
      if (s.query !== undefined) {
        const liveDatasets = live.bindings.filter((b) => b['kind'] === 'query').map((b) => String(b['table'])).sort();
        if (!deepEq(liveDatasets, [...s.query].sort())) {
          const { bindings, unknown } = bindingsFor(s.query, live.bindings, model.tables, parsed.tables);
          for (const u of unknown) at(s.line, `screen '${s.slug}' queries '${u}' - no such table; declare it above`);
          bodies.push(raise('screen', `query screen ${s.slug} over ${s.query.join(', ') || 'nothing'}`, s.line, 'revise_view', {
            viewSlug: s.slug, complaint: 'the project document changed its bindings', bindings,
          }));
        }
      }
      if (s.body !== null) {
        if (live.document === null) { at(s.line, `screen '${s.slug}' has no document (built on an older system) - recreate it under a new slug`); continue; }
        const compiled = await deps.compileScreen(s.slug, s.body);
        if (!compiled.ok) { errors.push(...compiled.errors); continue; }
        screens[s.slug] = { findings: compiled.findings, preExisting: compiled.preExisting };
        if (compiled.ops.length > 0) {
          bodies.push(raise('screen', `edit screen ${s.slug} (${compiled.ops.length} ops)`, s.line, 'scene_revise', {
            sceneSlug: s.slug, intent: 'project document edit', code: s.body,
          }));
        }
      }
    }
    if (!parsed.keepRest) {
      for (const live of model.screens) {
        if (parsed.screens.some((s) => s.slug === live.slug)) continue;
        deletions.push(raise('screen', `delete screen ${live.slug}`, 0, 'delete_view', { viewSlug: live.slug, reason: 'removed from the project document' }));
      }
    }
  }
  // the flow
  if (parsed.flow !== undefined) {
    const compiled = await deps.compileFlow(parsed.flow.body);
    if (!compiled.ok) errors.push(...compiled.errors.filter((e) => e !== DIALECT_FIX_SENTENCE));
    else {
      renames = compiled.renames;
      warnings.push(...compiled.warnings);
      for (const call of compiled.calls) bodies.push({ construct: 'flow', says: call.says, line: parsed.flow.line, door: { kind: 'raise', verb: call.verb, params: call.params } });
      for (const pin of compiled.pins) bodies.push({ construct: 'flow', says: pin.items === null ? `unpin ${pin.stepId}` : `pin ${pin.stepId}`, line: parsed.flow.line, door: { kind: 'flow-pin', stepId: pin.stepId, items: pin.items } });
    }
  }
  // triggers
  if (parsed.mentioned.has('trigger')) {
    for (const t of parsed.triggers) {
      const live = model.triggers.find((x) => idMatches(x.id, t.id));
      if (live !== undefined) {
        if (live.kind !== t.kind || !deepEq(live.spec, t.spec) || !deepEq(live.action, t.action)) {
          at(t.line, `trigger ${t.id} never edits in place - leave it out (it deletes) and declare a fresh one (a re-mint)`);
        } else if (live.enabled === t.off) at(t.line, `trigger ${t.id}: switch triggers on and off from the canvas, not here`);
        continue;
      }
      const action = { ...t.action };
      if (action['type'] === 'call_integration') {
        const id = serviceOf(String(action['connection']), t.line);
        if (id !== null) action['connection'] = id;
      }
      if (action['type'] === 'propose_work') {
        if (action['threadId'] === undefined && deps.threadId !== null) action['threadId'] = deps.threadId;
        if (action['role'] === undefined) action['role'] = 'builder';
        if (action['brief'] === undefined) action['brief'] = action['goal'];
      }
      if (t.off) warnings.push(`line ${t.line}: trigger ${t.id} arms enabled - 'off' applies from the canvas after it exists`);
      commands.push(raise('trigger', `arm trigger ${t.id} (${t.kind})`, t.line, 'create_trigger', { triggerKind: t.kind, spec: t.spec, action }));
    }
    if (!parsed.keepRest) {
      for (const live of model.triggers) {
        if (parsed.triggers.some((t) => idMatches(live.id, t.id))) continue;
        deletions.push(raise('trigger', `delete trigger ${shortId(live.id)} (${live.kind})`, 0, 'delete_trigger', { specContains: triggerSpecWords(live.spec) }));
      }
    }
  }
  // chains
  if (parsed.mentioned.has('chain')) {
    for (const ch of parsed.chains) {
      const live = model.chains.find((x) => idMatches(x.id, ch.id));
      if (live !== undefined) {
        if (live.operation !== ch.operation || !deepEq(live.inputs, ch.inputs)) at(ch.line, `chain ${ch.id} never edits in place - leave it out (it revokes) and declare a fresh one`);
        continue;
      }
      commands.push(raise('chain', `create chain ${ch.id} (${ch.operation})`, ch.line, 'create_reactive_chain', { operation: ch.operation, inputs: ch.inputs }));
    }
    if (!parsed.keepRest) {
      for (const live of model.chains) {
        if (parsed.chains.some((ch) => idMatches(live.id, ch.id))) continue;
        deletions.push(raise('chain', `revoke chain ${shortId(live.id)} (${live.operation})`, 0, 'revoke_reactive_chain', { operation: live.operation }));
      }
    }
  }
  // the commands, in written order
  for (const cmd of parsed.commands) {
    switch (cmd.kind) {
      case 'rows': {
        if (cmd.replace) {
          if (cmd.rows.length > ROWS_PER_REPLACE) { at(cmd.line, `replace rows ${cmd.table}: ${cmd.rows.length} rows - the replace cap is ${ROWS_PER_REPLACE}`); break; }
          commands.push({ construct: 'rows', says: `replace rows ${cmd.table} (${cmd.rows.length})`, line: cmd.line, door: { kind: 'rows-replace', table: cmd.table, rows: cmd.rows } });
          break;
        }
        for (let i = 0; i < cmd.rows.length; i += ROWS_PER_APPEND) {
          const chunk = cmd.rows.slice(i, i + ROWS_PER_APPEND);
          commands.push({ construct: 'rows', says: `rows ${cmd.table} +${chunk.length}`, line: cmd.line, door: { kind: 'rows-append', table: cmd.table, rows: chunk } });
        }
        break;
      }
      case 'keys': {
        // The placed node's OWN key card (ruling 15): the token goes to the vault through the card, never a payload.
        const id = serviceOf(cmd.service, cmd.line);
        if (id === null) break;
        commands.push(raise('service', `keys for ${cmd.service}`, cmd.line, 'integrations_connect', { connectionId: id }));
        break;
      }
      case 'call': {
        const id = serviceOf(cmd.service, cmd.line);
        if (id === null) break;
        commands.push(raise('call', `call ${cmd.service}.${cmd.endpoint}`, cmd.line, 'call_integration', { connectionId: id, endpoint: cmd.endpoint, params: cmd.params }));
        break;
      }
      case 'run': commands.push(raise('run', `run ${cmd.operation}`, cmd.line, 'run_operation', { operation: cmd.operation, inputs: cmd.inputs })); break;
      case 'operation': commands.push(raise('operation', `propose operation ${cmd.name}`, cmd.line, 'operation_proposal', { name: cmd.name, ...cmd.params })); break;
      case 'component': {
        const bare = cmd.name.includes('@') ? cmd.name.slice(0, cmd.name.lastIndexOf('@')) : cmd.name;
        commands.push(raise('component', `propose component ${bare}`, cmd.line, 'component_proposal', { definition: { name: bare, ...cmd.definition } }));
        break;
      }
      case 'import-component': {
        let file: unknown;
        try { file = deps.readJsonFile(cmd.path); } catch (e) { at(cmd.line, `import component: ${e instanceof Error ? e.message : String(e)}`); break; }
        commands.push(raise('component', `import component ${cmd.path}`, cmd.line, 'import_component', { file, ...cmd.params }));
        break;
      }
      case 'plan': commands.push(raise('plan', 'the plan', cmd.line, 'app_plan', cmd.params)); break;
      case 'dispatch': {
        if (cmd.parts.length > 0) commands.push({ construct: 'mission', says: `mission: ${cmd.parts.length} parts`, line: cmd.line, door: { kind: 'mission-set', parts: cmd.parts } });
        const { role, rationale, ...rest } = cmd.params;
        commands.push(raise('dispatch', `dispatch ${JSON.stringify(cmd.goal.slice(0, 60))}`, cmd.line, 'work_proposal', {
          goal: cmd.goal, rationale: typeof rationale === 'string' ? rationale : cmd.goal, role: typeof role === 'string' ? role : 'builder', ...rest,
        }));
        break;
      }
      case 'mission': {
        const marks: { partIdx: number; status: string; evidence?: string }[] = [];
        for (const m of cmd.marks) {
          const idx = deps.missionParts.findIndex((p) => p.toLowerCase().includes(m.text.toLowerCase()));
          if (idx === -1) { at(cmd.line, `mission: no open part reads ${JSON.stringify(m.text)} - the parts: ${deps.missionParts.map((p) => JSON.stringify(p)).join(', ') || 'none'}`); continue; }
          if (!['pending', 'in_flight', 'done', 'blocked', 'dropped'].includes(m.status)) { at(cmd.line, `mission: '${m.status}' is not a status - done / blocked / dropped / pending / in_flight`); continue; }
          marks.push({ partIdx: idx, status: m.status, ...(m.evidence !== undefined ? { evidence: m.evidence } : {}) });
        }
        if (marks.length > 0) commands.push({ construct: 'mission', says: `mark ${marks.length} part${marks.length === 1 ? '' : 's'}`, line: cmd.line, door: { kind: 'mission-mark', marks } });
        break;
      }
      case 'export-package': {
        const fileName = /\.(tproject|lsg)$/.test(cmd.name) ? cmd.name : `${cmd.name}.tproject`;
        commands.push(raise('package', `export package ${fileName}`, cmd.line, 'export_package', { fileName, ...cmd.params }));
        break;
      }
      case 'import-package': commands.push(raise('package', `import package ${cmd.path}`, cmd.line, 'import_package', { filePath: cmd.path, ...cmd.params })); break;
      case 'mode': commands.push(raise('mode', `mode ${cmd.mode}`, cmd.line, 'thread_mode', { mode: cmd.mode })); break;
      case 'settings': commands.push(raise('settings', 'settings', cmd.line, 'org_settings', { patch: cmd.patch })); break;
      case 'delete-thread': commands.push(raise('thread', `delete thread ${JSON.stringify(cmd.words)}`, cmd.line, 'delete_thread', { titleContains: cmd.words })); break;
      case 'create-project': commands.push(raise('create-project', `create project ${JSON.stringify(cmd.name)}`, cmd.line, 'create_project', { name: cmd.name, path: cmd.path })); break;
    }
  }
  // notes
  if (parsed.mentioned.has('note')) {
    for (const n of parsed.notes) {
      if (model.notes.some((live) => noteKey(live.body) === noteKey(n.text))) continue;
      commands.push({ construct: 'note', says: `note ${JSON.stringify(n.text.slice(0, 40))}`, line: n.line, door: { kind: 'note-save', text: n.text } });
    }
    if (!parsed.keepRest) {
      for (const live of model.notes) {
        if (parsed.notes.some((n) => noteKey(n.text) === noteKey(live.body))) continue;
        deletions.push(raise('note', `delete note ${JSON.stringify(live.body.slice(0, 40))}`, 0, 'delete_note', { bodyContains: live.body }));
      }
    }
  }
  if (errors.length > 0) return refuse();
  return { ok: true, ops: [...creates, ...bodies, ...commands, ...deletions], warnings, screens, renames };
}

const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// THE GRAMMAR BLOCK - every construct's grammar line and hint comments, then
// DIALECT_GRAMMAR whole; rendered from this data alone (byte-stable per deploy)
// into the cached prompt prefix. No tool serves a construct.
// ---------------------------------------------------------------------------

interface CommandDoc { grammar: string[]; hints: string[] }

const COMMAND_DOCS: Record<string, CommandDoc> = {
  project: { grammar: ['project "<name>"'], hints: ['renames this project; free'] },
  theme: {
    grammar: ['theme { background, foreground, card, cardForeground, cardRaised, muted, mutedForeground, primary, primaryForeground, accent, accentForeground, border, ring, green, amber, red: "<color>", radius: <px>, fontSans: "..", fontMono: "..", glow?: "<color>", shadow?: "<box-shadow>", signature: "..", density: ".." }'],
    hints: ['the one token file every component references - a node names a token (fill: "card", color: "accent") and the engine resolves it; the block lands free and overwrites the theme whole; the brief tool writes it from a design brief', 'status hues (green, amber, red) and the surface ladder (background, card, cardRaised) are outside the color budget'],
  },
  table: {
    grammar: ['table <name> { <col>: string|number|boolean, ... }'],
    hints: ['a new name creates the table; a new column adds; a missing column deprecates (never returns); retype does not exist', 'leaving a live table out of a document that lists tables deletes it (a card, always) - a top-level ... line keeps everything unlisted'],
  },
  rows: {
    grammar: ['rows <table> [ { <col>: <value>, ... }, ... ]', 'replace rows <table> [ ... ]'],
    hints: ['write-only; up to 500 rows per edit (bigger loads ride a dispatched run); replace caps at 100 and swaps the whole contents', 'rows are never shown by read - rows {dataset} queries them'],
  },
  screen: {
    grammar: ['screen <slug> "<Title>" [purpose "..."] [query <table>, ...] { <screen dialect> }'],
    hints: ['a new slug creates the screen (the kernel mints the slug from the title - the receipt names it); a changed title renames; a changed query list re-contracts the data; the body compiles as the screen dialect below', 'an empty { } declares a screen without touching its body; ... inside keeps unlisted nodes; leaving a live screen out deletes it (a card)'],
  },
  flow: {
    grammar: ['flow main { step <id> = <kind> { ... } [off]  wire <from>[:port] -> <to>[:slot]  pin <id> = [ ... ] }'],
    hints: ['the body is the flow dialect below; the block is the whole flow (a step left out is removed; ... keeps the rest)', 'every step carries a pin with sample output - following steps\' pills read it; pins are data, never checked'],
  },
  trigger: {
    grammar: ['trigger <id> = <kind> { <spec> } -> flow main at <entry step>', 'trigger <id> = <kind> { <spec> } -> operation <name> { <inputs> }', 'trigger <id> = <kind> { <spec> } -> call <service>.<endpoint> { <params> }', 'trigger <id> = <kind> { <spec> } -> dispatch "<goal>" { brief: "...", role: "..." }'],
    hints: ['a new id arms the trigger (ask-once); a trigger never edits in place - leave it out (deletes) and declare a fresh one', 'the flow it starts must exist first - declare the flow block above the trigger'],
  },
  service: {
    grammar: ['service <name> "<label>" { }', 'service <name> keys'],
    hints: ['{ } places the service node unconnected (free); keys raises the placed node\'s own key card (always asks) - the key goes to the vault through the card, never through you; contract {names:[\'<name>\']} answers the endpoints'],
  },
  call: { grammar: ['call <service>.<endpoint> { <params> }'], hints: ['fires one endpoint through the placed, connected service node; always asks'] },
  chain: { grammar: ['chain <id> = <operation> { <inputs> }'], hints: ['a standing re-run of an operation when its watched outputs re-register (ask-once); leaving a live chain out revokes it'] },
  operation: { grammar: ['operation <name> { runtime: "wasm"|"native", code: "...", ioContract: { ... } }'], hints: ['proposes a sealed operation version (always asks); the block is the verb\'s params'] },
  run: { grammar: ['run <operation> { <inputs> }'], hints: ['one sealed run of a registered operation (ask-once)'] },
  component: { grammar: ['component <name> { <definition> }', 'import component "<path>"'], hints: ['a definition enters the library after its preview card (always asks)'] },
  plan: { grammar: ['plan { tables: [...], screens: [...], flows: [...], services: [...], theme: { ... } }'], hints: ['the plan card; approval is the build\'s scope ceiling and wakes the build turn; the theme it names lands on the project at approval and STANDS - the build turn\'s brief never overwrites an approved theme'] },
  dispatch: {
    grammar: ['dispatch "<goal>" { role: "...", brief: "...", browse: [...], connect: [...], part "<text>": "<acceptance>", ... }'],
    hints: ['one run owns the goal end to end (ask-once); the part lines set the mission before the run spawns; role defaults to builder, rationale to the goal'],
  },
  mission: { grammar: ['mission { part "<text>": done "<evidence>", part "<text>": blocked "<why>" }'], hints: ['marks parts of the open checklist by their text; statuses: done / blocked / dropped / pending / in_flight'] },
  package: { grammar: ['export package "<name>" { scenes: [...], license: "...", workspacePath: "..." }', 'import package "<path>" { onCollision: "refuse"|"skip-existing"|"copy-rename" }'], hints: ['always asks'] },
  note: { grammar: ['note "<one plain sentence>"'], hints: ['saves the why for future turns (8..2000 chars); leaving a live note out deletes it'] },
  canvas: {
    grammar: ['canvas { table <name> at <x>, <y>   screen <slug> at <x>, <y>   step <id> at ..   trigger "<id>" at ..   service <name> at ..   chain "<id>" at ..   operation <name> at ..   result <name> at ..   notes at ..   group "<label>" at <x>, <y> { <card>, <card>, ... } }'],
    hints: [
      'arranges the canvas the user sees; free; x grows right, y grows down, in canvas pixels; a card is about 112 wide and tall, a group card 196 x 140, a screen 0.375 of its design size (a 1440 x 900 screen takes 540 x 338)',
      'listed cards move, cards left out stay where they are; the groups are exactly the ones listed - a group left out unfolds; a group folds two or more cards into one card, any kinds mixed',
      'arrange when the user asks to organize, move or group things - new cards place themselves; keep wired cards near each other, leave 48 or more between cards',
    ],
  },
  mode: { grammar: ['mode ask|auto'], hints: ['always asks - a thread never self-promotes'] },
  settings: { grammar: ['settings { <patch> }'], hints: ['always asks'] },
  thread: { grammar: ['delete thread "<words from its title>"'], hints: ['always asks; the current thread refuses'] },
  'create-project': { grammar: ['create project "<name>" at "<absolute path>"'], hints: ['ask-once; the folder grant rides the same card'] },
};

/** The `<grammar>` block of the cached prompt prefix: every construct's grammar line and hints, then the dialect grammar whole. */
export function renderGrammarBlock(): string {
  const lines: string[] = [
    '<grammar>',
    'THE CONSTRUCTS (what edit takes - one block per construct, the hint says how it lands; no tool serves these):',
  ];
  for (const [name, doc] of Object.entries(COMMAND_DOCS)) {
    lines.push(`// ${name}`);
    for (const g of doc.grammar) lines.push(g);
    for (const h of doc.hints) lines.push(`// ${h}`);
  }
  lines.push('', DIALECT_GRAMMAR, '</grammar>');
  return lines.join('\n');
}

/** One service's contract as contract answers it and as the approval turn pre-renders it - one renderer, two callers. */
export function renderServiceContract(def: IntegrationDef): Record<string, unknown> {
  return {
    name: def.name, displayName: def.displayName, blurb: def.blurb,
    category: def.category, surfaces: def.surfaces, scope: def.scope, auth: def.auth.kind,
    endpoints: def.endpoints.map((e) => ({
      id: e.id, displayName: e.displayName, method: e.method, class: e.class,
      ...(e.hint !== undefined ? { hint: e.hint } : {}),
      params: Object.entries(e.params).map(([pname, p]) => ({
        name: pname, type: p.type, required: p.required === true,
        ...(p.choices !== undefined ? { choices: p.choices } : {}),
        ...(p.help !== undefined ? { help: p.help } : {}),
      })),
    })),
    insideTables: def.inside.tables.map((t) => t.name),
  };
}

// ---------------------------------------------------------------------------
// SQL wrappers for the project half - the model loader, the lens, the compile.
// ---------------------------------------------------------------------------

export async function loadProjectModel(sql: postgres.Sql, input: { orgId: string; projectId: string }): Promise<ProjectModel> {
  const { orgId, projectId } = input;
  const [project] = await sql<{ name: string; theme: unknown }[]>`
    select name, theme from projects where id = ${projectId} and org_id = ${orgId}`;
  const theme = projectThemeSchema.safeParse(project?.theme);
  const tableRows = await sql<{ name: string; row_schema: Record<string, ColType>; deprecated_columns: string[] | null; key_columns: unknown; n: string }[]>`
    select d.name, d.row_schema, d.deprecated_columns, d.key_columns,
      (select count(*) from dataset_rows r where r.dataset_id = d.id) as n
    from datasets d where d.org_id = ${orgId} and d.project_id = ${projectId} and d.deleted_at is null
    order by d.created_at asc, d.name asc`;
  const { listTabs } = await import('./tabs/model.js');
  const { listTriggers } = await import('./triggers.js');
  const { listIntegrationConnections } = await import('./integrations/connections.js');
  const { listReactiveChains } = await import('./operations/reactive.js');
  const { listOperations } = await import('./operations/registry.js');
  const { listOrgComponents } = await import('./scenes/library.js');
  const { readNotes } = await import('./notes.js');
  const screens: ProjectScreenModel[] = [];
  for (const tab of (await listTabs(sql, orgId)).filter((t) => t.projectId === projectId)) {
    if (tab.sceneId === null || tab.sceneSlug === null) {
      screens.push({ slug: tab.slug, title: tab.title, status: tab.status, bindings: [], document: null, revision: 0 });
      continue;
    }
    const [scene] = await sql<{ bindings: unknown }[]>`select bindings from scenes where id = ${tab.sceneId}`;
    const document = await getSceneDocument(sql, { orgId, sceneId: tab.sceneId });
    screens.push({
      slug: tab.sceneSlug, title: tab.title, status: tab.status,
      bindings: Array.isArray(scene?.bindings) ? (scene.bindings as Record<string, unknown>[]) : [],
      document, revision: document.revision,
    });
  }
  const flow = await getFlow(sql, orgId, { projectId, name: MAIN_FLOW });
  const flowDoc = flow === null ? null : flowDocSchema.parse(flow.doc);
  const triggers = (await listTriggers(sql, orgId)).filter((t) => t.projectId === projectId && t.revokedAt === null);
  const services = await listIntegrationConnections(sql, { orgId, projectId });
  const chains = (await listReactiveChains(sql, orgId)).filter((c) => c.projectId === projectId && c.revokedAt === null);
  const operations = (await listOperations(sql, orgId, projectId)).filter((o) => o.status === 'active');
  const placedScreens = (await listTabs(sql, orgId)).filter((t) => t.projectId === projectId && t.sceneId !== null && t.sceneSlug !== null);
  const canvas = await loadCanvas(sql, {
    orgId,
    names: {
      projectId, flowId: flow?.id ?? null, flowSteps: flowDoc === null ? [] : Object.keys(flowDoc.steps),
      tables: tableRows.map((r) => r.name),
      screens: placedScreens.map((t) => ({ slug: t.sceneSlug!, sceneId: t.sceneId! })),
      triggers: triggers.map((t) => t.id), services: services.map((v) => ({ id: v.id, integration: v.integration })),
      chains: chains.map((c) => c.id), operations: operations.map((o) => o.name),
    },
  });
  return {
    name: project?.name ?? 'untitled',
    theme: theme.success ? theme.data : null,
    tables: tableRows.map((r) => ({
      name: r.name, columns: r.row_schema, deprecated: r.deprecated_columns ?? [],
      keyColumns: Array.isArray(r.key_columns) ? (r.key_columns as string[]) : null, rowCount: Number(r.n),
    })),
    screens,
    flow: flowDoc,
    flowId: flow?.id ?? null,
    triggers: triggers.map((t) => ({ id: t.id, kind: t.kind, spec: t.spec, action: t.action as unknown as Record<string, unknown>, enabled: t.enabled })),
    services: services.map((v) => ({ id: v.id, integration: v.integration, label: v.label, status: v.status })),
    chains: chains.map((c) => ({ id: c.id, operation: c.operation, inputs: c.inputs, enabled: c.enabled })),
    operations: operations.map((o) => ({ name: o.name, version: o.version, runtime: o.runtime, outputs: o.outputs })),
    components: (await listOrgComponents(sql, orgId, projectId)).filter((c) => c.status === 'active')
      .map((c) => ({ name: c.name, version: c.version })),
    notes: (await readNotes(sql, { orgId, projectId })).map((n) => ({ id: n.id, body: n.body })),
    canvas,
  };
}

/** The screen lens's own budgets: the project lens renders every screen at this depth unless a caller names a smaller one. */
const FULL_SCREEN_DEPTH = 6;
const FULL_SCREEN_NODES = 60;

/** The project lens: the whole document as text, every screen whole by default - the envelope's document and edit's replace base. */
export async function projectDialectLens(
  sql: postgres.Sql, input: { orgId: string; projectId: string; screenDepth?: number; screenNodes?: number },
): Promise<{ ok: true; code: string; model: ProjectModel }> {
  const model = await loadProjectModel(sql, { orgId: input.orgId, projectId: input.projectId });
  const opts: ProjectLensOptions = {
    screenDepth: input.screenDepth ?? FULL_SCREEN_DEPTH,
    screenNodes: input.screenNodes ?? FULL_SCREEN_NODES,
  };
  return { ok: true, code: generateProjectDialect(model, opts), model };
}

/** Compile the project dialect against the live model; the tool surface lands the ops one by one. */
export async function compileProjectDialectAt(
  sql: postgres.Sql,
  input: { orgId: string; projectId: string; threadId: string | null; code: string },
): Promise<ProjectCompileResult & { model?: ProjectModel }> {
  const model = await loadProjectModel(sql, { orgId: input.orgId, projectId: input.projectId });
  const { ACTION_REGISTRY } = await import('./chat/actions.js');
  const { getOpenIntent } = await import('./chat/intents.js');
  const { readFileSync } = await import('node:fs');
  const intent = input.threadId === null ? null : await getOpenIntent(sql, input.orgId, input.threadId);
  const res = await compileProjectDialect(model, input.code, {
    compileScreen: (slug, code) => compileSceneDialectAt(sql, { orgId: input.orgId, sceneSlug: slug, code }),
    compileFlow: (code) => compileFlowDialectAt(sql, { orgId: input.orgId, projectId: input.projectId, code }),
    missionParts: intent?.parts.map((p) => p.text) ?? [],
    threadId: input.threadId,
    readJsonFile: (path) => JSON.parse(readFileSync(path, 'utf8')) as unknown,
    validate: (verb, params) => {
      const spec = ACTION_REGISTRY[verb];
      if (spec === undefined) return [`no verb '${verb}' stands behind this construct`];
      const parsed = spec.paramsSchema.safeParse(params);
      if (parsed.success) return [];
      return parsed.error.issues.slice(0, 12).map((i) => `${i.path.join('.') || 'params'}: ${i.message}`);
    },
  });
  return { ...res, model };
}
