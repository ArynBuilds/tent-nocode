import { ArrowLeft, StickyNote, Table2 } from 'lucide-react';
import { TableGrid } from '../page-edit/TableGrid.js';
import type { GridEdit } from '../page-edit/TableGrid.js';
import { NotesDetail } from '../shell/NotesDetail.js';
import { DatasetGrain } from './DatasetGrain.js';
import panelStyles from '../shell/sidepanel.module.css';
import styles from './entered.module.css';

// Fractal descent surfaces: a table's rows or the project's notes, under a bar that leads back to the canvas.

export type EnteredSurface =
  | { kind: 'grid'; dataset: string }
  | { kind: 'notes'; projectId: string };

export function WorkspaceEntered({ title, entered, quietLine, orgId, projectId, say, onExit, onRowEdit }: {
  title: string;
  entered: EnteredSurface;
  quietLine: string | null;
  orgId: string;
  projectId: string | null;
  say: (sentence: string) => void;
  onExit: () => void;
  onRowEdit: (edit: GridEdit) => void;
}) {
  const grid = entered.kind === 'grid';
  return (
    <div className={styles.wrap}>
      <div className={styles.bar}>
        <button type="button" className={styles.back} onClick={onExit} aria-label="Back to the canvas" title="Back to the canvas">
          <ArrowLeft size={15} />
        </button>
        <span className={styles.icon}>{grid ? <Table2 size={15} /> : <StickyNote size={15} />}</span>
        <span className={styles.where}>{title}</span>
        <span className={styles.sep}>/</span>
        <span className={styles.what}>{grid ? entered.dataset : 'Notes'}</span>
        <span className={styles.spacer} />
        {grid ? <DatasetGrain orgId={orgId} projectId={projectId} dataset={entered.dataset} say={say} /> : null}
      </div>
      <div className={panelStyles.benchEntered}>
        {grid ? <TableGrid dataset={entered.dataset} onDidEdit={onRowEdit} /> : <NotesDetail projectId={entered.projectId} />}
      </div>
      {quietLine !== null ? <div className={panelStyles.benchQuiet}>{quietLine}</div> : null}
    </div>
  );
}
