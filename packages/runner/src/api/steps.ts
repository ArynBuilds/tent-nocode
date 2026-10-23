import type { ActivityStep } from '@tent-nocode/core';
import { summarizeToolInput } from '../streamParser.js';

// Maps AI SDK stream parts to ActivitySteps; never throws, unknown parts map to nothing.

const TEXT_CAP = 500;
const HEADLINE_CAP = 100;
const THINK_BUF_CAP = 300;

/** One mapped stream part: steps to persist + the ephemeral typing delta. */
export interface MappedApiPart {
  steps: ActivityStep[];
  /** Token-level text delta — ephemeral, never persisted. */
  delta?: string;
  /** The finished text block, human-readable text only. */
  textBlock?: string;
}

/** Duck-typed part shape so new SDK part kinds degrade to silence, never a crash. */
export interface ApiStreamPartLike {
  type: string;
  id?: string;
  text?: string;
  toolName?: string;
  input?: unknown;
  [key: string]: unknown;
}

const lines = (v: unknown): number => (typeof v === 'string' && v.length > 0 ? v.split('\n').length : 0);

/** Stateful per-turn mapper; one instance per driver execute. */
export class ApiStepMapper {
  private textBufs = new Map<string, string>();
  private thinkBuf = '';

  onPart(part: ApiStreamPartLike): MappedApiPart {
    switch (part.type) {
      case 'text-start': {
        if (typeof part.id === 'string') this.textBufs.set(part.id, '');
        return { steps: [] };
      }
      case 'text-delta': {
        const text = typeof part.text === 'string' ? part.text : '';
        if (typeof part.id === 'string') {
          this.textBufs.set(part.id, (this.textBufs.get(part.id) ?? '') + text);
        }
        return text.length > 0 ? { steps: [], delta: text } : { steps: [] };
      }
      case 'text-end': {
        const buf = typeof part.id === 'string' ? (this.textBufs.get(part.id) ?? '') : '';
        if (typeof part.id === 'string') this.textBufs.delete(part.id);
        if (buf.length === 0) return { steps: [] };
        return { steps: [{ kind: 'text', text: buf.slice(0, TEXT_CAP) }], textBlock: buf };
      }
      case 'reasoning-delta': {
        const text = typeof part.text === 'string' ? part.text : '';
        if (this.thinkBuf.length < THINK_BUF_CAP) this.thinkBuf += text;
        return { steps: [] };
      }
      case 'reasoning-end': {
        // Only a short headline of the reasoning persists.
        const headline = (this.thinkBuf.split('\n').find((l) => l.trim().length > 0) ?? '')
          .trim().slice(0, HEADLINE_CAP);
        this.thinkBuf = '';
        return { steps: [{ kind: 'thinking', ...(headline.length > 0 ? { text: headline } : {}) }] };
      }
      case 'tool-call': {
        if (typeof part.toolName !== 'string') return { steps: [] };
        const step: ActivityStep = {
          kind: 'tool', tool: part.toolName,
          target: summarizeToolInput(part.toolName, part.input),
        };
        // Edit magnitude from the tool input — line counts, no bodies.
        const input = (part.input !== null && typeof part.input === 'object' ? part.input : {}) as Record<string, unknown>;
        if (part.toolName === 'Edit') {
          step.plus = lines(input['new_string']);
          step.minus = lines(input['old_string']);
        } else if (part.toolName === 'Write') {
          step.plus = lines(input['content']);
        }
        return { steps: [step] };
      }
      case 'tool-result':
        return { steps: [{ kind: 'tool_done', ok: true }] };
      case 'tool-error':
        return { steps: [{ kind: 'tool_done', ok: false }] };
      default:
        return { steps: [] };
    }
  }
}
