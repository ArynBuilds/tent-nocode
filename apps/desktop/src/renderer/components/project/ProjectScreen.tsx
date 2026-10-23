import { useState } from 'react';
import { desk } from '../../lib/desk.js';
import { useLive } from '../../lib/data/useLive.js';
import { useQuery } from '../../lib/data/useQuery.js';
import { useOrg } from '../../lib/OrgContext.js';
import type { ProjectSectionId } from '../../lib/publishTakeover.js';
import { Empty, SectionHead, StatusLine } from '../kit/kit.js';
import { SettingsPage } from '../kit/SettingsPage.js';
import { SecretsEditor } from '../settings/SecretsSection.js';
import { ExportSection } from './exportSection.js';
import { GeneralSection } from './generalSection.js';
import { navFor, resolveSection, type ProjectKind, type ProjectNavItem } from './projectNav.js';
import { PublishSection } from './publishSection.js';
import { ServerSection } from './serverSection.js';

// The one project screen: the shared settings page with this project's sections.

export interface LoadedProject {
  id: string;
  name: string;
  kind: ProjectKind;
  /** The project's screens: its tabs that host a scene. */
  screens: Array<{ slug: string; title: string }>;
}

function SectionBody({ item, orgId, project, go, onRenamed }: {
  item: ProjectNavItem;
  orgId: string;
  project: LoadedProject;
  go: (id: ProjectSectionId) => void;
  onRenamed: () => void;
}) {
  switch (item.id) {
    case 'general': return <GeneralSection item={item} orgId={orgId} project={project} onRenamed={onRenamed} />;
    case 'publish': return <PublishSection item={item} orgId={orgId} project={project} />;
    case 'export': return <ExportSection item={item} orgId={orgId} project={project} />;
    case 'server': return <ServerSection item={item} onGoExport={() => go('export')} />;
    case 'secrets': return <><SectionHead title={item.label} description={item.description} /><SecretsEditor orgId={orgId} projectId={project.id} /></>;
  }
}

export function ProjectScreen({ projectId, section, onClose }: {
  projectId: string;
  section?: ProjectSectionId;
  onClose: () => void;
}) {
  const { orgId } = useOrg();
  const projects = useQuery(`project-screen:projects:${orgId}`, () => desk.listProjects(orgId), [orgId]);
  const tabs = useQuery(`project-screen:tabs:${orgId}`, () => desk.listTabs(orgId), [orgId]);
  useLive(['tabs'], () => tabs.refetch());
  const [picked, setPicked] = useState<ProjectSectionId | null>(null);

  const row = projects.data?.find((p) => p.id === projectId);
  const project: LoadedProject | null = row === undefined || tabs.data === undefined ? null : {
    id: row.id,
    name: row.name,
    kind: row.kind ?? 'app',
    screens: tabs.data
      .filter((t) => t.projectId === projectId && t.sceneSlug !== null)
      .map((t) => ({ slug: t.sceneSlug!, title: t.title })),
  };
  const items = project !== null ? navFor(project.kind) : [];
  const active = project !== null ? (picked ?? resolveSection(project.kind, section)) : null;
  const activeItem = items.find((i) => i.id === active) ?? items[0];

  const loading = project === null && projects.error === undefined && tabs.error === undefined && (projects.loading || tabs.loading);
  const failed = projects.error ?? tabs.error;

  return (
    <SettingsPage
      {...(project !== null ? { title: project.name, subtitle: `${project.kind === 'website' ? 'Website' : 'App'} settings` } : {})}
      label="Project settings"
      sections={items}
      active={activeItem?.id ?? null}
      onPick={setPicked}
      onBack={onClose}
    >
      {loading ? <Empty>Loading project…</Empty> : null}
      {failed !== undefined && project === null ? <StatusLine state={{ phase: 'failed', sentence: 'Could not read this project.', detail: failed }} /> : null}
      {!loading && failed === undefined && project === null ? <Empty>This project no longer exists. It may have been deleted.</Empty> : null}
      {project !== null && activeItem !== undefined ? (
        <SectionBody item={activeItem} orgId={orgId} project={project} go={setPicked} onRenamed={() => projects.refetch()} />
      ) : null}
    </SettingsPage>
  );
}
