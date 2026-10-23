import { CalendarClock, Monitor, Table2 } from 'lucide-react';
import type { CSSProperties } from 'react';
import { Ambient } from '../brand/Ambient.js';
import { Logo } from '../brand/Logo.js';
import styles from './showcase.module.css';

// The onboarding's picture of the product: three nodes on a small canvas, wired, with data moving along the wires.
// Pure decoration - hidden from assistive technology; the words beside it say the same thing.

const WIRES = [
  'M 158 86 C 214 86, 214 70, 270 70',
  'M 118 252 C 118 196, 80 168, 80 110',
  'M 210 290 C 320 290, 355 230, 355 152',
];

function Node({ x, y, w, icon: Icon, title, line, delay, children }: {
  x: number; y: number; w: number;
  icon: typeof Table2; title: string; line: string; delay: number;
  children?: React.ReactNode;
}) {
  return (
    <div className={styles.node} style={{ left: x, top: y, width: w, '--d': `${delay}ms` } as CSSProperties}>
      <div className={styles.nodeFloat} style={{ '--f': `${delay * 3}ms` } as CSSProperties}>
        <div className={styles.nodeHead}>
          <span className={styles.nodeIcon}><Icon size={14} /></span>
          <span className={styles.nodeTitle}>{title}</span>
        </div>
        <div className={styles.nodeLine}>{line}</div>
        {children}
      </div>
    </div>
  );
}

export function Showcase() {
  return (
    <div className={styles.side} aria-hidden="true">
      <Ambient />
      <div className={styles.brand}>
        <Logo size={26} className={styles.brandMark} />
        <span className={styles.brandName}>Tent NoCode</span>
      </div>
      <div className={styles.stage}>
        <svg className={styles.wires} width="440" height="340" viewBox="0 0 440 340">
          {WIRES.map((d, i) => (
            <path key={d} d={d} pathLength={1} className={styles.wire} style={{ '--d': `${700 + i * 220}ms` } as CSSProperties} />
          ))}
        </svg>
        {WIRES.map((d, i) => (
          <span key={d} className={styles.pulse} style={{ offsetPath: `path('${d}')`, '--d': `${1500 + i * 700}ms` } as CSSProperties} />
        ))}
        <Node x={0} y={38} w={158} icon={Table2} title="Habits" line="Table · 12 rows" delay={120} />
        <Node x={270} y={0} w={170} icon={Monitor} title="Today" line="Screen" delay={260}>
          <div className={styles.mini}>
            {['Read 20 pages', 'Walk outside', 'No sugar'].map((t, i) => (
              <div key={t} className={styles.miniRow}>
                <span className={i < 2 ? `${styles.miniBox} ${styles.miniBoxOn}` : styles.miniBox} />
                <span>{t}</span>
              </div>
            ))}
          </div>
        </Node>
        <Node x={40} y={252} w={170} icon={CalendarClock} title="Every morning" line="Flow · 7:00" delay={400} />
      </div>
      <div className={styles.caption}>
        <div className={styles.captionTitle}>Tables, screens and flows on one canvas.</div>
        <div className={styles.captionLine}>Ask the AI to build it, or place each piece yourself.</div>
      </div>
    </div>
  );
}
