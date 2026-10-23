import type { Rect } from '../../lib/canvas/store.js';
import styles from './selection.module.css';

// THE ONE SELECTION CHROME (Phase 12, row 12.16): the outline, the four corners, the size badge - the same
// marks on a card, a screen frame, and an element inside one; the guides, the hover and the ghost beside it.
// Constant screen size through --sk (the caller's zoom divisor); the interaction hue alone.

export type SelRect = Rect;

const CORNERS = [
  { key: 'nw', sx: -1, sy: -1, cursor: 'nwse-resize' },
  { key: 'ne', sx: 1, sy: -1, cursor: 'nesw-resize' },
  { key: 'sw', sx: -1, sy: 1, cursor: 'nesw-resize' },
  { key: 'se', sx: 1, sy: 1, cursor: 'nwse-resize' },
] as const;

const box = (rect: Rect, radius?: string): React.CSSProperties =>
  ({ left: rect.x, top: rect.y, width: rect.w, height: rect.h, ...(radius !== undefined ? { borderRadius: radius } : {}) });

/** A second selected member's outline (no corners, no badge). */
export function ExtraChrome({ rect, radius }: { rect: Rect; radius?: string }) {
  return <span className={styles.extra} style={box(rect, radius)} />;
}

/** The dashed ghost a drag leaves at the origin. */
export function GhostChrome({ rect }: { rect: Rect }) {
  return <span className={styles.ghost} style={box(rect)} />;
}

/** The snap guides: a vertical and a horizontal hairline where an edge or center took the snap. */
export function GuideChrome({ x = null, y = null }: { x?: number | null; y?: number | null }) {
  return (
    <>
      {x !== null ? <span className={styles.guideV} style={{ left: x }} /> : null}
      {y !== null ? <span className={styles.guideH} style={{ top: y }} /> : null}
    </>
  );
}

/** The quiet outline under the cursor. */
export function HoverChrome({ rect, radius, k }: { rect: Rect; radius?: string; k?: number }) {
  return <span className={styles.hover} style={{ ...box(rect, radius), ...(k !== undefined ? { '--sk': k } : {}) } as React.CSSProperties} />;
}

export function SelectionChrome({ rect, radius, k, resizable = false, badge = null, onOutlineDown, onCornerDown, children }: {
  rect: Rect;
  /** The element's rendered border-radius: the outline hugs the true shape. */
  radius?: string;
  /** The constant-px divisor (--sk); omit to inherit the caller's stamp. */
  k?: number;
  resizable?: boolean;
  /** The size badge under the selection; null = none. */
  badge?: string | null;
  onOutlineDown?: (e: React.PointerEvent<HTMLSpanElement>) => void;
  onCornerDown?: (corner: { sx: -1 | 1; sy: -1 | 1 }, cursor: string, e: React.PointerEvent<HTMLSpanElement>) => void;
  /** Extra chrome the caller mounts inside the outline (the rotate knob, the spacing zones). */
  children?: React.ReactNode;
}) {
  const sk = (k !== undefined ? { '--sk': k } : {}) as React.CSSProperties;
  return (
    <>
      <span
        className={styles.outline}
        style={{ ...box(rect, radius), ...(onOutlineDown === undefined ? { pointerEvents: 'none' as const } : {}), ...sk }}
        onPointerDown={onOutlineDown}
      >
        {resizable ? CORNERS.map((c) => (
          <span
            key={c.key} className={styles.corner}
            style={{ left: c.sx === -1 ? 0 : '100%', top: c.sy === -1 ? 0 : '100%', cursor: c.cursor }}
            onPointerDown={(e) => onCornerDown?.({ sx: c.sx, sy: c.sy }, c.cursor, e)}
          />
        )) : null}
        {children}
      </span>
      {badge !== null ? <span className={styles.badge} style={{ left: rect.x + rect.w / 2, top: rect.y + rect.h, ...sk }}>{badge}</span> : null}
    </>
  );
}
