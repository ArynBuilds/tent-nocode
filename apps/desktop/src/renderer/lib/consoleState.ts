/**
 * Tier 52 Phase 1 (D-200, FR-462/463): the console's PURE state grammar. Every decision
 * the floating console makes — tab lifecycle, the shrink ladder, THE GATE-OVERRIDES-SHRINK
 * law — lives here as plain functions so the laws are testable without a DOM (the house
 * no-jsdom ruling). Console.tsx only renders these answers.
 */

/** pill = title-only capsule · panel = the floating conversation · full = fills the MAIN
 * grid cell ONLY (never the rails/panels/title bar — the T30 never-overlap law). */
export type ConsoleMode = 'pill' | 'panel' | 'full';

/** DRAFT FIRST (user, 2026-08-01): hover-INTENT delay before the capsule opens the chat —
 * a drive-by pointer never flickers the region open; a settled hover does. */
export const OPEN_HOVER_MS = 180;

export interface ConsoleTab {
  id: string;
  /** null = a DRAFT tab: the thread is created by the first message (the SidePanel
   * side-chat idiom — the same `sendChat(orgId, null, …)` call Home uses). */
  threadId: string | null;
}

export interface ConsoleTabsState {
  tabs: ConsoleTab[];
  activeId: string;
}

let nextId = 1;
export function newConsoleTab(threadId: string | null = null): ConsoleTab {
  return { id: `ct${nextId++}`, threadId };
}

/** Open a thread as a console tab — focuses the existing tab when the thread is already open. */
export function openThreadTab(state: ConsoleTabsState, threadId: string): ConsoleTabsState {
  const existing = state.tabs.find((t) => t.threadId === threadId);
  if (existing) return { tabs: state.tabs, activeId: existing.id };
  const t = newConsoleTab(threadId);
  return { tabs: [...state.tabs, t], activeId: t.id };
}

/** The "+" button: a fresh DRAFT tab, active immediately. */
export function addDraftTab(state: ConsoleTabsState): ConsoleTabsState {
  const t = newConsoleTab(null);
  return { tabs: [...state.tabs, t], activeId: t.id };
}

/** A draft tab's first message created its thread — adopt the id in place. */
export function adoptThread(state: ConsoleTabsState, id: string, threadId: string): ConsoleTabsState {
  return { tabs: state.tabs.map((t) => (t.id === id ? { ...t, threadId } : t)), activeId: state.activeId };
}

/** Close a tab; the neighbor (last tab) becomes active. Empty tabs = no console renders. */
export function closeTab(state: ConsoleTabsState, id: string): ConsoleTabsState {
  const left = state.tabs.filter((t) => t.id !== id);
  return {
    tabs: left,
    activeId: left.length === 0 ? '' : state.activeId === id ? left[left.length - 1]!.id : state.activeId,
  };
}

/**
 * D-200/FR-463: may the console auto-shrink to the pill right now? Only a PANEL (never
 * full-screen, never an already-shrunk pill), never while sticky, and NEVER while any open
 * tab's thread holds a pending needs-you gate — an off-screen gate is indistinguishable
 * from a hang (the invisible-gate class, pre-blocked).
 */
export function shrinkAllowed(mode: ConsoleMode, sticky: boolean, hasPendingGate: boolean): boolean {
  return mode === 'panel' && !sticky && !hasPendingGate;
}

/** FR-463(b): a pill whose tabs gain a pending gate auto-expands to the panel; every other
 * mode already shows the gate and stays put. */
export function modeOnPendingGate(mode: ConsoleMode): ConsoleMode {
  return mode === 'pill' ? 'panel' : mode;
}

/** Keep a dragged console inside the stage (main-cell) bounds — it can never leave `main`. */
export function clampPosition(
  x: number,
  y: number,
  consoleW: number,
  consoleH: number,
  boundsW: number,
  boundsH: number,
): { x: number; y: number } {
  return {
    x: Math.min(Math.max(0, x), Math.max(0, boundsW - consoleW)),
    y: Math.min(Math.max(0, y), Math.max(0, boundsH - consoleH)),
  };
}
