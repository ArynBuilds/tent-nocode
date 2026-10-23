import { useEffect, useRef, useState } from 'react';
import type { OrgConfig, OrgRole, ThreadMode } from '@tent-nocode/core';
import type { AuthState } from '../../../shared/ipc.js';
import { can } from '../../../shared/roles.js';
import { useQuery } from '../../lib/data/useQuery.js';
import { desk } from '../../lib/desk.js';
import threadStyles from '../thread/thread.module.css';
import { fieldPatch } from './configPatch.js';
import type { ConfigField, NumberField } from './configPatch.js';
import styles from './settings.module.css';

// General settings section: Account + Chat rows, save-on-change; numbers commit on blur/Enter.

interface NumberDraft {
  autoBudgetUsdPerJob: string;
}

function toNumberDraft(config: OrgConfig): NumberDraft {
  return {
    autoBudgetUsdPerJob: config.chat.autoBudgetUsdPerJob === null ? '' : String(config.chat.autoBudgetUsdPerJob),
  };
}

// Account rows: identity + sign-out (locks the app); engine credentials are machine-scoped and survive it.
function AccountRows() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    desk.authState().then(setAuth).catch(() => undefined);
    const bridge = (window as unknown as { desk?: { onAuth?: (cb: (s: AuthState) => void) => () => void } }).desk;
    const off = bridge?.onAuth?.(setAuth);
    return () => off?.();
  }, []);
  if (auth === null || auth.status !== 'signed-in') return null;
  return (
    <>
      <div className={styles.groupH}>Account</div>
      <div className={styles.row}>
        <div className={styles.rowText}>
          <div className={styles.rowTitle}>{auth.displayName ?? auth.email ?? 'Signed in'}</div>
          <div className={styles.rowDesc}>
            {auth.email ?? ''} · Signing out locks the app until your password is entered again. Everything stays on this computer.
          </div>
        </div>
        <div className={styles.rowCtl}>
          <button
            type="button"
            className={styles.rowBtn}
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void desk.signOut().finally(() => setBusy(false));
            }}
          >
            sign out
          </button>
        </div>
      </div>
    </>
  );
}

export function GeneralSection({ orgId, role }: { orgId: string; role: OrgRole }) {
  const configQuery = useQuery('settings:config', () => desk.getOrgConfig(orgId), [orgId]);
  const [config, setConfig] = useState<OrgConfig | undefined>(undefined);
  const [draft, setDraft] = useState<NumberDraft | undefined>(undefined);
  const [error, setError] = useState<{ field: ConfigField; message: string } | undefined>(undefined);
  const [saved, setSaved] = useState<ConfigField | undefined>(undefined);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (configQuery.data) {
      setConfig(configQuery.data);
      setDraft(toNumberDraft(configQuery.data));
    }
  }, [configQuery.data]);

  useEffect(() => () => clearTimeout(savedTimer.current), []);

  const canEdit = can(role, 'config');

  async function commit(field: ConfigField, raw: string): Promise<void> {
    if (!config) return;
    setError(undefined);
    const patch = fieldPatch(field, raw);
    if (patch === undefined) {
      setDraft(toNumberDraft(config)); // unparsable — revert to the record
      return;
    }
    const result = await desk.updateOrgConfig(orgId, patch);
    if (!result.ok) {
      setError({ field, message: result.error });
      setDraft(toNumberDraft(config)); // the record did not change; neither may the field
      return;
    }
    if (result.data) {
      setConfig(result.data);
      setDraft(toNumberDraft(result.data));
    }
    setSaved(field);
    clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSaved(undefined), 1800);
  }

  if (!config || !draft) {
    return <div className={threadStyles.placeholder}>loading config…</div>;
  }

  function numberRow(field: NumberField, title: string, desc: string, unit?: string, placeholder?: string) {
    if (!draft || !config) return null;
    const recordValue = toNumberDraft(config)[field];
    return (
      <div className={styles.row}>
        <div className={styles.rowText}>
          <div className={styles.rowTitle}>{title}</div>
          <div className={styles.rowDesc}>{desc}</div>
          {error?.field === field ? <div className={styles.rowErr}>{error.message}</div> : null}
        </div>
        <div className={styles.rowCtl}>
          {saved === field ? <span className={styles.rowSaved}>saved</span> : null}
          <input
            className={styles.rowNum}
            disabled={!canEdit}
            placeholder={placeholder}
            value={draft[field]}
            onChange={(e) => setDraft({ ...draft, [field]: e.target.value })}
            onBlur={(e) => {
              if (e.target.value.trim() !== recordValue.trim()) void commit(field, e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
          />
          {unit ? <span className={styles.rowUnit}>{unit}</span> : null}
        </div>
      </div>
    );
  }

  return (
    <>
      <AccountRows />
      <div className={styles.groupH}>Chat</div>
      <div className={styles.row}>
        <div className={styles.rowText}>
          <div className={styles.rowTitle}>Default chat mode</div>
          <div className={styles.rowDesc}>New threads start here; any thread can override its own mode.</div>
          {error?.field === 'defaultMode' ? <div className={styles.rowErr}>{error.message}</div> : null}
        </div>
        <div className={styles.rowCtl}>
          {saved === 'defaultMode' ? <span className={styles.rowSaved}>saved</span> : null}
          <select
            className={styles.rowSelect}
            disabled={!canEdit}
            value={config.chat.defaultMode}
            onChange={(e) => void commit('defaultMode', e.target.value as ThreadMode)}
          >
            <option value="ask">ask</option>
            <option value="auto">auto</option>
            <option value="agent">agent</option>
          </select>
        </div>
      </div>
      {numberRow(
        'autoBudgetUsdPerJob',
        'Auto budget cap',
        'Optional ceiling per auto-mode job — work that would exceed it stops honestly.',
        '$/job',
        'none',
      )}
    </>
  );
}
