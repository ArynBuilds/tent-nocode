import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useOrg } from '../../lib/OrgContext.js';
import { closeOverlay, useOverlayOpen } from '../../lib/overlay.js';
import { usePublishTakeover } from '../../lib/publishTakeover.js';
import { GeneralSection } from './GeneralSection.js';
import { HealthSection } from './HealthSection.js';
import { MembersSection } from './MembersSection.js';
import { PermissionsSection } from './PermissionsSection.js';
import { ConnectionsSection } from './ConnectionsSection.js';
import { EnginesSection } from './EnginesSection.js';
import { SecretsSection } from './SecretsSection.js';
import { SETTINGS_NAV } from './settingsNav.js';
import type { SettingsSectionId } from './settingsNav.js';
import styles from './settings.module.css';

// Settings modal: one section at a time; Esc closes (capture phase stops propagation).
function SectionBody({ section, orgId, role }: { section: SettingsSectionId; orgId: string; role: ReturnType<typeof useOrg>['role'] }) {
  switch (section) {
    case 'general':
      return <GeneralSection orgId={orgId} role={role} />;
    case 'permissions':
      return <PermissionsSection orgId={orgId} role={role} />;
    case 'members':
      return <MembersSection orgId={orgId} />;
    case 'connections':
      return <ConnectionsSection orgId={orgId} role={role} />;
    case 'engines':
      return <EnginesSection orgId={orgId} role={role} />;
    case 'secrets':
      return <SecretsSection orgId={orgId} role={role} />;
    case 'health':
      return <HealthSection orgId={orgId} />;
  }
}

export function SettingsModal() {
  // While the project screen takeover holds the overlay flag, settings yields the keyboard and renders nothing.
  const overlayOpen = useOverlayOpen();
  const takeover = usePublishTakeover();
  const open = overlayOpen && takeover === null;
  const { orgId, role } = useOrg();
  const nav = SETTINGS_NAV;
  const home = nav[0]!.id;
  const [section, setSection] = useState<SettingsSectionId>(home);

  // Every open starts at the first section (the refs' behavior) — a stale deep
  // section from last time is not a fact worth persisting.
  useEffect(() => {
    if (open) setSection(home);
  }, [open, home]);

  // Esc closes the modal and NOTHING else hears it: capture phase + stopPropagation beats the
  // window-level bubble listeners (Esc-interrupt, Knowledge's whole-map reset) even before their
  // own isOverlayOpen() guards.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      closeOverlay();
    }
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [open]);

  if (!open) return null;

  const active = nav.find((i) => i.id === section) ?? nav[0]!;

  return (
    <div className={styles.backdrop} onMouseDown={(e) => e.target === e.currentTarget && closeOverlay()}>
      <div className={styles.modal} role="dialog" aria-modal="true" aria-label="Settings">
        <nav className={styles.rail}>
          <button type="button" className={styles.railClose} aria-label="Close settings" onClick={() => closeOverlay()}>
            <X size={14} />
          </button>
          {nav.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className={id === section ? `${styles.railItem} ${styles.railItemActive}` : styles.railItem}
              onClick={() => setSection(id)}
            >
              <Icon size={14} />
              {label}
            </button>
          ))}
        </nav>
        <div className={styles.body}>
          <div className={styles.bodyTitle}>{active.label}</div>
          <div className={styles.bodyScroll}>
            <SectionBody section={section} orgId={orgId} role={role} />
          </div>
        </div>
      </div>
    </div>
  );
}
