import type { FlowItem } from '@tent-nocode/core';
import { SINGLE_IN, type FlowStepDef, type PureRunOutput } from '../stepTypes.js';

/** Parses an RSS or Atom feed text field into one row per entry; fetching is not this step's job. */

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Inner text of the first <tag> in the block; CDATA unwrapped, markup stripped, entities decoded. */
function tagText(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'));
  if (!m) return '';
  let text = (m[1] ?? '').trim();
  const cdata = text.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  if (cdata) text = (cdata[1] ?? '').trim();
  return decodeEntities(text.replace(/<[^>]*>/g, '')).trim();
}

/** The entry's link: RSS link text, else the Atom href (alternate rel or first). */
function linkOf(block: string): string {
  const rssLink = tagText(block, 'link');
  if (rssLink !== '') return rssLink;
  const hrefs = [...block.matchAll(/<link\b([^>]*)\/?>(?:<\/link>)?/gi)].map((m) => m[1] ?? '');
  const pick = hrefs.find((a) => /rel\s*=\s*"alternate"/i.test(a)) ?? hrefs[0] ?? '';
  const href = pick.match(/href\s*=\s*"([^"]*)"/i);
  return href ? decodeEntities(href[1] ?? '') : '';
}

function entryRow(block: string): Record<string, unknown> {
  return {
    title: tagText(block, 'title'),
    link: linkOf(block),
    published: tagText(block, 'pubDate') || tagText(block, 'published') || tagText(block, 'updated'),
    summary: tagText(block, 'description') || tagText(block, 'summary'),
    id: tagText(block, 'guid') || tagText(block, 'id'),
  };
}

function parseFeed(xml: string): Record<string, unknown>[] {
  const blocks = [
    ...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi),
    ...xml.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi),
  ];
  return blocks.map((m) => entryRow(m[1] ?? ''));
}

export const readFeedStep: FlowStepDef = {
  kind: 'read-feed',
  displayName: 'Read a feed',
  blurb: 'turns a feed text into one row per entry',
  inputs: SINGLE_IN,
  outputs: ['out'],
  params: {
    field: { type: 'string', required: true, help: 'the field holding the feed text (an HTTP request step fetches it)' },
    limit: { type: 'number', help: 'keep only the first entries (empty = all)' },
  },
  guidance: 'Parses an RSS or Atom feed TEXT already sitting in a field into one row per entry ({ title, link, published, summary, id }) - it never fetches (a connection step fetches the feed first). Dedupe by id or link before saving to keep re-runs clean.',
  examples: [
    { title: 'rows from a fetched feed', params: { field: 'body', limit: 20 }, note: 'follow with dedupe by link, then save-rows' },
  ],
  exec: {
    pure: ({ params, inputs }): PureRunOutput => {
      const field = typeof params['field'] === 'string' ? params['field'] : '';
      const items = inputs['in'] ?? [];
      if (field === '') return { outputs: { out: items } };
      const limit = typeof params['limit'] === 'number' && params['limit'] > 0 ? Math.floor(params['limit']) : Infinity;
      const out: FlowItem[] = [];
      for (const item of items) {
        const raw = item.json[field];
        if (typeof raw !== 'string') { out.push(item); continue; }
        for (const row of parseFeed(raw).slice(0, limit === Infinity ? undefined : limit)) {
          out.push({ json: row });
        }
      }
      return { outputs: { out } };
    },
  },
};
