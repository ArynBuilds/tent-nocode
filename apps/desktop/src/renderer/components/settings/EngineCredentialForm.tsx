import { useState } from 'react';
import type { EngineStatus } from '../../../shared/ipc.js';
import { desk } from '../../lib/desk.js';
import threadStyles from '../thread/thread.module.css';
import styles from './settings.module.css';

// Credential entry form: validates live before sealing; same form in onboarding and settings.
export function EngineCredentialForm({ orgId, engine, onSaved }: {
  orgId: string;
  engine: EngineStatus;
  onSaved: () => void;
}) {
  const [kind, setKind] = useState(engine.kinds[0]?.kind ?? 'api-key');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const kindRow = engine.kinds.find((k) => k.kind === kind) ?? engine.kinds[0];

  async function save(): Promise<void> {
    if (value.trim() === '') return;
    setBusy(true);
    setError(null);
    const res = await desk.saveEngineCredential(orgId, engine.engineId, kind, value);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    if (res.data !== undefined && !res.data.validated) {
      setError(res.data.error);
      return;
    }
    setValue('');
    onSaved();
  }

  return (
    <div>
      {engine.kinds.length > 1 ? (
        <div className={styles.addRow}>
          {engine.kinds.map((k) => (
            <button
              key={k.kind}
              type="button"
              className={k.kind === kind ? `${styles.btn} ${styles.btnActive ?? ''}` : styles.btn}
              onClick={() => { setKind(k.kind); setError(null); }}
              disabled={busy}
            >
              {k.label}
            </button>
          ))}
        </div>
      ) : null}
      {engine.lane === 'api' ? (
        <div className={styles.groupDesc}>
          Paste your {kindRow?.label ?? 'API key'}. Tip: use a dedicated key with a monthly
          spend cap so rotating it is a 30-second act. It stays sealed on this machine and
          only ever meets requests to its own vendor.
        </div>
      ) : kind === 'subscription-token' ? (
        <div className={styles.groupDesc}>
          Run <span className={styles.rowMono}>claude setup-token</span> in a terminal, authorize in the
          browser, and paste the token it prints. It stays sealed on this machine.
        </div>
      ) : (
        <div className={styles.groupDesc}>
          Paste an Anthropic API key. Tip: use a dedicated key with a monthly spend cap
          (console.anthropic.com) so rotating it is a 30-second act.
        </div>
      )}
      <div className={styles.addRow}>
        <input
          className={styles.inpValue}
          type="password"
          placeholder={kindRow?.placeholder ?? (kind === 'subscription-token' ? 'paste the setup-token output' : 'sk-ant-…')}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={busy}
        />
        <button type="button" className={styles.btn} onClick={() => void save()} disabled={busy || value.trim() === ''}>
          {busy ? 'validating…' : 'connect'}
        </button>
      </div>
      {busy ? <div className={styles.zero}>running a live validation probe — this can take a moment</div> : null}
      {error !== null ? <div className={threadStyles.errorText}>{error}</div> : null}
    </div>
  );
}
