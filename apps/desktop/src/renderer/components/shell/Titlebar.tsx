import { ArrowLeft, Minus, Moon, PanelBottom, PanelLeft, PanelRight, Square, Sun, X } from 'lucide-react';
import { desk } from '../../lib/desk.js';
import { toggleTheme, useTheme } from '../../lib/theme.js';
import styles from './shell.module.css';

/**
 * The 35px title bar (user-directed 2026-07-20, the Cursor reference): a drag
 * region whose controls toggle the panels; the in-frame window controls
 * replaced the OS overlay (it floated in its own layer and ghosted at some
 * DPIs — one frame, one bar, our buttons).
 *
 * THE ONE DASHBOARD (D1/D5, 2026-08-14): the bar serves BOTH shells — every
 * control renders only where its handler exists (absence, never a disabled
 * row). The dashboard passes none of the panel toggles; the editor takeover
 * passes onBack — the ruled top-left way back to the dashboard.
 */
export function Titlebar({ onBack, onPublish, toggleLabel, onToggleSide, bottomVisible = false, onToggleBottom, panelOpen = false, onTogglePanel }: {
  /** D5: the editor takeover's top-left Back — absent on the dashboard. */
  onBack?: () => void;
  /** D12 (verbatim: "on top left there will be button called publish/export"):
   * the editor's door to the one project screen — absent on the dashboard. */
  onPublish?: () => void;
  toggleLabel?: string;
  onToggleSide?: () => void;
  bottomVisible?: boolean;
  onToggleBottom?: () => void;
  panelOpen?: boolean;
  onTogglePanel?: () => void;
}) {
  const theme = useTheme();
  return (
    <div className={styles.titlebar}>
      {onBack !== undefined ? (
        <button
          type="button"
          className={styles.titlebarBtn}
          aria-label="Back to the dashboard"
          title="Back to the dashboard"
          onClick={onBack}
        >
          <ArrowLeft size={16} />
        </button>
      ) : null}
      {onToggleSide !== undefined ? (
        <button
          type="button"
          className={styles.titlebarBtn}
          aria-label={toggleLabel}
          title={toggleLabel}
          onClick={onToggleSide}
        >
          <PanelLeft size={16} />
        </button>
      ) : null}
      {onPublish !== undefined ? (
        <button
          type="button"
          className={`${styles.titlebarBtn} ${styles.titlebarTextBtn}`}
          onClick={onPublish}
        >
          Publish/Export
        </button>
      ) : null}
      <div className={styles.titlebarSpacer} />
      {/* LIGHT MODE toggle (user-ruled 2026-07-28): per-device view-state, titlebar-owned
          like the panel toggles. */}
      <button
        type="button"
        className={styles.titlebarBtn}
        aria-label={theme === 'dark' ? 'Light mode' : 'Dark mode'}
        title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
        onClick={toggleTheme}
      >
        {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
      </button>
      {onToggleBottom !== undefined ? (
        <button
          type="button"
          className={styles.titlebarBtn}
          aria-label={bottomVisible ? 'Hide bottom panel' : 'Show bottom panel'}
          title={bottomVisible ? 'Hide bottom panel' : 'Show bottom panel'}
          onClick={onToggleBottom}
        >
          <PanelBottom size={16} />
        </button>
      ) : null}
      {onTogglePanel !== undefined ? (
        <button
          type="button"
          className={styles.titlebarBtn}
          aria-label={panelOpen ? 'Hide side panel' : 'Show side panel'}
          title={panelOpen ? 'Hide side panel' : 'Show side panel'}
          onClick={onTogglePanel}
        >
          <PanelRight size={16} />
        </button>
      ) : null}
      <div className={styles.winControls}>
        <button type="button" className={styles.winBtn} aria-label="Minimize" onClick={() => void desk.windowControl('minimize')}>
          <Minus size={14} />
        </button>
        <button type="button" className={styles.winBtn} aria-label="Maximize or restore" onClick={() => void desk.windowControl('maximize')}>
          <Square size={12} />
        </button>
        <button
          type="button"
          className={`${styles.winBtn} ${styles.winBtnClose}`}
          aria-label="Close"
          onClick={() => void desk.windowControl('close')}
        >
          <X size={15} />
        </button>
      </div>
    </div>
  );
}
