import { useState } from 'react';
import type { OrgRole } from '@tent-nocode/core';
import { can } from '../../../shared/roles.js';
import { useQuery } from '../../lib/data/useQuery.js';
import { desk } from '../../lib/desk.js';
import threadStyles from '../thread/thread.module.css';
import styles from './settings.module.css';

// Connections gallery: services connect one click + token (vault only); tokens stay private.
export function ConnectionsSection({ orgId, role }: { orgId: string; role: OrgRole }) {
  const gallery = useQuery(`settings:gallery:${orgId}`, () => desk.listGalleryServices(orgId), [orgId]);
  const conns = useQuery(`settings:connections:${orgId}`, () => desk.listConnections(orgId), [orgId]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [tokenFor, setTokenFor] = useState<string | null>(null);
  const [token, setToken] = useState('');
  const canManage = can(role, 'config');

  const connected = conns.data ?? [];
  const available = (gallery.data ?? []).filter((g) => !connected.some((c) => c.serviceId === g.id));

  async function connect(serviceId: string, secretName: string): Promise<void> {
    setBusy(true);
    setError(undefined);
    if (token.length > 0) {
      const saved = await desk.setSecret(orgId, secretName, token);
      if (!saved.ok) {
        setBusy(false);
        setError(saved.error);
        return;
      }
    }
    const res = await desk.addConnection(orgId, serviceId);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setToken('');
    setTokenFor(null);
    void conns.refetch();
  }

  async function revoke(connectionId: string): Promise<void> {
    setBusy(true);
    setError(undefined);
    const res = await desk.revokeConnection(orgId, connectionId);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    conns.refetch();
  }

  return (
    <>
      <div className={styles.groupDesc}>
        Outside services Tent NoCode may act on — every connection is consented, its token lives in the encrypted
        vault, reads run automatically and writes ask first. You can also connect by just asking in any thread.
      </div>

      {connected.map((c) => (
        <div className={styles.row} key={c.id}>
          <div className={styles.rowText}>
            <div className={styles.rowMono}>{c.title}</div>
            <div className={styles.rowDesc}>{c.command.join(' ')} · token: {c.secretName}</div>
          </div>
          {canManage ? (
            <div className={styles.rowCtl}>
              <button type="button" className={styles.rowBtn} onClick={() => void revoke(c.id)} disabled={busy}>
                revoke
              </button>
            </div>
          ) : null}
        </div>
      ))}

      {available.map((g) => (
        <div className={styles.row} key={g.id}>
          <div className={styles.rowText}>
            <div className={styles.rowMono}>{g.title}</div>
            <div className={styles.rowDesc}>{g.blurb}</div>
            {tokenFor === g.id ? (
              <div className={styles.rowDesc}>
                <div>{g.tokenHelp}</div>
                <input
                  type="password"
                  placeholder={`${g.secretName} (stored in the vault only)`}
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  disabled={busy}
                  style={{ width: '100%' }}
                />
              </div>
            ) : null}
          </div>
          {canManage ? (
            <div className={styles.rowCtl}>
              {tokenFor === g.id ? (
                <button type="button" className={styles.rowBtn} onClick={() => void connect(g.id, g.secretName)} disabled={busy}>
                  connect
                </button>
              ) : (
                <button type="button" className={styles.rowBtn} onClick={() => { setTokenFor(g.id); setToken(''); }} disabled={busy}>
                  connect…
                </button>
              )}
            </div>
          ) : null}
        </div>
      ))}

      <div className={styles.zero}>
        Vercel arrives with OAuth support. Custom MCP servers: ask in a thread — the consent card shows the
        exact command before anything runs.
      </div>
      {error ? <div className={threadStyles.errorText}>{error}</div> : null}
    </>
  );
}
