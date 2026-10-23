import { Layers, MessageSquarePlus, Network, PackageSearch, Settings, SquareCode } from 'lucide-react';
import { useQuery } from '../../lib/data/useQuery.js';
import { desk } from '../../lib/desk.js';
import { useFocusedProject } from '../../lib/FocusContext.js';
import { useOrg } from '../../lib/OrgContext.js';
import { store } from '../../lib/canvas/store.js';
import styles from './sidepanel.module.css';

// Panel launcher: picker for side chat, workspace, code, node browser, layers, project settings.

export function PanelLauncher({ onAdd }: { onAdd: (kind: 'chat' | 'workspace' | 'code' | 'nodeBrowser' | 'layers') => void }) {
  const { orgId } = useOrg();
  const { focusedProjectId } = useFocusedProject();
  const { data: projects } = useQuery(`launcher:projects:${orgId}`, () => desk.listProjects(orgId), [orgId]);
  const focusedProject = (projects ?? []).find((p) => p.id === focusedProjectId) ?? null;

  function openProjectSettings(projectId: string, name: string): void {
    store.openInspector({ citizen: true, kind: 'project', nodeId: `project:${projectId}`, label: name, projectId });
  }

  return (
    <div className={styles.launcher}>
      <button type="button" className={styles.launchItem} onClick={() => onAdd('chat')}>
        <MessageSquarePlus size={15} /> Side chat
      </button>
      <button type="button" className={styles.launchItem} onClick={() => onAdd('workspace')}>
        <Network size={15} /> Workspace
      </button>
      <button type="button" className={styles.launchItem} onClick={() => onAdd('code')}>
        <SquareCode size={15} /> Code
      </button>
      <button type="button" className={styles.launchItem} onClick={() => onAdd('nodeBrowser')}>
        <PackageSearch size={15} /> Node browser
      </button>
      <button type="button" className={styles.launchItem} onClick={() => onAdd('layers')}>
        <Layers size={15} /> Layers
      </button>
      {focusedProject !== null ? (
        <button
          type="button" className={styles.launchItem}
          onClick={() => openProjectSettings(focusedProject.id, focusedProject.name)}
        >
          <Settings size={15} /> Project settings
        </button>
      ) : null}
    </div>
  );
}
