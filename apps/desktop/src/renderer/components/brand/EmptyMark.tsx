import { Logo } from './Logo.js';
import styles from './emptyMark.module.css';

// An empty place: the soft mark, and at most one short line saying what fills it.

export function EmptyMark({ line, compact = false }: { line?: string; compact?: boolean }) {
  return (
    <div className={compact ? `${styles.empty} ${styles.compact}` : styles.empty}>
      <Logo size={compact ? 30 : 44} className={styles.mark} />
      {line !== undefined ? <div className={styles.line}>{line}</div> : null}
    </div>
  );
}
