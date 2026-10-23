import { CodeScreen } from '../code/CodeScreen.js';
import { InspectorPane } from './InspectorPane.js';
import { LayersPane } from './LayersPane.js';
import { NodeBrowser } from './NodeBrowser.js';
import { WorkspacePane } from '../workspace/WorkspacePane.js';
import { BrowserPane, FilePane, SideChat } from './panelPanes.js';
import type { PanelTab } from './panelPanes.js';
import styles from './sidepanel.module.css';

/**
 * THE RE-HOUSING R0 (§3.1): THE ONE PANE-KIND SWITCH — both panels (side + bottom)
 * render every tab body through this single component; the twin inline switches are
 * dead. A new registered tab type gets its case HERE, never per-panel code (the slot
 * machinery of the shell law: panels are slots, content is tabs).
 *
 * 'browser' renders here but no surface OFFERS it (ruling 8b step 1: entries hidden
 * everywhere — launcher, + menu, Stage grounds; the lease auto-open in App.tsx is the
 * one opener left, D-131: a lease can never drive an invisible surface).
 * 'nodeBrowser' is REGISTERED now; its content (§1.6) lands in R2.
 */
export function PaneBody({ tab, onThread }: {
  tab: PanelTab;
  /** chat tabs: the first message creates the thread — the panel records it. */
  onThread: (threadId: string) => void;
}) {
  switch (tab.kind) {
    case 'chat':
      return <SideChat tab={tab} onThread={onThread} />;
    case 'file':
      return <FilePane path={tab.path ?? ''} />;
    case 'inspector':
      return tab.selection
        ? <InspectorPane selection={tab.selection} />
        : <div className={styles.fileEmpty}>alt-click a scene node to inspect it</div>;
    case 'workspace':
      return <WorkspacePane />;
    case 'code':
      return <CodeScreen projectId={tab.projectId} />;
    case 'nodeBrowser':
      // R2 (§1.6) → B5 ㉘: opened FOR you by a wire question = contract-filtered
      // (tab.browse carries the question); opened BY you (strip/launcher — no
      // question) = THE CATALOG, complete. The old waiting state died with ㉘.
      return <NodeBrowser context={tab.browse ?? { mode: 'catalog', projectId: null }} />;
    // ㊿ (user-ruled 2026-08-05): the editing page's hierarchy — the layers tree.
    case 'layers':
      return <LayersPane />;
    case 'browser':
      return <BrowserPane />;
  }
}
