import type { ActivityStep } from '@tent-nocode/core';
import type { ActivityRow, ConversationView, EventRow, IntentPartDto, MessageRow, RunRow, ThreadIntent, WorkRunView } from '../../../shared/ipc.js';
import { stripLiveWindow, stripMachineryFences } from './fences.js';
import { toolLabel } from './labels.js';
export { toolLabel, toolStatusVerb } from './labels.js';

/**
 * THE ONE FEED FILE (the AI-surface rebuild): rows derive from RUN EVENTS plus the
 * per-tool UI captions tools.ts emits — the user's messages, the assistant's prose,
 * the shimmer thinking word, tool caption lines, the one card, the mission checklist.
 * Pure data in, pure data out: no fetching, no JSX, no Date.now().
 * The chat surface laws hold: one fact one owner; status as words never dots;
 * machinery vocabulary renders as silence (fences.ts owns the fence wall).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One inline file pill: `corroborated` is null while the run is live, then
 * true/false against the run's workspace diff — an uncorroborated chip renders warned. */
export interface FeedChip {
  path: string;
  corroborated: boolean | null;
}

export type FeedItem =
  | { kind: 'prompt'; id: string; text: string; at: string }
  | { kind: 'narration'; id: string; runId: string; text: string; at: string; live: boolean; failed: boolean }
  | { kind: 'question'; id: string; gate: MessageRow; at: string }
  | {
      /** One run's tool work: the desk turn's own steps (absorbed into the turn header)
       * or a dispatched work run (a pill). Steps render as tool caption lines. */
      kind: 'work';
      id: string;
      runId: string;
      /** True = the steps belong to a desk turn; false = a dispatched work run. */
      desk: boolean;
      live: boolean;
      summary: string;
      /** The last meaningful step's line — the settled headline; null for step-less rows. */
      headline: string | null;
      /** The quiet trailing datum: `N steps · [N files ·] duration`. */
      meta: string;
      /** The run's wall clock ("21s" / "2m 10s"). */
      dur: string | null;
      /** Terminal row — true=Done, false=Failed, 'stopped'=user-cancelled, null=live/unknown. */
      settledOk: boolean | 'stopped' | null;
      steps: ActivityStep[];
      chips: FeedChip[];
      at: string;
    }
  | {
      kind: 'outcome';
      id: string;
      runId: string;
      text: string;
      at: string;
      /** Delivered files from the run's workspace diffs — `absolute` null for scratch workspaces. */
      files: { path: string; absolute: string | null }[];
    }
  | { kind: 'stopped'; id: string; at: string }
  | {
      /** A SETTLED ≥2-part mission collapses into the document at its settle time,
       * carrying the final ticks and its runs' delivered files. */
      kind: 'mission';
      id: string;
      status: 'done' | 'cancelled';
      parts: IntentPartDto[];
      at: string;
      files: { path: string; absolute: string | null }[];
    };

export type FoldedItem =
  | FeedItem
  | {
      kind: 'turn';
      id: string;
      runId: string;
      text: string;
      at: string;
      live: boolean;
      failed: boolean;
      children: FeedItem[];
    };

// ---------------------------------------------------------------------------
// Liveness words
// ---------------------------------------------------------------------------

/** The live line for ONE run's steps — the header speaks the current step while running. */
export function groupLiveVerb(steps: { kind: string; tool?: string; target?: string; text?: string }[]): string {
  const last = steps[steps.length - 1];
  if (last === undefined) return 'Working';
  switch (last.kind) {
    case 'thinking': return last.text !== undefined && last.text.length > 0 ? `Thought — ${last.text}` : 'Thinking';
    case 'text': return 'Writing';
    case 'tool': return toolLabel(last.tool ?? '', last.target) ?? 'Working';
    case 'tool_done': return 'Working';
    default: return 'Working';
  }
}

/** The edge status word: null while any live group carries its own verb. */
export function deriveStatus(items: FeedItem[], activeWorkCount = 0): string | null {
  const hasLiveGroup = items.some((i) => i.kind === 'work' && i.live);
  if (hasLiveGroup) return null;

  const liveNarration = items.find((i): i is Extract<FeedItem, { kind: 'narration' }> => i.kind === 'narration' && i.live);
  if (liveNarration !== undefined) return liveNarration.text.length === 0 ? 'Thinking' : 'Writing';

  // A work run in flight with no live steps is never silent.
  if (activeWorkCount > 0) return 'Working';

  return null;
}

/** Tokens as humans read them — 999, 12.4k, 1.2M. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

// ---------------------------------------------------------------------------
// The feed build — rows derive from run events + tool captions.
// ---------------------------------------------------------------------------

/** A run still doing anything: running, or a historical queued row. */
function runActive(status: RunRow['status']): boolean {
  return status === 'running' || status === 'queued';
}

export function composerPlaceholder(hasActive: boolean): string {
  return hasActive ? 'Add a follow-up…' : 'Ask anything…';
}

export function hasActiveWork(view: Pick<ConversationView, 'work'>): boolean {
  return view.work.some((r) => runActive(r.status));
}

/** Driver-hygiene artifacts are plumbing — they never reach a user-facing line. */
const HYGIENE_FILES = new Set(['.tent-nocode-mcp.json', '.tent-nocode-system.md']);

/** Outcomes speak deliverable-first: bookkeeping lines strip; honest sentences pass verbatim. */
export function outcomeText(summary: string): string {
  const lines = summary.split('\n').filter((l) => {
    const t = l.trim();
    return !t.startsWith('workspace:') && !t.startsWith('agents used:');
  });
  if (lines.length > 0 && /^\d+ of \d+ tasks? succeeded\.?$/.test(lines[0]!.trim())) {
    lines.shift();
  }
  return lines.map((l) => humanizeFailureLine(l.replace(/^task [\w?]+:\s*/, ''))).join('\n').trim();
}

/** Failures speak sentences, never driver tokens; real error prose passes verbatim. */
function humanizeFailureLine(l: string): string {
  if (/^aborted( before start)?\.?$/.test(l.trim())) {
    return 'Interrupted — the app closed before this run finished.';
  }
  const timeout = /^timed out after (\d+)ms\.?$/.exec(l.trim());
  if (timeout) {
    const mins = Math.round(Number(timeout[1]) / 60000);
    return mins >= 1 ? `Ran out of time after ${mins} minute${mins === 1 ? '' : 's'}.` : 'Ran out of time.';
  }
  return l;
}

/** The last meaningful step's display line, capped — the settled headline. */
export function groupHeadline(steps: ActivityRow['steps']): string | null {
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i]!;
    let line: string | null = null;
    if (s.kind === 'text' && s.text !== undefined && s.text.trim().length > 0) line = s.text.trim();
    else if (s.kind === 'thinking' && s.text !== undefined && s.text.length > 0) line = s.text;
    else if (s.kind === 'tool' && s.tool !== undefined) line = toolLabel(s.tool, s.target);
    if (line !== null && line.length > 0) {
      const first = line.split('\n')[0]!.trim();
      return first.length > 72 ? `${first.slice(0, 71)}…` : first;
    }
  }
  return null;
}

function durationLabel(clock: { startedAt?: string | null; finishedAt?: string | null } | undefined): string | null {
  if (!clock?.startedAt || !clock.finishedAt) return null;
  const s = Math.max(0, Math.round((new Date(clock.finishedAt).getTime() - new Date(clock.startedAt).getTime()) / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

/** Chips come from Write/Edit steps; corroboration checks the run's workspace-diff event. */
function chipsFor(steps: ActivityRow['steps'], runId: string, live: boolean, events: EventRow[]): FeedChip[] {
  const paths: string[] = [];
  for (const s of steps) {
    if (s.kind === 'tool' && (s.tool === 'Write' || s.tool === 'Edit') && s.target && !paths.includes(s.target)
      && !HYGIENE_FILES.has(s.target.replace(/^.*[\\/]/, ''))) {
      paths.push(s.target);
    }
  }
  if (paths.length === 0) return [];
  const diff = events.find((e) => e.type === 'run.workspace_changes' && e.payload['runId'] === runId);
  return paths.map((path) => {
    if (live || diff === undefined) return { path, corroborated: null };
    const haystack = JSON.stringify(diff.payload).replace(/\\\\/g, '/');
    return { path, corroborated: haystack.includes(path.replace(/\\/g, '/')) };
  });
}

/** A run's delivered files (absolute when the workspace was a consented folder). */
function runFiles(detail: WorkRunView | undefined): { path: string; absolute: string | null }[] {
  const files: { path: string; absolute: string | null }[] = [];
  for (const e of detail?.events ?? []) {
    if (e.type !== 'run.workspace_changes') continue;
    const ws = typeof e.payload['workspacePath'] === 'string' ? (e.payload['workspacePath'] as string) : null;
    const sample = Array.isArray(e.payload['sample']) ? (e.payload['sample'] as string[]) : [];
    for (const p of sample) {
      if (typeof p !== 'string' || files.some((f) => f.path === p)) continue;
      if (HYGIENE_FILES.has(p.replace(/^.*[\\/]/, ''))) continue;
      if (files.length >= 8) break;
      files.push({ path: p, absolute: ws !== null ? `${ws.replace(/[\\/]+$/, '')}\\${p}` : null });
    }
  }
  return files;
}

export interface BuildFeedInput {
  view: ConversationView;
  activity: ActivityRow[];
  /** Per-work-run detail (run + messages + events), keyed by runId. Missing entries degrade
   * gracefully: groups render without run metadata, outcomes wait for the fetch. */
  details: Map<string, WorkRunView>;
  /** The thread's latest mission — a SETTLED ≥2-part one becomes a collapsed 'mission'
   * item at its settle time (the pinned card's afterlife). */
  intent?: ThreadIntent | null;
}

export function buildFeed(input: BuildFeedInput): FeedItem[] {
  const items: FeedItem[] = [];
  const { view, activity, details } = input;

  // Turns: the user's messages + the assistant's prose.
  for (const t of view.turns) {
    if (t.role === 'user') {
      items.push({ kind: 'prompt', id: `p-${t.messageId}`, text: t.text, at: t.createdAt });
    } else if (t.runId !== null) {
      const live = t.status === 'running';
      // Live text is a WINDOW over the output; stripLiveWindow drops mid-fence remnants.
      // A failed turn with no reply shows its failure sentence in place - a silent failure reads as "thinking forever".
      const failed = t.status === 'failed' && t.text.length === 0 && typeof t.failure === 'string' && t.failure.length > 0;
      const text = live ? stripLiveWindow(t.outputTail ?? '') : failed ? (t.failure as string) : stripMachineryFences(t.text);
      items.push({ kind: 'narration', id: `n-${t.runId}`, runId: t.runId, text, at: t.createdAt, live, failed });
    }
  }

  // Open gates: the one card at its chronological position.
  for (const g of view.gates) {
    items.push({ kind: 'question', id: `q-${g.id}`, gate: g, at: g.createdAt });
  }

  // Per work run: stopped markers and the outcome.
  const missionParts = input.intent?.parts ?? [];
  const missionRunIds = new Set(missionParts.map((p) => p.runId).filter(Boolean));
  for (const run of view.work) {
    const detail = details.get(run.id);
    for (const e of detail?.events ?? []) {
      if (e.type === 'run.cancelled') {
        items.push({ kind: 'stopped', id: `s-${e.id}`, at: e.createdAt });
      }
    }
    if (runActive(run.status)) continue;
    // A CANCELLED run has no outcome voice — the stopped marker owns the fact.
    if (run.status === 'cancelled') continue;
    // A SUCCEEDED mission-member run has no voice of its own — the settled-mission card
    // and the final reply own that fact. Failures always speak (honesty law).
    if (run.status === 'succeeded' && missionRunIds.has(run.id) && missionParts.length >= 2) continue;
    const result = run.output !== null && typeof run.output['result'] === 'string' ? (run.output['result'] as string) : null;
    const text = outcomeText(stripMachineryFences(run.failure ?? result ?? ''));
    const files = runFiles(detail);
    // Nothing to say and nothing delivered = silence (the reply owns completion).
    if (text === '' && files.length === 0) continue;
    items.push({
      kind: 'outcome', id: `o-${run.id}`, runId: run.id,
      text,
      at: run.finishedAt ?? run.createdAt,
      files,
    });
  }

  // A settled ≥2-part mission collapses into the document at its settle time,
  // carrying the final ticks and its runs' delivered files.
  const intent = input.intent;
  if (intent && intent.parts.length >= 2 && (intent.status === 'done' || intent.status === 'cancelled')) {
    const files: { path: string; absolute: string | null }[] = [];
    for (const p of intent.parts) {
      if (!p.runId) continue;
      for (const f of runFiles(details.get(p.runId))) {
        if (!files.some((x) => x.path === f.path)) files.push(f);
      }
    }
    items.push({
      kind: 'mission', id: `mi-${intent.id}`, status: intent.status,
      parts: intent.parts, at: intent.updatedAt, files,
    });
  }

  // Work groups: activity slices grouped per run — tool caption lines, live while the
  // run runs, summarized after. The desk turn's own steps absorb into the turn header.
  const byRun = new Map<string, { steps: ActivityRow['steps']; at: string }>();
  for (const row of activity) {
    const g = byRun.get(row.runId);
    if (g === undefined) byRun.set(row.runId, { steps: [...row.steps], at: row.at });
    else g.steps.push(...row.steps);
  }
  for (const [runId, g] of byRun) {
    const run = view.work.find((r) => r.id === runId);
    const detail = details.get(runId);
    const deskTurn = view.turns.find((t) => t.runId === runId);
    // The narration bubble OWNS the desk's prose — its 'text' steps never render again
    // inside the group. A desk turn with zero tool work gets NO group at all.
    if (deskTurn !== undefined) {
      g.steps = g.steps.filter((s) => s.kind !== 'text');
      if (g.steps.length === 0) continue;
    }
    const live = run !== undefined ? runActive(run.status) : deskTurn?.status === 'running';
    const chips = chipsFor(g.steps, runId, live, detail?.events ?? []);
    const dur = durationLabel(run ?? deskTurn);
    const headline = groupHeadline(g.steps);
    // A FAILED group's settled header carries its CAUSE on its face.
    const failHead = !live && run?.status === 'failed' && typeof run.failure === 'string' && run.failure.length > 0
      ? run.failure.slice(0, 60)
      : null;
    const meta = [
      `${g.steps.length} step${g.steps.length === 1 ? '' : 's'}`,
      ...(chips.length > 0 ? [`${chips.length} file${chips.length === 1 ? '' : 's'}`] : []),
      ...(dur !== null ? [dur] : []),
      ...(failHead !== null ? [failHead] : []),
    ].join(' · ');
    // The settled line: headline-first when one exists.
    const summary = headline !== null ? `${headline} · ${meta}` : meta;
    const status = run?.status ?? deskTurn?.status ?? null;
    // A user-cancelled run is STOPPED BY YOU — its own honest terminal state, never Failed.
    const settledOk = live || status === null ? null
      : status === 'succeeded' ? true
      : status === 'cancelled' ? 'stopped' as const
      : status === 'failed' ? false
      : null;
    items.push({
      kind: 'work', id: `g-${runId}`, runId, desk: deskTurn !== undefined, live,
      summary, headline, meta, dur, settledOk, steps: g.steps, chips, at: g.at,
    });
  }

  // One chronological document. Ties: prompts first, outcome late, the settled mission last.
  const rank = (k: FeedItem['kind']): number => (k === 'prompt' ? 0 : k === 'outcome' ? 2 : k === 'mission' ? 3 : 1);
  return items.sort((a, b) => {
    const byTime = new Date(a.at).getTime() - new Date(b.at).getTime();
    if (byTime !== 0) return byTime;
    return rank(a.kind) - rank(b.kind);
  });
}

// ---------------------------------------------------------------------------
// The fold — the turn is the container for the whole story.
// ---------------------------------------------------------------------------

/** Work = the items that make a container a mission story (the continuation-rule predicate). */
function holdsWork(children: FeedItem[]): boolean {
  return children.some((c) => c.kind === 'work' || c.kind === 'outcome');
}

/** The continuation freshness bound: a review wake follows its settle within seconds; a
 * distant turn hours later stays its own container. Ten minutes covers every wake path. */
const CONTINUATION_WINDOW_MS = 10 * 60 * 1000;

export function foldTurns(items: FeedItem[]): FoldedItem[] {
  const out: FoldedItem[] = [];
  let current: Extract<FoldedItem, { kind: 'turn' }> | null = null;

  for (const item of items) {
    if (item.kind === 'narration') {
      if (current !== null && holdsWork(current.children)) {
        const newest = current.children.reduce<string>((acc, c) => (c.at > acc ? c.at : acc), current.at);
        if (new Date(item.at).getTime() - new Date(newest).getTime() <= CONTINUATION_WINDOW_MS) {
          // The same story continuing — the review speaks INSIDE the container.
          current.children.push(item);
          current.live = current.live || item.live;
          continue;
        }
      }
      current = { kind: 'turn', id: item.id, runId: item.runId, text: item.text, at: item.at, live: item.live, failed: item.failed, children: [] };
      out.push(current);
      continue;
    }
    if (item.kind === 'prompt') {
      current = null; // a new ask — whatever follows belongs to the NEXT reply
      out.push(item);
      continue;
    }
    if (item.kind === 'mission') {
      // The settled mission's ticks are part of the story it closes.
      if (current !== null) current.children.push(item);
      else out.push(item);
      continue;
    }
    if (current !== null) current.children.push(item);
    else out.push(item);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Esc targets — what Esc stops in the focused thread.
// ---------------------------------------------------------------------------

export type EscTarget =
  | { kind: 'intent'; intentId: string }
  | { kind: 'run'; runId: string };

/**
 * The LIVE INTENT first (Esc kills the whole loop; cancelIntent itself cancels the
 * thread's active runs and queued wakes), then the running desk turn, then every
 * active work run (double-cancel is harmless). NEVER a consent answer, and an empty
 * result makes Esc a visible no-op.
 */
export function escTargets(view: ConversationView, intent?: ThreadIntent | null): EscTarget[] {
  const out: EscTarget[] = [];
  if (intent && (intent.status === 'open' || intent.status === 'parked')) {
    out.push({ kind: 'intent', intentId: intent.id });
  }
  for (const t of view.turns) {
    if (t.role === 'desk' && t.status === 'running' && t.runId !== null) out.push({ kind: 'run', runId: t.runId });
  }
  for (const r of view.work) {
    if (runActive(r.status)) out.push({ kind: 'run', runId: r.id });
  }
  return out;
}
