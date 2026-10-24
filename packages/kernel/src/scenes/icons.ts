import { icons as lucideIcons } from 'lucide';
import feather from 'feather-icons';
import phosphor from '@iconify-json/ph/icons.json' with { type: 'json' };
import heroicons from '@iconify-json/heroicons/icons.json' with { type: 'json' };
import material from '@iconify-json/material-symbols/icons.json' with { type: 'json' };
import flowbite from '@iconify-json/flowbite/icons.json' with { type: 'json' };
import nonicons from '@iconify-json/nonicons/icons.json' with { type: 'json' };
import meteor from '@iconify-json/meteor-icons/icons.json' with { type: 'json' };
import mage from '@iconify-json/mage/icons.json' with { type: 'json' };
import sargam from '@iconify-json/si/icons.json' with { type: 'json' };
import logos from '@iconify-json/logos/icons.json' with { type: 'json' };
import { primitiveOfRef } from '@nodeloom/core';
import type { SceneDocument } from '@nodeloom/core';

// Vendored icon sets resolved to shape data at the serve seam; nothing fetches at runtime - icons are data, never code.

const SHAPE_TAGS = new Set(['path', 'circle', 'ellipse', 'line', 'rect', 'polyline', 'polygon']);

/** Parse an inner-SVG string into the closed shape vocabulary; group attributes flatten onto children, event/href attributes never pass. */
export function parseSvgShapes(inner: string): Array<[string, Record<string, string>]> {
  const out: Array<[string, Record<string, string>]> = [];
  const gStack: Record<string, string>[] = [];
  const attrsOf = (raw: string): Record<string, string> => {
    const attrs: Record<string, string> = {};
    for (const a of raw.matchAll(/([a-zA-Z0-9_:-]+)="([^"]*)"/g)) {
      const key = a[1]!.toLowerCase();
      if (key.startsWith('on') || key === 'href' || key === 'xlink:href') continue;
      attrs[key] = a[2]!;
    }
    return attrs;
  };
  for (const m of inner.matchAll(/<(\/?)([a-zA-Z]+)((?:\s+[a-zA-Z0-9_:-]+="[^"]*")*)\s*(\/?)>/g)) {
    const closing = m[1] === '/';
    const tag = m[2]!.toLowerCase();
    const selfClosed = m[4] === '/';
    if (tag === 'g') {
      if (closing) gStack.pop();
      else if (!selfClosed) gStack.push(attrsOf(m[3] ?? ''));
      continue;
    }
    if (closing || !SHAPE_TAGS.has(tag)) continue;
    const own = attrsOf(m[3] ?? '');
    const merged: Record<string, string> = Object.assign({}, ...gStack, own);
    const transforms = [...gStack.map((g2) => g2['transform']), own['transform']].filter((t): t is string => typeof t === 'string' && t !== '');
    if (transforms.length > 0) merged['transform'] = transforms.join(' ');
    out.push([tag, merged]);
  }
  return out;
}

interface Glyph { s: unknown; vb: string }
interface IconSet { glyphs: Map<string, Glyph>; mode: 'stroke' | 'fill' }

interface IconifyData {
  icons: Record<string, { body: string; width?: number; height?: number; left?: number; top?: number }>;
  aliases?: Record<string, { parent: string }>;
  width?: number;
  height?: number;
}

/** The one Iconify adapter: every Iconify JSON package rides through it, rendered in fill mode. */
function iconifySet(data: IconifyData): IconSet {
  const glyphs = new Map<string, Glyph>();
  const vbOf = (i: { width?: number; height?: number; left?: number; top?: number }): string =>
    `${i.left ?? 0} ${i.top ?? 0} ${i.width ?? data.width ?? 16} ${i.height ?? data.height ?? data.width ?? 16}`;
  for (const [name, icon] of Object.entries(data.icons)) {
    glyphs.set(name.toLowerCase(), { s: parseSvgShapes(icon.body), vb: vbOf(icon) });
  }
  for (const [alias, ref] of Object.entries(data.aliases ?? {})) {
    const parent = glyphs.get(ref.parent.toLowerCase());
    if (parent) glyphs.set(alias.toLowerCase(), parent);
  }
  return { glyphs, mode: 'fill' };
}

const SETS = new Map<string, IconSet>();

const lucideSet = new Map<string, Glyph>();
for (const [pascal, node] of Object.entries(lucideIcons as Record<string, unknown>)) {
  const kebab = pascal.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([A-Z])([A-Z][a-z])/g, '$1-$2').toLowerCase();
  lucideSet.set(kebab, { s: node, vb: '0 0 24 24' });
}
SETS.set('lucide', { glyphs: lucideSet, mode: 'stroke' });

const featherSet = new Map<string, Glyph>();
for (const [name, icon] of Object.entries((feather as { icons: Record<string, { contents: string }> }).icons)) {
  featherSet.set(name.toLowerCase(), { s: parseSvgShapes(icon.contents), vb: '0 0 24 24' });
}
SETS.set('feather', { glyphs: featherSet, mode: 'stroke' });

SETS.set('phosphor', iconifySet(phosphor as IconifyData));
SETS.set('hero', iconifySet(heroicons as IconifyData));
SETS.set('material', iconifySet(material as IconifyData));
SETS.set('flowbite', iconifySet(flowbite as IconifyData));
SETS.set('nonicons', iconifySet(nonicons as IconifyData));
SETS.set('meteor', iconifySet(meteor as IconifyData));
SETS.set('sargam', iconifySet(sargam as IconifyData));
SETS.set('mage', iconifySet(mage as IconifyData));
SETS.set('logos', iconifySet(logos as IconifyData));

/** Resolve a set + kebab name to its glyph record, or null. */
export function resolveIconGlyph(name: string, set = 'lucide'): Glyph | null {
  return SETS.get(set)?.glyphs.get(name.toLowerCase()) ?? null;
}

/** The catalog's honest vocabulary - every vendored glyph name in a set, sorted. */
export function iconNames(set = 'lucide'): string[] {
  return [...(SETS.get(set)?.glyphs.keys() ?? [])].sort();
}

/** The vendored set names - the icon param's honest enum. */
export function iconSetNames(): string[] {
  return [...SETS.keys()];
}

/** Stamp glyph shape data onto every payload naming a glyph (a text's or a field's Lucide name); runs after instance expansion, unknown names stamp nothing. */
export function stampIconGlyphs(doc: SceneDocument): SceneDocument {
  for (const node of Object.values(doc.nodes)) {
    for (const [ref, payload] of Object.entries(node.components)) {
      const p = payload as Record<string, unknown>;
      const prim = primitiveOfRef(ref);
      // The five: a text's or a field's glyph is a Lucide name; the shapes ride the served payload for the engine.
      if ((prim === 'text' || prim === 'field') && typeof p['glyph'] === 'string' && p['glyph'] !== '') {
        const glyph = resolveIconGlyph(p['glyph'], 'lucide');
        if (glyph !== null) {
          p['_svg'] = glyph.s;
          p['_vb'] = glyph.vb;
          p['_mode'] = 'stroke';
        }
      }
      // A field's focused-icon stamps the same way (lucide names).
      if (prim === 'field' && typeof p['focused-icon'] === 'string' && p['focused-icon'] !== '') {
        const fGlyph = resolveIconGlyph(p['focused-icon'], 'lucide');
        if (fGlyph !== null) {
          p['_focused-icon-svg'] = fGlyph.s;
          p['_focused-icon-vb'] = fGlyph.vb;
        }
      }
    }
  }
  return doc;
}
