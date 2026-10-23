import type { IntentPartDto, ThreadIntent } from '../../../shared/ipc.js';
import { formatTokens } from './feed.js';

/**
 * FR-232: pure derivation for the living checklist (house law: pure functions carry the logic,
 * the component only renders) — derive from the read, refetch on live signals, never a local
 * state flip.
 */

export interface ChecklistLine {
  glyph: string;
  text: string;
  status: IntentPartDto['status'];
  /** The part's evidence/why note, when the desk wrote one. */
  note: string | null;
}

/** ✓ done · ● in flight (breathes) · ○ pending · ⚠ blocked (amber) · ✕ dropped (struck) —
 * the CC-task vocabulary (Tier 52 FR-466): blocked forked from dropped so the amber status
 * hue has a glyph of its own; everything else is the same house set. */
export function partGlyph(status: IntentPartDto['status']): string {
  switch (status) {
    case 'done': return '✓';
    case 'in_flight': return '●';
    case 'pending': return '○';
    case 'blocked': return '⚠';
    case 'dropped': return '✕';
  }
}

export function checklistLines(parts: IntentPartDto[]): ChecklistLine[] {
  return parts.map((p) => ({
    glyph: partGlyph(p.status), text: p.text, status: p.status, note: p.note ?? null,
  }));
}

// The `wakes N of M` readout DIED 2026-07-29 (speed arc D-x13): the D-65 budget loop is
// gone — settles are quiet, the last settle triggers ONE review; no brake to render.

/** The mission's price tag (FR-232 amendment): tokens headline, like the thread strip. */
export function spendLabel(intent: Pick<ThreadIntent, 'spendTokens'>): string | null {
  return intent.spendTokens > 0 ? `${formatTokens(intent.spendTokens)} tokens` : null;
}

/** The parked banner's text — the question the user must answer, verbatim from the record. */
export function parkedBanner(intent: Pick<ThreadIntent, 'status' | 'note'>): string | null {
  if (intent.status !== 'parked') return null;
  return intent.note ?? 'parked — reply to continue';
}
