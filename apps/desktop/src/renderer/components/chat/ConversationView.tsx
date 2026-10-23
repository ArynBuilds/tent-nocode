import { useEffect, useMemo, useRef, useState } from 'react';
import type { OrgRole, ThreadMode } from '@tent-nocode/core';
import type { MessageRow, WorkRunView } from '../../../shared/ipc.js';
import { can } from '../../../shared/roles.js';
import { useLive } from '../../lib/data/useLive.js';
import { useQuery } from '../../lib/data/useQuery.js';
import { desk } from '../../lib/desk.js';
import { store } from '../../lib/canvas/store.js';
import type { CodeSelection } from '../../lib/canvas/store.js';
import { ambientScreen, ambientSelection } from '../../lib/ambientSelection.js';
import { getTheme } from '../../lib/theme.js';
import { useFocusedProject } from '../../lib/FocusContext.js';
import { useOrg } from '../../lib/OrgContext.js';
import { navigate } from '../../lib/router.js';
import { buildFeed, composerPlaceholder, deriveStatus, escTargets, foldTurns, hasActiveWork } from '../../lib/feed/feed.js';
import { overlayDeltas } from '../../lib/feed/delta.js';
import { isOverlayOpen } from '../../lib/overlay.js';
import { useDeltas } from '../../lib/data/useDeltas.js';
import { Feed } from '../feed/Feed.js';
import { ComposerMeta, ModeControl } from './ComposerMeta.js';
import { IntentChecklist } from './IntentChecklist.js';
import styles from './chat.module.css';
import { ConsentBlock } from './ConsentBlock.js';

function payloadStr(payload: Record<string, unknown>, key: string): string {
  const v = payload[key];
  return typeof v === 'string' ? v : '';
}

interface ConversationViewProps {
  threadId: string;
  jobParam: string | undefined;
  /** False for side-panel instances: only the primary route view owns window-level hotkeys. */
  hotkeys?: boolean;
  /** False for side-panel instances: the panel tab already carries the thread title. */
  showHeader?: boolean;
  /** True hides the ComposerMeta row (console pill/panel states). */
  slimMeta?: boolean;
  /** False when the composer lives outside this view (console floating panel). */
  showComposer?: boolean;
}

/** The conversation route's body: one narrated document built by buildFeed and rendered by Feed. */
const codeSelectionBlock = (sel: CodeSelection): string =>
  '\n\n[about ' + sel.subject + ', lines ' + sel.fromLine + '-' + sel.toLine + ']\n```\n' + sel.text + '\n```';

export function ConversationView({ threadId, jobParam, hotkeys = true, showHeader = true, slimMeta = false, showComposer = true }: ConversationViewProps) {
  const { orgId, role } = useOrg();
  void jobParam; // every job renders inline; the param survives only as an anchor

  const convQuery = useQuery(`conversation:${threadId}`, () => desk.getConversation(orgId, threadId), [orgId, threadId]);
  const activityQuery = useQuery(`activity:${threadId}`, () => desk.listActivity(orgId, threadId), [orgId, threadId]);
  useLive(['threads', 'messages', 'runs'], () => convQuery.refetch());
  useLive(['events'], () => activityQuery.refetch());
  const configQuery = useQuery(`org-config:${orgId}`, () => desk.getOrgConfig(orgId), [orgId]);
  // Token spend refreshes as runs settle.
  const usageQuery = useQuery(`usage:${threadId}`, () => desk.threadUsage(orgId, threadId), [orgId, threadId]);
  useLive(['runs', 'events'], () => usageQuery.refetch());
  // The mission checklist read.
  const intentQuery = useQuery(`intent:${threadId}`, () => desk.threadIntent(orgId, threadId), [orgId, threadId]);
  useLive(['thread_intents', 'runs'], () => intentQuery.refetch());

  // Per-work-run detail; keyed by run ids+statuses so a settle refetches exactly once.
  const workKey = (convQuery.data?.work ?? []).map((r) => `${r.id}:${r.status}`).join(',');
  const detailsQuery = useQuery(
    `conv-details:${threadId}:${workKey}`,
    async () => {
      const work = convQuery.data?.work ?? [];
      const fetched = await Promise.all(work.map(async (r) => [r.id, await desk.getThread(orgId, r.id)] as const));
      return new Map<string, WorkRunView>(fetched);
    },
    [orgId, workKey],
  );
  useLive(['runs', 'events'], () => detailsQuery.refetch());

  // Esc interrupts this thread's execution, never answers a consent question; focus lands in the composer.
  const composerInputRef = useRef<HTMLInputElement | null>(null);
  const escState = useRef({ data: convQuery.data, role, intent: intentQuery.data?.intent ?? null });
  escState.current = { data: convQuery.data, role, intent: intentQuery.data?.intent ?? null };
  useEffect(() => {
    if (!hotkeys) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key !== 'Escape') return;
      if (isOverlayOpen()) return; // an open overlay owns Esc
      const { data, role: liveRole, intent } = escState.current;
      if (data === undefined || !can(liveRole, 'cancel')) return;
      const targets = escTargets(data, intent);
      if (targets.length === 0) return;
      e.preventDefault();
      for (const t of targets) {
        // Intent first: cancelIntent kills the whole mission; run targets cover missionless work.
        if (t.kind === 'intent') void desk.cancelIntent(orgId, t.intentId);
        else void desk.cancelRun(orgId, t.runId);
      }
      composerInputRef.current?.focus();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [orgId, hotkeys]);

  // Keyboard answers for the newest pending question: 1/Enter = primary, 2 = ghost; never while typing.
  useEffect(() => {
    if (!hotkeys) return;
    function onGateKey(e: KeyboardEvent): void {
      if (e.key !== 'Enter' && e.key !== '1' && e.key !== '2') return;
      if (isOverlayOpen()) return; // never answer a background consent from inside an overlay
      const tag = (document.activeElement?.tagName ?? '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      const cls = e.key === '2' ? styles.pBtnGhost : styles.pBtnPrimary;
      const buttons = document.querySelectorAll<HTMLButtonElement>(`.${cls}`);
      const newest = buttons[buttons.length - 1];
      if (!newest || newest.disabled) return;
      e.preventDefault();
      newest.click();
    }
    window.addEventListener('keydown', onGateKey);
    return () => window.removeEventListener('keydown', onGateKey);
  }, [hotkeys]);

  // Token deltas overlay live narration, fresher than the heartbeat tail.
  const deltas = useDeltas();
  const feedItems = useMemo(() => {
    if (convQuery.data === undefined) return [];
    const items = buildFeed({
      view: convQuery.data,
      activity: activityQuery.data ?? [],
      details: detailsQuery.data ?? new Map(),
      intent: intentQuery.data?.intent ?? null,
    });
    return overlayDeltas(items, deltas);
  }, [convQuery.data, activityQuery.data, detailsQuery.data, intentQuery.data, deltas]);

  if (convQuery.error) {
    return <div className={styles.placeholder}>failed to load conversation: {convQuery.error}</div>;
  }
  if (!convQuery.data) {
    return <div className={styles.placeholder}>loading conversation…</div>;
  }

  const view = convQuery.data;
  const { thread, turns } = view;
  const orgDefault: ThreadMode = configQuery.data?.chat.defaultMode ?? 'ask';
  const activeRunIds = view.work
    .filter((r) => r.status === 'running' || r.status === 'queued')
    .map((r) => r.id);

  /** The producing desk turn's text, the ConsentBlock's "show raw" source. */
  function runRawText(runId: string): string {
    if (runId === '') return '';
    return turns.find((t) => t.runId === runId)?.text ?? '';
  }

  /** Every escalation kind renders through ConsentBlock; no kind switch, no null path. */
  function renderGate(gate: MessageRow) {
    const kind = payloadStr(gate.payload, 'kind');
    const rawText = kind === 'work_proposal' ? runRawText(payloadStr(gate.payload, 'runId')) : undefined;
    return <ConsentBlock orgId={orgId} role={role} gate={gate} rawText={rawText} />;
  }

  return (
    <div className={styles.conv}>
      {/* Header keeps the title only; other chrome lives in the composer meta row. */}
      {showHeader ? (
        <div className={styles.head}>
          <h2>{thread.title.trim() || 'untitled thread'}</h2>
        </div>
      ) : null}
      <div className={showComposer ? styles.scroll : `${styles.scroll} ${styles.scrollNoComposer}`}>
        <Feed
          items={foldTurns(feedItems)}
          renderGate={renderGate}
          onOpenPath={(absolute) => {
            // A delivered file opens in the glass pane; no pane registered falls back to the OS reveal.
            if (!store.openFile(absolute)) void desk.openPath(orgId, absolute);
          }}
          statusWord={deriveStatus(feedItems, activeRunIds.length)}
        />
      </div>
      {/* The float wrapper lets the feed scroll beneath the capsule; the scroll pads its bottom. */}
      {showComposer ? (
      <div className={styles.composerFloat}>
      <IntentChecklist intent={intentQuery.data?.intent ?? null} />
      <ChatComposer
        orgId={orgId}
        threadId={threadId}
        role={role}
        inputRef={composerInputRef}
        placeholder={composerPlaceholder(hasActiveWork(view))}
        trailing={
          <ModeControl
            orgId={orgId}
            threadId={threadId}
            role={role}
            mode={thread.mode}
            orgDefault={orgDefault}
            configLoaded={configQuery.data !== undefined}
          />
        }
      />
      {slimMeta ? null : (
        <ComposerMeta
          orgId={orgId}
          threadId={threadId}
          role={role}
          usage={usageQuery.data ?? null}
          activeRunIds={activeRunIds}
        />
      )}
      </div>
      ) : null}
    </div>
  );
}

interface ChatComposerProps {
  orgId: string;
  /** null = no thread yet: submitting creates one, then navigates into it. */
  threadId: string | null;
  role: OrgRole;
  /** Seeds the input's initial text; read only on first render, never auto-sends. */
  initialText?: string;
  /** Lets the thread's Esc handler land focus here after an interrupt. */
  inputRef?: React.RefObject<HTMLInputElement | null>;
  placeholder?: string;
  /** Composer-owned chrome rendered inside the pill's right edge. */
  trailing?: React.ReactNode;
  /** When a threadless composer creates its thread, call this instead of navigating. */
  onCreated?: (threadId: string) => void;
  /** Fires after any successful send. */
  onSent?: () => void;
  /** True while no AI is connected: the input disables. */
  disabled?: boolean;
}

/** Pinned composer: sends into the open thread, or creates one on the fly when threadId is null. */
export function ChatComposer({ orgId, threadId, role, initialText, inputRef, placeholder, trailing, onCreated, onSent, disabled = false }: ChatComposerProps) {
  const [text, setText] = useState(initialText ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  // A threadless send births its thread in the focused project.
  const { focusedProjectId } = useFocusedProject();

  if (!can(role, 'submit')) {
    return <div className={styles.composerNote}>you have read-only access to this thread</div>;
  }

  async function send(): Promise<void> {
    const value = text.trim();
    if (!value) return;
    setSubmitting(true);
    setError(undefined);
    // An armed inspector selection rides this ask; consumed only when a real desk turn took it.
    const armed = store.panel.armed;
    // An armed code selection rides the ask as text appended to the message.
    const armedCode = store.panel.armedCode;
    const outgoing = armedCode !== null ? value + codeSelectionBlock(armedCode) : value;
    // The ambient envelope rides every ask: theme, open screen, and current selection.
    const screen = ambientScreen();
    const result = await desk.sendChat(
      orgId, threadId, outgoing,
      armed ? { sceneSlug: armed.sceneSlug, nodeId: armed.nodeId } : undefined,
      threadId === null ? focusedProjectId ?? undefined : undefined,
      { theme: getTheme(), ...(screen !== null ? { screen } : {}), selection: ambientSelection() },
    );
    setSubmitting(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    if (armed && result.data?.runId !== null) store.armSelection(null);
    if (armedCode !== null && result.data?.runId !== null) store.armCodeSelection(null);
    if (threadId === null) {
      if (!result.data) {
        setError('thread created but no thread id was returned');
        return;
      }
      if (onCreated) onCreated(result.data.threadId);
      else navigate(`/thread/${result.data.threadId}`);
      onSent?.();
      return;
    }
    setText('');
    onSent?.();
  }

  return (
    <div className={styles.composerDock}>
      <div className={styles.composer}>
        <input
          ref={inputRef}
          className={styles.cbox}
          placeholder={placeholder ?? 'Ask anything…'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={submitting || disabled}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void send();
          }}
        />
        {trailing}
        <button
          type="button"
          className={styles.send}
          aria-label="Send"
          disabled={submitting || disabled || text.trim() === ''}
          onClick={() => void send()}
        >
          ↑
        </button>
      </div>
      {error ? <div className={styles.errorText}>{error}</div> : null}
    </div>
  );
}
