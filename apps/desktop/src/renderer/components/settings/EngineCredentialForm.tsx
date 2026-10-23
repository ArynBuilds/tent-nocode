import { useState } from 'react';
import type { EngineStatus } from '../../../shared/ipc.js';
import { desk } from '../../lib/desk.js';
import { Row, StatusLine, errorText, kit, type RowState, IDLE } from '../kit/kit.js';

// Credential entry: checked live with its own vendor before it is sealed on this computer.

export function EngineCredentialForm({ orgId, engine, onSaved }: {
  orgId: string;
  engine: EngineStatus;
  onSaved: () => void;
}) {
  const [kind, setKind] = useState(engine.kinds[0]?.kind ?? 'api-key');
  const [value, setValue] = useState('');
  const [state, setState] = useState<RowState>(IDLE);
  const kindRow = engine.kinds.find((k) => k.kind === kind) ?? engine.kinds[0];
  const busy = state.phase === 'working';
  const id = `engine-${engine.engineId}-${kind}`;

  const save = (): void => {
    if (value.trim() === '' || busy) return;
    setState({ phase: 'working', sentence: 'Checking it with the vendor. This can take a moment…' });
    void desk.saveEngineCredential(orgId, engine.engineId, kind, value).then((res) => {
      if (!res.ok) { setState({ phase: 'failed', sentence: 'Could not save it.', detail: res.error }); return; }
      if (res.data !== undefined && !res.data.validated) {
        setState({ phase: 'failed', sentence: 'The vendor did not accept it.', detail: res.data.error });
        return;
      }
      setValue('');
      setState(IDLE);
      onSaved();
    }).catch((err: unknown) => setState({ phase: 'failed', sentence: 'Could not save it.', detail: errorText(err) }));
  };

  const hint = kind === 'subscription-token'
    ? <>Run <code>claude setup-token</code> in a terminal, approve it in the browser, and paste the token it prints.</>
    : 'Use a key of its own with a monthly spending limit, so replacing it takes a minute.';

  return (
    <form className={kit.form} onSubmit={(e) => { e.preventDefault(); save(); }}>
      {engine.kinds.length > 1 ? (
        <Row label="Kind">
          <div className={kit.segmented} role="radiogroup" aria-label="Credential kind">
            {engine.kinds.map((k) => (
              <button
                key={k.kind}
                type="button"
                role="radio"
                aria-checked={k.kind === kind}
                className={k.kind === kind ? `${kit.segment} ${kit.segmentOn}` : kit.segment}
                disabled={busy}
                onClick={() => { setKind(k.kind); setState(IDLE); }}
              >
                {k.label}
              </button>
            ))}
          </div>
        </Row>
      ) : null}
      <Row label={kindRow?.label ?? 'API key'} htmlFor={id} hint={hint} stack>
        <input
          id={id}
          className={`${kit.input} ${kit.mono}`}
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={kindRow?.placeholder ?? (kind === 'subscription-token' ? 'The token setup-token printed' : 'sk-ant-…')}
          value={value}
          disabled={busy}
          onChange={(e) => { setValue(e.target.value); if (state.phase === 'failed') setState(IDLE); }}
        />
      </Row>
      <div className={kit.formFoot}>
        <StatusLine state={state} />
        <button type="submit" className={`${kit.btn} ${kit.btnPrimary}`} disabled={busy || value.trim() === ''}>
          {busy ? 'Checking…' : 'Connect'}
        </button>
      </div>
    </form>
  );
}
