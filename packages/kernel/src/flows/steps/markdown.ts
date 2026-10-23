import { SINGLE_IN, type FlowStepDef, type PureRunOutput } from '../stepTypes.js';

/** Converts a small markdown subset to simple HTML and back; only http/https links become anchors. */

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function unescapeHtml(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

/** Inline spans, applied inside one block of already-escaped text. */
function inlineToHtml(text: string): string {
  let out = text.replace(/`([^`]+)`/g, (_m, code: string) => `<code>${code}</code>`);
  // the url group allows one level of nested parens so a ) inside the url never leaks
  out = out.replace(/\[([^\]]*)\]\(((?:[^()]|\([^()]*\))+)\)/g, (_m, label: string, url: string) =>
    // quotes escaped so the url cannot break out of the attribute
    /^https?:\/\//i.test(url) ? `<a href="${url.replace(/"/g, '&quot;')}">${label}</a>` : label);
  out = out.replace(/\*\*([^*]+)\*\*/g, (_m, b: string) => `<strong>${b}</strong>`);
  out = out.replace(/\*([^*]+)\*/g, (_m, i: string) => `<em>${i}</em>`);
  return out;
}

function toHtml(text: string): string {
  const lines = escapeHtml(text).split(/\r?\n/);
  const blocks: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.trim() === '') { i++; continue; }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = (heading[1] ?? '#').length;
      blocks.push(`<h${level}>${inlineToHtml(heading[2] ?? '')}</h${level}>`);
      i++;
      continue;
    }
    if (/^-\s+/.test(line)) {
      const items: string[] = [];
      let cur = lines[i] ?? '';
      while (i < lines.length && /^-\s+/.test(cur)) {
        items.push(`<li>${inlineToHtml(cur.replace(/^-\s+/, ''))}</li>`);
        i++;
        cur = lines[i] ?? '';
      }
      blocks.push(`<ul>${items.join('')}</ul>`);
      continue;
    }
    const para: string[] = [];
    let cur = lines[i] ?? '';
    while (i < lines.length && cur.trim() !== '' && !/^#{1,6}\s+/.test(cur) && !/^-\s+/.test(cur)) {
      para.push(cur);
      i++;
      cur = lines[i] ?? '';
    }
    blocks.push(`<p>${inlineToHtml(para.join(' '))}</p>`);
  }
  return blocks.join('\n');
}

function toMarkdown(html: string): string {
  let out = html;
  out = out.replace(/<code>([\s\S]*?)<\/code>/g, (_m, c: string) => `\`${c}\``);
  out = out.replace(/<a href="([^"]*)">([\s\S]*?)<\/a>/g, (_m, url: string, label: string) => `[${label}](${url})`);
  out = out.replace(/<strong>([\s\S]*?)<\/strong>/g, (_m, b: string) => `**${b}**`);
  out = out.replace(/<em>([\s\S]*?)<\/em>/g, (_m, i: string) => `*${i}*`);
  out = out.replace(/<h([1-6])>([\s\S]*?)<\/h\1>/g, (_m, level: string, inner: string) => `${'#'.repeat(Number(level))} ${inner}\n\n`);
  out = out.replace(/<li>([\s\S]*?)<\/li>/g, (_m, inner: string) => `- ${inner}\n`);
  out = out.replace(/<\/?ul>/g, '');
  out = out.replace(/<p>([\s\S]*?)<\/p>/g, (_m, inner: string) => `${inner}\n\n`);
  // anything else: strip the tags, keep the text they wrapped
  out = out.replace(/<[^>]+>/g, '');
  out = unescapeHtml(out);
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

export const markdownStep: FlowStepDef = {
  kind: 'markdown',
  displayName: 'Markdown',
  blurb: 'turns markdown into simple HTML, or back',
  inputs: SINGLE_IN,
  outputs: ['out'],
  params: {
    field: { type: 'string', required: true, help: 'the text field to convert' },
    direction: { type: 'enum', choices: ['to-html', 'to-markdown'], help: 'to-html is the default' },
    into: { type: 'string', help: 'where the answer lands (defaults to the field)' },
  },
  guidance: 'Converts a text field between markdown and simple HTML (headings, lists, bold, italic, code, http links only). to-html before sending rich mail through a connection; to-markdown to tame fetched HTML into readable text.',
  examples: [
    { title: 'render the note as HTML', params: { field: 'note', direction: 'to-html', into: 'html' } },
  ],
  exec: {
    pure: ({ params, inputs }): PureRunOutput => {
      const field = params['field'];
      const items = inputs['in'] ?? [];
      if (typeof field !== 'string' || field === '') return { outputs: { out: items } };
      const toMarkdownDirection = params['direction'] === 'to-markdown';
      const into = typeof params['into'] === 'string' && params['into'] !== '' ? params['into'] : field;
      const out = items.map((item) => {
        const raw = item.json[field];
        if (typeof raw !== 'string') return item;
        const converted = toMarkdownDirection ? toMarkdown(raw) : toHtml(raw);
        return { json: { ...item.json, [into]: converted } };
      });
      return { outputs: { out } };
    },
  },
};
