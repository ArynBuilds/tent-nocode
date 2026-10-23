import { useState } from 'react';
import styles from './canvas.module.css';

/** Corner legend: what each gesture does and its keys, top-right of the canvas; it rests folded as a ? chip. */

export function CornerLegend({ items, storageKey }: {
  items: Array<{ does: string; keys: string }>;
  storageKey: string;
}) {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(storageKey) !== '0'; } catch { return true; } // view-state only; folded until opened
  });
  const set = (v: boolean): void => {
    setCollapsed(v);
    try { localStorage.setItem(storageKey, v ? '1' : '0'); } catch { /* view-state only */ }
  };
  if (collapsed) {
    return (
      <button type="button" className={styles.legendChip} aria-label="Show the shortcuts" title="Shortcuts" onClick={() => set(false)}>
        ?
      </button>
    );
  }
  return (
    <div className={styles.legend} role="note" aria-label="Shortcuts">
      <div className={styles.legendHead}>
        <span>Shortcuts</span>
        <button type="button" className={styles.legendHide} aria-label="Hide the shortcuts" onClick={() => set(true)}>×</button>
      </div>
      {items.map((i) => (
        <div key={i.does} className={styles.legendLine}>
          <span>{i.does}</span>
          <kbd className={styles.legendKeys}>{i.keys}</kbd>
        </div>
      ))}
    </div>
  );
}
