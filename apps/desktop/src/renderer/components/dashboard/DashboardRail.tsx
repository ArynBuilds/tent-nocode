import { AppWindow, Globe, LayoutGrid, Settings } from 'lucide-react';
import { can } from '../../../shared/roles.js';
import { useQuery } from '../../lib/data/useQuery.js';
import { desk } from '../../lib/desk.js';
import { useOrg } from '../../lib/OrgContext.js';
import { openOverlay, useOverlayOpen } from '../../lib/overlay.js';
import { Logo } from '../brand/Logo.js';
import shell from '../shell/shell.module.css';
import styles from './dashRail.module.css';

// The apps page sidebar: the brand, the projects by kind, which AI is ready, and who is signed in.

export type ProjectFilter = 'all' | 'app' | 'website';

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}

/** Which engine the AI builder will use right now, in a few words. */
function AiStatus({ orgId }: { orgId: string }) {
  const engines = useQuery(`rail:engines:${orgId}`, () => desk.listEngines(orgId), [orgId]);
  if (engines.data === undefined) return null;
  const cli = engines.data.find((e) => e.lane === 'cli' && e.binaryVersion !== null);
  const keyed = engines.data.find((e) => e.lane === 'api' && e.kinds.some((k) => k.present));
  const ready = cli !== undefined || keyed !== undefined;
  const name = cli !== undefined ? cli.displayName : keyed !== undefined ? keyed.displayName : 'No AI connected';
  const line = cli !== undefined ? 'Uses your own sign-in' : keyed !== undefined ? 'Uses your API key' : 'Add one in Settings';
  return (
    <button type="button" className={styles.ai} onClick={() => openOverlay()} title="AI engines in Settings">
      <span className={ready ? `${styles.aiDot} ${styles.aiDotOn}` : styles.aiDot} />
      <span className={styles.aiText}>
        <span className={styles.aiName}>{name}</span>
        <span className={styles.aiLine}>{line}</span>
      </span>
    </button>
  );
}

export function DashboardRail({ filter, onFilter }: { filter: ProjectFilter; onFilter: (f: ProjectFilter) => void }) {
  const { orgId, role, displayName, email } = useOrg();
  const settingsOpen = useOverlayOpen();
  const projects = useQuery(`dash-projects:${orgId}`, () => desk.listProjects(orgId), [orgId]);
  const rows = projects.data ?? [];
  const apps = rows.filter((p) => (p.kind ?? 'app') === 'app').length;
  const sites = rows.length - apps;

  const items: Array<{ id: ProjectFilter; label: string; icon: typeof AppWindow; count: number }> = [
    { id: 'all', label: 'All projects', icon: LayoutGrid, count: rows.length },
    { id: 'app', label: 'Apps', icon: AppWindow, count: apps },
    { id: 'website', label: 'Websites', icon: Globe, count: sites },
  ];

  return (
    <aside className={`${shell.sidebar} ${styles.rail}`}>
      <div className={styles.brand}>
        <Logo size={22} className={styles.mark} />
        <span className={styles.word}>Nodeloom</span>
      </div>

      <nav className={styles.nav} aria-label="Projects">
        <div className={styles.navTitle}>Projects</div>
        {items.map(({ id, label, icon: Icon, count }) => (
          <button
            key={id}
            type="button"
            aria-current={filter === id ? 'page' : undefined}
            className={filter === id ? `${styles.item} ${styles.itemOn}` : styles.item}
            onClick={() => onFilter(id)}
          >
            <Icon size={16} />
            <span className={styles.itemLabel}>{label}</span>
            {projects.data !== undefined ? <span className={styles.count}>{count}</span> : null}
          </button>
        ))}
      </nav>

      <div className={styles.spacer} />

      <div className={styles.section}>
        <div className={styles.navTitle}>AI builder</div>
        <AiStatus orgId={orgId} />
      </div>

      <div className={styles.account}>
        <span className={styles.avatar}>{initials(displayName)}</span>
        <span className={styles.who}>
          <span className={styles.name}>{displayName !== '' ? displayName : 'You'}</span>
          {email !== '' ? <span className={styles.email}>{email}</span> : null}
        </span>
        {can(role, 'config') ? (
          <button
            type="button"
            className={settingsOpen ? `${styles.gear} ${styles.gearOn}` : styles.gear}
            aria-label="Settings"
            title="Settings"
            onClick={() => openOverlay()}
          >
            <Settings size={16} />
          </button>
        ) : null}
      </div>
    </aside>
  );
}
