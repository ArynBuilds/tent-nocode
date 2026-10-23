import { useEffect, useState } from 'react';
import { useOrg } from '../../lib/OrgContext.js';
import { closeOverlay, useOverlayOpen } from '../../lib/overlay.js';
import { usePublishTakeover } from '../../lib/publishTakeover.js';
import { SectionHead } from '../kit/kit.js';
import { SettingsPage, Takeover, useTakeoverEscape } from '../kit/SettingsPage.js';
import { ConnectionsSection } from './ConnectionsSection.js';
import { EnginesSection } from './EnginesSection.js';
import { GeneralSection } from './GeneralSection.js';
import { PermissionsSection } from './PermissionsSection.js';
import { SecretsEditor } from './SecretsSection.js';
import { SETTINGS_NAV, type SettingsNavItem, type SettingsSectionId } from './settingsNav.js';

// The settings screen: the shared settings page over the whole window, one section at a time.

function SectionBody({ item, orgId, role }: { item: SettingsNavItem; orgId: string; role: ReturnType<typeof useOrg>['role'] }) {
  switch (item.id) {
    case 'general': return <GeneralSection orgId={orgId} role={role} />;
    case 'engines': return <EnginesSection orgId={orgId} role={role} />;
    case 'connections': return <ConnectionsSection orgId={orgId} role={role} />;
    case 'secrets': return <SecretsEditor orgId={orgId} />;
    case 'permissions': return <PermissionsSection orgId={orgId} role={role} />;
  }
}

export function SettingsScreen() {
  // While the project screen holds the overlay flag, settings yields the keyboard and renders nothing.
  const overlayOpen = useOverlayOpen();
  const takeover = usePublishTakeover();
  const open = overlayOpen && takeover === null;
  const { orgId, role, displayName } = useOrg();
  const [section, setSection] = useState<SettingsSectionId>('general');

  // Every open starts at the first section; a deep section from last time is not worth keeping.
  useEffect(() => {
    if (open) setSection('general');
  }, [open]);
  useTakeoverEscape(open, closeOverlay);

  if (!open) return null;
  const item = SETTINGS_NAV.find((i) => i.id === section) ?? SETTINGS_NAV[0]!;
  return (
    <Takeover>
      <SettingsPage
        title="Settings"
        {...(displayName !== '' ? { subtitle: displayName } : {})}
        label="Settings"
        sections={SETTINGS_NAV}
        active={item.id}
        onPick={setSection}
        onBack={closeOverlay}
      >
        <SectionHead title={item.label} description={item.description} />
        <SectionBody item={item} orgId={orgId} role={role} />
      </SettingsPage>
    </Takeover>
  );
}
