import type postgres from 'postgres';
import { getArrangement, mergeArrangement } from './human/doors.js';

// The canvas half of the project lens: where each card sits and which cards rest folded together.
// Node ids follow the observatory's scheme; the document speaks the project's own names.

export interface CanvasFold { id: string; kind: string; label: string; members: string[]; open: boolean }

export interface CanvasModel {
  /** node id -> the words the document uses for it, e.g. "table customers". */
  refs: Map<string, string>;
  positions: Record<string, { x: number; y: number }>;
  folds: CanvasFold[];
}

/** The project's citizens, as the model loader already holds them. */
export interface CanvasNames {
  projectId: string;
  flowId: string | null;
  flowSteps: string[];
  tables: string[];
  screens: Array<{ slug: string; sceneId: string }>;
  triggers: string[];
  services: Array<{ id: string; integration: string }>;
  chains: string[];
  operations: string[];
}

export type CanvasDoor = { kind: 'canvas-set'; positions: Record<string, { x: number; y: number }>; folds: CanvasFold[] | null };

const short = (id: string): string => id.slice(0, 8);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const quoteIfNeeded = (s: string): string => (/^[A-Za-z_][\w.-]*$/.test(s) ? s : JSON.stringify(s));

/** The fold kind the canvas draws: the members' one kind, or a mixed group. */
const KIND_OF_PREFIX: Record<string, string> = {
  ds: 'dataset', scene: 'scene', trg: 'trigger', intg: 'integration', fstep: 'step',
  op: 'operation', chain: 'chain', out: 'output', notes: 'notes',
};

export async function loadCanvas(sql: postgres.Sql, input: { orgId: string; names: CanvasNames }): Promise<CanvasModel> {
  const n = input.names;
  const refs = new Map<string, string>();
  for (const t of n.tables) refs.set(`ds:${t}`, `table ${quoteIfNeeded(t)}`);
  for (const s of n.screens) refs.set(`scene:${s.sceneId}`, `screen ${quoteIfNeeded(s.slug)}`);
  if (n.flowId !== null) for (const st of n.flowSteps) refs.set(`fstep:${n.flowId}:${st}`, `step ${quoteIfNeeded(st)}`);
  for (const id of n.triggers) refs.set(`trg:${id}`, `trigger ${JSON.stringify(short(id))}`);
  for (const s of n.services) {
    const unique = n.services.filter((o) => o.integration === s.integration).length === 1;
    refs.set(`intg:${s.id}`, `service ${unique ? quoteIfNeeded(s.integration) : JSON.stringify(short(s.id))}`);
  }
  for (const id of n.chains) refs.set(`chain:${id}`, `chain ${JSON.stringify(short(id))}`);
  for (const o of n.operations) refs.set(`op:${o}`, `operation ${quoteIfNeeded(o)}`);
  refs.set(`notes:${n.projectId}`, 'notes');
  const doc = (await getArrangement(sql, { orgId: input.orgId, projectId: n.projectId })) ?? {};
  const positions: Record<string, { x: number; y: number }> = {};
  if (isObj(doc['positions'])) {
    for (const [id, p] of Object.entries(doc['positions'])) {
      // A result card is named by its key alone; it has no other row in the document.
      if (id.startsWith('out:') && !refs.has(id)) refs.set(id, `result ${quoteIfNeeded(id.slice(4))}`);
      if (isObj(p) && typeof p['x'] === 'number' && typeof p['y'] === 'number') positions[id] = { x: Math.round(p['x']), y: Math.round(p['y']) };
    }
  }
  const folds = Array.isArray(doc['folds'])
    ? (doc['folds'] as unknown[]).filter((f): f is CanvasFold => isObj(f) && typeof f['id'] === 'string' && Array.isArray(f['members']))
    : [];
  return { refs, positions, folds };
}

/** The canvas block of the project document: one line per placed card, one per group with its members. */
export function renderCanvasBlock(m: CanvasModel): string[] {
  const groups = m.folds
    .map((f) => ({ f, members: f.members.filter((id) => m.refs.has(id)) }))
    .filter((g) => g.members.length > 0);
  const grouped = new Set(groups.flatMap((g) => g.members));
  const lines: string[] = [];
  for (const [id, ref] of m.refs) {
    const p = m.positions[id];
    if (p === undefined || grouped.has(id)) continue;
    lines.push(`  ${ref} at ${p.x}, ${p.y}`);
  }
  for (const { f, members } of groups) {
    const p = m.positions[f.id];
    const at = p !== undefined ? ` at ${p.x}, ${p.y}` : '';
    lines.push(`  group ${JSON.stringify(f.label)}${at} { ${members.map((id) => m.refs.get(id)!).join(', ')} }`);
  }
  if (lines.length === 0) return ['canvas { }   # nothing placed yet - the canvas places new cards itself'];
  return ['canvas {', ...lines, '}'];
}

// ---- the written block -> one door ----

type Tok = { v: string; quoted: boolean; line: number };

function tokenize(body: string): Tok[] {
  const toks: Tok[] = [];
  body.split('\n').forEach((text, i) => {
    const re = /"((?:[^"\\]|\\.)*)"|#.*$|[{},]|-?\d+(?:\.\d+)?|[^\s{},"#]+/g;
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      if (m[0].startsWith('#')) break;
      toks.push(m[1] !== undefined ? { v: JSON.parse(`"${m[1]}"`) as string, quoted: true, line: i + 1 } : { v: m[0], quoted: false, line: i + 1 });
    }
  });
  return toks;
}

const REF_WORDS = new Set(['table', 'screen', 'step', 'trigger', 'service', 'chain', 'operation', 'result']);

/**
 * The canvas block against the live model. Listed cards move; cards left out stay where they are.
 * The groups are exactly the ones listed: a group left out unfolds.
 */
export function compileCanvasBlock(
  m: CanvasModel, body: string, line0: number,
): { door: CanvasDoor | null; errors: string[] } {
  const errors: string[] = [];
  const at = (line: number, msg: string): void => { errors.push(`line ${line0 + line - 1}: canvas: ${msg}`); };
  const byRef = new Map<string, string>();
  for (const [id, ref] of m.refs) byRef.set(ref.replace(/"/g, ''), id);
  const toks = tokenize(body);
  let i = 0;
  const peek = (): Tok | undefined => toks[i];
  const take = (): Tok | undefined => toks[i++];
  const num = (what: string, line: number): number | null => {
    const t = take();
    if (t === undefined || t.quoted || !/^-?\d+(\.\d+)?$/.test(t.v)) { at(t?.line ?? line, `expected ${what}`); return null; }
    return Math.round(Number(t.v));
  };
  const point = (line: number): { x: number; y: number } | null => {
    const x = num('the x number after at', line);
    if (peek()?.v === ',') take();
    const y = num('the y number', line);
    return x === null || y === null ? null : { x, y };
  };
  const ref = (first: Tok): string | null => {
    if (first.v === 'notes' && !first.quoted) {
      const id = byRef.get('notes');
      if (id === undefined) at(first.line, 'this project has no notes card');
      return id ?? null;
    }
    if (!REF_WORDS.has(first.v)) {
      at(first.line, `'${first.v}' is not a card - a line reads '<table|screen|step|trigger|service|chain|operation|result> <name> at <x>, <y>', 'notes at <x>, <y>' or 'group "<label>" at <x>, <y> { <card>, ... }'`);
      return null;
    }
    const name = take();
    if (name === undefined) { at(first.line, `the ${first.v} name is missing`); return null; }
    const id = byRef.get(`${first.v} ${name.v}`);
    if (id === undefined) {
      const known = [...byRef.keys()].filter((k) => k.startsWith(`${first.v} `)).map((k) => k.slice(first.v.length + 1));
      at(name.line, `there is no ${first.v} '${name.v}'${known.length > 0 ? ` - the ${first.v}s are ${known.slice(0, 12).join(', ')}` : ''}`);
      return null;
    }
    return id;
  };

  const positions: Record<string, { x: number; y: number }> = {};
  const groups: Array<{ label: string; at: { x: number; y: number } | null; members: string[]; line: number }> = [];
  while (i < toks.length) {
    const t = take()!;
    if (t.v === ',') continue;
    if (t.v === 'group' && !t.quoted) {
      const label = take();
      if (label === undefined || !label.quoted) { at(t.line, 'a group reads group "<label>" at <x>, <y> { <card>, ... }'); break; }
      let p: { x: number; y: number } | null = null;
      if (peek()?.v === 'at') { take(); p = point(t.line); }
      if (peek()?.v !== '{') { at(t.line, `group ${JSON.stringify(label.v)} needs its cards in { }`); break; }
      take();
      const members: string[] = [];
      while (peek() !== undefined && peek()!.v !== '}') {
        const mt = take()!;
        if (mt.v === ',') continue;
        const id = ref(mt);
        if (id !== null) members.push(id);
      }
      if (take()?.v !== '}') { at(t.line, `group ${JSON.stringify(label.v)} is never closed - add '}'`); break; }
      if (members.length < 2) at(t.line, `group ${JSON.stringify(label.v)} needs at least two cards`);
      groups.push({ label: label.v, at: p, members, line: t.line });
      continue;
    }
    const id = ref(t);
    if (id === null) { while (peek() !== undefined && peek()!.line === t.line) take(); continue; }
    if (take()?.v !== 'at') { at(t.line, `${m.refs.get(id)} needs 'at <x>, <y>'`); continue; }
    const p = point(t.line);
    if (p !== null) positions[id] = p;
  }

  const seen = new Map<string, string>();
  for (const g of groups) {
    for (const id of g.members) {
      const other = seen.get(id);
      if (other !== undefined && other !== g.label) at(g.line, `${m.refs.get(id)} is already in group ${JSON.stringify(other)} - a card rests in one group`);
      seen.set(id, g.label);
    }
  }
  if (errors.length > 0) return { door: null, errors };

  const moved: Record<string, { x: number; y: number }> = {};
  for (const [id, p] of Object.entries(positions)) {
    const live = m.positions[id];
    if (live === undefined || live.x !== p.x || live.y !== p.y) moved[id] = p;
  }
  const folds: CanvasFold[] = groups.map((g) => {
    const live = m.folds.find((f) => f.label === g.label);
    const kinds = new Set(g.members.map((id) => KIND_OF_PREFIX[id.split(':')[0]!] ?? 'group'));
    const id = live?.id ?? `fold:${Math.random().toString(36).slice(2, 8)}`;
    if (g.at !== null) {
      const livePos = m.positions[id];
      if (livePos === undefined || livePos.x !== g.at.x || livePos.y !== g.at.y) moved[id] = g.at;
    }
    return { id, kind: kinds.size === 1 ? [...kinds][0]! : 'group', label: g.label, members: g.members, open: false };
  });
  const liveFolds = m.folds.filter((f) => f.members.some((id) => m.refs.has(id)));
  const sameFolds = folds.length === liveFolds.length && folds.every((f) => {
    const l = liveFolds.find((x) => x.id === f.id);
    return l !== undefined && l.label === f.label && l.members.length === f.members.length && l.members.every((x) => f.members.includes(x));
  });
  if (Object.keys(moved).length === 0 && sameFolds) return { door: null, errors };
  return { door: { kind: 'canvas-set', positions: moved, folds: sameFolds ? null : folds }, errors };
}

/** Lands the canvas door: the moved cards merge into the saved layout; the groups replace the saved ones. */
export async function landCanvasDoor(sql: postgres.Sql, input: { orgId: string; projectId: string; door: CanvasDoor }): Promise<void> {
  await mergeArrangement(sql, { orgId: input.orgId, projectId: input.projectId, positions: input.door.positions, folds: input.door.folds });
}
