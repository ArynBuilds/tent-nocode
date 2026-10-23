import { ChartColumn, Mail, PanelsTopLeft, Table2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Logo } from '../brand/Logo.js';
import styles from './chatWelcome.module.css';

// A new chat: the soft mark, one line, and starting points that fill the composer (never send).

const STARTS: { icon: LucideIcon; title: string; text: string }[] = [
  { icon: Table2, title: 'A table', text: 'Add a table for customers with name, email and plan' },
  { icon: PanelsTopLeft, title: 'A screen', text: 'Make a sign-up page that saves each entry to a table' },
  { icon: Mail, title: 'An automation', text: 'Email me whenever a new row is added' },
  { icon: ChartColumn, title: 'A dashboard', text: 'Build a dashboard that charts sign-ups by week' },
];

export function ChatWelcome({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className={styles.welcome}>
      <Logo size={36} className={styles.mark} />
      <div className={styles.title}>What should we build?</div>
      <div className={styles.line}>The AI builds on your canvas and asks before anything leaves your project.</div>
      <div className={styles.starts}>
        {STARTS.map((s, i) => (
          <button
            key={s.title}
            type="button"
            className={styles.start}
            style={{ animationDelay: `${120 + i * 50}ms` }}
            onClick={() => onPick(s.text)}
          >
            <span className={styles.startIcon}><s.icon size={15} /></span>
            <span className={styles.startText}>
              <span className={styles.startTitle}>{s.title}</span>
              <span className={styles.startLine}>{s.text}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
