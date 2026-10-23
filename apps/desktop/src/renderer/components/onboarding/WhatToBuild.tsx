import { AppWindow, Globe } from 'lucide-react';
import styles from './whatToBuild.module.css';

// The "What do you want to build?" picker: two cards, App or Website; no shell coupling.
export function WhatToBuild({ framed = false, onPick }: {
  /** True = the quiet framed variant; false = the page. */
  framed?: boolean;
  onPick: (kind: 'app' | 'website') => void;
}) {
  return (
    <div className={framed ? `${styles.wrap} ${styles.wrapFramed}` : styles.wrap}>
      <div className={styles.question}>What do you want to build?</div>
      <div className={styles.cards}>
        <button type="button" className={styles.card} onClick={() => onPick('app')}>
          <AppWindow size={22} strokeWidth={1.5} />
          <span className={styles.cardName}>App</span>
          <span className={styles.cardLine}>a focused tool — dashboards, trackers, cockpits</span>
        </button>
        <button type="button" className={styles.card} onClick={() => onPick('website')}>
          <Globe size={22} strokeWidth={1.5} />
          <span className={styles.cardName}>Website</span>
          <span className={styles.cardLine}>pages with navigation that hold your apps</span>
        </button>
      </div>
    </div>
  );
}
