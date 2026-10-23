import { useMemo, useState, type CSSProperties } from 'react';
import { AppWindow, Globe, Pencil, Plus, Search, Settings2 } from 'lucide-react';
import type { ProjectRow } from '../../../shared/ipc.js';
import { desk } from '../../lib/desk.js';
import { useLive } from '../../lib/data/useLive.js';
import { useQuery } from '../../lib/data/useQuery.js';
import { useOrg } from '../../lib/OrgContext.js';
import { openPublishTakeover } from '../../lib/publishTakeover.js';
import { Logo } from '../brand/Logo.js';
import { kit } from '../kit/kit.js';
import type { ProjectFilter } from './DashboardRail.js';
import styles from './dashboard.module.css';

// The apps page: a greeting, the projects as cards that open on click, and the one main verb that makes a new one.

function greeting(name: string): string {
  const h = new Date().getHours();
  const part = h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  const first = name.trim().split(/\s+/)[0] ?? '';
  return first !== '' ? `${part}, ${first}` : part;
}

const made = (iso: string): string => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

function ProjectCard({ project, screens, index, onEdit, onRename }: {
  project: ProjectRow;
  /** null while the screen list is still loading. */
  screens: number | null;
  index: number;
  onEdit: () => void;
  onRename: (name: string) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const website = project.kind === 'website';
  const KindIcon = website ? Globe : AppWindow;
  const commit = (v: string): void => {
    setRenaming(false);
    if (v.trim() !== '' && v.trim() !== project.name) onRename(v.trim());
  };
  return (
    <article className={styles.card} style={{ '--i': index } as CSSProperties}>
      <button type="button" className={styles.cardOpen} aria-label={`Open ${project.name}`} onClick={onEdit} />
      <div className={styles.preview}>
        <Logo size={64} className={styles.previewMark} />
        {screens !== null && screens > 0 ? (
          <span className={styles.previewCount}>{screens} screen{screens === 1 ? '' : 's'}</span>
        ) : null}
        <div className={styles.cardTools}>
          <button type="button" className={styles.cardTool} aria-label={`Rename ${project.name}`} title="Rename" onClick={() => setRenaming(true)}>
            <Pencil size={14} />
          </button>
          <button
            type="button"
            className={styles.cardTool}
            aria-label={`Settings for ${project.name}`}
            title="Settings"
            onClick={() => openPublishTakeover({ projectId: project.id, section: 'general' })}
          >
            <Settings2 size={14} />
          </button>
        </div>
      </div>
      <div className={styles.cardBody}>
        {renaming ? (
          <input
            className={`${kit.input} ${styles.cardRename}`}
            defaultValue={project.name}
            aria-label="Project name"
            autoFocus
            data-own-escape=""
            onFocus={(e) => e.currentTarget.select()}
            onBlur={(e) => commit(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') { e.stopPropagation(); setRenaming(false); }
            }}
          />
        ) : (
          <h2 className={styles.cardName}>{project.name}</h2>
        )}
        <div className={styles.cardMeta}>
          <span className={styles.kindTag}><KindIcon size={13} />{website ? 'Website' : 'App'}</span>
          <span className={styles.dot} aria-hidden="true" />
          <span>Made {made(project.createdAt)}</span>
        </div>
      </div>
    </article>
  );
}

function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div className={styles.empty}>
      <div className={styles.emptyMark}>
        <Logo size={72} />
      </div>
      <h2 className={styles.emptyTitle}>Build your first app</h2>
      <p className={styles.emptyLine}>Tables, screens and flows on one canvas. Ask the AI or place things yourself. Everything stays on this computer.</p>
      <button type="button" className={`${kit.btn} ${kit.btnPrimary} ${styles.newBtn}`} onClick={onNew}>
        <Plus size={16} />
        New project
      </button>
    </div>
  );
}

export function CreateSurface({ filter, onEdit, onNew }: {
  filter: ProjectFilter;
  onEdit: (projectId: string) => void;
  onNew: () => void;
}) {
  const { orgId, displayName } = useOrg();
  const projects = useQuery(`dash-projects:${orgId}`, () => desk.listProjects(orgId), [orgId]);
  // A project's screens are its tabs that host a scene - the same read the project screen and the canvas use.
  const tabs = useQuery(`dash-tabs:${orgId}`, () => desk.listTabs(orgId), [orgId]);
  useLive(['tabs'], () => tabs.refetch());
  const [query, setQuery] = useState('');

  const screensOf = useMemo(() => {
    if (tabs.data === undefined) return null;
    const counts = new Map<string, number>();
    for (const t of tabs.data) if (t.sceneSlug !== null && t.projectId !== null) counts.set(t.projectId, (counts.get(t.projectId) ?? 0) + 1);
    return counts;
  }, [tabs.data]);

  const rows = [...(projects.data ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const q = query.trim().toLowerCase();
  const ofKind = filter === 'all' ? rows : rows.filter((p) => (p.kind ?? 'app') === filter);
  const shown = q === '' ? ofKind : ofKind.filter((p) => p.name.toLowerCase().includes(q));
  const loaded = projects.data !== undefined;

  return (
    <div className={`${styles.home} ${kit.readable}`}>
      <header className={styles.pageHead}>
        <div className={styles.hello}>
          <h1 className={styles.pageTitle}>{greeting(displayName)}</h1>
          <p className={styles.pageMeta}>
            {!loaded ? 'Loading your projects…' : rows.length === 0 ? 'Nothing here yet.' : `${rows.length} project${rows.length === 1 ? '' : 's'} on this computer`}
          </p>
        </div>
        {rows.length > 0 ? (
          <div className={styles.headTools}>
            {rows.length > 3 ? (
              <label className={styles.search}>
                <Search size={15} />
                <input
                  className={styles.searchInput}
                  placeholder="Find a project"
                  aria-label="Find a project"
                  value={query}
                  data-own-escape={query !== '' ? '' : undefined}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Escape') setQuery(''); }}
                />
              </label>
            ) : null}
            <button type="button" className={`${kit.btn} ${kit.btnPrimary} ${styles.newBtn}`} onClick={onNew}>
              <Plus size={16} />
              New project
            </button>
          </div>
        ) : null}
      </header>
      {projects.error !== undefined ? <p className={styles.problem}>Could not read your projects. {projects.error}</p> : null}
      {loaded && rows.length === 0 ? <EmptyState onNew={onNew} /> : null}
      {rows.length > 0 && shown.length === 0 ? (
        <p className={styles.noMatch}>
          {q !== '' ? `No project matches “${query.trim()}”.` : filter === 'app' ? 'No apps yet.' : 'No websites yet.'}
        </p>
      ) : null}
      {shown.length > 0 ? (
        <div className={styles.grid}>
          {shown.map((p, i) => (
            <ProjectCard
              key={p.id} project={p} index={i} onEdit={() => onEdit(p.id)}
              screens={screensOf === null ? null : (screensOf.get(p.id) ?? 0)}
              onRename={(name) => { void desk.renameProject(orgId, p.id, name).then(() => projects.refetch()); }}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
