import { SINGLE_IN, type FlowStepDef, type PureRunOutput } from '../stepTypes.js';

/** Turns an XML string field into row data or back; malformed XML adds an 'xml-error' field instead of throwing. */

function stripNoise(xml: string): string {
  return xml.replace(/<\?[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '');
}

interface Cursor { s: string; i: number }

function skipWs(c: Cursor): void {
  while (c.i < c.s.length && /\s/.test(c.s[c.i]!)) c.i++;
}

const NAME = /[A-Za-z_][\w.:-]*/y;
const ATTR = /\s+([A-Za-z_][\w.:-]*)\s*=\s*"([^"]*)"/y;

function readName(c: Cursor): string {
  NAME.lastIndex = c.i;
  const m = NAME.exec(c.s);
  if (!m) throw new Error('the xml has an unnamed tag');
  c.i = NAME.lastIndex;
  return m[0];
}

function readAttrs(c: Cursor): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (;;) {
    ATTR.lastIndex = c.i;
    const m = ATTR.exec(c.s);
    if (!m) break;
    attrs[m[1]!] = m[2]!;
    c.i = ATTR.lastIndex;
  }
  return attrs;
}

/** Folds attributes + child tags + stray text into one row-shaped object. */
function attrify(attrs: Record<string, string>, children: Record<string, unknown>, text: string): Record<string, unknown> {
  const value: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs)) value['@' + k] = v;
  Object.assign(value, children);
  if (text !== '' && Object.keys(children).length === 0) value['#text'] = text;
  return value;
}

/** Reads one element starting at '<'; consumes through its closing tag. */
function readElement(c: Cursor): { tag: string; value: unknown } {
  skipWs(c);
  if (c.s[c.i] !== '<') throw new Error('the xml is not well-formed');
  c.i++;
  const tag = readName(c);
  const attrs = readAttrs(c);
  skipWs(c);
  if (c.s.startsWith('/>', c.i)) {
    c.i += 2;
    return { tag, value: Object.keys(attrs).length > 0 ? attrify(attrs, {}, '') : '' };
  }
  if (c.s[c.i] !== '>') throw new Error(`the <${tag}> tag is not well-formed`);
  c.i++;
  const children: Record<string, unknown> = {};
  let text = '';
  for (;;) {
    const closeAt = c.s.indexOf('<', c.i);
    if (closeAt === -1) throw new Error(`the <${tag}> tag is never closed`);
    text += c.s.slice(c.i, closeAt);
    c.i = closeAt;
    if (c.s.startsWith('</', c.i)) {
      c.i += 2;
      const closeTag = readName(c);
      skipWs(c);
      if (c.s[c.i] !== '>') throw new Error(`the </${closeTag}> tag is not well-formed`);
      c.i++;
      if (closeTag !== tag) throw new Error(`the <${tag}> tag closes as </${closeTag}>`);
      break;
    }
    const child = readElement(c);
    const existing = children[child.tag];
    children[child.tag] = existing === undefined ? child.value : Array.isArray(existing) ? [...existing, child.value] : [existing, child.value];
  }
  const hasChildren = Object.keys(children).length > 0;
  const hasAttrs = Object.keys(attrs).length > 0;
  if (!hasChildren && !hasAttrs) return { tag, value: text.trim() };
  return { tag, value: attrify(attrs, children, text.trim()) };
}

function parseXml(xml: string): Record<string, unknown> {
  const c: Cursor = { s: stripNoise(xml), i: 0 };
  skipWs(c);
  if (c.i >= c.s.length) throw new Error('the xml is empty');
  const root = readElement(c);
  return { [root.tag]: root.value };
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function toTag(tag: string, value: unknown): string {
  if (Array.isArray(value)) return value.map((v) => toTag(tag, v)).join('');
  if (typeof value === 'object' && value !== null) {
    let attrs = '';
    let inner = '';
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // attribute values also escape the quote so a value cannot end the attribute
      if (k.startsWith('@')) attrs += ` ${k.slice(1)}="${escapeXml(String(v)).replace(/"/g, '&quot;')}"`;
      else if (k === '#text') inner += escapeXml(String(v));
      else inner += toTag(k, v);
    }
    return `<${tag}${attrs}>${inner}</${tag}>`;
  }
  return `<${tag}>${value === undefined || value === null ? '' : escapeXml(String(value))}</${tag}>`;
}

function toXml(value: unknown): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('the field is not row data to turn into xml');
  }
  return Object.entries(value as Record<string, unknown>).map(([k, v]) => toTag(k, v)).join('');
}

export const xmlStep: FlowStepDef = {
  kind: 'xml',
  displayName: 'XML',
  blurb: 'turns XML into row data, or back',
  inputs: SINGLE_IN,
  outputs: ['out'],
  params: {
    field: { type: 'string', required: true, help: 'the field to convert' },
    direction: { type: 'enum', choices: ['to-data', 'to-xml'], help: 'to-data is the default' },
    into: { type: 'string', help: 'where the answer lands (defaults to the field)' },
  },
  guidance: 'Converts a field between XML text and row data: to-data parses (attributes land as @name, text as #text, repeated tags become arrays); to-xml writes the object back out. Malformed XML never throws - the row gains an xml-error field instead, so check it downstream.',
  examples: [
    { title: 'parse a SOAP-ish answer', params: { field: 'body', direction: 'to-data', into: 'data' }, note: 'follow with keep-rows where xml-error is empty' },
  ],
  exec: {
    pure: ({ params, inputs }): PureRunOutput => {
      const items = inputs['in'] ?? [];
      const field = typeof params['field'] === 'string' ? params['field'] : '';
      if (!field) return { outputs: { out: items } };
      const toXmlDirection = params['direction'] === 'to-xml';
      const target = typeof params['into'] === 'string' && params['into'] !== '' ? params['into'] : field;
      const out = items.map((item) => {
        try {
          const answer = toXmlDirection ? toXml(item.json[field]) : parseXml(String(item.json[field] ?? ''));
          return { json: { ...item.json, [target]: answer } };
        } catch (err) {
          const message = err instanceof Error ? err.message : 'the xml could not be read';
          return { json: { ...item.json, 'xml-error': message } };
        }
      });
      return { outputs: { out } };
    },
  },
};
