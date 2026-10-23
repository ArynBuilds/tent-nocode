import { Layers, Network, PackageSearch, Settings, SquareCode } from 'lucide-react';
import { useQuery } from '../../lib/data/useQuery.js';
import { desk } from '../../lib/desk.js';
import { useFocusedProject } from '../../lib/FocusContext.js';
import { useOrg } from '../../lib/OrgContext.js';
import { openPublishTakeover } from '../../lib/publishTakeover.js';
import { Logo } from '../brand/Logo.js';
import styles from './sidepanel.module.css';

// Panel launcher: picker for workspace, code, node browser, layers, project settings.

export function PanelLauncher({ onAdd }: { onAdd: (kind: 'workspace' | 'code' | 'nodeBrowser' | 'layers') => void }) {
  const { orgId } = useOrg();
  const { focusedProjectId } = useFocusedProject();
  const { data: projects } = useQuery(`launcher:projects:${orgId}`, () => desk.listProjects(orgId), [orgId]);
  const focusedProject = (projects ?? []).find((p) => p.id === focusedProjectId) ?? null;


  const items: Array<{ id: 'workspace' | 'code' | 'nodeBrowser' | 'layers'; label: string; line: string; icon: typeof Network }> = [
    { id: 'layers', label: 'Layers', line: 'Everything on the selected screen', icon: Layers },
    { id: 'nodeBrowser', label: 'Node browser', line: 'Everything you can place', icon: PackageSearch },
    { id: 'code', label: 'Code', line: 'Your tools and files', icon: SquareCode },
    { id: 'workspace', label: 'Workspace', line: 'A second view of the canvas', icon: Network },
  ];
  return (
    <div className={styles.launcher}>
      <Logo size={30} className={styles.launchMark} />
      <div className={styles.launchTitle}>Open a panel</div>
      <div className={styles.launchList}>
        {items.map(({ id, label, line, icon: Icon }) => (
          <button key={id} type="button" className={styles.launchItem} onClick={() => onAdd(id)}>
            <span className={styles.launchIcon}><Icon size={15} /></span>
            <span className={styles.launchText}>
              <span className={styles.launchLabel}>{label}</span>
              <span className={styles.launchLine}>{line}</span>
            </span>
          </button>
        ))}
        {focusedProject !== null ? (
          <button
            type="button" className={styles.launchItem}
            onClick={() => openPublishTakeover({ projectId: focusedProject.id, section: 'general' })}
          >
            <span className={styles.launchIcon}><Settings size={15} /></span>
            <span className={styles.launchText}>
              <span className={styles.launchLabel}>Project settings</span>
              <span className={styles.launchLine}>Publish, export and secrets</span>
            </span>
          </button>
        ) : null}
      </div>
    </div>
  );
}
