// The leaf lint: cage rules for org-component HTML - no script, network, storage, forms, frames, or raw control characters.

export interface LeafLintFinding { rule: string; message: string }

const BANS: Array<{ rule: string; re: RegExp; message: string }> = [
  { rule: 'no-script', re: /<\s*script\b/i, message: 'script does not run in a face — behavior comes only from the grammar: declared actions, channels, and slots' },
  { rule: 'no-handlers', re: /<[^>]*\son[a-z]+\s*=/i, message: 'on*-attribute handlers are script — wire behavior through the grammar (declared actions, channels, slots), never inline JS' },
  { rule: 'no-js-uri', re: /javascript\s*:/i, message: 'javascript: URIs are script — a face acts only through the grammar, never inline JS' },
  { rule: 'no-network', re: /\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b|\bimport\s*\(/, message: 'network access does not exist in the cage — data reaches a scene only through its consented bindings' },
  { rule: 'no-external-url', re: /https?:\/\//i, message: 'external URLs are banned (even in comments) — inline everything; images are data: URIs' },
  { rule: 'no-storage', re: /\b(localStorage|sessionStorage|indexedDB|document\.cookie)\b/, message: 'browser storage throws in the cage — durable state belongs to the state pocket or a dataset' },
  { rule: 'no-forms', re: /<form\b|\bonsubmit\b/i, message: 'forms do not submit in the cage — inputs and buttons act through declared actions, never a submit' },
  { rule: 'no-frames', re: /<iframe\b|\bsrcdoc\b/i, message: 'nested browsing contexts are banned — the host owns the frame' },
];

export function lintLeafHtml(html: string): LeafLintFinding[] {
  const findings: LeafLintFinding[] = [];
  for (const ban of BANS) {
    if (ban.re.test(html)) findings.push({ rule: ban.rule, message: ban.message });
  }
  // eslint-disable-next-line no-control-regex -- the ban IS about control characters
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(html)) {
    findings.push({ rule: 'no-control-chars', message: 'raw control characters are banned — write escape sequences as text' });
  }
  return findings;
}
