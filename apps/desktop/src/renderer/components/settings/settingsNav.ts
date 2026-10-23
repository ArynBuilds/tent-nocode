import { Cpu, KeyRound, Plug, Settings2, ShieldCheck } from 'lucide-react';
import type { ComponentType } from 'react';

// The settings screen's section list: pure data, in reading order; deliberately edited here, never auto-appended.

export type SettingsSectionId = 'general' | 'engines' | 'connections' | 'secrets' | 'permissions';

export interface SettingsNavItem {
  id: SettingsSectionId;
  label: string;
  /** The one plain sentence under the section title. */
  description: string;
  icon: ComponentType<{ size?: number }>;
}

export const SETTINGS_NAV: SettingsNavItem[] = [
  { id: 'general', label: 'General', icon: Settings2, description: 'Your account and how new chats start.' },
  {
    id: 'engines', label: 'Engines', icon: Cpu,
    description: 'What the AI builder runs on. Claude Code is used by itself when it is on this computer; an API key works too.',
  },
  {
    id: 'connections', label: 'Connections', icon: Plug,
    description: 'Outside services the AI may use in a chat. Reading runs on its own; anything that changes something asks you first.',
  },
  {
    id: 'secrets', label: 'Secrets', icon: KeyRound,
    description: 'Keys and passwords every project can use. Values are stored encrypted and never shown again.',
  },
  {
    id: 'permissions', label: 'Permissions', icon: ShieldCheck,
    description: 'What the AI may do without asking again. Each one was given by approving its card once.',
  },
];
