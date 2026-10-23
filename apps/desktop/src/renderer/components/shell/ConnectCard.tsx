import { useEffect, useState } from 'react';
import type { EngineStatus } from '../../../shared/ipc.js';
import { desk } from '../../lib/desk.js';
import { useQuery } from '../../lib/data/useQuery.js';
import { EngineCredentialForm } from '../settings/EngineCredentialForm.js';
import styles from './console.module.css';

// Heading and composer placeholder.
export const CONNECT_SENTENCE = 'To use this, connect your AI';

// Hook: checks if AI connected (vault credential OR inherited CLI login). Returns null while loading.
export function useEngineConnected(orgId: string): {
  connected: boolean | null;
  engines: EngineStatus[] | null;
  refresh: () => void;
} {
  const enginesQuery = useQuery(`engine-status:${orgId}`, () => desk.listEngines(orgId), [orgId]);
  const engines = enginesQuery.data ?? null;
  const [inherited, setInherited] = useState<boolean | null>(null);
  const anyCredential = engines?.some((e) => e.kinds.some((k) => k.present)) ?? false;
  const cliVisible = engines?.some((e) => e.lane === 'cli') ?? false;

  useEffect(() => {
    if (engines === null || anyCredential || inherited !== null) return;
    if (!cliVisible) { setInherited(false); return; }
    desk.probeInheritedLogin(orgId).then(setInherited).catch(() => setInherited(false));
  }, [engines, anyCredential, cliVisible, inherited, orgId]);

  const connected = engines === null ? null
    : anyCredential ? true
      : inherited === null ? null : inherited;
  return {
    connected,
    engines,
    refresh: () => { setInherited(null); enginesQuery.refetch(); },
  };
}

// Connect card in console: one quiet card, engine picker, credential form. Re-reads facts on save.
export function ConnectCard({ orgId, engines, onSaved }: {
  orgId: string;
  engines: EngineStatus[] | null;
  onSaved: () => void;
}) {
  const [pickedId, setPickedId] = useState<string | null>(null);
  if (engines === null || engines.length === 0) {
    return (
      <div className={styles.connectCard}>
        <div className={styles.connectLine}>{CONNECT_SENTENCE}</div>
      </div>
    );
  }
  const picked = engines.find((e) => e.engineId === pickedId) ?? engines[0]!;
  return (
    <div className={styles.connectCard}>
      <div className={styles.connectLine}>{CONNECT_SENTENCE}</div>
      {engines.length > 1 ? (
        <div className={styles.connectHint}>
          {engines.map((e) => (
            <button
              key={e.engineId}
              type="button"
              className={styles.connectEngineBtn}
              data-active={e.engineId === picked.engineId ? '1' : undefined}
              onClick={() => setPickedId(e.engineId)}
            >
              {e.displayName}
            </button>
          ))}
        </div>
      ) : null}
      {picked.lane === 'cli' && picked.binaryVersion === null
        ? <div className={styles.connectHint}>{picked.installHint}</div>
        : <EngineCredentialForm orgId={orgId} engine={picked} onSaved={onSaved} />}
    </div>
  );
}
