import { useEffect, useState } from 'react';
import type { IntegrationCatalogWire, IntegrationConnectionWire, IntegrationImportWire } from '@tent-nocode/core';
import { desk } from '../../lib/desk.js';
import { useOrg } from '../../lib/OrgContext.js';
import type { CitizenSelection } from '../../lib/canvas/store.js';
import { idTail } from '../../lib/canvas/tools/select/Idle.js';
import { PropertyRow } from '../page-edit/PropertyRow.js';
import type { RowSpec } from '../page-edit/panelGroups.js';
import styles from './sidepanel.module.css';

/** A connection setting as one schema row: the panel's one row per type renders it. */
const settingRow = (s: { id: string; label: string; kind: string; choices?: string[]; help?: string }): RowSpec => ({
  key: s.id, label: s.label,
  kind: s.kind === 'boolean' ? 'toggle' : s.kind === 'number' ? 'number' : s.kind === 'enum' ? 'enum' : 'text',
  unit: null, options: s.kind === 'enum' ? s.choices ?? [] : [], hint: s.help ?? '', fixed: false, atOk: false, type: s.kind, range: null,
});
const textRow = (key: string, label: string, hint: string): RowSpec => ({ key, label, kind: 'text', unit: null, options: [], hint, fixed: false, atOk: false, type: 'string', range: null });

// Integration connection settings panel with inline token consent and auth.
export function IntegrationProperties({ selection }: { selection: CitizenSelection }) {
  const { orgId } = useOrg();
  const connectionId = idTail(selection.nodeId);
  const [connection, setConnection] = useState<IntegrationConnectionWire | null>(null);
  const [entry, setEntry] = useState<IntegrationCatalogWire | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [hostDraft, setHostDraft] = useState('');
  const [slotDraft, setSlotDraft] = useState('');
  const [tokenDraft, setTokenDraft] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [epoch, setEpoch] = useState(0);
  const [imports, setImports] = useState<IntegrationImportWire[]>([]);

  useEffect(() => {
    let cancelled = false;
    void desk.integrationsList(orgId, selection.projectId ?? undefined).then((rows) => {
      if (cancelled) return;
      const row = rows.find((r) => r.id === connectionId) ?? null;
      setConnection(row);
      if (row !== null) {
        void desk.integrationsCatalog().then((defs) => {
          if (!cancelled) setEntry(defs.find((d) => d.name === row.integration && d.version === row.version) ?? null);
        });
      }
    }).catch(() => undefined);
    void desk.integrationsImportsList(orgId, connectionId).then((rows) => {
      if (!cancelled) setImports(rows);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [orgId, connectionId, selection.projectId, epoch]);

  useEffect(() => {
    if (!imports.some((i) => i.status === 'pending' || i.status === 'running')) return undefined;
    const t = window.setInterval(() => setEpoch((n) => n + 1), 5000);
    return () => window.clearInterval(t);
  }, [imports]);

  if (connection === null || entry === null) return null;
  const conn = connection;
  const def = entry;

  async function saveSetting(id: string, value: unknown): Promise<void> {
    const res = await desk.integrationsSettings(orgId, connectionId, { [id]: value });
    if (!res.ok) setNotice(res.error ?? 'that did not save');
    else if (res.data?.ok !== true) setNotice(res.data?.refusal ?? 'that did not save');
    else setEpoch((n) => n + 1);
  }

  async function connect(): Promise<void> {
    // Secret tokens store in the vault before activation and never ride integration calls.
    if (def.authKind !== 'none' && def.secretName !== null) {
      if (tokenDraft.trim() === '') {
        setNotice('paste the key first');
        return;
      }
      const saved = await desk.setSecret(orgId, def.secretName, tokenDraft.trim(), conn.projectId);
      if (!saved.ok) {
        setNotice(saved.error ?? 'the key did not save');
        return;
      }
    }
    const res = await desk.integrationsActivate(orgId, {
      id: connectionId,
      ...(def.ownerPinned && hostDraft.trim() !== '' ? { ownerHost: hostDraft.trim() } : {}),
      ...(def.hostTemplate !== null && slotDraft.trim() !== '' ? { hostValue: slotDraft.trim() } : {}),
    });
    if (!res.ok) setNotice(res.error ?? 'that did not connect');
    else if (res.data?.ok !== true) setNotice(res.data?.refusal ?? 'that did not connect');
    else {
      setTokenDraft('');
      setConnecting(false);
      setNotice('connected');
      setEpoch((n) => n + 1);
    }
  }

  const grouped = (['read', 'write', 'send'] as const)
    .map((klass) => ({ klass, rows: def.endpoints.filter((e) => e.class === klass) }))
    .filter((g) => g.rows.length > 0);

  return (
    <section className={styles.inspectorSection}>
      {notice !== null ? <div className={styles.inspectorNotice}>{notice}</div> : null}
      <div className={styles.contractText}>
        {conn.status === 'active' ? 'connected' : 'not connected yet'}
      </div>
      {conn.ownerHost !== null ? (
        <div className={styles.contractLine}><span className={styles.contractMono}>{conn.ownerHost}</span></div>
      ) : null}

      {def.settings.map((s) => {
        const value = conn.settings[s.id];
        // text, template and channel-pick settings ride the text row; a cleared row keeps the last value.
        const shown = s.kind === 'enum' && typeof value !== 'string' ? s.choices?.[0] : value;
        return (
          <PropertyRow
            key={s.id} spec={settingRow(s)} value={shown} scoped={false}
            onChange={(v) => { if (v !== undefined) void saveSetting(s.id, v as string | number | boolean); }}
          />
        );
      })}

      {def.availability === 'upcoming' ? (
        // THE UPCOMING STATE: the one sentence, no dead button (absence is the off state).
        <div className={styles.contractText}>{`${def.displayName} is upcoming - it connects the moment its approval clears`}</div>
      ) : def.authKind === 'oauth' ? (
        // OAuth flow: browser opens sign-in; no key field renders here.
        <button
          type="button"
          className={styles.contractVerb}
          onClick={() => {
            void desk.integrationsOauthStart(orgId, connectionId).then((r) => {
              if (!r.ok) setNotice(r.error ?? 'that did not start');
              else if (r.data?.ok !== true || r.data.url === undefined) setNotice(r.data?.refusal ?? 'that did not start');
              else {
                window.open(r.data.url, '_blank');
                setNotice('finish signing in in your browser - this panel updates when it lands');
              }
            });
          }}
        >
          {conn.status === 'active' ? `Reconnect ${def.displayName}` : `Sign in to ${def.displayName}`}
        </button>
      ) : !connecting ? (
        <button type="button" className={styles.contractVerb} onClick={() => setConnecting(true)}>
          {conn.status === 'active' ? 'Reconnect' : `Connect ${def.displayName}`}
        </button>
      ) : (
        <>
          {def.ownerPinned ? (
            <PropertyRow spec={textRow('host', 'Sends to', 'https://your-service.example')} value={hostDraft === '' ? undefined : hostDraft} scoped={false} onChange={(v) => setHostDraft(typeof v === 'string' ? v : '')} />
          ) : def.hostTemplate !== null ? (
            // Host template: short code for account subdomain; the rest is fixed.
            <PropertyRow spec={textRow('slot', 'Address code', def.hostTemplate.slot)} value={slotDraft === '' ? undefined : slotDraft} scoped={false} onChange={(v) => setSlotDraft(typeof v === 'string' ? v : '')} />
          ) : (
            def.hosts.map((h) => (
              <div key={h} className={styles.contractLine}><span className={styles.contractMono}>{h}</span></div>
            ))
          )}
          {grouped.map((g) => (
            <div key={g.klass} className={styles.contractSub}>
              {`${g.klass}s: ${g.rows.map((r) => r.displayName).join(' · ')}`}
            </div>
          ))}
          {def.authKind !== 'none' ? (
            <>
              <div className={styles.inspectorRowStatic}>
                <span className={styles.rowWordStatic}>Key</span>
                <span className={styles.rowControl}>
                  <input
                    type="password"
                    className={styles.rowText}
                    value={tokenDraft}
                    placeholder="paste the key"
                    onChange={(e) => setTokenDraft(e.target.value)}
                  />
                </span>
              </div>
              {def.tokenHelp !== null ? <div className={styles.contractSub}>{def.tokenHelp}</div> : null}
            </>
          ) : null}
          <button type="button" className={styles.contractVerb} onClick={() => void connect()}>Connect</button>
          <button type="button" className={styles.contractVerb} onClick={() => { setConnecting(false); setTokenDraft(''); }}>Not now</button>
        </>
      )}

      {def.importDoor && conn.status === 'active' ? (
        <>
          {!imports.some((i) => i.status === 'pending' || i.status === 'running') ? (
            <button
              type="button"
              className={styles.contractVerb}
              onClick={() => {
                void desk.integrationsImportStart(orgId, { connectionId }).then((r) => {
                  if (!r.ok) setNotice(r.error ?? 'the import did not start');
                  else if (r.data?.ok !== true) setNotice(r.data?.refusal ?? 'the import did not start');
                  else setEpoch((n) => n + 1);
                });
              }}
            >
              {`Import from ${def.displayName}`}
            </button>
          ) : null}
          {imports[0] !== undefined ? (
            <div className={styles.contractSub}>
              {imports[0].status === 'done' ? `imported ${imports[0].rowsLanded} rows into ${imports[0].dataset}`
                : imports[0].status === 'failed' ? (imports[0].error ?? 'the import failed')
                  : `importing into ${imports[0].dataset} - ${imports[0].rowsLanded} rows so far`}
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
