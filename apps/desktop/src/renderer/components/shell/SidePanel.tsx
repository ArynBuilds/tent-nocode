import { useState } from 'react';
import { PaneBody } from './paneBody.js';
import { PanelLauncher } from './PanelLauncher.js';
import { PanelStrip } from './PanelStrip.js';
import { newTab } from './panelPanes.js';
import type { PanelTab } from './panelPanes.js';
import styles from './sidepanel.module.css';

/**
 * The side panel (user-directed 2026-07-20, the Codex reference): a right pane with its OWN
 * tab strip — side chats and a user-driven browser — living beside the main thread.
 *
 * Law accounting (spec §19): this is APP-SHELL furniture, the same class as the sidebar and
 * title bar — thread chrome laws are untouched. Each side chat renders the SAME
 * ConversationView as the main route (every surface law applies inside it unchanged);
 * window-level hotkeys stay with the primary view (hotkeys={false} here). The browser tab is
 * the USER's surface (own persist: partition) — it is NOT the agents' walled browser (D-73:
 * that one stays hidden and caged; agent-visible browsing is a separate consented design).
 *
 * Tier 52 Phase 3: the tab system (PanelTab/newTab), the panes (SideChat/FilePane/
 * BrowserPane), and the strip (PanelStrip) extracted to their own files so the BOTTOM
 * panel hosts the identical surfaces — one tab system, never a duplicate. This file keeps
 * only the RIGHT-side geometry (width resize, right overlay, width-pinned clip).
 */

// Re-exported so existing importers (App.tsx) keep their seam unchanged.
export { newTab };
export type { PanelTab };

interface SidePanelProps {
  tabs: PanelTab[];
  activeId: string;
  onTabs: (tabs: PanelTab[], activeId: string) => void;
  /** True while the track is collapsing/shut (the sidebar's animation grammar): the panel
   * stays mounted, content clips, the border fades with the same tween. */
  hidden?: boolean;
  /** Narrow-window mode (mirrors the left sidebar): fixed overlay sliding in from the RIGHT
   * over a blurred scrim. */
  overlay?: boolean;
  /** D11 (the one-dashboard spec, 2026-08-14): 'left' mounts the SAME species on the
   * left track - same tabs, same launcher, same resize, same visuals; the default
   * 'right' is byte-identical to before (the ruling is ADDITIVE ONLY). */
  side?: 'left' | 'right';
  /** Drag-resize (user-directed 2026-07-20): px width to set (null = back to the default),
   * clamped in here between the panel floor and the chat floor. Docked mode only. */
  onResize?: (width: number | null) => void;
  /** Space the panel may never eat on its far side (the chat column's floor). */
  reservedLeft?: number;
  /** Mirrors the drag into the shell (kills the grid tween + mounts the pointer veil). */
  onResizingChange?: (active: boolean) => void;
}

/** The panel can never shrink below this; the chat column keeps its own floor via reservedLeft. */
const PANEL_MIN = 340;
/** The left slot's own floor (a tree/Map pane earns life at less than a chat does). */
const LEFT_MIN = 220;

export function SidePanel({
  tabs, activeId, onTabs, hidden = false, overlay = false, side = 'right',
  onResize, reservedLeft = 720, onResizingChange,
}: SidePanelProps) {
  const [dragging, setDragging] = useState(false);
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];
  const floor = side === 'left' ? LEFT_MIN : PANEL_MIN;

  function startResize(e: React.PointerEvent): void {
    if (!onResize || hidden || overlay) return;
    e.preventDefault();
    setDragging(true);
    onResizingChange?.(true);
    const onMove = (ev: PointerEvent): void => {
      const max = Math.max(floor, window.innerWidth - reservedLeft);
      const w = side === 'left' ? Math.round(ev.clientX) : Math.round(window.innerWidth - ev.clientX);
      onResize(Math.min(Math.max(w, floor), max));
    };
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setDragging(false);
      onResizingChange?.(false);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  function add(kind: PanelTab['kind']): void {
    const t = newTab(kind);
    onTabs([...tabs, t], t.id);
  }

  function close(id: string): void {
    const left = tabs.filter((t) => t.id !== id);
    // The last tab closed → the pane stays and shows the LAUNCHER again (user-directed
    // 2026-07-20, the Codex picker); only the titlebar toggle hides the pane.
    onTabs(left, left.length === 0 ? '' : activeId === id ? left[left.length - 1]!.id : activeId);
  }

  function setThread(id: string, threadId: string): void {
    onTabs(tabs.map((t) => (t.id === id ? { ...t, threadId } : t)), activeId);
  }

  const base = side === 'left' ? `${styles.panel} ${styles.panelLeft}` : styles.panel;
  const cls = overlay
    ? `${base} ${styles.panelOverlay}`
    : hidden
      ? `${base} ${styles.panelShut}`
      : base;
  return (
    <div className={cls}>
      {!hidden && !overlay && onResize ? (
        <div
          className={dragging ? `${styles.dragHandle} ${styles.dragHandleActive}` : styles.dragHandle}
          onPointerDown={startResize}
          onDoubleClick={() => onResize(null)}
          title="Drag to resize · double-click to reset"
        />
      ) : null}
      {dragging ? <div className={styles.resizeVeil} /> : null}
      {tabs.length === 0 ? (
        /* The LAUNCHER (the Codex picker) + the Tier 37 parts shelf — own component. */
        <PanelLauncher onAdd={add} />
      ) : (
        <>
          <PanelStrip tabs={tabs} activeId={activeId} onTabs={onTabs} onClose={close} onAdd={add} />
          {/* Every tab stays mounted (display toggling) so a browser keeps its page and a chat
              keeps its scroll when you flip between tabs. */}
          {tabs.map((t) => (
            <div key={t.id} className={t.id === active?.id ? styles.body : styles.bodyHidden}>
              <PaneBody tab={t} onThread={(threadId) => setThread(t.id, threadId)} />
            </div>
          ))}
        </>
      )}
    </div>
  );
}
