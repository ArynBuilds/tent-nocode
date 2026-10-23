import type { ActivityStep } from '@tent-nocode/core';

/**
 * FR-173/174: pure mapping from claude CLI stream-json NDJSON lines to ActivitySteps.
 * D-40 law: this file may NEVER throw on input — a bad line maps to null and the run's
 * truth stays the final result line + exit code.
 */

const TEXT_CAP = 500;
const TARGET_CAP = 80;

/** Line splitter with partial-line carry-over across stdout chunks. */
export class NdjsonBuffer {
  private buf = '';
  feed(chunk: string): string[] {
    this.buf += chunk;
    const lines: string[] = [];
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line) lines.push(line);
    }
    return lines;
  }
  flush(): string[] {
    const rest = this.buf.trim();
    this.buf = '';
    return rest ? [rest] : [];
  }
}

/** Redacting one-liner for a tool call: names the object, never carries bodies. */
export function summarizeToolInput(tool: string, input: unknown): string {
  const obj = (input !== null && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const pick = (...keys: string[]): string | null => {
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === 'string' && v.length > 0) return v;
    }
    return null;
  };
  // The roster's UI caption: 2-5 plain words riding the call ARE the feed line.
  const doing = obj['doing'];
  if (typeof doing === 'string' && doing.length > 0) return doing.slice(0, TARGET_CAP);
  let raw: string | null;
  if (tool === 'Bash') raw = (pick('command') ?? '').split('\n')[0] ?? '';
  else if (tool === 'Read' || tool === 'Write' || tool === 'Edit') raw = pick('file_path');
  else if (tool === 'Grep' || tool === 'Glob') raw = pick('pattern');
  else {
    raw = pick('query', 'path', 'file_path', 'pattern', 'name', 'url');
    if (raw === null) {
      const first = Object.values(obj).find((v): v is string => typeof v === 'string' && v.length > 0);
      raw = first ?? '';
    }
  }
  return (raw ?? '').slice(0, TARGET_CAP);
}

export interface StreamLineOut {
  steps: ActivityStep[]; delta?: string; resultRaw?: string;
  /** Tier 33: a thinking-content delta — the ONLY place the reasoning text streams. */
  thinkDelta?: string;
  /** Tier 28 (D-118): the engine compacted this session mid-run — an ANOMALY by design (the
   * kernel's window step exists so the wall is never reached; the runner records the event). */
  compacted?: true;
}

/** Maps one NDJSON line. Returns null for blank/unparseable/irrelevant lines. */
export function mapStreamLine(line: string): StreamLineOut | null {
  if (!line) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (obj === null || typeof obj !== 'object') return null;
  const type = obj['type'];
  if (type === 'system' && obj['subtype'] === 'compact_boundary') return { steps: [], compacted: true };
  if (type === 'result') return { steps: [], resultRaw: line };
  if (type === 'stream_event') {
    const event = obj['event'] as Record<string, unknown> | undefined;
    const delta = event?.['delta'] as Record<string, unknown> | undefined;
    const text = delta?.['type'] === 'text_delta' && typeof delta['text'] === 'string' ? delta['text'] : undefined;
    if (text !== undefined) return { steps: [], delta: text };
    // Tier 33 (live find 2026-07-20): the completed assistant message carries its thinking
    // block WITHOUT the text — the content only streams here, as thinking deltas. The driver
    // accumulates these into the next thinking step's headline.
    const think = delta?.['type'] === 'thinking_delta' && typeof delta['thinking'] === 'string' ? delta['thinking'] : undefined;
    return think !== undefined ? { steps: [], thinkDelta: think } : null;
  }
  if (type !== 'assistant' && type !== 'user') return null;
  const message = obj['message'] as Record<string, unknown> | undefined;
  const content = Array.isArray(message?.['content']) ? (message['content'] as Record<string, unknown>[]) : [];
  const steps: ActivityStep[] = [];
  for (const block of content) {
    if (type === 'assistant' && block['type'] === 'text' && typeof block['text'] === 'string' && block['text'].length > 0) {
      steps.push({ kind: 'text', text: block['text'].slice(0, TEXT_CAP) });
    } else if (type === 'assistant' && block['type'] === 'tool_use' && typeof block['name'] === 'string') {
      const step: ActivityStep = { kind: 'tool', tool: block['name'], target: summarizeToolInput(block['name'], block['input']) };
      // Tier 33 (2026-07-20): edit magnitude from the tool INPUT — honest counts, no bodies.
      const input = (block['input'] !== null && typeof block['input'] === 'object' ? block['input'] : {}) as Record<string, unknown>;
      const lines = (v: unknown): number => (typeof v === 'string' && v.length > 0 ? v.split('\n').length : 0);
      if (block['name'] === 'Edit') {
        step.plus = lines(input['new_string']);
        step.minus = lines(input['old_string']);
      } else if (block['name'] === 'Write') {
        step.plus = lines(input['content']);
      } else if (block['name'] === 'NotebookEdit') {
        step.plus = lines(input['new_source']);
      }
      steps.push(step);
    } else if (type === 'assistant' && block['type'] === 'thinking') {
      // Tier 33 (2026-07-20, user-ratified): the tick becomes narration — a short HEADLINE of
      // the reasoning (first line, capped) rides the step; the full content still never persists.
      const think = typeof block['thinking'] === 'string' ? block['thinking'].trim() : '';
      const headline = (think.split('\n').find((l) => l.trim().length > 0) ?? '').trim().slice(0, 100);
      steps.push({ kind: 'thinking', ...(headline.length > 0 ? { text: headline } : {}) });
    } else if (type === 'user' && block['type'] === 'tool_result') {
      steps.push({ kind: 'tool_done', ok: block['is_error'] !== true });
    }
  }
  return steps.length > 0 ? { steps } : null;
}
