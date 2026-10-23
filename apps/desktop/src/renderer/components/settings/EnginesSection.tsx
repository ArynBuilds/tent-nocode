import { listRegistryModels, type OrgRole } from '@tent-nocode/core';
import { can } from '../../../shared/roles.js';
import { useQuery } from '../../lib/data/useQuery.js';
import { desk } from '../../lib/desk.js';
import { EngineCredentialForm } from './EngineCredentialForm.js';
import threadStyles from '../thread/thread.module.css';
import styles from './settings.module.css';
import { useState } from 'react';

// Engine settings: registry-driven rows, per-kind credentials, model picker stores as org chat-model pin.
export function EnginesSection({ orgId, role }: { orgId: string; role: OrgRole }) {
  const enginesQuery = useQuery(`settings:engines:${orgId}`, () => desk.listEngines(orgId), [orgId]);
  const configQuery = useQuery(`settings:engines:config:${orgId}`, () => desk.getOrgConfig(orgId), [orgId]);
  const [error, setError] = useState<string | null>(null);
  const canManage = can(role, 'config');
  const engines = enginesQuery.data ?? null;

  async function remove(engineId: string, kind: string): Promise<void> {
    setError(null);
    const res = await desk.removeEngineCredential(orgId, engineId, kind);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    enginesQuery.refetch();
  }

  async function pickModel(id: string): Promise<void> {
    setError(null);
    // '' = clear the pin back to the default pick.
    const res = await desk.updateOrgConfig(orgId, { deskModel: id === '' ? null : id });
    if (!res.ok) setError(res.error);
    configQuery.refetch();
  }

  if (engines === null) return <div className={styles.zero}>checking engines…</div>;

  const anyPresent = engines.some((e) => e.kinds.some((k) => k.present));
  const pinned = configQuery.data?.deskModel ?? '';

  return (
    <>
      <div className={styles.groupDesc}>
        Chats run on your own AI key. Credentials are validated live, sealed by your operating
        system&apos;s keychain, and only ever meet requests to their own vendor.
      </div>

      <div className={styles.row}>
        <div className={styles.rowText}>
          <div className={styles.rowMono}>Chat model</div>
          <div className={styles.rowDesc}>The model your conversations run on.</div>
        </div>
        <div className={styles.rowCtl}>
          <select
            className={styles.inpValue}
            value={pinned}
            disabled={!canManage}
            onChange={(e) => void pickModel(e.target.value)}
          >
            <option value="">Default (Claude Sonnet 5)</option>
            {listRegistryModels().map((m) => (
              <option key={m.id} value={m.id}>{m.display}</option>
            ))}
          </select>
        </div>
      </div>

      {engines.map((engine) => (
        <div key={engine.engineId}>
          <div className={styles.row}>
            <div className={styles.rowText}>
              <div className={styles.rowMono}>{engine.displayName}</div>
              <div className={styles.rowDesc}>
                {engine.lane === 'api'
                  ? 'Direct API — bring your own key.'
                  : engine.binaryVersion !== null ? engine.binaryVersion : engine.installHint}
              </div>
            </div>
          </div>
          {engine.kinds.map((k) => (
            <div className={styles.row} key={`${engine.engineId}:${k.kind}`}>
              <div className={styles.rowText}>
                <div className={styles.rowMono}>{k.label}</div>
                <div className={styles.rowDesc}>{k.present ? '•••••••• sealed' : 'not set'}</div>
              </div>
              {canManage && k.present ? (
                <div className={styles.rowCtl}>
                  <button type="button" className={styles.rowBtn} onClick={() => void remove(engine.engineId, k.kind)}>
                    remove
                  </button>
                </div>
              ) : null}
            </div>
          ))}
          {canManage ? (
            <EngineCredentialForm orgId={orgId} engine={engine} onSaved={() => enginesQuery.refetch()} />
          ) : null}
        </div>
      ))}

      {canManage && anyPresent ? (
        <div className={styles.groupDesc}>
          Rotate by connecting the same kind again — the old value is replaced everywhere.
        </div>
      ) : null}
      {error !== null ? <div className={threadStyles.errorText}>{error}</div> : null}
    </>
  );
}
