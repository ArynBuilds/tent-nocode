/**
 * FR-194 (deterministic half): machinery fence grammar must never render in the feed. The
 * governed CONTENT still reaches the user through its question block / machinery line — the
 * raw ```ACTION/PROPOSAL/...``` JSON is internal wire format, and rendering it reads as a
 * prompt leak (user finding, 2026-07-10). Case-sensitive, fence-to-fence, all seven grammars
 * (INTENT joined 2026-07-11 — the Tier 15 mission fence rendered as a raw code block until
 * this live finding; the checklist is the mission's only clothing). An UNTERMINATED machinery
 * fence (live tail cut mid-stream) is stripped to the end.
 */

const FENCE = /```(?:ACTION|PROPOSAL|SCHEDULE|TAB_BUNDLE|DATASET_APPEND|TOOL_NOMINATION|INTENT)\b[\s\S]*?(?:```|$)/g;

export function stripMachineryFences(text: string): string {
  if (!text.includes('```')) return text;
  return text.replace(FENCE, '').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Law 6 on LOSSY WINDOWS (live finding 2026-07-13: the website thread flashed raw INTENT/PROPOSAL
 * JSON twice). The delta buffer and the persisted `output_tail` are sliding windows over the
 * output — a window can open MID-FENCE, past the ```NAME opening line, leaving raw fence body +
 * an orphan closing ``` that the opening-anchored regex can never match. For live windows only:
 * when the FIRST fence marker in the (already-stripped) window is a bare closing line, everything
 * through it is a fence remnant and drops. Deliberate bias: an ambiguous leading segment in a
 * lossy preview strips (worst case, a code block's head vanishes from a live preview for a
 * second); the settled render is byte-authoritative and never comes through here.
 */
export function stripLiveWindow(text: string): string {
  const stripped = stripMachineryFences(text);
  const idx = stripped.indexOf('```');
  if (idx === -1) return stripped;
  const lineEnd = stripped.indexOf('\n', idx);
  const marker = (lineEnd === -1 ? stripped.slice(idx) : stripped.slice(idx, lineEnd)).trim();
  if (marker !== '```') return stripped;
  const cut = lineEnd === -1 ? stripped.length : lineEnd + 1;
  return stripped.slice(cut).replace(/\n{3,}/g, '\n\n').trim();
}
