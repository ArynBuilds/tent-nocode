import {
  AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical,
  AlignHorizontalDistributeCenter, AlignStartHorizontal, AlignStartVertical,
  AlignVerticalDistributeCenter,
} from 'lucide-react';
import type { AlignMode } from '../../lib/page-edit/positionGround.js';
import type { ElementRecord, Placed, Rect } from '../../lib/canvas/store.js';
import styles from './editor.module.css';

// Align/distribute strip for a multi-selection; each verb names one alignment the caller lands as a store diff.

export type AlignVerb = { kind: 'align'; mode: AlignMode } | { kind: 'distribute'; axis: 'x' | 'y' };

const ALIGNS: Array<{ mode: AlignMode; title: string; Icon: typeof AlignStartVertical }> = [
  { mode: 'left', title: 'Align left', Icon: AlignStartVertical },
  { mode: 'center', title: 'Align centers', Icon: AlignCenterVertical },
  { mode: 'right', title: 'Align right', Icon: AlignEndVertical },
  { mode: 'top', title: 'Align top', Icon: AlignStartHorizontal },
  { mode: 'middle', title: 'Align middles', Icon: AlignCenterHorizontal },
  { mode: 'bottom', title: 'Align bottom', Icon: AlignEndHorizontal },
];

export function AlignBar({ members, parentRect, at, zoom, onCommit }: {
  /** Selected members with their measured rects (world units). */
  members: Array<{ el: ElementRecord; rect: Rect }>;
  /** The parent frame's rect, the same units. */
  parentRect: Rect;
  /** Where the strip sits: the selection's top-left in screen px. */
  at: Placed;
  zoom: number;
  onCommit: (verb: AlignVerb, label: string) => void;
}) {
  const measured = members;
  if (measured.length < 2 || parentRect.w <= 0) return null;
  const left = Math.min(...measured.map((m) => m.rect.x));
  const right = Math.max(...measured.map((m) => m.rect.x + m.rect.w));

  const commit = (verb: AlignVerb, label: string): void => onCommit(verb, label);

  return (
    <div
      className={styles.alignBar}
      style={{ left: Math.round(at.x + ((right - left) / 2) * zoom), top: Math.max(4, Math.round(at.y) - 36) }}
    >
      {ALIGNS.map(({ mode, title, Icon }) => (
        <button
          key={mode} type="button" className={styles.alignBtn} title={title} aria-label={title}
          onClick={() => commit({ kind: 'align', mode }, title.toLowerCase())}
        ><Icon size={13} /></button>
      ))}
      {measured.length >= 3 ? (
        <>
          <span className={styles.alignSep} />
          <button
            type="button" className={styles.alignBtn} title="Space evenly across" aria-label="Space evenly across"
            onClick={() => commit({ kind: 'distribute', axis: 'x' }, 'space evenly across')}
          ><AlignHorizontalDistributeCenter size={13} /></button>
          <button
            type="button" className={styles.alignBtn} title="Space evenly down" aria-label="Space evenly down"
            onClick={() => commit({ kind: 'distribute', axis: 'y' }, 'space evenly down')}
          ><AlignVerticalDistributeCenter size={13} /></button>
        </>
      ) : null}
    </div>
  );
}
