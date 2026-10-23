import { useState } from 'react';
import styles from './canvas.module.css';

/** Corner legend: collapsible gesture hints at bottom-right of the canvas. */

export function CornerLegend({ lines, storageKey }: {
  lines: string[];
  storageKey: string;
}) {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(storageKey) === '1'; } catch { return false; } // view-state only
  });
  const set = (v: boolean): void => {
    setCollapsed(v);
    try { localStorage.setItem(storageKey, v ? '1' : '0'); } catch { /* view-state only */ }
  };
  if (collapsed) {
    return (
      <button type="button" className={styles.legendChip} aria-label="Show the gesture legend" onClick={() => set(false)}>
        ?
      </button>
    );
  }
  return (
    <div className={styles.legend}>
      {lines.map((l) => <div key={l} className={styles.legendLine}>{l}</div>)}
      <button type="button" className={styles.legendHide} aria-label="Hide the gesture legend" onClick={() => set(true)}>
        ×
      </button>
    </div>
  );
}
