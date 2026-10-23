import { useState } from 'react';
import { Plus } from 'lucide-react';
import type { ProjectRow } from '../../../shared/ipc.js';
import { desk } from '../../lib/desk.js';
import { useLive } from '../../lib/data/useLive.js';
import { useQuery } from '../../lib/data/useQuery.js';
import { useOrg } from '../../lib/OrgContext.js';
import { openPublishTakeover } from '../../lib/publishTakeover.js';
import logoOnDark from '../../assets/tent-nocode-logo-white.svg';
import logoOnLight from '../../assets/tent-nocode-logo.svg';
import styles from './dashboard.module.css';

// Create surface showing projects with name, kind, and edit/settings verbs.

/** The muted mark a project with no screens shows; the theme picks the file, CSS swaps them. */
function NoScreensMark() {
  return (
    <div className={`${styles.previewEmpty} ${styles.previewMark}`} title="No screens yet">
      <img className={styles.markOnDark} src={logoOnDark} alt="" width={56} height={56} />
      <img className={styles.markOnLight} src={logoOnLight} alt="" width={56} height={56} />
    </div>
  );
}

function ProjectCard({ project, hasScreens, onEdit, onRename }: {
  project: ProjectRow;
  /** null while the screen list is still loading - the frame stays plain until it is known. */
  hasScreens: boolean | null;
  onEdit: () => void;
  onRename: (name: string) => void;
}) {
  // Double-click card name to rename it.
  const [renaming, setRenaming] = useState(false);
  const commit = (v: string): void => {
    setRenaming(false);
    if (v.trim() !== '' && v.trim() !== project.name) onRename(v.trim());
  };
  return (
    <div className={styles.card}>
      {hasScreens === false ? <NoScreensMark /> : <div className={styles.previewEmpty} />}
      <div className={styles.cardBody}>
        {renaming ? (
          <input
            className={styles.cardName}
            defaultValue={project.name}
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            onBlur={(e) => commit(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit((e.target as HTMLInputElement).value);
              if (e.key === 'Escape') setRenaming(false);
            }}
          />
        ) : (
          <div className={styles.cardName} title="Double-click to rename" onDoubleClick={() => setRenaming(true)}>{project.name}</div>
        )}
        <div className={styles.cardMeta}>
          <span>{(project.kind ?? 'app') === 'website' ? 'Website' : 'App'}</span>
        </div>
      </div>
      <div className={styles.cardVerbs}>
        <button type="button" className={`${styles.verb} ${styles.verbPrimary}`} onClick={onEdit}>
          Edit
        </button>
        <button type="button" className={styles.verb} onClick={() => openPublishTakeover({ projectId: project.id, section: 'general' })}>
          Settings
        </button>
      </div>
    </div>
  );
}

export function CreateSurface({ onEdit, onNew }: {
  onEdit: (projectId: string) => void;
  onNew: () => void;
}) {
  const { orgId } = useOrg();
  const projects = useQuery(`dash-projects:${orgId}`, () => desk.listProjects(orgId), [orgId]);
  // A project's screens are its tabs that host a scene - the same read the project screen and the canvas use.
  const tabs = useQuery(`dash-tabs:${orgId}`, () => desk.listTabs(orgId), [orgId]);
  useLive(['tabs'], () => tabs.refetch());
  const withScreens = tabs.data === undefined
    ? null
    : new Set(tabs.data.filter((t) => t.sceneSlug !== null && t.projectId !== null).map((t) => t.projectId));
  const rows = projects.data ?? [];
  const count = rows.length === 0 ? null : `${rows.length} project${rows.length === 1 ? '' : 's'}`;

  return (
    <div className={`${styles.home} ${styles.scaleUp}`}>
      <header className={styles.pageHead}>
        <h1 className={styles.pageTitle}>Your projects</h1>
        {count !== null ? <span className={styles.pageMeta}>{count}</span> : null}
      </header>
      <div className={styles.grid}>
        <button type="button" className={`${styles.card} ${styles.plusCard}`} onClick={onNew}>
          <div className={`${styles.previewEmpty} ${styles.plusFrame}`}>
            <Plus size={26} strokeWidth={1.5} />
          </div>
          <div className={styles.cardBody}>
            <div className={styles.cardName}>New project</div>
          </div>
        </button>
        {rows.map((p) => (
          <ProjectCard
            key={p.id} project={p} onEdit={() => onEdit(p.id)}
            hasScreens={withScreens === null ? null : withScreens.has(p.id)}
            onRename={(name) => { void desk.renameProject(orgId, p.id, name).then(() => projects.refetch()); }}
          />
        ))}
      </div>
    </div>
  );
}
