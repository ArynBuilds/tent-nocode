import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { OrgRole, ThreadMode } from '@tent-nocode/core';
import type { ThreadUsage } from '../../../shared/ipc.js';
import { can } from '../../../shared/roles.js';
import { desk } from '../../lib/desk.js';
import { formatTokens } from '../../lib/feed/feed.js';
import { store, useValue } from '../../lib/canvas/store.js';
import styles from './chat.module.css';

/** Chrome lives in the composer: mode control in pill, meta row below carries the token count. */

interface ModeControlProps {
  orgId: string;
  threadId: string;
  role: OrgRole;
  mode: ThreadMode | null;
  orgDefault: ThreadMode;
  configLoaded: boolean;
}

/** Mode control: ask|auto popover. */
export function ModeControl({ orgId, threadId, role, mode, orgDefault, configLoaded }: ModeControlProps) {
  const [modePending, setModePending] = useState(false);
  const [modeError, setModeError] = useState<string | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement | null>(null);

  // Click-outside closes menu.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent): void {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
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
  return (
    <>
      {modeError ? <span className={styles.errorText}>{modeError}</span> : null}
      {can(role, 'approve_plan') ? (
        <span className={styles.modeWrap} ref={wrapRef}>
          <button
            type="button"
            className={styles.modeBtn}
            disabled={modePending || !configLoaded}
            onClick={() => setOpen((v) => !v)}
          >
            {current}
            <ChevronDown size={12} />
          </button>
          {open ? (
            <span className={styles.modeMenu}>
              {(['ask', 'auto', 'agent'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  className={m === current ? `${styles.modeItem} ${styles.modeItemActive}` : styles.modeItem}
                  onClick={() => void changeMode(m)}
                >
                  {m}
                </button>
              ))}
            </span>
          ) : null}
        </span>
      ) : (
        <span className={styles.metaQuiet}>{current}</span>
      )}
    </>
  );
}

interface ComposerMetaProps {
  orgId: string;
  threadId: string;
  usage: ThreadUsage | null;
  activeRunIds: string[];
  role: OrgRole;
}

export function ComposerMeta({ orgId, threadId, usage, activeRunIds, role }: ComposerMetaProps) {
  // The armed point-and-ask selection renders here; × disarms, send consumes.
  const armed = useValue('composer.armed', () => store.panel.armed, []);
  // The code selection chip; send consumes.
  const armedCode = useValue('composer.armedCode', () => store.panel.armedCode, []);
  const clearSelection = (): void => store.armSelection(null);
  const clearCodeSelection = (): void => store.armCodeSelection(null);

  const total = usage?.totalTokens ?? 0;
  let capLine: string | null = null;
  if (usage !== null && usage.capUsd !== null && activeRunIds.length > 0) {
    const spent = activeRunIds.reduce((sum, id) => sum + (usage.byRun[id]?.spentUsd ?? 0), 0);
    capLine = `$${spent.toFixed(2)} of $${usage.capUsd.toFixed(2)} cap`;
  }

  if (total <= 0 && capLine === null && armed === null && armedCode === null) return null;

  return (
    <div className={styles.metaRow}>
      {armed !== null ? (
        <span className={styles.statusTokens} title={`node ${armed.nodeId} in '${armed.sceneTitle}' rides your next message`}>
          ⌖ {armed.sceneTitle}
          <button type="button" className={styles.schedToggle} aria-label="Drop the selection" onClick={clearSelection}>×</button>
        </span>
      ) : null}
      {armedCode !== null ? (
        <span className={styles.statusTokens} title={`lines ${armedCode.fromLine}-${armedCode.toLine} ride your next message`}>
          ⌖ {armedCode.subject}
          <button type="button" className={styles.schedToggle} aria-label="Drop the code selection" onClick={clearCodeSelection}>×</button>
        </span>
      ) : null}
      {total > 0 ? <span className={styles.statusTokens}>{formatTokens(total)} tokens</span> : null}
      {capLine !== null ? <span className={styles.statusTokens}>{capLine}</span> : null}
    </div>
  );
}
