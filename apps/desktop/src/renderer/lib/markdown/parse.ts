/**
 * FR-198: a hand-rolled INERT markdown subset — bold/italic/inline code/code blocks/lists/
 * headings/pipe tables, nothing else. Deliberately NOT a real markdown engine: links and images stay
 * literal text (the FR-108 inertness law — rendered output can never navigate or fetch),
 * raw HTML stays literal text, unclosed markers stay literal (never swallow). Zero deps:
 * every future model integration emits markdown natively, so the renderer is the reusable
 * investment (spec §15 decision, 2026-07-10).
 */

export type Inline = { kind: 'text' | 'bold' | 'italic' | 'code'; text: string };
export type Block =
  | { kind: 'para'; inline: Inline[] }
  | { kind: 'heading'; level: 1 | 2 | 3; inline: Inline[] }
  | { kind: 'code'; text: string; lang: string | null }
  | { kind: 'list'; ordered: boolean; items: Inline[][] }
  | { kind: 'table'; header: Inline[][]; rows: Inline[][][] };

/** Scan one line's text into inline runs. A marker with no closer is emitted as literal text. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let literal = '';
  const flush = (): void => {
    if (literal.length > 0) { out.push({ kind: 'text', text: literal }); literal = ''; }
  };
  let i = 0;
  while (i < text.length) {
    // `code` — highest precedence: markdown does not nest inside code spans.
    if (text[i] === '`') {
      const close = text.indexOf('`', i + 1);
      if (close > i + 1) { flush(); out.push({ kind: 'code', text: text.slice(i + 1, close) }); i = close + 1; continue; }
    } else if (text.startsWith('**', i)) {
      const close = text.indexOf('**', i + 2);
      if (close > i + 2) { flush(); out.push({ kind: 'bold', text: text.slice(i + 2, close) }); i = close + 2; continue; }
    } else if (text[i] === '*') {
      const close = text.indexOf('*', i + 1);
      if (close > i + 1) { flush(); out.push({ kind: 'italic', text: text.slice(i + 1, close) }); i = close + 1; continue; }
    } else if (text[i] === '_') {
      const close = text.indexOf('_', i + 1);
      if (close > i + 1) { flush(); out.push({ kind: 'italic', text: text.slice(i + 1, close) }); i = close + 1; continue; }
    }
    literal += text[i];
    i += 1;
  }
  flush();
  return out;
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const UL_RE = /^[-*]\s+(.*)$/;
const OL_RE = /^\d+\.\s+(.*)$/;
const FENCE_RE = /^```(\S*)\s*$/;
/* Tables (added 2026-07-20, the investor-table specimen): recognized ONLY as header line +
 * dash separator — a lone piped line stays literal text (never swallow). */
const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** Split one `| a | b |` row into trimmed cell strings (leading/trailing pipes optional). */
function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

export function parseInert(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.split('\n');
  let para: string[] = [];
  const flushPara = (): void => {
    if (para.length === 0) return;
    blocks.push({ kind: 'para', inline: parseInline(para.join('\n')) });
    para = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    const fence = FENCE_RE.exec(line);
    if (fence) {
      flushPara();
      const lang = fence[1] === '' ? null : fence[1]!;
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE_RE.test(lines[i]!)) { body.push(lines[i]!); i += 1; }
      i += 1; // skip the closing fence (or run past the end — unterminated swallows honestly)
      blocks.push({ kind: 'code', text: body.join('\n'), lang });
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      flushPara();
      const level = Math.min(heading[1]!.length, 3) as 1 | 2 | 3;
      blocks.push({ kind: 'heading', level, inline: parseInline(heading[2]!) });
      i += 1;
      continue;
    }

    const nextLine = i + 1 < lines.length ? lines[i + 1]! : null;
    if (line.includes('|') && nextLine !== null && nextLine.includes('|') && TABLE_SEP_RE.test(nextLine)) {
      flushPara();
      const header = splitTableRow(line).map(parseInline);
      const rows: Inline[][][] = [];
      i += 2; // header + separator consumed
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim() !== '') {
        rows.push(splitTableRow(lines[i]!).map(parseInline));
        i += 1;
      }
      blocks.push({ kind: 'table', header, rows });
      continue;
    }

    const ul = UL_RE.exec(line);
    const ol = ul === null ? OL_RE.exec(line) : null;
    if (ul || ol) {
      flushPara();
      const ordered = ol !== null;
      const items: Inline[][] = [];
      while (i < lines.length) {
        const m = ordered ? OL_RE.exec(lines[i]!) : UL_RE.exec(lines[i]!);
        if (m === null) break;
        items.push(parseInline(m[1]!));
        i += 1;
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }

    if (line.trim() === '') { flushPara(); i += 1; continue; }

    para.push(line);
    i += 1;
  }
  flushPara();
  return blocks;
}
