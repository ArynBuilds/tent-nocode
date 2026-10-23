import { useState } from 'react';
import { SettingsModal } from '../settings/SettingsModal.js';
import { PublishTakeover } from '../project/PublishTakeover.js';
import { Titlebar } from '../shell/Titlebar.js';
import { CreateSurface } from './CreateSurface.js';
import { DashboardRail } from './DashboardRail.js';
import { NewProjectScreen } from './NewProjectScreen.js';
import styles from '../shell/shell.module.css';

// Dashboard shell: titlebar, rail, and the projects surface.
export function DashboardShell({ onEnterEditor, onPickKind }: {
  // Opens editor takeover for the selected project.
  onEnterEditor: (projectId: string) => void;
  // Creates new project with chosen kind and name, opens editor.
  onPickKind: (kind: 'app' | 'website', name: string) => void;
}) {
  // The plus opens the birth ceremony (kind + name, one screen).
  const [asking, setAsking] = useState(false);

  return (
    <div className={`${styles.app} ${styles.dashApp}`}>
      <Titlebar />
      <DashboardRail />
      <main className={styles.main}>
        <div className={styles.dashFrame}>
          {asking
            ? <NewProjectScreen onCreate={onPickKind} />
            : <CreateSurface onEdit={onEnterEditor} onNew={() => setAsking(true)} />}
        </div>
      </main>
      <PublishTakeover />
      <SettingsModal />
    </div>
  );
}
