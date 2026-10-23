import { Download, Globe, KeyRound, Server, Settings2, Users } from 'lucide-react';
import type { ComponentType } from 'react';
import type { ProjectSectionId } from '../../lib/publishTakeover.js';

// The project screen's section list: pure data, in reading order; a section a project kind cannot use is absent.

export type ProjectKind = 'app' | 'website';

export interface ProjectNavItem {
  id: ProjectSectionId;
  label: string;
  /** The one plain sentence under the section title. */
  description: string;
  icon: ComponentType<{ size?: number }>;
  /** Kinds the section exists for; absent = every kind. */
  only?: ProjectKind;
}

export const PROJECT_NAV: ProjectNavItem[] = [
  { id: 'general', label: 'General', icon: Settings2, description: 'The name and kind of this project.' },
  {
    id: 'publish', label: 'Publish', icon: Globe,
    description: 'Put this project on the server running on this computer, at its own address.',
  },
  {
    id: 'export', label: 'Export', icon: Download,
    description: 'Save the project as a .tproject file you can keep, share, or open on another computer.',
  },
  {
    id: 'server', label: 'Own server', icon: Server,
    description: 'Run this project on a server you control, from an exported file.',
  },
  {
    id: 'secrets', label: 'Secrets', icon: KeyRound,
    description: 'Keys and passwords this project uses. Values are stored encrypted and never shown again.',
  },
  { id: 'people', label: 'People', icon: Users, description: 'Who can open and change this project.' },
];

export function navFor(kind: ProjectKind): ProjectNavItem[] {
  return PROJECT_NAV.filter((i) => i.only === undefined || i.only === kind);
}

/** The asked-for section when this kind has it; an app asked for Publish lands on Export. */
export function resolveSection(kind: ProjectKind, asked: ProjectSectionId | undefined): ProjectSectionId {
  const items = navFor(kind);
  if (asked !== undefined && items.some((i) => i.id === asked)) return asked;
  return asked === 'publish' ? 'export' : 'general';
}
