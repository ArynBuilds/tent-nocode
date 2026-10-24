import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { desk } from './desk.js';
import { useLive } from './data/useLive.js';
import { useOrg } from './OrgContext.js';

/**
 * PROJECT FOCUS (spec 2026-08-01): ONE focused project at a time — everything aims at it
 * (the center, every Map mount, chat births, ⚙ settings, file drops). The OrgContext
 * idiom: one context at the App root, read everywhere instead of threading props.
 *
 * §1.4 defaults: boot restores the last-focused project (localStorage, the Stage-key
 * idiom); fresh/unknown → the most recently active project (listThreads is activity-
 * ordered), no threads → the newest project; ZERO projects → null (the birth flow owns
 * the center, and every birth lane auto-focuses its result via `focusProject`).
 */

const FOCUS_KEY = 'nodeloom-focus';

export interface FocusValue {
  /** Null only while no project exists (or the default is still resolving for one beat). */
  focusedProjectId: string | null;
  /** Focus a project (persisted locally). Callers aim the center via the router lanes. */
  focusProject: (projectId: string) => void;
}

const FocusContext = createContext<FocusValue | undefined>(undefined);

export function FocusProvider({ children }: { children: ReactNode }) {
  const { orgId } = useOrg();
  const [focused, setFocused] = useState<string | null>(() => {
    try { return localStorage.getItem(FOCUS_KEY); } catch { return null; }
  });
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  // Re-resolves the default while unfocused (zero projects → the first birth adopts).
  const [resolveTick, setResolveTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const projects = await desk.listProjects(orgId).catch(() => []);
      if (cancelled) return;
      const current = focusedRef.current;
      if (projects.length === 0) {
        // THE DELETION DOORS (2026-08-02): the LAST project deleted → focus clears and
        // the birth flow owns the center (What-to-build) — never a dead focus id.
        if (current !== null) {
          setFocused(null);
          try { localStorage.removeItem(FOCUS_KEY); } catch { /* view-state only */ }
        }
        return;
      }
      if (current !== null && projects.some((p) => p.id === current)) return;
      const threads = await desk.listThreads(orgId).catch(() => []);
      if (cancelled) return;
      const mostActive = threads.find((t) => projects.some((p) => p.id === t.thread.projectId))?.thread.projectId
        ?? [...projects].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]!.id;
      setFocused(mostActive);
      try { localStorage.setItem(FOCUS_KEY, mostActive); } catch { /* view-state only */ }
    })();
    return () => { cancelled = true; };
  }, [orgId, resolveTick]);

  // Every relevant tick re-checks the default: a project born while nothing is focused
  // adopts focus, and a DELETED focused project falls back per the §1.4 resolution
  // (most recently active; zero projects → null and the birth flow owns the center).
  useLive(['tabs', 'threads'], () => setResolveTick((t) => t + 1));

  function focusProject(projectId: string): void {
    setFocused(projectId);
    try { localStorage.setItem(FOCUS_KEY, projectId); } catch { /* view-state only */ }
  }

  return <FocusContext.Provider value={{ focusedProjectId: focused, focusProject }}>{children}</FocusContext.Provider>;
}

/** Reads the focus. Throws outside `FocusProvider` — the provider wraps the whole app. */
export function useFocusedProject(): FocusValue {
  const value = useContext(FocusContext);
  if (!value) {
    throw new Error('useFocusedProject() called outside FocusProvider');
  }
  return value;
}
