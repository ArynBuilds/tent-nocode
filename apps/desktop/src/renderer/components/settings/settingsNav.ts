import { Activity, Cpu, KeyRound, Plug, Settings2, ShieldCheck, Users } from 'lucide-react';
import type { ComponentType } from 'react';

// Settings modal's rail: pure data; deliberately edited here, never auto-appended. Icons from Lucide.
export type SettingsSectionId = 'general' | 'permissions' | 'connections' | 'engines' | 'members' | 'secrets' | 'health';

export interface SettingsNavItem {
  id: SettingsSectionId;
  label: string;
  icon: ComponentType<{ size?: number }>;
}

export const SETTINGS_NAV: SettingsNavItem[] = [
  { id: 'general', label: 'General', icon: Settings2 },
  { id: 'permissions', label: 'Permissions', icon: ShieldCheck },
  { id: 'connections', label: 'Connections', icon: Plug },
  { id: 'engines', label: 'Engines', icon: Cpu },
  { id: 'members', label: 'Members', icon: Users },
  { id: 'secrets', label: 'Secrets', icon: KeyRound },
  { id: 'health', label: 'Health', icon: Activity },
];
