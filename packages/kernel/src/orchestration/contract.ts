import type { IoContract } from '@tent-nocode/core';

// Deterministic check that every declared output appears in what a run produced; non-empty prose passes.
export interface ContractCheck { ok: boolean; missing: string[] }

/** `output` is the stored `runs.output` value, usually `{ result: <driver text> }`. */
export function checkContract(contract: IoContract, output: unknown): ContractCheck {
  const text = extractText(output);
  if (text.trim() === '') {
    return { ok: false, missing: contract.outputs.map((o) => o.name) };
  }
  const parsed = tryParseObject(text);
  if (parsed === null) return { ok: true, missing: [] }; // prose deliverable: non-empty is enough
  const missing = contract.outputs.map((o) => o.name).filter((name) => !(name in parsed));
  return { ok: missing.length === 0, missing };
}

function extractText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output !== null && typeof output === 'object' && 'result' in output) {
    const r = (output as { result: unknown }).result;
    return typeof r === 'string' ? r : JSON.stringify(r ?? '');
  }
  return output === null || output === undefined ? '' : JSON.stringify(output);
}

function tryParseObject(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
