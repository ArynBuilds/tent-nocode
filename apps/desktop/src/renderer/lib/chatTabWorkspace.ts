import { useEffect, useRef } from 'react';
import type { ThreadOverview } from '../../shared/ipc.js';
import type { PanelTab } from '../components/shell/panelPanes.js';
import { newConsoleTab } from './consoleState.js';
import type { ConsoleTab } from './consoleState.js';
import { useLive } from './data/useLive.js';
import { useQuery } from './data/useQuery.js';
import { desk } from './desk.js';
import { useFocusedProject } from './FocusContext.js';
import { useOrg } from './OrgContext.js';

/**
 * PROJECT FOCUS follow-up (user, 2026-08-01): CHAT TABS LIVE IN THE PROJECT WORKSPACE.
 * Each project remembers ITS OWN open-chat set (console tabs + side/bottom chat tabs);
 * a focus switch SWAPS the whole set — the outgoing project's set is saved exactly as
 * left (never closed-closed), the incoming project's set is restored (none remembered →
 * none loaded). Persistence rides localStorage per project (the `tent-nocode-last-view`
 * idiom). A thread's project comes from its ROW: restore drops threads that no longer
 * exist or were moved to another project. Drafts (threadId null) carry no thread and
 * don't persist; non-chat panel tabs (map/code/file/inspector/browser) never swap.
 */

const key = (projectId: string) => `tent-nocode-chat-tabs:${projectId}`;

/** Restored panel chat tabs mint ids in their own namespace (`wt`) — never colliding
 * with panelPanes' session `pt` counter (type-only import keeps this module pure). */
let nextRestoredId = 1;
const restoredChatTab = (threadId: string): PanelTab => ({ id: `wt${nextRestoredId++}`, kind: 'chat', threadId });

/** One project's remembered open-chat set — thread ids only (tab ids are session-local).
 * D11 (2026-08-14): the LEFT slot joins the family — same grammar, third member. */
export interface ChatTabSet {
  console: string[];
  /** The console's active thread, restored as the active tab. */
  consoleActive: string | null;
  side: string[];
  bottom: string[];
  left: string[];
}

export const EMPTY_CHAT_SET: ChatTabSet = { console: [], consoleActive: null, side: [], bottom: [], left: [] };

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

export function loadChatSet(projectId: string): ChatTabSet {
  try {
    const raw = localStorage.getItem(key(projectId));
    if (raw === null) return EMPTY_CHAT_SET;
    const p = JSON.parse(raw) as Partial<ChatTabSet>;
    return {
      console: strings(p.console),
      consoleActive: typeof p.consoleActive === 'string' ? p.consoleActive : null,
      side: strings(p.side),
      bottom: strings(p.bottom),
      left: strings(p.left),
    };
  } catch {
    return EMPTY_CHAT_SET;
  }
}

export function saveChatSet(projectId: string, set: ChatTabSet): void {
  try { localStorage.setItem(key(projectId), JSON.stringify(set)); } catch { /* view-state only */ }
}

/** The snapshot of what is open RIGHT NOW (drafts drop — no thread, nothing to remember). */
export function snapshotChatSet(
  consoleTabs: ConsoleTab[], consoleActiveId: string,
  panelTabs: Pick<PanelTab, 'kind' | 'threadId'>[], bottomTabs: Pick<PanelTab, 'kind' | 'threadId'>[],
  leftTabs: Pick<PanelTab, 'kind' | 'threadId'>[] = [],
): ChatTabSet {
  const chats = (tabs: Pick<PanelTab, 'kind' | 'threadId'>[]): string[] =>
    tabs.filter((t) => t.kind === 'chat' && t.threadId !== null).map((t) => t.threadId!);
  return {
    console: consoleTabs.filter((t) => t.threadId !== null).map((t) => t.threadId!),
    consoleActive: consoleTabs.find((t) => t.id === consoleActiveId)?.threadId ?? null,
    side: chats(panelTabs),
    bottom: chats(bottomTabs),
    left: chats(leftTabs),
  };
}

/** The row is the project truth: restore keeps only threads that still exist AND still
 * belong to the project (moved/deleted threads leave the set). An unloaded thread list
 * skips the filter — a cold read never wipes a remembered set. */
export function restoreThreadIds(ids: string[], projectId: string, overviews: ThreadOverview[] | undefined): string[] {
  if (overviews === undefined || overviews.length === 0) return ids;
  return ids.filter((id) => overviews.some((o) => o.thread.id === id && o.thread.projectId === projectId));
}

/** The one swap effect — App mounts this beside its tab state; everything else is pure. */
export function useProjectChatTabs(deps: {
  consoleTabs: ConsoleTab[]; consoleActive: string;
  onConsole: (tabs: ConsoleTab[], activeId: string) => void;
  panelTabs: PanelTab[]; panelActive: string;
  onPanel: (tabs: PanelTab[], activeId: string) => void;
  bottomTabs: PanelTab[]; bottomActive: string;
  onBottom: (tabs: PanelTab[], activeId: string) => void;
  leftTabs: PanelTab[]; leftActive: string;
  onLeft: (tabs: PanelTab[], activeId: string) => void;
}): void {
  const { orgId } = useOrg();
  const { focusedProjectId } = useFocusedProject();
  const threadsQuery = useQuery(`chat-workspace:${orgId}`, () => desk.listThreads(orgId), [orgId]);
  useLive(['threads'], () => threadsQuery.refetch());
  const live = useRef({ deps, threads: threadsQuery.data });
  live.current = { deps, threads: threadsQuery.data };
  // Starts null so the FIRST resolved focus restores its remembered set (boot restore).
  const prevRef = useRef<string | null>(null);

  useEffect(() => {
    const prev = prevRef.current;
    if (prev === focusedProjectId) return;
    prevRef.current = focusedProjectId;
    const { deps: d, threads } = live.current;
    // SAVE the outgoing project's set exactly as left.
    if (prev !== null) saveChatSet(prev, snapshotChatSet(d.consoleTabs, d.consoleActive, d.panelTabs, d.bottomTabs, d.leftTabs));
    if (focusedProjectId === null) return;
    // RESTORE the incoming project's set (row-filtered; none remembered → none loaded).
    const stored = loadChatSet(focusedProjectId);
    const consoleTabs = restoreThreadIds(stored.console, focusedProjectId, threads).map((id) => newConsoleTab(id));
    const active = consoleTabs.find((t) => t.threadId === stored.consoleActive) ?? consoleTabs[consoleTabs.length - 1];
    d.onConsole(consoleTabs, active?.id ?? '');
    const swapPanel = (
      tabs: PanelTab[], ids: string[], activeId: string,
      on: (tabs: PanelTab[], activeId: string) => void,
    ): void => {
      const kept = tabs.filter((t) => t.kind !== 'chat'); // only the CHAT lane swaps
      const restored = restoreThreadIds(ids, focusedProjectId, threads).map(restoredChatTab);
      const next = [...kept, ...restored];
      const activeStays = next.some((t) => t.id === activeId);
      on(next, activeStays ? activeId : next[next.length - 1]?.id ?? '');
    };
    swapPanel(d.panelTabs, stored.side, d.panelActive, d.onPanel);
    swapPanel(d.bottomTabs, stored.bottom, d.bottomActive, d.onBottom);
    swapPanel(d.leftTabs, stored.left, d.leftActive, d.onLeft);
  }, [focusedProjectId]);
}
