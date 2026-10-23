import { useState } from 'react';
import type { OrgRole } from '@tent-nocode/core';
import { can } from '../../../shared/roles.js';
import { useQuery } from '../../lib/data/useQuery.js';
import { desk } from '../../lib/desk.js';
import threadStyles from '../thread/thread.module.css';
import styles from './settings.module.css';

// Secrets vault: names stored, values write-once and never shown; decrypted in main only.
export function SecretsSection({ orgId, role }: { orgId: string; role: OrgRole }) {
  const namesQuery = useQuery(`settings:secrets:${orgId}`, () => desk.listSecretNames(orgId), [orgId]);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const canManage = can(role, 'config');
  const names = namesQuery.data ?? [];

  async function save(): Promise<void> {
    const n = name.trim();
    if (!n || !value) return;
    setBusy(true);
    setError(undefined);
    const res = await desk.setSecret(orgId, n, value);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setName('');
    setValue('');
    namesQuery.refetch();
  }

  async function remove(secretName: string): Promise<void> {
    setBusy(true);
    setError(undefined);
    const res = await desk.deleteSecret(orgId, secretName);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    namesQuery.refetch();
  }

  return (
    <>
      <div className={styles.groupDesc}>
        API keys for connectors, encrypted by your operating system&apos;s keychain. Values are write-once and never
        shown again — rotate by setting the same name.
      </div>

      {canManage ? (
        <div className={styles.addRow}>
          <input
            className={styles.inpName}
            placeholder="NAME"
            value={name}
            onChange={(e) => setName(e.target.value.toUpperCase())}
            disabled={busy}
          />
          <input
            className={styles.inpValue}
            type="password"
            placeholder="value"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={busy}
          />
          <button type="button" className={styles.btn} onClick={() => void save()} disabled={busy || !name.trim() || !value}>
            set
          </button>
        </div>
      ) : null}

      {names.length === 0 ? (
        <div className={styles.zero}>no secrets</div>
      ) : (
        names.map((n) => (
          <div className={styles.row} key={n}>
            <div className={styles.rowText}>
              <div className={styles.rowMono}>{n}</div>
              <div className={styles.rowDesc}>••••••••</div>
            </div>
            {canManage ? (
              <div className={styles.rowCtl}>
                <button type="button" className={styles.rowBtn} onClick={() => void remove(n)} disabled={busy}>
                  delete
                </button>
              </div>
            ) : null}
          </div>
        ))
      )}
      {error ? <div className={threadStyles.errorText}>{error}</div> : null}
    </>
  );
}
