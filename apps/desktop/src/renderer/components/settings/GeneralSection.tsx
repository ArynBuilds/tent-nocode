import { useEffect, useRef, useState } from 'react';
import type { OrgConfig, OrgRole, ThreadMode } from '@tent-nocode/core';
import type { AuthState } from '../../../shared/ipc.js';
import { can } from '../../../shared/roles.js';
import { useQuery } from '../../lib/data/useQuery.js';
import { desk } from '../../lib/desk.js';
import { Empty, Group, IDLE, Row, StatusLine, errorText, kit, type RowState } from '../kit/kit.js';
import { fieldPatch, type ConfigField } from './configPatch.js';

// General: the account (sign out locks the app) and the chat defaults, each saved the moment it changes.

const MODES: Array<{ id: ThreadMode; label: string }> = [
  { id: 'ask', label: 'Ask' },
  { id: 'auto', label: 'Auto' },
  { id: 'agent', label: 'Agent' },
];

function AccountGroup() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [state, setState] = useState<RowState>(IDLE);
  useEffect(() => {
    desk.authState().then(setAuth).catch(() => undefined);
    const bridge = (window as unknown as { desk?: { onAuth?: (cb: (s: AuthState) => void) => () => void } }).desk;
    const off = bridge?.onAuth?.(setAuth);
    return () => off?.();
  }, []);
  if (auth === null || auth.status !== 'signed-in') return null;
  const signOut = (): void => {
    setState({ phase: 'working', sentence: 'Signing out…' });
    void desk.signOut().catch((err: unknown) => setState({ phase: 'failed', sentence: 'Could not sign out.', detail: errorText(err) }));
  };
  return (
    <Group title="Account">
      <Row label="Name">
        <span className={kit.value}>{auth.displayName ?? 'Not set'}</span>
      </Row>
      <Row label="Email">
        <span className={kit.value}>{auth.email ?? 'Not set'}</span>
      </Row>
      <Row label="Sign out" hint="Locks the app until your password is entered again. Everything stays on this computer.">
        <button type="button" className={kit.btn} disabled={state.phase === 'working'} onClick={signOut}>Sign out</button>
      </Row>
      <StatusLine state={state} />
    </Group>
  );
}

export function GeneralSection({ orgId, role }: { orgId: string; role: OrgRole }) {
  const configQuery = useQuery('settings:config', () => desk.getOrgConfig(orgId), [orgId]);
  const [config, setConfig] = useState<OrgConfig | undefined>(undefined);
  const [cap, setCap] = useState('');
  const [state, setState] = useState<{ field: ConfigField; row: RowState } | null>(null);
  const clearTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(clearTimer.current), []);

  const capOf = (c: OrgConfig): string => (c.chat.autoBudgetUsdPerJob === null ? '' : String(c.chat.autoBudgetUsdPerJob));
  useEffect(() => {
    if (configQuery.data === undefined) return;
    setConfig(configQuery.data);
    setCap(capOf(configQuery.data));
  }, [configQuery.data]);

  const canEdit = can(role, 'config');

  const commit = async (field: ConfigField, raw: string): Promise<void> => {
    if (config === undefined) return;
    const patch = fieldPatch(field, raw);
    if (patch === undefined) {
      setCap(capOf(config));
      setState({ field, row: { phase: 'failed', sentence: 'That is not an amount. The old value is back.' } });
      return;
    }
    setState({ field, row: { phase: 'working', sentence: 'Saving…' } });
    try {
      const result = await desk.updateOrgConfig(orgId, patch);
      if (!result.ok) {
        setCap(capOf(config));
        setState({ field, row: { phase: 'failed', sentence: 'Could not save.', detail: result.error } });
        return;
      }
      if (result.data !== undefined) {
        setConfig(result.data);
        setCap(capOf(result.data));
      }
      setState({ field, row: { phase: 'done', sentence: 'Saved.' } });
      window.clearTimeout(clearTimer.current);
      clearTimer.current = window.setTimeout(() => setState(null), 2000);
    } catch (err) {
      setState({ field, row: { phase: 'failed', sentence: 'Could not save.', detail: errorText(err) } });
    }
  };

  const rowState = (field: ConfigField): RowState => (state?.field === field ? state.row : IDLE);

  return (
    <>
      <AccountGroup />
      <Group title="Chat">
        {configQuery.error !== undefined ? <StatusLine state={{ phase: 'failed', sentence: 'Could not read the settings.', detail: configQuery.error }} /> : null}
        {config === undefined && configQuery.error === undefined ? <Empty>Loading…</Empty> : null}
        {config !== undefined ? (
          <>
            <Row
              label="New chats start in"
              htmlFor="settings-mode"
              hint="Ask waits for your Yes on every card. Auto and Agent answer routine cards themselves and record each answer. Any chat can change its own mode."
            >
              <select
                id="settings-mode"
                className={kit.select}
                disabled={!canEdit}
                value={config.chat.defaultMode}
                onChange={(e) => void commit('defaultMode', e.target.value)}
              >
                {MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            </Row>
            <StatusLine state={rowState('defaultMode')} />
            <Row
              label="Spending cap per job"
              htmlFor="settings-cap"
              hint="Shown beside the chat while a job runs in Auto, as spent of this amount. It does not stop the job. Leave it empty for none."
            >
              <div className={kit.amount}>
                <span className={kit.unit}>$</span>
                <input
                  id="settings-cap"
                  className={`${kit.input} ${kit.inputShort}`}
                  inputMode="decimal"
                  placeholder="None"
                  disabled={!canEdit}
                  value={cap}
                  onChange={(e) => setCap(e.target.value)}
                  onBlur={(e) => { if (e.target.value.trim() !== capOf(config).trim()) void commit('autoBudgetUsdPerJob', e.target.value); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                />
              </div>
            </Row>
            <StatusLine state={rowState('autoBudgetUsdPerJob')} />
          </>
        ) : null}
      </Group>
    </>
  );
}
