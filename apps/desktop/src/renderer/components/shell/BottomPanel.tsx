import { useState } from 'react';
import { PaneBody } from './paneBody.js';
import { PanelLauncher } from './PanelLauncher.js';
import { PanelStrip } from './PanelStrip.js';
import { newTab } from './panelPanes.js';
import type { PanelTab } from './panelPanes.js';
import panelStyles from './sidepanel.module.css';
import styles from './bottompanel.module.css';

// Bottom panel: third dockable, same tab system as side panel (never duplicate). Grid-anchored, session-local, default hidden. Mirrors side drag-resize.
interface BottomPanelProps {
  tabs: PanelTab[];
  activeId: string;
  onTabs: (tabs: PanelTab[], activeId: string) => void;
  /** True while the track is collapsing/shut: mounted, content clips, border fades. */
  hidden?: boolean;
  /** Narrow-window mode: fixed overlay sliding up from the BOTTOM over the shared scrim. */
  overlay?: boolean;
  /** Vertical drag-resize: px height to set (null = back to the default), clamped here. */
  onResize?: (height: number | null) => void;
  /** Vertical space the panel may never eat: title bar + the stage's floor. */
  reservedTop?: number;
  /** Mirrors the drag into the shell (kills the grid tween + mounts the pointer veil). */
  onResizingChange?: (active: boolean) => void;
}

/** The panel can never shrink below this; the stage keeps its own floor via reservedTop. */
const BOTTOM_MIN = 160;

export function BottomPanel({
  tabs, activeId, onTabs, hidden = false, overlay = false,
  onResize, reservedTop = 275, onResizingChange,
}: BottomPanelProps) {
  const [dragging, setDragging] = useState(false);
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];

  function startResize(e: React.PointerEvent): void {
    if (!onResize || hidden || overlay) return;
    e.preventDefault();
    setDragging(true);
    onResizingChange?.(true);
    const onMove = (ev: PointerEvent): void => {
      const max = Math.max(BOTTOM_MIN, window.innerHeight - reservedTop);
      const h = Math.round(window.innerHeight - ev.clientY);
      onResize(Math.min(Math.max(h, BOTTOM_MIN), max));
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
    // The last tab closed → the pane stays on the LAUNCHER (the side panel's ruling);
    // only the titlebar toggle hides the pane.
    const left = tabs.filter((t) => t.id !== id);
    onTabs(left, left.length === 0 ? '' : activeId === id ? left[left.length - 1]!.id : activeId);
  }

  const cls = overlay
    ? `${styles.bottom} ${styles.bottomOverlay}`
    : hidden
      ? `${styles.bottom} ${styles.bottomShut}`
      : styles.bottom;
  return (
    <div className={cls}>
      {/* Clip-not-reflow: the inner column keeps the OPEN track's height, anchored to the
          window-stationary BOTTOM edge — the closing top edge sweeps over it, content never
          rewraps mid-tween (the sidebar's grammar, rotated). */}
      <div className={styles.bottomInner}>
        {!hidden && !overlay && onResize ? (
          <div
            className={dragging ? `${styles.dragHandleH} ${styles.dragHandleHActive}` : styles.dragHandleH}
            onPointerDown={startResize}
            onDoubleClick={() => onResize(null)}
            title="Drag to resize · double-click to reset"
          />
        ) : null}
        {dragging ? <div className={styles.resizeVeilH} /> : null}
        {tabs.length === 0 ? (
          <PanelLauncher onAdd={add} />
        ) : (
          <>
            <PanelStrip tabs={tabs} activeId={activeId} onTabs={onTabs} onClose={close} onAdd={add} />
            {/* Every tab mounted (display-toggled). */}
            {tabs.map((t) => (
              <div key={t.id} className={t.id === active?.id ? panelStyles.body : panelStyles.bodyHidden}>
                <PaneBody tab={t} />
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
