import { useEffect, useRef, useState } from 'react';
import { Maximize2, Minimize2, Pin, Plus, Trash2, X } from 'lucide-react';
import { ChatComposer, ConversationView } from '../chat/ConversationView.js';
import { ModeControl } from '../chat/ComposerMeta.js';
import { ContextMenu } from '../canvas/ContextMenu.js';
import { useLive } from '../../lib/data/useLive.js';
import { useQuery } from '../../lib/data/useQuery.js';
import { desk } from '../../lib/desk.js';
import { useFocusedProject } from '../../lib/FocusContext.js';
import { useOrg } from '../../lib/OrgContext.js';
import {
  OPEN_HOVER_MS, addDraftTab, adoptThread, closeTab, modeOnPendingGate, openThreadTab, shrinkAllowed,
} from '../../lib/consoleState.js';
import type { ConsoleMode, ConsoleTab } from '../../lib/consoleState.js';
import { CONNECT_SENTENCE, ConnectCard, useEngineConnected } from './ConnectCard.js';
import styles from './console.module.css';

// The console: capsule composer (closed) or chat region above it (open); full-screen fills the grid cell only.

// Hover-out grace before chat region collapses back to capsule.
export const SHRINK_MS = 500;

interface ConsoleProps {
  tabs?: ConsoleTab[];
  activeId?: string;
  mode: ConsoleMode;
  sticky: boolean;
  onTabs?: (tabs: ConsoleTab[], activeId: string) => void;
  onMode: (mode: ConsoleMode) => void;
  onSticky: (sticky: boolean) => void;
  // The room variant: one fixed tab; no + button or tab-close; connect card renders above.
  room?: { threadId: string; title: string };
}

export function Console({ tabs: propTabs, activeId: propActiveId, mode, sticky, onTabs: propOnTabs, onMode, onSticky, room }: ConsoleProps) {
  const { orgId, role } = useOrg();
  const tabs = room !== undefined ? [{ id: 'room', threadId: room.threadId }] : propTabs ?? [];
  const activeId = room !== undefined ? 'room' : propActiveId ?? '';
  const onTabs = propOnTabs ?? (() => undefined);
  // The + button opens a popover listing past threads and the new-thread option; right-click deletes silently.
  const { focusedProjectId } = useFocusedProject();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [threadMenu, setThreadMenu] = useState<{ x: number; y: number; threadId: string } | null>(null);
  const shrinkTimer = useRef<number | null>(null);
  // Exit animation plays before folding; region stays mounted during the transition.
  const closeTimer = useRef<number | null>(null);
  const [closing, setClosing] = useState(false);

  const threadsQuery = useQuery(`console-threads:${orgId}`, () => desk.listThreads(orgId), [orgId]);
  useLive(['threads', 'runs', 'messages'], () => threadsQuery.refetch());
  const overviews = threadsQuery.data ?? [];
  const configQuery = useQuery(`org-config:${orgId}`, () => desk.getOrgConfig(orgId), [orgId]);
  const { connected, engines, refresh } = useEngineConnected(orgId);

  function title(t: ConsoleTab): string {
    if (room !== undefined) return room.title; // the app's own name — the one room tab
    if (t.threadId === null) return 'New thread';
    const raw = overviews.find((o) => o.thread.id === t.threadId)?.thread.title.trim();
    return raw !== undefined && raw !== '' ? raw : 'untitled thread';
  }

  function pending(t: ConsoleTab): boolean {
    if (t.threadId === null) return false;
    return (overviews.find((o) => o.thread.id === t.threadId)?.openGates ?? 0) > 0;
  }

  const hasPending = tabs.some(pending);
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];

  const liveRef = useRef({ mode, sticky, hasPending, tabs, activeId });
  liveRef.current = { mode, sticky, hasPending, tabs, activeId };

  function clearShrink(): void {
    if (shrinkTimer.current !== null) {
      window.clearTimeout(shrinkTimer.current);
      shrinkTimer.current = null;
    }
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setClosing(false);
  }

  function armShrink(): void {
    clearShrink();
    if (!shrinkAllowed(mode, sticky, hasPending)) return;
    shrinkTimer.current = window.setTimeout(() => {
      const s = liveRef.current;
      if (!shrinkAllowed(s.mode, s.sticky, s.hasPending)) return;
      // Play the exit animation, THEN fold (the region unmounts only after the beat).
      setClosing(true);
      closeTimer.current = window.setTimeout(() => {
        setClosing(false);
        onMode('pill');
      }, 170);
    }, SHRINK_MS);
  }

  // Hovering the capsule opens the region even with no chats; a draft tab appears if none exist.
  const openTimer = useRef<number | null>(null);
  function cancelHoverOpen(): void {
    if (openTimer.current !== null) {
      window.clearTimeout(openTimer.current);
      openTimer.current = null;
    }
  }
  function armHoverOpen(): void {
    clearShrink();
    if (openTimer.current !== null) return;
    openTimer.current = window.setTimeout(() => {
      openTimer.current = null;
      const s = liveRef.current;
      // No AI connected: the region carries the connect card — never mint a draft.
      if (s.tabs.length === 0 && connected !== false) {
        const next = addDraftTab({ tabs: s.tabs, activeId: s.activeId });
        onTabs(next.tabs, next.activeId);
      }
      if (s.mode === 'pill') onMode('panel');
    }, OPEN_HOVER_MS);
  }

  // A pending gate cancels shrink and expands to panel to keep consent reachable.
  useEffect(() => {
    if (!hasPending) return;
    clearShrink();
    if (mode === 'pill') onMode(modeOnPendingGate(mode));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasPending, mode]);

  useEffect(() => () => { clearShrink(); cancelHoverOpen(); }, []);

  // Connect-card region owns no hotkeys; Esc folds it.
  useEffect(() => {
    if (mode !== 'panel' || connected !== false || tabs.length > 0) return;
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onMode('pill'); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, connected, tabs.length]);

  // The capsule is shared by both closed and open states.
  function capsule() {
    const activeThread = active?.threadId !== null && active !== undefined
      ? overviews.find((o) => o.thread.id === active.threadId)?.thread
      : undefined;
    return (
      <div className={styles.capsule}>
        <ChatComposer
          orgId={orgId}
          threadId={active?.threadId ?? null}
          role={role}
          disabled={connected === false}
          placeholder={connected === false ? CONNECT_SENTENCE : undefined}
          trailing={room === undefined && activeThread !== undefined ? (
            <ModeControl
              orgId={orgId}
              threadId={activeThread.id}
              role={role}
              mode={activeThread.mode}
              orgDefault={configQuery.data?.chat.defaultMode ?? 'ask'}
              configLoaded={configQuery.data !== undefined}
            />
          ) : undefined}
          onCreated={(threadId) => {
            if (active) {
              const next = adoptThread({ tabs, activeId }, active.id, threadId);
              onTabs(next.tabs, next.activeId);
            } else {
              const draft = addDraftTab({ tabs, activeId });
              const next = adoptThread(draft, draft.activeId, threadId);
              onTabs(next.tabs, next.activeId);
            }
          }}
          onSent={() => { if (mode === 'pill') onMode('panel'); }}
        />
      </div>
    );
  }

  // The conversation panes with connect card in place (authoring) or above (room variant).
  function body(external: boolean) {
    if (connected !== false) return panes(external);
    const card = <ConnectCard orgId={orgId} engines={engines} onSaved={refresh} />;
    return room !== undefined ? <>{card}{panes(external)}</> : card;
  }

  // Full mode keeps the original grid-cell geometry; never overlaps rails/panels.
  if (mode === 'full') {
    return (
      <div className={styles.wrap}>
        <div className={styles.consoleFull} onMouseEnter={clearShrink}>
          {header()}
          {body(false)}
        </div>
      </div>
    );
  }

  function header() {
    return (
      <div className={styles.header}>
        <div className={styles.tabsScroll} onWheel={(e) => { e.currentTarget.scrollLeft += e.deltaY; }}>
          {tabs.map((t) => (
            <div
              key={t.id}
              data-tabid={t.id}
              className={t.id === active?.id ? `${styles.tab} ${styles.tabActive}` : styles.tab}
              onClick={() => onTabs(tabs, t.id)}
            >
              {pending(t) ? <span className={styles.tabDot} /> : null}
              <span className={styles.tabTitle}>{title(t)}</span>
              {room === undefined ? (
                <button
                  type="button"
                  className={styles.tabClose}
                  aria-label="Close tab"
                  onClick={(e) => {
                    e.stopPropagation();
                    const next = closeTab({ tabs, activeId }, t.id);
                    onTabs(next.tabs, next.activeId);
                  }}
                >
                  <X size={12} />
                </button>
              ) : null}
            </div>
          ))}
        </div>
        {room === undefined ? (
          <div className={styles.threadPickWrap}>
            <button
              type="button"
              className={styles.headerBtn}
              aria-label="New thread"
              onClick={() => setPickerOpen((v) => !v)}
            >
              <Plus size={14} />
            </button>
            {pickerOpen ? (
              <>
                <div className={styles.threadPickScrim} onClick={() => setPickerOpen(false)} />
                <div className={styles.threadPick}>
                  <button
                    type="button"
                    className={styles.threadPickNew}
                    onClick={() => {
                      setPickerOpen(false);
                      const next = addDraftTab({ tabs, activeId });
                      onTabs(next.tabs, next.activeId);
                    }}
                  >
                    <Plus size={13} />
                    New thread
                  </button>
                  {overviews
                    .filter((o) => o.thread.projectId === focusedProjectId)
                    .map((o) => (
                      <button
                        key={o.thread.id}
                        type="button"
                        className={styles.threadPickRow}
                        onClick={() => {
                          setPickerOpen(false);
                          const next = openThreadTab({ tabs, activeId }, o.thread.id);
                          onTabs(next.tabs, next.activeId);
                        }}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          setThreadMenu({ x: e.clientX, y: e.clientY, threadId: o.thread.id });
                        }}
                      >
                        {(o.openGates ?? 0) > 0 ? <span className={styles.tabDot} /> : null}
                        <span className={styles.threadPickTitle}>
                          {o.thread.title.trim() !== '' ? o.thread.title.trim() : 'untitled thread'}
                        </span>
                      </button>
                    ))}
                </div>
              </>
            ) : null}
            {threadMenu !== null ? (
              <ContextMenu
                at={threadMenu}
                groups={[[{
                  key: 'delete',
                  label: 'Delete',
                  icon: Trash2,
                  onAct: () => {
                    // Silent by ruling (the deletion doors): tombstone + refetch;
                    // an open tab for the dead thread closes with it.
                    void desk.humanDeleteThread(orgId, threadMenu.threadId).then(() => threadsQuery.refetch());
                    const open = tabs.find((t) => t.threadId === threadMenu.threadId);
                    if (open !== undefined) {
                      const next = closeTab({ tabs, activeId }, open.id);
                      onTabs(next.tabs, next.activeId);
                    }
                  },
                }]]}
                onClose={() => setThreadMenu(null)}
              />
            ) : null}
          </div>
        ) : null}
        <button
          type="button"
          className={sticky ? `${styles.headerBtn} ${styles.headerBtnActive}` : styles.headerBtn}
          aria-label={sticky ? 'Unpin console' : 'Pin console'}
          title={sticky ? 'Unpin console' : 'Pin console'}
          onClick={() => onSticky(!sticky)}
        >
          <Pin size={13} />
        </button>
        <button
          type="button"
          className={styles.headerBtn}
          aria-label={mode === 'full' ? 'Restore console' : 'Fill the stage'}
          title={mode === 'full' ? 'Restore console' : 'Fill the stage'}
          onClick={() => onMode(mode === 'full' ? 'panel' : 'full')}
        >
          {mode === 'full' ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </button>
      </div>
    );
  }

  // Tabs stay mounted but hidden; active tab owns hotkeys when region is visible.
  function panes(external: boolean) {
    return tabs.map((t) => (
      <div key={t.id} className={t.id === active?.id ? styles.pane : styles.paneHidden}>
        {t.threadId === null ? (
          <div className={styles.freshHint}>a new thread — say the word below</div>
        ) : (
          <ConversationView
            threadId={t.threadId}
            jobParam={undefined}
            hotkeys={t.id === active?.id && mode !== 'pill'}
            showHeader={false}
            slimMeta={external}
            showComposer={!external}
          />
        )}
      </div>
    ));
  }

  // Floating mode: capsule centered on viewport; region stays mounted while folded.
  return (
    <div className={styles.floatLayer}>
      {tabs.length > 0 || connected === false ? (
        <div
          className={
            mode !== 'panel' ? `${styles.region} ${styles.regionFolded}`
              : closing ? `${styles.region} ${styles.regionOut}` : styles.region
          }
          onMouseEnter={clearShrink}
          onMouseLeave={armShrink}
        >
          {tabs.length > 0 ? header() : null}
          {body(true)}
        </div>
      ) : null}
      {/* Hovering the capsule opens the chat; keeping the mouse open suppresses shrink. */}
      <div
        onMouseEnter={armHoverOpen}
        onMouseLeave={() => {
          cancelHoverOpen();
          armShrink();
        }}
      >
        {capsule()}
      </div>
    </div>
  );
}
