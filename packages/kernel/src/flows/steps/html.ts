import { SINGLE_IN, type FlowStepDef, type PureRunOutput } from '../stepTypes.js';

// Pulls inner text out of an HTML field by a small selector subset (tag, .class, #id).

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

// Inner text of a fragment: scripts/styles dropped, tags become spaces, whitespace collapses.
function stripTags(html: string): string {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ');
  return decodeEntities(text).replace(/\s+/g, ' ').trim();
}

interface Selector { tag: string; cls: string; id: string }

// Parses the selector subset: an optional tag plus .class / #id suffixes.
function parseSelector(raw: string): Selector | null {
  const m = raw.trim().match(/^([a-zA-Z][\w-]*)?((?:[.#][\w-]+)*)$/);
  if (!m || (!m[1] && !m[2])) return null;
  let cls = '';
  let id = '';
  for (const part of m[2]?.match(/[.#][\w-]+/g) ?? []) {
    if (part.startsWith('.')) cls = part.slice(1);
    else id = part.slice(1);
  }
  return { tag: (m[1] ?? '').toLowerCase(), cls, id };
}

function attrsMatch(attrs: string, sel: Selector): boolean {
  if (sel.id !== '') {
    const m = attrs.match(/\bid\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    if ((m?.[1] ?? m?.[2] ?? '') !== sel.id) return false;
  }
  if (sel.cls !== '') {
    const m = attrs.match(/\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    if (!(m?.[1] ?? m?.[2] ?? '').split(/\s+/).includes(sel.cls)) return false;
  }
  return true;
}

// Inner markup of the element opening at `from`; counts same-tag nesting, unclosed reads to end.
function innerAfter(html: string, tag: string, from: number): string {
  const re = new RegExp(`<(/?)${tag}(?=[\\s/>])[^>]*>`, 'gi');
  re.lastIndex = from;
  let depth = 1;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m[1] === '/') depth--;
    else if (!m[0].endsWith('/>')) depth++;
    if (depth === 0) return html.slice(from, m.index);
  }
  return html.slice(from);
}

// Every matching element's inner text in document order, nested matches included.
function extract(html: string, sel: Selector): string[] {
  const texts: string[] = [];
  const open = /<([a-zA-Z][\w-]*)((?:\s[^<>]*)?)>/g;
  for (let m = open.exec(html); m; m = open.exec(html)) {
    const tag = (m[1] ?? '').toLowerCase();
    if (sel.tag !== '' && tag !== sel.tag) continue;
    if (!attrsMatch(m[2] ?? '', sel)) continue;
    const selfClosed = (m[2] ?? '').trimEnd().endsWith('/') || VOID_TAGS.has(tag);
    texts.push(selfClosed ? '' : stripTags(innerAfter(html, tag, open.lastIndex)));
  }
  return texts;
}

export const htmlStep: FlowStepDef = {
  kind: 'html',
  displayName: 'HTML',
  blurb: 'pulls values out of an HTML field',
  inputs: SINGLE_IN,
  outputs: ['out'],
  params: {
    field: { type: 'string', required: true, help: 'the HTML field to read' },
    selector: { type: 'string', help: 'what to pull: a tag, .class, or #id (empty = the whole text)' },
    take: { type: 'enum', choices: ['first', 'all'], help: 'first is the default' },
    into: { type: 'string', help: 'where the answer lands (defaults to the field)' },
  },
  guidance: 'Pulls text OUT of an HTML field - it never fetches (a connection step fetches the page first). The selector is a small subset: a tag, .class, or #id; empty strips every tag and returns the whole text. take: all lands an array - One row per... fans it out.',
  examples: [
    { title: 'every headline on the page', params: { field: 'body', selector: 'h2', take: 'all', into: 'headlines' }, note: 'follow with one-row-per on headlines' },
  ],
  exec: {
    pure: ({ params, inputs }): PureRunOutput => {
      const items = inputs['in'] ?? [];
      const field = typeof params['field'] === 'string' ? params['field'] : '';
      if (field === '') return { outputs: { out: items } };
      const rawSelector = typeof params['selector'] === 'string' ? params['selector'].trim() : '';
      const sel = rawSelector === '' ? null : parseSelector(rawSelector);
      if (rawSelector !== '' && !sel) {
        return { outputs: {}, error: 'the HTML step takes a tag, .class, or #id as its selector' };
      }
      const all = params['take'] === 'all';
      const into = typeof params['into'] === 'string' && params['into'] !== '' ? params['into'] : field;
      const out = items.map((item) => {
        const raw = item.json[field];
        if (typeof raw !== 'string') return item;
        const texts = sel ? extract(raw, sel) : [stripTags(raw)];
        return { json: { ...item.json, [into]: all ? texts : texts[0] ?? '' } };
      });
      return { outputs: { out } };
    },
  },
};
