import type { Rect } from '../../lib/canvas/store.js';
import type { PointerTarget } from '../../lib/canvas/tools/StateNode.js';
import styles from './editor.module.css';

// THE CHROME INSIDE A FOCUSED SCREEN (Phase 12, row 12.16): the selected element's outline with its four
// handles and rotate knob, the other members' outlines, the hover outline, the stack's spacing zones, the
// landing line and its parent, the snap guides, the drag ghost, and the screen's own edge grips. Every
// press names one PointerTarget for the machine; the overlay draws and never decides. World units in.

export interface OverlayTarget { scene: string; screenId: string }

const CORNERS = [
  { sx: -1, sy: -1, cursor: 'nwse-resize' }, { sx: 1, sy: -1, cursor: 'nesw-resize' },
  { sx: -1, sy: 1, cursor: 'nesw-resize' }, { sx: 1, sy: 1, cursor: 'nwse-resize' },
] as const;

const box = (r: Rect): React.CSSProperties => ({ left: r.x, top: r.y, width: r.w, height: r.h });

export function FrameOverlay({ at, selected, extras, hover, parent, spacing, landing, guides, ghost, screenRect, resizable, rotatable, textEditing, onTarget }: {
  at: OverlayTarget;
  /** The selected element and its world rect (radius as rendered). */
  selected: { id: string; rect: Rect; r?: string } | null;
  extras: Array<{ id: string; rect: Rect }>;
  hover: { id: string; rect: Rect; r?: string } | null;
  /** The selected element's parent, outlined quietly while a drag looks for a landing. */
  parent: { id: string; rect: Rect } | null;
  /** The stack's gap zone and padding edges the hand may drag. */
  spacing: Array<{ id: string; key: 'gap' | 'padding'; edge?: 'left' | 'right' | 'top' | 'bottom'; rect: Rect; axis: 'x' | 'y' }>;
  landing: { line: Rect; parent: Rect | null } | null;
  guides: { x: number | null; y: number | null };
  ghost: Rect | null;
  /** The screen's world rect: the east and south edge grips resize the design size. */
  screenRect: Rect;
  resizable: boolean;
  rotatable: boolean;
  textEditing: boolean;
  onTarget: (target: PointerTarget, e: React.PointerEvent) => void;
}) {
  const press = (target: PointerTarget) => (e: React.PointerEvent): void => { e.preventDefault(); e.stopPropagation(); onTarget(target, e); };
  return (
    <div className={styles.frameEditLayer}>
      {hover !== null && hover.id !== selected?.id ? <span className={styles.outlineHover} style={{ ...box(hover.rect), borderRadius: hover.r }} /> : null}
      {parent !== null && (landing !== null || extras.length > 0) ? <span className={styles.landingParent} style={box(parent.rect)} /> : null}
      {extras.map((x) => <span key={x.id} className={styles.outlineExtra} style={box(x.rect)} />)}
      {selected !== null && !textEditing ? (
        <span className={styles.outline} style={{ ...box(selected.rect), borderRadius: selected.r }} onPointerDown={press({ kind: 'outline', ...at, id: selected.id })}>
          {resizable ? CORNERS.map((c) => (
            <span
              key={`${c.sx}${c.sy}`} className={styles.handle}
              style={{ left: c.sx === -1 ? 0 : '100%', top: c.sy === -1 ? 0 : '100%', cursor: c.cursor }}
              onPointerDown={press({ kind: 'handle', ...at, id: selected.id, sx: c.sx, sy: c.sy, cursor: c.cursor })}
            />
          )) : null}
          {rotatable ? (
            <span className={styles.rotate} style={{ left: '50%', top: 'calc(-14px / var(--cz, 1))' }} onPointerDown={press({ kind: 'rotate', ...at, id: selected.id })} />
          ) : null}
        </span>
      ) : null}
      {spacing.map((s) => (
        <span
          key={`${s.id}:${s.key}:${s.edge ?? ''}`} className={`${styles.spacing} ${s.axis === 'y' ? styles.spacingY : ''}`} style={box(s.rect)}
          onPointerDown={press({ kind: 'spacing', ...at, id: s.id, key: s.key, ...(s.edge !== undefined ? { edge: s.edge } : {}) })}
        />
      ))}
      {landing !== null ? (
        <>
          {landing.parent !== null ? <span className={styles.landingParent} style={box(landing.parent)} /> : null}
          <span className={styles.landing} style={box(landing.line)} />
        </>
      ) : null}
      {guides.x !== null ? <span className={styles.guideV} style={{ left: guides.x }} /> : null}
      {guides.y !== null ? <span className={styles.guideH} style={{ top: guides.y }} /> : null}
      {ghost !== null ? <span className={styles.ghostRect} style={box(ghost)} /> : null}
      <span className={styles.edgeGripE} style={{ top: screenRect.y, height: screenRect.h, left: screenRect.x + screenRect.w }} onPointerDown={press({ kind: 'screen-edge', screenId: at.screenId, edge: 'e' })} />
      <span className={styles.edgeGripS} style={{ left: screenRect.x, width: screenRect.w, top: screenRect.y + screenRect.h }} onPointerDown={press({ kind: 'screen-edge', screenId: at.screenId, edge: 's' })} />
    </div>
  );
}
