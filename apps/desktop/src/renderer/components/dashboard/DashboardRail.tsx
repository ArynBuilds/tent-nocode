import { Settings } from 'lucide-react';
import { can } from '../../../shared/roles.js';
import { useOrg } from '../../lib/OrgContext.js';
import { openOverlay, useOverlayOpen } from '../../lib/overlay.js';
import { usePublishTakeover } from '../../lib/publishTakeover.js';
// Tent NoCode logo that adjusts for light and dark themes.
import tentNocodeLogoDark from '../../assets/tent-nocode-logo-white.svg';
import tentNocodeLogoLight from '../../assets/tent-nocode-logo.svg';
import styles from '../shell/shell.module.css';

// Thin dashboard rail with logo, Settings, and user avatar.

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}

export function DashboardRail() {
  const { role, displayName } = useOrg();
  const showSettings = can(role, 'config');
  const settingsOpen = useOverlayOpen();
  // Rail controls hide while project screen is open; logo and avatar stay.
  const takeoverOpen = usePublishTakeover() !== null;

  return (
    <aside className={styles.sidebar}>
      <div className={styles.dashRailLogo}>
        <img className={styles.dashRailLogoDark} src={tentNocodeLogoDark} alt="Tent NoCode" width={40} height={40} />
        <img className={styles.dashRailLogoLight} src={tentNocodeLogoLight} alt="Tent NoCode" width={40} height={40} />
      </div>

      <div className={styles.spacer} />

      {showSettings && !takeoverOpen ? (
        <button
          type="button"
          className={settingsOpen ? `${styles.dashRailIcon} ${styles.dashRailIconActive}` : styles.dashRailIcon}
          aria-label="Settings"
          title="Settings"
          onClick={() => openOverlay()}
        >
          <Settings size={18} />
        </button>
      ) : null}

      <div className={styles.dashAvatar} title={displayName}>
        {initials(displayName)}
      </div>
    </aside>
  );
}
