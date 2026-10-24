import type postgres from 'postgres';
import {
  PRIMITIVE_NAMES, SCENE_ROOT_ID, breakpointsOf, channelRefParts, instanceRefsIn, isChannelRef, isExprValue,
  libraryItemSchema, nearestNames, nearestPrimitiveNames, nearestPropertyNames, payloadSchema, primitiveOfNode, primitiveOfRef,
  validateExpression, validateSceneStructure, PRIMITIVES,
  type LibraryItem, type LibraryItemResolver, type PrimitiveName, type SceneAction, type SceneDocument,
} from '@nodeloom/core';
import { projectArm } from '../containment.js';
import { projectThemeSchema } from '../projects.js';

// THE GATE (Phase 12, ruling 12): one pass over the folded document, every issue accumulated
// with its path; refs resolved by one query. json-render's spec-validator shape (code, path,
// severity, one list), n8n's tracker key (code|path) so the edit door dedupes by location.

export interface SceneIssue {
  code: string;
  /** Where: 'document', '<node>', '<node>.<property>', '<node>.states.hover.<property>'. */
  path: string;
  message: string;
  severity: 'error' | 'warning';
  /** The tracker's identity: the same place dedupes while its message may change. */
  key: string;
}

export interface ValidateContext {
  /** The named widths `at` blocks may address. */
  breakpoints: readonly string[];
  /** The query (binding) names the screen declares. */
  queries: ReadonlySet<string>;
  /** Declared scene actions: name -> its param names. */
  actions: ReadonlyMap<string, readonly string[]>;
  /** Every live screen slug the document names (resolved by one query). */
  screens: ReadonlySet<string>;
  /** Library items by name or name@version. */
  items: LibraryItemResolver;
}

export interface SceneVerdict { ok: boolean; issues: SceneIssue[] }

const ACTION_PROPERTIES: Readonly<Record<PrimitiveName, readonly string[]>> = {
  frame: ['action'], text: [], field: ['on-change'], chart: ['on-pick'], instance: [],
};
const LEAF_MESSAGE = 'a leaf primitive takes no children - put them beside it inside a frame';

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The screen slugs a document names: {goto} actions and scene: refs - the one query resolves them. */
export function sceneSlugsNamed(doc: SceneDocument): string[] {
  const out = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (!isObj(v)) return;
    if (typeof v['goto'] === 'string' && Object.keys(v).every((k) => k === 'goto' || k === 'key')) out.add(v['goto']);
    for (const x of Object.values(v)) walk(x);
  };
  for (const node of Object.values(doc.nodes)) {
    for (const payload of Object.values(node.components)) walk(payload);
    for (const target of Object.values(node.refs ?? {})) if (target.startsWith('scene:')) out.add(target.slice('scene:'.length));
  }
  return [...out];
}

/** The one pass: structure, one primitive per node, every payload against its contract, every ref it names. */
export function validateScene(doc: SceneDocument, ctx: ValidateContext): SceneVerdict {
  const issues: SceneIssue[] = [];
  const at = (code: string, path: string, message: string, severity: 'error' | 'warning' = 'error'): void => {
    issues.push({ code, path, message, severity, key: `${code}|${path}` });
  };
  for (const e of validateSceneStructure(doc)) at('structure', 'document', e);
  const structureBroken = issues.length > 0;

  const nodes = doc.nodes;
  const childrenOf = new Map<string, number>();
  for (const n of Object.values(nodes)) if (n.parent !== null) childrenOf.set(n.parent, (childrenOf.get(n.parent) ?? 0) + 1);
  const primitiveAt = new Map<string, PrimitiveName>();

  // 1. Every node carries exactly one primitive; the root may carry none (it reads as a frame).
  for (const node of Object.values(nodes)) {
    const keys = Object.keys(node.components);
    if (keys.length === 0) {
      if (node.id !== SCENE_ROOT_ID) at('no-primitive', node.id, `'${node.id}' carries no primitive - a node is one of ${PRIMITIVE_NAMES.join(', ')}`);
      else primitiveAt.set(node.id, 'frame');
      continue;
    }
    if (keys.length > 1) at('one-primitive', node.id, `'${node.id}' carries ${keys.length} components (${keys.join(', ')}) - a node is exactly one primitive; nest a second one as a child`);
    for (const ref of keys) {
      const name = primitiveOfRef(ref);
      if (name === null) {
        const bare = ref.replace(/^[a-z0-9-]+::/, '').replace(/@\d+$/, '');
        at('unknown-primitive', node.id, `'${bare}' is not a primitive - the five are ${PRIMITIVE_NAMES.join(', ')}; nearest: ${nearestPrimitiveNames(bare).join(', ')}`);
        continue;
      }
      if (node.id === SCENE_ROOT_ID && name !== 'frame') at('root-frame', node.id, `the root is a frame - '${name}' cannot be the root`);
      primitiveAt.set(node.id, name);
    }
  }

  const emitsOf = (nodeId: string): Record<string, { type: string }> => {
    const name = primitiveAt.get(nodeId);
    return name === undefined ? {} : PRIMITIVES[name].emits;
  };

  /** A channel or expression anywhere in a value; the path names the property. */
  const checkValueForms = (v: unknown, path: string): void => {
    if (isExprValue(v)) {
      const r = validateExpression(v);
      if (!r.ok) for (const e of r.errors) at('bad-expr', path, `expr(): ${e}`);
      return;
    }
    if (isChannelRef(v)) {
      const parts = channelRefParts(v.from);
      if (parts === null) { at('bad-channel', path, `from('${v.from}') is not '<node>.<emit>'`); return; }
      const target = nodes[parts.node];
      if (target === undefined) { at('unknown-node', path, `from('${v.from}') names no node '${parts.node}' on this screen`); return; }
      const emits = emitsOf(parts.node);
      if (!(parts.emit in emits)) {
        const says = Object.keys(emits);
        at('unknown-emit', path, `'${parts.node}' says no '${parts.emit}' - ${says.length > 0 ? `it says: ${says.join(', ')}` : 'it says nothing'}`);
      }
      return;
    }
    if (Array.isArray(v)) { v.forEach((x, i) => checkValueForms(x, `${path}[${i}]`)); return; }
    if (isObj(v)) for (const [k, x] of Object.entries(v)) checkValueForms(x, `${path}.${k}`);
  };

  const checkQuery = (q: unknown, path: string): void => {
    if (typeof q !== 'string') return;
    if (!ctx.queries.has(q)) {
      const known = [...ctx.queries];
      at('unknown-query', path, `'${q}' is not a query this screen declares${known.length > 0 ? ` - it declares: ${known.join(', ')}` : ' - it declares none; bind the table on the screen line first'}`);
    }
  };

  const checkAction = (a: unknown, path: string): void => {
    if (!isObj(a)) return;
    if (typeof a['run'] === 'string') {
      const params = ctx.actions.get(a['run']);
      if (params === undefined) {
        const declared = [...ctx.actions.keys()];
        at('undeclared-action', path, `'${a['run']}' is not an action this screen declares yet${declared.length > 0 ? ` - declared: ${declared.join(', ')}` : ''}`, 'warning');
      } else if (isObj(a['with'])) {
        for (const k of Object.keys(a['with'])) {
          if (!params.includes(k)) at('bad-param', `${path}.with.${k}`, `'${k}' is not a param of '${a['run']}' - its params are [${params.join(', ')}]`);
        }
      }
    }
    if (typeof a['goto'] === 'string' && !ctx.screens.has(a['goto'])) at('unknown-screen', path, `goto '${a['goto']}' names no live screen - the target of a goto is a screen slug of this project`);
    for (const k of ['open', 'close', 'toggle'] as const) {
      const t = a[k];
      if (typeof t === 'string' && nodes[t] === undefined) at('unknown-node', path, `${k} '${t}' names no node on this screen`);
    }
  };

  // 2. Every payload against its primitive's contract, then the refs the payload names.
  for (const node of Object.values(nodes)) {
    const p = primitiveOfNode(node);
    if (p === null) continue;
    const name = p.name;
    const schema = payloadSchema(name, ctx.breakpoints);
    const parsed = schema.safeParse(p.payload);
    if (!parsed.success) {
      for (const issue of parsed.error.issues.slice(0, 20)) {
        const path = `${node.id}${issue.path.length > 0 ? `.${issue.path.join('.')}` : ''}`;
        if (issue.code === 'unrecognized_keys') {
          const inState = issue.path.length > 0;
          const inAt = issue.path[0] === 'at';
          for (const k of issue.keys) {
            const nearest = nearestPropertyNames(name, k, 3, inAt ? 'at' : inState ? 'block' : 'payload');
            at('unknown-property', `${path}.${k}`, inState
              ? `'${k}' is not a property a ${issue.path[0] === 'states' ? 'state' : 'breakpoint'} block of ${name} may set (${inAt ? 'structure never varies - layout alone may' : 'structure never varies'})${inAt && issue.path.length === 1 ? ` - the breakpoints are ${ctx.breakpoints.join(', ')}` : ''} - nearest: ${nearest.join(', ')}`
              : `'${k}' is not a property of ${name} - nearest: ${nearest.join(', ')}; contract {names:['${name}']} lists them all`);
          }
          continue;
        }
        if (issue.code === 'invalid_union') {
          const key = String(issue.path[issue.path.length - 1] ?? '');
          const hint = key.length > 0 && key in PRIMITIVES[name].own ? PRIMITIVES[name].own[key]!.hint : undefined;
          at('bad-value', path, `${key.length > 0 ? `'${key}'` : 'the value'} does not fit its contract${hint !== undefined ? ` - ${hint}` : ''}`);
          continue;
        }
        at('bad-value', path, issue.message);
      }
    }
    const py = p.payload;
    // The required ones the contract cannot mark optional-by-shape.
    if (name === 'text' && py['text'] === undefined && py['blocks'] === undefined && py['glyph'] === undefined) at('text-empty', `${node.id}.text`, 'a text needs text, blocks or a glyph');
    if (name === 'chart' && typeof py['query'] !== 'string') at('missing', `${node.id}.query`, 'a chart names the query it draws');
    if (name === 'instance' && typeof py['component'] !== 'string') at('missing', `${node.id}.component`, 'a new instance - pick its component in properties', 'warning');
    if (name === 'field' && typeof py['name'] !== 'string') at('missing', `${node.id}.name`, "a field names the value it fills: name: 'customer'");
    if (PRIMITIVES[name].children === 'none' && (childrenOf.get(node.id) ?? 0) > 0) at('leaf-children', node.id, `'${node.id}' is a ${name} with children - ${LEAF_MESSAGE}`);

    for (const [k, v] of Object.entries(py)) checkValueForms(v, `${node.id}.${k}`);

    if (name === 'frame') {
      const each = py['each'];
      checkQuery(typeof each === 'string' ? each : isObj(each) ? each['query'] : undefined, `${node.id}.each`);
      const anchor = py['anchor'];
      if (isObj(anchor) && typeof anchor['to'] === 'string' && anchor['to'] !== 'screen' && nodes[anchor['to']] === undefined) at('unknown-node', `${node.id}.anchor`, `anchor.to '${anchor['to']}' names no node on this screen`);
    }
    if (name === 'chart') {
      checkQuery(py['query'], `${node.id}.query`);
      if (Array.isArray(py['layers'])) py['layers'].forEach((l, i) => { if (isObj(l)) checkQuery(l['query'], `${node.id}.layers[${i}].query`); });
    }
    if (name === 'field') {
      if (isObj(py['filters'])) checkQuery(py['filters']['query'], `${node.id}.filters.query`);
      if (isObj(py['options'])) checkQuery(py['options']['query'], `${node.id}.options.query`);
      if (typeof py['name'] === 'string' && ctx.actions.size > 0 && ![...ctx.actions.values()].some((params) => params.includes(py['name'] as string))) {
        at('unfed-field', `${node.id}.name`, `'${py['name']}' is not a param of any declared action (${[...ctx.actions.keys()].join(', ')}) - it fills nothing until one names it`, 'warning');
      }
    }
    for (const key of ACTION_PROPERTIES[name]) checkAction(py[key], `${node.id}.${key}`);
    const visible = py['visible'];
    if (isObj(visible) && typeof visible['field'] === 'string') {
      const target = visible['field'];
      if (nodes[target] === undefined) at('unknown-node', `${node.id}.visible`, `visible.field '${target}' names no node on this screen`);
      else if (primitiveAt.get(target) !== 'field') at('bad-value', `${node.id}.visible`, `visible.field '${target}' is not a field`);
    }
    if (name === 'instance' && typeof py['component'] === 'string') {
      const item = ctx.items(py['component']);
      if (item === null) at('unknown-item', `${node.id}.component`, `'${py['component']}' is not a library item this project holds - contract names any item by its name`);
      else {
        if (typeof py['variant'] === 'string' && !(py['variant'] in item.variants)) {
          const options = Object.keys(item.variants);
          at('bad-value', `${node.id}.variant`, `variant '${py['variant']}' has no seat on '${item.name}' - ${options.length > 0 ? `its variants: ${options.join(', ')}` : 'it declares none'}`);
        }
        if (isObj(py['overrides'])) {
          for (const childId of Object.keys(py['overrides'])) {
            if (childId !== SCENE_ROOT_ID && !item.exposed.includes(childId)) at('bad-value', `${node.id}.overrides.${childId}`, `'${item.name}' does not expose '${childId}' - it exposes: ${item.exposed.join(', ') || 'nothing'}`);
          }
        }
      }
    }
    for (const [key, target] of Object.entries(node.refs ?? {})) {
      if (target.startsWith('scene:') && !ctx.screens.has(target.slice('scene:'.length))) at('unknown-screen', `${node.id}.ref.${key}`, `ref '${key}' targets '${target}' - no live screen carries that slug`);
    }
  }

  return { ok: !structureBroken && issues.every((i) => i.severity !== 'error'), issues };
}

/** The issue lines a refusal speaks, errors first. */
export function formatIssues(issues: readonly SceneIssue[]): string[] {
  const order = (s: SceneIssue['severity']): number => (s === 'error' ? 0 : 1);
  return [...issues].sort((a, b) => order(a.severity) - order(b.severity)).map((i) => `${i.path}: ${i.message}`);
}

/** The context in one round trip per kind: screens by one `slug = any(...)`, the theme's breakpoints, the items the instances name. */
export async function loadValidateContext(
  sql: postgres.Sql,
  input: { orgId: string; projectId: string | null; doc: SceneDocument; bindings: unknown; actions: unknown },
): Promise<ValidateContext> {
  const slugs = sceneSlugsNamed(input.doc);
  const screens = new Set<string>();
  if (slugs.length > 0) {
    const rows = await sql<{ slug: string }[]>`
      select slug from scenes where org_id = ${input.orgId} and status != 'deleted' and slug = any(${sql.array(slugs)})`;
    for (const r of rows) screens.add(r.slug);
  }
  let breakpoints = Object.keys(breakpointsOf(null));
  if (input.projectId !== null) {
    const [row] = await sql<{ theme: unknown }[]>`select theme from projects where id = ${input.projectId} and org_id = ${input.orgId}`;
    const theme = projectThemeSchema.safeParse(row?.theme);
    if (theme.success) breakpoints = Object.keys(breakpointsOf(theme.data));
  }
  const queries = new Set<string>();
  if (Array.isArray(input.bindings)) for (const b of input.bindings) if (isObj(b) && typeof b['name'] === 'string') queries.add(b['name']);
  const actions = new Map<string, readonly string[]>();
  if (Array.isArray(input.actions)) {
    for (const a of input.actions as SceneAction[]) if (isObj(a) && typeof a['name'] === 'string') actions.set(a['name'], Object.keys(isObj(a['params']) ? a['params'] : {}));
  }
  const items = await libraryItemsFor(sql, input.orgId, input.projectId, instanceRefsIn(input.doc));
  return { breakpoints, queries, actions, screens, items };
}

/** One query for the named items (this project's rows, then the stock seed); a name resolves to its latest version. */
export async function libraryItemsFor(
  sql: postgres.Sql, orgId: string, projectId: string | null, refs: readonly string[],
): Promise<LibraryItemResolver> {
  const byRef = new Map<string, LibraryItem>();
  const latest = new Map<string, LibraryItem>();
  const names = [...new Set(refs.map((r) => r.replace(/@\d+$/, '')))];
  if (names.length > 0) {
    const rows = await sql<{ name: string; version: number; definition: unknown }[]>`
      select name, version, definition from component_definitions
      where org_id = ${orgId} and ${projectArm(sql, projectId)} and status = 'active' and name = any(${sql.array(names)})
      order by name asc, version desc`;
    for (const row of rows) {
      const parsed = libraryItemSchema.safeParse(row.definition);
      if (!parsed.success) continue;
      byRef.set(`${row.name}@${row.version}`, parsed.data);
      if (!latest.has(row.name)) latest.set(row.name, parsed.data);
    }
  }
  return (ref) => byRef.get(ref) ?? latest.get(ref) ?? null;
}

/** Ordered names for the nearest-name refusal on an unknown item. */
export function nearestItemNames(wrong: string, known: readonly string[]): string[] {
  return nearestNames(wrong, [...new Set(known)]);
}
