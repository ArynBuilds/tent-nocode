import type { ReactNode } from 'react';
import { ArrowRight } from 'lucide-react';
import { CopyValue, Group, SectionHead, kit } from './kit.js';
import type { ProjectNavItem } from './projectNav.js';
import styles from './project.module.css';

// Own server: the steps from an exported file to a running server, each command copyable.

function Step({ n, title, children }: { n: number; title: string; children?: ReactNode }) {
  return (
    <li className={styles.step}>
      <span className={styles.stepNum} aria-hidden="true">{n}</span>
      <div className={styles.stepBody}>
        <div className={styles.stepTitle}>{title}</div>
        {children}
      </div>
    </li>
  );
}

export function ServerSection({ item, onGoExport }: { item: ProjectNavItem; onGoExport: () => void }) {
  return (
    <>
      <SectionHead title={item.label} description={item.description} />
      <Group>
        <ol className={styles.steps}>
          <Step n={1} title="Export the project as a .tproject file.">
            <button type="button" className={`${kit.btn} ${kit.btnQuiet} ${styles.stepAction}`} onClick={onGoExport}>
              <span>Go to Export</span>
              <ArrowRight size={14} />
            </button>
          </Step>
          <Step n={2} title="Copy the file to your server and name it app.tproject." />
          <Step n={3} title="Get Tent NoCode on the server.">
            <p className={styles.stepNote}>
              With Node 20 or newer, clone the Tent NoCode repository, then run these two commands inside it:
            </p>
            <CopyValue value="npm install" />
            <CopyValue value="npm run build:tentkit" />
          </Step>
          <Step n={4} title="Point it at your database.">
            <p className={styles.stepNote}>Set DATABASE_URL to the connection address of your Postgres.</p>
          </Step>
          <Step n={5} title="Install the file.">
            <CopyValue value="npm run server -- install app.tproject" />
          </Step>
          <Step n={6} title="Start the server.">
            <CopyValue value="npm run server -- serve" />
            <p className={styles.stepNote}>It answers on port 4680. Set PORT to use a different one.</p>
          </Step>
        </ol>
      </Group>
    </>
  );
}
