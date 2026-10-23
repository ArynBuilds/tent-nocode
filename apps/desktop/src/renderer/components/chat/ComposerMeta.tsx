import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import type { OrgRole, ThreadMode } from '@tent-nocode/core';
import type { ThreadUsage } from '../../../shared/ipc.js';
import { can } from '../../../shared/roles.js';
import { desk } from '../../lib/desk.js';
import { formatTokens } from '../../lib/feed/feed.js';
import styles from './chat.module.css';

/** Chrome lives in the composer: the mode control in the capsule, the meta row below carries the spend. */

interface ModeControlProps {
  orgId: string;
  threadId: string;
  role: OrgRole;
  mode: ThreadMode | null;
  orgDefault: ThreadMode;
  configLoaded: boolean;
}

// Each mode includes the one above it.
const MODES: { id: ThreadMode; name: string; line: string }[] = [
  { id: 'ask', name: 'Ask', line: 'Asks you before each change' },
  { id: 'auto', name: 'Auto', line: 'Goes ahead and notes what it approved' },
  { id: 'agent', name: 'Agent', line: 'Like Auto, and splits big work into parts' },
];

/** The mode chip and its menu: Ask, Auto or Agent. */
export function ModeControl({ orgId, threadId, role, mode, orgDefault, configLoaded }: ModeControlProps) {
  const [modePending, setModePending] = useState(false);
  const [modeError, setModeError] = useState<string | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement | null>(null);

  // Click outside or Esc closes the menu.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent): void {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); }
    }
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey, true); };
  }, [open]);

  async function changeMode(next: ThreadMode): Promise<void> {
    setOpen(false);
    setModePending(true);
    setModeError(undefined);
    const result = await desk.setThreadMode(orgId, threadId, next);
    setModePending(false);
    if (!result.ok) setModeError(result.error);
  }

  const current = mode ?? orgDefault;
  const name = MODES.find((m) => m.id === current)?.name ?? current;
  if (!can(role, 'approve_plan')) return <span className={styles.modeQuiet}>{name}</span>;
  return (
    <span className={styles.modeWrap} ref={wrapRef} onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className={open ? `${styles.modeBtn} ${styles.modeBtnOpen}` : styles.modeBtn}
        disabled={modePending || !configLoaded}
        title={modeError ?? 'How much the AI may do on its own'}
        onClick={() => setOpen((v) => !v)}
      >
        {name}
        <ChevronDown size={13} className={styles.modeCaret} />
      </button>
      {open ? (
        <span className={styles.modeMenu} role="menu">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="menuitemradio"
              aria-checked={m.id === current}
              className={styles.modeItem}
              onClick={() => void changeMode(m.id)}
            >
              <span className={styles.modeText}>
                <span className={styles.modeName}>{m.name}</span>
                <span className={styles.modeLine}>{m.line}</span>
              </span>
              {m.id === current ? <Check size={14} className={styles.modeCheck} /> : null}
            </button>
          ))}
        </span>
      ) : null}
    </span>
  );
}

interface ComposerMetaProps {
  orgId: string;
  threadId: string;
  usage: ThreadUsage | null;
  activeRunIds: string[];
  role: OrgRole;
}

/** The quiet line under the composer: tokens spent in this chat, and the cap while work runs. */
export function ComposerMeta({ usage, activeRunIds }: ComposerMetaProps) {
  const total = usage?.totalTokens ?? 0;
  let capLine: string | null = null;
  if (usage !== null && usage.capUsd !== null && activeRunIds.length > 0) {
    const spent = activeRunIds.reduce((sum, id) => sum + (usage.byRun[id]?.spentUsd ?? 0), 0);
    capLine = `$${spent.toFixed(2)} of $${usage.capUsd.toFixed(2)} cap`;
  }
  if (total <= 0 && capLine === null) return null;
  return (
    <div className={styles.metaRow}>
      {total > 0 ? <span>{formatTokens(total)} tokens</span> : null}
      {capLine !== null ? <span>{capLine}</span> : null}
    </div>
  );
}
