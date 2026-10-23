// The shared expression conformance corpus every implementation must pass; new fixtures may land, existing ones never change.

export interface ExprConformanceFixture {
  expr: string;
  bindings: Record<string, Record<string, unknown>[]>;
}

export const EXPR_CONFORMANCE_FIXTURES: readonly ExprConformanceFixture[] = [
  { expr: '1 + 2 * 3', bindings: {} },
  { expr: '(1 + 2) * 3 - 4 / 2', bindings: {} },
  { expr: "concat('n=', count('s'))", bindings: { s: [{ a: 1 }, { a: 2 }] } },
  { expr: "sum('s', 'a') + avg('s', 'a')", bindings: { s: [{ a: 4 }, { a: 8 }, { a: null }] } },
  { expr: "if(min('s', 'a') < 5, 'low', 'high')", bindings: { s: [{ a: 4 }, { a: 8 }] } },
  { expr: "round(avg('s', 'a'), 1)", bindings: { s: [{ a: 1 }, { a: 2 }] } },
  { expr: '1 / 0', bindings: {} },
  { expr: "1 + 'a'", bindings: {} },
  { expr: "if(1, 'a', 'b')", bindings: {} },
  { expr: "sum('ghost', 'x')", bindings: {} },
  { expr: "sum('s', 'a')", bindings: { s: [{ a: 'text' }] } },
  { expr: 'true and 2 > 1', bindings: {} },
  { expr: 'not false or 1 > 2', bindings: {} },
  { expr: "len('hello') % 2", bindings: {} },
  { expr: "max('s', 'a') >= 8", bindings: { s: [{ a: 4 }, { a: 8 }] } },
];
