// The expression contract's reference implementation: pure and total, errors are values, no truthiness or implicit coercion; the runtime embeds its own conformance-tested copy.

export interface ExprValue { $expr: string; deps?: string[] }

export function isExprValue(v: unknown): v is ExprValue {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    && typeof (v as Record<string, unknown>)['$expr'] === 'string';
}

export type ExprResult = { ok: true; value: unknown } | { ok: false; err: string };

const AGGREGATES = new Set(['count', 'sum', 'avg', 'min', 'max']);
// row('<column>') reads the current repeater row; bucket('<read>') reads the current calendar cell. Both error named outside their scope.
const FUNCTIONS = new Set([...AGGREGATES, 'concat', 'round', 'if', 'len', 'row', 'bucket']);
const BUCKET_READS = new Set(['date', 'day', 'count', 'rows']);

// --- tokenizer -------------------------------------------------------------

type Tok =
  | { t: 'num'; v: number } | { t: 'str'; v: string } | { t: 'id'; v: string }
  | { t: 'p'; v: string } | { t: 'end' };

function tokenize(src: string): Tok[] | string {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^[0-9]*\.?[0-9]+/.exec(src.slice(i))!;
      toks.push({ t: 'num', v: Number(m[0]) }); i += m[0].length; continue;
    }
    if (c === "'" || c === '"') {
      const end = src.indexOf(c, i + 1);
      if (end === -1) return `unterminated string starting at position ${i}`;
      toks.push({ t: 'str', v: src.slice(i + 1, end) }); i = end + 1; continue;
    }
    if (/[a-zA-Z_]/.test(c)) {
      const m = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(src.slice(i))!;
      toks.push({ t: 'id', v: m[0] }); i += m[0].length; continue;
    }
    const two = src.slice(i, i + 2);
    if (['==', '!=', '<=', '>='].includes(two)) { toks.push({ t: 'p', v: two }); i += 2; continue; }
    if ('+-*/%<>(),'.includes(c)) { toks.push({ t: 'p', v: c }); i++; continue; }
    return `unexpected character '${c}' at position ${i}`;
  }
  toks.push({ t: 'end' });
  return toks;
}

// --- parser (Pratt) ---------------------------------------------------------

export type ExprAst =
  | { k: 'num'; v: number } | { k: 'str'; v: string } | { k: 'bool'; v: boolean } | { k: 'null' }
  | { k: 'bin'; op: string; l: ExprAst; r: ExprAst }
  | { k: 'un'; op: 'neg' | 'not'; e: ExprAst }
  | { k: 'call'; fn: string; args: ExprAst[] };

export function parseExpression(src: string): { ok: true; ast: ExprAst } | { ok: false; err: string } {
  const toks = tokenize(src);
  if (typeof toks === 'string') return { ok: false, err: toks };
  let pos = 0;
  const peek = () => toks[pos]!;
  const next = () => toks[pos++]!;
  const expectP = (v: string): string | null => {
    const t = next();
    return t.t === 'p' && t.v === v ? null : `expected '${v}'`;
  };

  function parseBin(minBp: number): ExprAst | string {
    let left = parsePrimary();
    if (typeof left === 'string') return left;
    for (;;) {
      const t = peek();
      const op = t.t === 'p' ? t.v : t.t === 'id' && (t.v === 'and' || t.v === 'or') ? t.v : null;
      const bp = op === 'or' ? 1 : op === 'and' ? 2
        : op === '==' || op === '!=' ? 3
        : op === '<' || op === '<=' || op === '>' || op === '>=' ? 4
        : op === '+' || op === '-' ? 5
        : op === '*' || op === '/' || op === '%' ? 6 : 0;
      if (bp === 0 || bp < minBp) return left;
      next();
      const right = parseBin(bp + 1);
      if (typeof right === 'string') return right;
      left = { k: 'bin', op: op!, l: left, r: right };
    }
  }

  function parsePrimary(): ExprAst | string {
    const t = next();
    if (t.t === 'num') return { k: 'num', v: t.v };
    if (t.t === 'str') return { k: 'str', v: t.v };
    if (t.t === 'p' && t.v === '(') {
      const e = parseBin(1);
      if (typeof e === 'string') return e;
      const err = expectP(')');
      return err ?? e;
    }
    if (t.t === 'p' && t.v === '-') {
      const e = parsePrimary();
      return typeof e === 'string' ? e : { k: 'un', op: 'neg', e };
    }
    if (t.t === 'id') {
      if (t.v === 'true') return { k: 'bool', v: true };
      if (t.v === 'false') return { k: 'bool', v: false };
      if (t.v === 'null') return { k: 'null' };
      if (t.v === 'not') {
        const e = parsePrimary();
        return typeof e === 'string' ? e : { k: 'un', op: 'not', e };
      }
      if (peek().t === 'p' && (peek() as { v: string }).v === '(') {
        if (!FUNCTIONS.has(t.v)) return `unknown function '${t.v}' — the functions are [${[...FUNCTIONS].join(', ')}]`;
        next();
        const args: ExprAst[] = [];
        if (!(peek().t === 'p' && (peek() as { v: string }).v === ')')) {
          for (;;) {
            const a = parseBin(1);
            if (typeof a === 'string') return a;
            args.push(a);
            const p = next();
            if (p.t === 'p' && p.v === ',') continue;
            if (p.t === 'p' && p.v === ')') break;
            return "expected ',' or ')' in arguments";
          }
        } else next();
        return { k: 'call', fn: t.v, args };
      }
      return `bare identifier '${t.v}' — v1 expressions reference bindings only, through the aggregate functions (e.g. sum('sales', 'qty'))`;
    }
    return 'unexpected end of expression';
  }

  const ast = parseBin(1);
  if (typeof ast === 'string') return { ok: false, err: ast };
  if (peek().t !== 'end') return { ok: false, err: 'trailing input after the expression' };
  return { ok: true, ast };
}

// --- deps + validation --------------------------------------------------------

export function extractDeps(ast: ExprAst): string[] {
  const deps = new Set<string>();
  walk(ast, (n) => {
    if (n.k === 'call' && AGGREGATES.has(n.fn) && n.args[0]?.k === 'str') {
      deps.add(`bindings.${(n.args[0] as { v: string }).v}`);
    }
  });
  return [...deps].sort();
}

function walk(ast: ExprAst, fn: (n: ExprAst) => void): void {
  fn(ast);
  if (ast.k === 'bin') { walk(ast.l, fn); walk(ast.r, fn); }
  else if (ast.k === 'un') walk(ast.e, fn);
  else if (ast.k === 'call') ast.args.forEach((a) => walk(a, fn));
}

/** Parse and verify the declared deps cover the extracted ones; over-declaring is legal. */
export function validateExpression(v: ExprValue): { ok: true; deps: string[] } | { ok: false; errors: string[] } {
  const parsed = parseExpression(v.$expr);
  if (!parsed.ok) return { ok: false, errors: [`expression does not parse: ${parsed.err}`] };
  const extracted = extractDeps(parsed.ast);
  const declared = new Set(v.deps ?? []);
  const missing = extracted.filter((d) => !declared.has(d));
  if (missing.length > 0) {
    return { ok: false, errors: [`deps must declare every source the expression reads — missing [${missing.join(', ')}]`] };
  }
  return { ok: true, deps: extracted };
}

// --- evaluator ---------------------------------------------------------------

export interface ExprContext {
  bindings: Record<string, Record<string, unknown>[]>;
  /** The row scope, present only inside a repeater's template. */
  row?: Record<string, unknown>;
  /** The cell scope, present only inside a calendar view's template. */
  bucket?: { date: string; day: number; count: number; rows: Record<string, unknown>[] };
}

const ERR = (m: string): ExprResult => ({ ok: false, err: m });

export function evaluateExpression(src: string, ctx: ExprContext): ExprResult {
  const parsed = parseExpression(src);
  if (!parsed.ok) return ERR(parsed.err);
  return evalAst(parsed.ast, ctx);
}

function evalAst(ast: ExprAst, ctx: ExprContext): ExprResult {
  switch (ast.k) {
    case 'num': return { ok: true, value: ast.v };
    case 'str': return { ok: true, value: ast.v };
    case 'bool': return { ok: true, value: ast.v };
    case 'null': return { ok: true, value: null };
    case 'un': {
      const e = evalAst(ast.e, ctx);
      if (!e.ok) return e;
      if (ast.op === 'neg') return typeof e.value === 'number' ? { ok: true, value: -e.value } : ERR('unary - expects a number');
      return typeof e.value === 'boolean' ? { ok: true, value: !e.value } : ERR('not expects a boolean');
    }
    case 'bin': {
      const l = evalAst(ast.l, ctx);
      if (!l.ok) return l;
      // and/or short-circuit, but never on non-booleans.
      if (ast.op === 'and' || ast.op === 'or') {
        if (typeof l.value !== 'boolean') return ERR(`${ast.op} expects booleans`);
        if (ast.op === 'and' && !l.value) return { ok: true, value: false };
        if (ast.op === 'or' && l.value) return { ok: true, value: true };
        const r = evalAst(ast.r, ctx);
        if (!r.ok) return r;
        return typeof r.value === 'boolean' ? r : ERR(`${ast.op} expects booleans`);
      }
      const r = evalAst(ast.r, ctx);
      if (!r.ok) return r;
      return binOp(ast.op, l.value, r.value);
    }
    case 'call': return call(ast.fn, ast.args, ctx);
  }
}

function binOp(op: string, a: unknown, b: unknown): ExprResult {
  if (op === '==') return { ok: true, value: a === b };
  if (op === '!=') return { ok: true, value: a !== b };
  if (['<', '<=', '>', '>='].includes(op)) {
    if (typeof a === 'number' && typeof b === 'number' || typeof a === 'string' && typeof b === 'string') {
      const v = op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : a >= b;
      return { ok: true, value: v };
    }
    return ERR(`${op} compares two numbers or two strings`);
  }
  if (typeof a !== 'number' || typeof b !== 'number') {
    return ERR(op === '+' ? "'+' adds numbers — use concat() for strings" : `'${op}' expects numbers`);
  }
  if (op === '/' && b === 0) return ERR('divide by zero');
  if (op === '%' && b === 0) return ERR('modulo by zero');
  const v = op === '+' ? a + b : op === '-' ? a - b : op === '*' ? a * b : op === '/' ? a / b : a % b;
  return Number.isFinite(v) ? { ok: true, value: v } : ERR('the result is not a finite number');
}

function call(fn: string, argAsts: ExprAst[], ctx: ExprContext): ExprResult {
  if (fn === 'row') {
    const cArg = argAsts[0];
    if (cArg?.k !== 'str' || argAsts.length !== 1) return ERR("row names its column as a string literal: row('name')");
    if (ctx.row === undefined) return ERR("row('" + cArg.v + "') has no row in scope — row() lives inside a repeater's template");
    const v = ctx.row[cArg.v];
    return { ok: true, value: v === undefined ? null : v };
  }
  if (fn === 'bucket') {
    const bArg = argAsts[0];
    if (bArg?.k !== 'str' || argAsts.length !== 1) return ERR("bucket names its read as a string literal: bucket('date') — the reads are [date, day, count, rows]");
    if (!BUCKET_READS.has(bArg.v)) return ERR("bucket('" + bArg.v + "') is not a cell read — the reads are [date, day, count, rows]");
    if (ctx.bucket === undefined) return ERR("bucket('" + bArg.v + "') has no cell in scope — bucket() lives inside a calendar view's template");
    const bv = (ctx.bucket as unknown as Record<string, unknown>)[bArg.v];
    return { ok: true, value: bv === undefined ? null : bv };
  }
  if (AGGREGATES.has(fn)) {
    const bArg = argAsts[0];
    if (bArg?.k !== 'str') return ERR(`${fn} names its binding as a string literal: ${fn}('sales'${fn === 'count' ? '' : ", 'field'"})`);
    const rows = ctx.bindings[bArg.v];
    if (!rows) return ERR(`unknown binding '${bArg.v}' — the scene's bindings are [${Object.keys(ctx.bindings).join(', ') || 'none'}]`);
    if (fn === 'count') return { ok: true, value: rows.length };
    const fArg = argAsts[1];
    if (fArg?.k !== 'str') return ERR(`${fn} names the field as a string literal`);
    const nums: number[] = [];
    for (const row of rows) {
      const v = row[fArg.v];
      if (v === null || v === undefined) continue; // nulls skip
      if (typeof v !== 'number' || !Number.isFinite(v)) return ERR(`'${fArg.v}' holds a non-number — ${fn} needs numbers`);
      nums.push(v);
    }
    if (fn === 'sum') return { ok: true, value: nums.reduce((s, n) => s + n, 0) };
    if (nums.length === 0) return ERR(`${fn} over zero numeric values`);
    if (fn === 'avg') return { ok: true, value: nums.reduce((s, n) => s + n, 0) / nums.length };
    if (fn === 'min') return { ok: true, value: Math.min(...nums) };
    return { ok: true, value: Math.max(...nums) };
  }
  const args: unknown[] = [];
  for (const a of argAsts) {
    const r = evalAst(a, ctx);
    if (!r.ok) return r;
    args.push(r.value);
  }
  switch (fn) {
    case 'concat':
      return args.every((a) => ['string', 'number', 'boolean'].includes(typeof a))
        ? { ok: true, value: args.map(String).join('') }
        : ERR('concat takes strings, numbers, and booleans');
    case 'round': {
      const [x, d] = args;
      if (typeof x !== 'number' || (d !== undefined && typeof d !== 'number')) return ERR('round(number, digits?)');
      const f = 10 ** (d ?? 0);
      return { ok: true, value: Math.round(x * f) / f };
    }
    case 'if': {
      if (args.length !== 3) return ERR('if(condition, then, else)');
      if (typeof args[0] !== 'boolean') return ERR('if expects a boolean condition — no truthiness');
      return { ok: true, value: args[0] ? args[1] : args[2] };
    }
    case 'len':
      return typeof args[0] === 'string' ? { ok: true, value: args[0].length } : ERR('len expects a string');
    default:
      return ERR(`unknown function '${fn}'`);
  }
}
