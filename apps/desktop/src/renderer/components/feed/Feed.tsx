import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronRight, FileText, Square, X } from 'lucide-react';
import type { ActivityStep } from '@tent-nocode/core';
import type { MessageRow } from '../../../shared/ipc.js';
import { groupLiveVerb, toolLabel, type FeedChip, type FeedItem, type FoldedItem } from '../../lib/feed/feed.js';
import { advanceReveal } from '../../lib/feed/smooth.js';
import { Markdown } from './Markdown.js';
import styles from './feed.module.css';

/** Reduced-motion users get the truth instantly — pacing is motion. */
const INSTANT = typeof window !== 'undefined'
  && (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);

// Paces text reveals at reading speed when live; shows full text when settled.
function useSmoothText(target: string, live: boolean): string {
  const [shown, setShown] = useState(target);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  useEffect(() => {
    if (!live || INSTANT) {
      if (shownRef.current !== target) setShown(target);
      return;
    }
    let raf = 0;
    let last = performance.now();
    const tick = (now: number): void => {
      const next = advanceReveal(shownRef.current, target, now - last);
      last = now;
      if (next !== shownRef.current) setShown(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, live]);
  return live && !INSTANT ? shown : target;
}

/** One narration bubble — live text rides the pacer, settled text is the record verbatim. */
function LiveNarration({ text, live, failed }: { text: string; live: boolean; failed: boolean }) {
  const shown = useSmoothText(text, live);
  if (failed) return <div className={styles.narrationFailed}>{shown}</div>;
  return (
    <div className={styles.narration}>
      <Markdown text={shown} />
    </div>
  );
}

// Feed that renders turns with nested replies, groups, and gates.

interface FeedProps {
  items: FoldedItem[];
  renderGate: (gate: MessageRow) => ReactNode;
  onOpenPath?: (absolute: string) => void;
  // Status word shimmers at the live edge; null means idle.
  statusWord?: string | null;
}

function ArtifactChips({ files, onOpenPath }: {
  files: { path: string; absolute: string | null }[];
  onOpenPath?: (absolute: string) => void;
}) {
  if (files.length === 0) return null;
  return (
    <div className={styles.chipRow}>
      {files.map((f) => (
        <button
          key={f.path} type="button"
          className={`${styles.chip} ${styles.chipAction}`}
          disabled={f.absolute === null || onOpenPath === undefined}
          title={f.absolute ?? 'workspace-internal file'}
          onClick={() => { if (f.absolute !== null) onOpenPath?.(f.absolute); }}
        >
          <FileText size={12} />
          <span className={styles.chipText}>{f.path}</span>
        </button>
      ))}
    </div>
  );
}

export function Feed({ items, renderGate, onOpenPath, statusWord = null }: FeedProps) {
  /** One leaf item (top-level or nested in a turn) — the shared vocabulary. */
  function renderLeaf(item: FeedItem): ReactNode {
    switch (item.kind) {
      case 'prompt':
        return (
          <div key={item.id} className={styles.prompt}>
            {item.text}
          </div>
        );
      case 'narration':
        return <LiveNarration key={item.id} text={item.text} live={item.live} failed={item.failed} />;
      case 'question':
        return <div key={item.id}>{renderGate(item.gate)}</div>;
      case 'work':
        return (
          <WorkGroup
            key={item.id}
            live={item.live}
            summary={item.summary}
            steps={item.steps}
            chips={item.chips}
            settledOk={item.settledOk}
          />
        );
      case 'outcome':
        return (
          <div key={item.id} className={styles.outcome}>
            <Markdown text={item.text} />
            <ArtifactChips files={item.files} onOpenPath={onOpenPath} />
          </div>
        );
      case 'stopped':
        return (
          <div key={item.id} className={styles.stopped}>
            <Square size={10} fill="currentColor" />
            Stopped by you
          </div>
        );
      case 'mission':
        return (
          <MissionCard
            key={item.id}
            status={item.status}
            parts={item.parts}
            files={item.files}
            onOpenPath={onOpenPath}
          />
        );
      default:
        return null; // forward-compat: an unknown kind never blanks the thread
    }
  }

  return (
    <div className={styles.feed}>
      {items.map((item) => {
        if (item.kind !== 'turn') return renderLeaf(item);
        // D-67 as amended by FR-359 (D-139 THE WINDOW): the turn shell owns the whole story.
        return <TurnBlock key={item.id} turn={item} renderLeaf={renderLeaf} />;
      })}
      {statusWord !== null ? (
        <div className={styles.liveStatus} aria-live="polite">
          <span className={styles.shimmer}>{statusWord}</span>
        </div>
      ) : null}
    </div>
  );
}

type TurnItem = Extract<FoldedItem, { kind: 'turn' }>;
type GroupItem = Extract<FeedItem, { kind: 'work' }>;

// Turn block with activity header, nested replies, and worker pills.
function TurnBlock({ turn, renderLeaf }: { turn: TurnItem; renderLeaf: (item: FeedItem) => ReactNode }) {
  const [openActivity, setOpenActivity] = useState(false);
  const groups = turn.children.filter((c): c is GroupItem => c.kind === 'work');
  const desk = groups.filter((g) => g.desk);
  const deskSteps = desk.flatMap((g) => g.steps);
  // Header voice comes only from live desk group; typing turn with no tools has no header.
  const headerLive = desk.some((g) => g.live);

  // Aggregate edit counts and distinct files across all groups.
  let plus = 0; let minus = 0;
  const fileSet = new Set<string>();
  for (const g of groups) {
    for (const s of g.steps) { plus += s.plus ?? 0; minus += s.minus ?? 0; }
    for (const c of g.chips) fileSet.add(c.path);
  }
  for (const c of turn.children) {
    if (c.kind === 'outcome') for (const f of c.files) fileSet.add(f.path);
  }
  const dur = desk.find((g) => g.dur !== null)?.dur ?? null;
  const rollup = (
    <>
      {dur !== null ? `Worked for ${dur}` : 'Worked'}
      {fileSet.size > 0 ? ` · ${fileSet.size} file${fileSet.size === 1 ? '' : 's'}` : null}
      {plus > 0 ? <span className={styles.statPlus}> +{plus}</span> : null}
      {minus > 0 ? <span className={styles.statMinus}> −{minus}</span> : null}
    </>
  );

  // Work-run groups gather into pill rows; desk groups absorbed by header.
  const flow: ReactNode[] = [];
  let pillRun: GroupItem[] = [];
  const flush = (): void => {
    if (pillRun.length > 0) {
      flow.push(<PillRow key={`pills-${pillRun[0]!.id}`} groups={pillRun} />);
      pillRun = [];
    }
  };
  for (const c of turn.children) {
    if (c.kind === 'work') {
      if (c.desk) continue; // absorbed into the turn header
      pillRun.push(c);
      continue;
    }
    flush();
    flow.push(renderLeaf(c));
  }
  flush();

  const hasActivity = deskSteps.length > 0;
  return (
    <div className={styles.turn}>
      {hasActivity ? (
        <button
          type="button"
          className={styles.turnHeader}
          onClick={() => setOpenActivity((v) => !v)}
        >
          {headerLive
            ? <span className={styles.shimmer}>{groupLiveVerb(deskSteps)}</span>
            : <>{rollup}</>}
          <ChevronRight size={13} className={openActivity ? `${styles.caret} ${styles.caretOpen}` : styles.caret} />
        </button>
      ) : null}
      {openActivity && hasActivity ? (
        <Timeline steps={deskSteps} chips={desk.flatMap((g) => g.chips)} live={headerLive} settledOk={desk.every((g) => g.settledOk !== false) ? (desk.some((g) => g.settledOk === true) ? true : null) : false} />
      ) : null}
      <LiveNarration text={turn.text} live={turn.live} failed={turn.failed} />
      {flow.length > 0 ? <div className={styles.turnChildren}>{flow}</div> : null}
    </div>
  );
}

// Helper pills: the live verb while running, the helper's number once settled; click to open its timeline.
function PillRow({ groups }: { groups: GroupItem[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const allSettled = groups.every((g) => !g.live);
  const open = groups.find((g) => g.id === openId);
  return (
    <div className={styles.pillWrap}>
      <div className={styles.pillRow}>
        {groups.map((g, i) => (
          <button
            key={g.id} type="button"
            className={`${styles.pill}${g.live ? ` ${styles.pillLive}` : ''}`}
            onClick={() => setOpenId((v) => (v === g.id ? null : g.id))}
          >
            {g.live
              ? <span className={`${styles.pillState} ${styles.shimmer}`}>{groupLiveVerb(g.steps)}</span>
              : <><Check size={12} /><span className={styles.pillRole}>Helper {i + 1}</span></>}
          </button>
        ))}
        {allSettled && groups.length > 0 ? <span className={styles.pillWord}>All finished</span> : null}
      </div>
      {open !== undefined ? (
        <Timeline steps={open.steps} chips={open.chips} live={open.live} settledOk={open.settledOk} />
      ) : null}
    </div>
  );
}

// Timeline showing past-tense steps, edit magnitudes, and terminal status.
function Timeline({ steps, chips, live, settledOk }: {
  steps: ActivityStep[]; chips: FeedChip[]; live: boolean; settledOk: boolean | 'stopped' | null;
}) {
  return (
    <div className={styles.timeline}>
      {(live ? steps.slice(-24) : steps).map((s, i, arr) => stepLine(s, i, arr))}
      {chips.length > 0 ? (
        <div className={styles.chipRow}>
          {chips.map((c) => (
            <span key={c.path} className={`${styles.chip}${c.corroborated === false ? ` ${styles.chipWarn}` : ''}`}
              title={c.corroborated === false ? 'The AI said it wrote this file, but no change was found' : undefined}>
              <FileText size={12} />
              <span className={styles.chipText}>{c.path}</span>
            </span>
          ))}
        </div>
      ) : null}
      {!live && settledOk !== null ? (
        // Terminal row: Done / Stopped by you / Failed.
        <div className={`${styles.step} ${styles.timelineEnd}${settledOk === false ? ` ${styles.stepFail}` : ''}`}>
          {settledOk === true ? <><Check size={13} /> Done</> : settledOk === 'stopped' ? <><Square size={10} fill="currentColor" /> Stopped by you</> : <><X size={13} /> Failed</>}
        </div>
      ) : null}
    </div>
  );
}

// Collapsed mission record, expandable to show parts with ticks and notes.
function MissionCard({ status, parts, files, onOpenPath }: {
  status: 'done' | 'cancelled';
  parts: { text: string; acceptance: string; status: string; note?: string }[];
  files: { path: string; absolute: string | null }[];
  onOpenPath?: (absolute: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={styles.missionCard}>
      <button type="button" className={styles.machinery} onClick={() => setOpen((v) => !v)}>
        {status === 'done' ? 'Plan finished' : 'Plan stopped'} · {parts.length} steps
        <ChevronRight size={13} className={open ? `${styles.caret} ${styles.caretOpen}` : styles.caret} />
      </button>
      {open ? (
        <div className={styles.missionParts}>
          {parts.map((p, i) => (
            <div key={i} className={styles.missionPart} data-status={p.status}>
              <span className={styles.missionGlyph} aria-hidden="true" />
              {p.text}
              {p.note ? <span className={styles.missionNote}>{p.note}</span> : null}
            </div>
          ))}
        </div>
      ) : null}
      <ArtifactChips files={files} onOpenPath={onOpenPath} />
    </div>
  );
}

// Display edit magnitude as +N/-N suffix if present.
function StatSuffix({ step }: { step: ActivityStep }) {
  return (
    <>
      {typeof step.plus === 'number' && step.plus > 0
        ? <span className={styles.statPlus}> +{step.plus}</span> : null}
      {typeof step.minus === 'number' && step.minus > 0
        ? <span className={styles.statMinus}> −{step.minus}</span> : null}
    </>
  );
}

function stepLine(step: ActivityStep, i: number, arr?: ActivityStep[]): ReactNode {
  // A wordless thought renders nothing - the shimmer word already says Thinking.
  if (step.kind === 'thinking') {
    if (!step.text) return null;
    return <div key={i} className={`${styles.step} ${styles.stepThought}`}>{step.text}</div>;
  }
  if (step.kind === 'text') return <div key={i} className={styles.step}>{step.text}</div>;
  if (step.kind === 'tool') {
    const label = toolLabel(step.tool ?? '', step.target);
    if (label === null) return null;
    return (
      <div key={i} className={styles.step}>
        <span className={styles.stepTool}>{label}<StatSuffix step={step} /></span>
      </div>
    );
  }
  // Only show failures; success is implied by next step.
  if (step.ok !== false) return null;
  const src = arr === undefined ? undefined : [...arr.slice(0, i)].reverse().find((s) => s.kind === 'tool');
  const srcLabel = src === undefined ? null : toolLabel(src.tool ?? '', src.target);
  return (
    <div key={i} className={`${styles.step} ${styles.stepFail}`}>
      {srcLabel !== null ? `${srcLabel} returned an error` : 'A step returned an error'}
    </div>
  );
}

function WorkGroup({ live, summary, steps, chips, settledOk }: {
  live: boolean; summary: string; steps: ActivityStep[]; chips: FeedChip[]; settledOk: boolean | 'stopped' | null;
}) {
  const [expanded, setExpanded] = useState<boolean | null>(null);
  // Steps show only when user clicks; live group shows rotating verb only.
  const open = expanded ?? false;
  // Live verb rotates in header; settled groups show summary record.
  const liveLabel = groupLiveVerb(steps);
  return (
    <div className={`${styles.group}${live ? ` ${styles.groupLive}` : ''}`}>
      {/* Live header: the shimmering verb; clicking folds the timeline open and closed. */}
      <button type="button" className={styles.groupSummary} onClick={() => setExpanded((v) => (v === null ? true : !v))}>
        {live
          ? <span className={styles.shimmer}>{liveLabel}</span>
          : summary}
        <ChevronRight size={13} className={open ? `${styles.caret} ${styles.caretOpen}` : styles.caret} />
      </button>
      {open ? (
        <Timeline steps={live && !expanded ? steps.slice(-6) : steps} chips={chips} live={live} settledOk={settledOk} />
      ) : null}
    </div>
  );
}
