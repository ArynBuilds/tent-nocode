import { useEffect, useRef } from 'react';
import type { ThreadOverview } from '../../shared/ipc.js';
import { newConsoleTab } from './consoleState.js';
import type { ConsoleTab } from './consoleState.js';
import { useLive } from './data/useLive.js';
import { useQuery } from './data/useQuery.js';
import { desk } from './desk.js';
import { useFocusedProject } from './FocusContext.js';
import { useOrg } from './OrgContext.js';

/**
 * PROJECT FOCUS follow-up (user, 2026-08-01): CHAT TABS LIVE IN THE PROJECT WORKSPACE.
 * Each project remembers ITS OWN open-chat set (the console tabs);
 * a focus switch SWAPS the whole set — the outgoing project's set is saved exactly as
 * left (never closed-closed), the incoming project's set is restored (none remembered →
 * none loaded). Persistence rides localStorage per project (the `nodeloom-last-view`
 * idiom). A thread's project comes from its ROW: restore drops threads that no longer
 * exist or were moved to another project. Drafts (threadId null) carry no thread and
 * don't persist; panel tabs (map/code/file/inspector/browser) never swap.
 */

const key = (projectId: string) => `nodeloom-chat-tabs:${projectId}`;

/** One project's remembered open-chat set — thread ids only (tab ids are session-local). */
export interface ChatTabSet {
  console: string[];
  /** The console's active thread, restored as the active tab. */
  consoleActive: string | null;
}

export const EMPTY_CHAT_SET: ChatTabSet = { console: [], consoleActive: null };

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
    };
  } catch {
    return EMPTY_CHAT_SET;
  }
}

export function saveChatSet(projectId: string, set: ChatTabSet): void {
  try { localStorage.setItem(key(projectId), JSON.stringify(set)); } catch { /* view-state only */ }
}

/** The snapshot of what is open RIGHT NOW (drafts drop — no thread, nothing to remember). */
export function snapshotChatSet(consoleTabs: ConsoleTab[], consoleActiveId: string): ChatTabSet {
  return {
    console: consoleTabs.filter((t) => t.threadId !== null).map((t) => t.threadId!),
    consoleActive: consoleTabs.find((t) => t.id === consoleActiveId)?.threadId ?? null,
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
    if (prev !== null) saveChatSet(prev, snapshotChatSet(d.consoleTabs, d.consoleActive));
    if (focusedProjectId === null) return;
    // RESTORE the incoming project's set (row-filtered; none remembered → none loaded).
    const stored = loadChatSet(focusedProjectId);
    const consoleTabs = restoreThreadIds(stored.console, focusedProjectId, threads).map((id) => newConsoleTab(id));
    const active = consoleTabs.find((t) => t.threadId === stored.consoleActive) ?? consoleTabs[consoleTabs.length - 1];
    d.onConsole(consoleTabs, active?.id ?? '');
  }, [focusedProjectId]);
}
