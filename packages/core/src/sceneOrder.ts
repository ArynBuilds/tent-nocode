// Fractional order keys: base-62 fraction strings where lexicographic order equals numeric order; deterministic.

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** A key strictly between `below` and `above` (null = the respective bound). */
export function keyBetween(below: string | null, above: string | null): string {
  const a = below ?? '';
  if (above !== null && a >= above) {
    throw new Error(`keyBetween: '${a}' is not below '${above}'`);
  }
  return midpoint(a, above);
}

function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    let n = 0;
    while ((a.charAt(n) || DIGITS[0]) === b.charAt(n)) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const digitA = a ? DIGITS.indexOf(a.charAt(0)) : 0;
  const digitB = b !== null && b.length > 0 ? DIGITS.indexOf(b.charAt(0)) : DIGITS.length;
  if (digitB - digitA > 1) {
    return DIGITS.charAt(Math.round(0.5 * (digitA + digitB)));
  }
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS.charAt(digitA) + midpoint(a.slice(1), null);
}
