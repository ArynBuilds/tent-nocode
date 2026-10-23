import { useState } from 'react';
import { ChevronDown, X } from 'lucide-react';
import type { ThreadIntent } from '../../../shared/ipc.js';
import { checklistLines, parkedBanner, spendLabel } from '../../lib/feed/intentChecklist.js';
import styles from './chat.module.css';

interface IntentChecklistProps {
  intent: ThreadIntent | null;
}

/** The living plan: shows only while a plan of 2+ parts is open or paused. */
export function IntentChecklist({ intent }: IntentChecklistProps) {
  const [collapsedChoice, setCollapsedChoice] = useState<boolean | null>(null);
  const [hiddenByUser, setHiddenByUser] = useState(false);
  if (intent === null || intent.parts.length < 2) return null;
  if (intent.status !== 'open' && intent.status !== 'parked') return null;
  if (hiddenByUser) return null;
  const lines = checklistLines(intent.parts);
  const spend = spendLabel(intent);
  const banner = parkedBanner(intent);
  const done = lines.filter((l) => l.status === 'done').length;
  const collapsed = collapsedChoice ?? intent.parts.length > 4;

  return (
    <div className={styles.intentBlock}>
      <div
        className={styles.intentHead}
        role="button"
        tabIndex={0}
        onClick={() => setCollapsedChoice(!collapsed)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCollapsedChoice(!collapsed); } }}
        title={collapsed ? 'Show every step' : 'Fold the steps'}
      >
        <span className={styles.intentTitle}>Plan</span>
        <span className={styles.intentMeta}>{done} of {lines.length}</span>
        <span className={styles.intentBar} aria-hidden="true">
          <span className={styles.intentFill} style={{ width: `${(done / lines.length) * 100}%` }} />
        </span>
        {spend !== null ? <span className={styles.intentMeta}>{spend}</span> : null}
        <ChevronDown size={14} className={collapsed ? styles.intentCaret : `${styles.intentCaret} ${styles.intentCaretOpen}`} />
        <button
          type="button"
          className={styles.intentHide}
          aria-label="Hide the plan"
          title="Hide the plan until this chat reopens"
          onClick={(e) => { e.stopPropagation(); setHiddenByUser(true); }}
        >
          <X size={12} />
        </button>
      </div>
      {!collapsed ? (
        <div className={styles.intentParts}>
          {lines.map((l, i) => (
            <div key={i} className={styles.intentPart} data-status={l.status}>
              <span className={styles.intentGlyph} aria-hidden="true" />
              <span className={l.status === 'dropped' ? styles.intentDropped : styles.intentPartText}>{l.text}</span>
              {l.note !== null ? <span className={styles.intentNote}>{l.note}</span> : null}
            </div>
          ))}
        </div>
      ) : null}
      {banner !== null ? <div className={styles.intentParked}>{banner}</div> : null}
    </div>
  );
}
