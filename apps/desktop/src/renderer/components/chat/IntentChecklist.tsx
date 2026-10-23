import { useState } from 'react';
import type { ThreadIntent } from '../../../shared/ipc.js';
import { checklistLines, parkedBanner, spendLabel } from '../../lib/feed/intentChecklist.js';
import styles from './chat.module.css';

interface IntentChecklistProps {
  intent: ThreadIntent | null;
}

/** Living mission checklist; renders only while a 2+ part mission is open or parked. */
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
        onClick={() => setCollapsedChoice(!collapsed)}
        title={collapsed ? 'Show the mission steps' : 'Collapse to one line'}
        style={{ cursor: 'pointer' }}
      >
        <span>mission</span>
        <span className={styles.intentMeta}>{done} of {lines.length}</span>
        {spend !== null ? <span className={styles.intentMeta}>{spend}</span> : null}
        <span className={styles.intentMeta}>{collapsed ? '▸' : '▾'}</span>
        <button
          type="button"
          className={styles.intentHide}
          title="Hide this card until the thread reopens"
          onClick={(e) => { e.stopPropagation(); setHiddenByUser(true); }}
        >×</button>
      </div>
      {!collapsed && lines.map((l, i) => (
        <div key={i} className={styles.intentPart}>
          <span
            className={[
              styles.intentGlyph,
              l.status === 'in_flight' ? styles.intentGlyphLive : '',
              l.status === 'blocked' ? styles.intentGlyphBlocked : '',
              l.status === 'done' ? styles.intentGlyphDone : '',
            ].filter(Boolean).join(' ')}
          >{l.glyph}</span>
          <span className={l.status === 'dropped' ? styles.intentDropped : styles.intentPartText}>{l.text}</span>
          {l.note !== null ? <span className={styles.intentNote}>— {l.note}</span> : null}
        </div>
      ))}
      {banner !== null ? <div className={styles.intentParked}>⏸ {banner}</div> : null}
    </div>
  );
}
