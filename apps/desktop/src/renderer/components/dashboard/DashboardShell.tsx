import { useState } from 'react';
import { SettingsScreen } from '../settings/SettingsScreen.js';
import { PublishTakeover } from '../project/PublishTakeover.js';
import { Titlebar } from '../shell/Titlebar.js';
import { CreateSurface } from './CreateSurface.js';
import { DashboardRail, type ProjectFilter } from './DashboardRail.js';
import { NewProjectScreen } from './NewProjectScreen.js';
import styles from '../shell/shell.module.css';

// Dashboard shell: titlebar, rail, and the projects surface.
export function DashboardShell({ onEnterEditor, onPickKind }: {
  // Opens editor takeover for the selected project.
  onEnterEditor: (projectId: string) => void;
  // Creates new project with chosen kind and name, opens editor.
  onPickKind: (kind: 'app' | 'website', name: string) => void;
}) {
  // The plus opens the new-project screen (name + kind, one screen).
  const [asking, setAsking] = useState(false);
  const [filter, setFilter] = useState<ProjectFilter>('all');

  return (
    <div className={`${styles.app} ${styles.dashApp}`}>
      <Titlebar />
      <DashboardRail filter={filter} onFilter={setFilter} />
      <main className={styles.main}>
        <div className={styles.dashFrame}>
          <CreateSurface filter={filter} onEdit={onEnterEditor} onNew={() => setAsking(true)} />
        </div>
      </main>
      {asking ? <NewProjectScreen onCreate={onPickKind} onCancel={() => setAsking(false)} /> : null}
      <PublishTakeover />
      <SettingsScreen />
    </div>
  );
}
