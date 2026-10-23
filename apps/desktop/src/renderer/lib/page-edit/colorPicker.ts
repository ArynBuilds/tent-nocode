/** Pure color picker logic; baked scene palette mirrors engine constants. */

export const BAKED_SCENE_COLORS: Readonly<Record<string, string>> = {
  'bg': '#171717', 'side': '#212121', 'panel': '#2a2a2a', 'panel2': '#303030',
  'border': '#3a3a3a', 'border2': '#4a4a4a',
  't0': '#ffffff', 't1': '#ececec', 't2': '#a0a0a0', 't3': '#7a7a7a',
  'accent': '#ececec',
  'green': '#3fb950', 'amber': '#d29922', 'red': '#f85149',
  'chart-grid': '#2c2c2c', 'chart-axis': '#4a4a4a',
  'series-1': '#d97757', 'series-2': '#8caec9', 'series-3': '#c9a84c',
  'series-4': '#86b39c', 'series-5': '#a98fc0', 'series-6': '#97999e',
};

export interface Rgba { r: number; g: number; b: number; a: number }
export interface Hsv { h: number; s: number; v: number }

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** Parse a stored color value: hex (#rgb/#rrggbb/#rrggbbaa), rgb()/rgba(), or a
 * house color name (resolved through the BAKED palette - the scene's own truth).
 * Junk = null (the picker starts from a neutral, honestly). */
export function parseColor(v: string): Rgba | null {
  const s = (BAKED_SCENE_COLORS[v.trim()] ?? v).trim();
  let m = /^#([0-9a-f]{3,4})$/i.exec(s);
  if (m !== null) {
    const t = m[1]!;
    const hx = (c: string): number => parseInt(c + c, 16);
    return { r: hx(t[0]!), g: hx(t[1]!), b: hx(t[2]!), a: t.length === 4 ? hx(t[3]!) / 255 : 1 };
  }
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(s);
  if (m !== null) {
    const t = m[1]!;
    return {
      r: parseInt(t.slice(0, 2), 16), g: parseInt(t.slice(2, 4), 16), b: parseInt(t.slice(4, 6), 16),
      a: m[2] !== undefined ? parseInt(m[2], 16) / 255 : 1,
    };
  }
  m = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(0|1|0?\.\d+)\s*)?\)$/i.exec(s);
  if (m !== null) {
    return {
      r: clamp(Number(m[1]), 0, 255), g: clamp(Number(m[2]), 0, 255), b: clamp(Number(m[3]), 0, 255),
      a: m[4] !== undefined ? clamp(Number(m[4]), 0, 1) : 1,
    };
  }
  return null;
}

export function rgbToHsv(c: Rgba): Hsv {
  const r = c.r / 255;
  const g = c.g / 255;
  const b = c.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

export function hsvToRgb(hsv: Hsv, a = 1): Rgba {
  const h = ((hsv.h % 360) + 360) % 360;
  const s = clamp(hsv.s, 0, 1);
  const v = clamp(hsv.v, 0, 1);
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const to255 = (n: number): number => Math.round((n + m) * 255);
  return { r: to255(r!), g: to255(g!), b: to255(b!), a: clamp(a, 0, 1) };
}

export type ColorFormat = 'hex' | 'rgb';

const hex2 = (n: number): string => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');

/** The committed string: HEX (#rrggbb, alpha as #rrggbbaa only when it matters)
 * or RGB (rgba() only when alpha matters). */
export function formatColor(c: Rgba, format: ColorFormat): string {
  if (format === 'rgb') {
    return c.a < 1
      ? `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${Math.round(c.a * 100) / 100})`
      : `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})`;
  }
  const base = `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
  return c.a < 1 ? `${base}${hex2(c.a * 255)}` : base;
}

/** The hex FIELD text (no alpha - the opacity % field owns it). */
export function hexFieldText(c: Rgba): string {
  return `${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`.toUpperCase();
}

// Session recents only

const recents: string[] = [];
const RECENT_MAX = 8;

export function pushRecentColor(v: string): void {
  const idx = recents.indexOf(v);
  if (idx !== -1) recents.splice(idx, 1);
  recents.unshift(v);
  if (recents.length > RECENT_MAX) recents.length = RECENT_MAX;
}

export function recentColors(): readonly string[] {
  return recents;
}
