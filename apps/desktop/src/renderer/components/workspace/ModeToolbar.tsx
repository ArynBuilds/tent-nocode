import { Hand, MousePointer2, SquarePlus } from 'lucide-react';
import type { CanvasMode, CreateArm, Placed } from '../../lib/canvas/store.js';
import type { MenuGroups } from '../../lib/canvas/store.js';
import { ContextMenu } from '../canvas/ContextMenu.js';
import styles from '../canvas/canvas.module.css';

// Vertical mode toolbar: SELECT (V), CREATE (C), HAND (H); Space-hold toggles hand mode.
// Arming create does NOTHING visible - the pick appears at the release of an unarmed draw
// (the ask menu, beside the cursor) and the chosen kind lands at the drawn rect.

export function ModeToolbar({ pickRows, mode, onMode, armed, ask, onAskPick, onAskClose }: {
  /** The one create-pick vocabulary (Screen, the five primitives), built by the mount. */
  pickRows: (act: (arm: CreateArm) => void) => MenuGroups;
  mode: CanvasMode;
  onMode: (m: CanvasMode) => void;
  /** An armed kind (the node browser's lane) lands without asking; shown on the button title. */
  armed: CreateArm | null;
  // Unarmed create drag triggers pick at release, opening at the drawn rect.
  ask: { client: Placed } | null;
  onAskPick: (arm: CreateArm) => void;
  onAskClose: () => void;
}) {
  const btn = (m: CanvasMode, label: string, icon: React.ReactNode): React.ReactNode => (
    <button
      type="button"
      className={mode === m ? `${styles.modeBtn} ${styles.modeBtnOn}` : styles.modeBtn}
      title={label}
      aria-label={label}
      // The light-dismiss closer must not eat the click (the engine's right-click guard, same law).
      onClick={(e) => { e.stopPropagation(); onMode(m); }}
    >{icon}</button>
  );

  return (
    <>
      <div className={styles.modeStrip}>
        {btn('select', 'Select (V)', <MousePointer2 size={15} />)}
        {btn('create', `Create (C)${armed !== null ? ` — ${armed.label}` : ''}`, <SquarePlus size={15} />)}
        {btn('hand', 'Hand (H · hold Space)', <Hand size={15} />)}
      </div>
      {ask !== null ? (
        <ContextMenu
          at={{ x: ask.client.x, y: ask.client.y }}
          groups={pickRows(onAskPick)}
          search="always"
          placeholder="What are you drawing?"
          onClose={onAskClose}
        />
      ) : null}
    </>
  );
}
