import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowLeft } from 'lucide-react';
import { desk } from '../../lib/desk.js';
import { useLive } from '../../lib/data/useLive.js';
import { useQuery } from '../../lib/data/useQuery.js';
import { useOrg } from '../../lib/OrgContext.js';
import type { ProjectSectionId } from '../../lib/publishTakeover.js';
import { ExportSection } from './exportSection.js';
import { GeneralSection } from './generalSection.js';
import { Empty, kit } from './kit.js';
import { PeopleSection } from './peopleSection.js';
import { navFor, resolveSection, type ProjectKind, type ProjectNavItem } from './projectNav.js';
import { PublishSection } from './publishSection.js';
import { SecretsSection } from './secretsSection.js';
import { ServerSection } from './serverSection.js';
import styles from './project.module.css';

// The one project screen: a section list on the left, one section at a time on the right.

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
    case 'secrets': return <SecretsSection item={item} orgId={orgId} projectId={project.id} />;
    case 'people': return <PeopleSection item={item} orgId={orgId} projectId={project.id} />;
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
  const rootRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef(new Map<ProjectSectionId, HTMLButtonElement>());

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

  useEffect(() => {
    rootRef.current?.closest('[data-scroll-root]')?.scrollTo({ top: 0 });
  }, [active]);

  const go = (id: ProjectSectionId, focus = false): void => {
    setPicked(id);
    if (focus) tabRefs.current.get(id)?.focus();
  };

  // The section list is a vertical tab list: arrows move, Home and End jump.
  const onNavKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (activeItem === undefined) return;
    const i = items.findIndex((it) => it.id === activeItem.id);
    const to = e.key === 'ArrowDown' ? items[(i + 1) % items.length]
      : e.key === 'ArrowUp' ? items[(i - 1 + items.length) % items.length]
        : e.key === 'Home' ? items[0]
          : e.key === 'End' ? items[items.length - 1]
            : undefined;
    if (to === undefined) return;
    e.preventDefault();
    go(to.id, true);
  };

  const loading = project === null && projects.error === undefined && tabs.error === undefined && (projects.loading || tabs.loading);
  const failed = projects.error ?? tabs.error;

  return (
    <div ref={rootRef} className={styles.layout}>
      <aside className={styles.side}>
        <button type="button" className={styles.back} onClick={onClose}>
          <ArrowLeft size={14} />
          <span>Back</span>
        </button>
        {project !== null ? (
          <div className={styles.identity}>
            <div className={styles.projectName} title={project.name}>{project.name}</div>
            <div className={styles.projectKind}>{project.kind === 'website' ? 'Website' : 'App'} settings</div>
          </div>
        ) : null}
        {project !== null ? (
          <div className={styles.nav} role="tablist" aria-orientation="vertical" aria-label="Project settings" onKeyDown={onNavKey}>
            {items.map(({ id, label, icon: Icon }) => {
              const on = id === activeItem?.id;
              return (
                <button
                  key={id}
                  ref={(el) => { if (el !== null) tabRefs.current.set(id, el); else tabRefs.current.delete(id); }}
                  type="button"
                  role="tab"
                  id={`project-tab-${id}`}
                  aria-selected={on}
                  aria-controls="project-pane"
                  tabIndex={on ? 0 : -1}
                  className={on ? `${styles.navItem} ${styles.navItemOn}` : styles.navItem}
                  onClick={() => go(id)}
                >
                  <Icon size={15} />
                  <span>{label}</span>
                </button>
              );
            })}
          </div>
        ) : null}
      </aside>
      <main className={styles.content}>
        {loading ? <Empty>Loading project…</Empty> : null}
        {failed !== undefined && project === null ? (
          <div className={kit.status}><span className={styles.failText}>Could not read this project. {failed}</span></div>
        ) : null}
        {!loading && failed === undefined && project === null ? <Empty>This project no longer exists. It may have been deleted.</Empty> : null}
        {project !== null && activeItem !== undefined ? (
          <div key={activeItem.id} id="project-pane" role="tabpanel" aria-labelledby={`project-tab-${activeItem.id}`} className={styles.pane}>
            <SectionBody item={activeItem} orgId={orgId} project={project} go={(id) => go(id)} onRenamed={() => projects.refetch()} />
          </div>
        ) : null}
      </main>
    </div>
  );
}
