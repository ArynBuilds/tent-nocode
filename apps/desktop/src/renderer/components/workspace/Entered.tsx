import { TableGrid } from '../page-edit/TableGrid.js';
import type { GridEdit } from '../page-edit/TableGrid.js';
import { NotesDetail } from '../shell/NotesDetail.js';
import canvasStyles from '../canvas/canvas.module.css';
import styles from '../shell/sidepanel.module.css';

// Fractal descent surfaces: table grid or notes; workshop owns state and doors.

export type EnteredSurface =
  | { kind: 'grid'; dataset: string }
  | { kind: 'notes'; projectId: string };

export function WorkspaceEntered({ title, entered, quietLine, onExit, onRowEdit }: {
  title: string;
  entered: EnteredSurface;
  quietLine: string | null;
  onExit: () => void;
  onRowEdit: (edit: GridEdit) => void;
}) {
  return (
    <div className={canvasStyles.wrap}>
      <button type="button" className={canvasStyles.crumb} onClick={onExit}>
        {`‹ ${title} / ${entered.kind === 'grid' ? entered.dataset : 'Notes'}`}
      </button>
      <div className={styles.benchEntered}>
        {entered.kind === 'grid' ? (
          <TableGrid dataset={entered.dataset} onDidEdit={onRowEdit} />
        ) : (
          <NotesDetail projectId={entered.projectId} />
        )}
      </div>
      {quietLine !== null ? <div className={styles.benchQuiet}>{quietLine}</div> : null}
    </div>
  );
}
