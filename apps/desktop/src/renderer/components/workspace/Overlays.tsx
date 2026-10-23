import type { ComponentProps } from 'react';
import { ExpressionPicker } from '../page-edit/ExpressionPicker.js';
import type { PickerPayload } from '../page-edit/ExpressionPicker.js';
import type { LanePicker } from '../../lib/canvas/tools/select/DrawingWire.js';
import type { DeleteConfirm } from '../../lib/canvas/tools/select/Idle.js';
import { WorkspaceContextMenu } from './ContextMenu.js';
import type { WorkspaceMenuState } from './ContextMenu.js';
import styles from '../shell/sidepanel.module.css';

// Floating chrome: table delete confirm, context menus, wire picker; the workspace owns all state.

export function WorkspaceOverlays({
  confirmDelete, onConfirmDelete, onDismissConfirm,
  menu, menuDeps, onMenuClose,
  picker, onPicked, onPickerClose,
}: {
  confirmDelete: DeleteConfirm | null;
  onConfirmDelete: (name: string) => void;
  onDismissConfirm: () => void;
  menu: WorkspaceMenuState | null;
  menuDeps: ComponentProps<typeof WorkspaceContextMenu>['deps'];
  onMenuClose: () => void;
  picker: LanePicker | null;
  onPicked: (p: PickerPayload) => void;
  onPickerClose: () => void;
}) {
  return (
    <>
      {/* Table delete confirm: small anchored popover, never modal. */}
      {confirmDelete !== null ? (
        <div className={styles.benchConfirm}>
          <span>This deletes {confirmDelete.name} and its {confirmDelete.rows} rows.</span>
          <button
            type="button" className={styles.benchConfirmDelete}
            onClick={() => onConfirmDelete(confirmDelete.name)}
          >
            Delete
          </button>
          <button type="button" className={styles.benchConfirmDismiss} onClick={onDismissConfirm}>
            Cancel
          </button>
        </div>
      ) : null}
      {/* Right-click menu: create palette on empty canvas, verb menu on nodes. */}
      {menu !== null ? <WorkspaceContextMenu menu={menu} onClose={onMenuClose} deps={menuDeps} /> : null}
      {picker !== null ? <ExpressionPicker request={picker} onPick={onPicked} onClose={onPickerClose} /> : null}
    </>
  );
}
