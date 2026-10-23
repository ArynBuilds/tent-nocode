import { useState } from 'react';
import { listRegistryModels, type OrgRole } from '@tent-nocode/core';
import type { EngineStatus } from '../../../shared/ipc.js';
import { can } from '../../../shared/roles.js';
import { useQuery } from '../../lib/data/useQuery.js';
import { desk } from '../../lib/desk.js';
import { ConfirmAction, Empty, Group, IDLE, Row, StatusLine, errorText, kit, type RowState } from '../kit/kit.js';
import { EngineCredentialForm } from './EngineCredentialForm.js';

// Engines: Claude Code found on this computer first, then the API vendors; the model pick is the account's chat-model pin.

function EngineGroup({ orgId, engine, canManage, onChanged }: {
  orgId: string;
  engine: EngineStatus;
  canManage: boolean;
  onChanged: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [state, setState] = useState<RowState>(IDLE);
  const saved = engine.kinds.filter((k) => k.present);
  const cli = engine.lane === 'cli';

  const remove = async (kind: string, label: string): Promise<void> => {
    setState(IDLE);
    try {
      const res = await desk.removeEngineCredential(orgId, engine.engineId, kind);
      if (!res.ok) { setState({ phase: 'failed', sentence: `Could not remove the ${label}.`, detail: res.error }); return; }
      onChanged();
    } catch (err) {
      setState({ phase: 'failed', sentence: `Could not remove the ${label}.`, detail: errorText(err) });
    }
  };

  // A CLI engine works on its own sign-in, so its form waits behind a verb; an API engine with no key shows it at once.
  const showForm = canManage && (adding || (!cli && saved.length === 0));
  return (
    <Group title={engine.displayName}>
      {cli ? (
        <Row
          label={engine.binaryVersion !== null ? 'Found on this computer' : 'Not found on this computer'}
          hint={engine.binaryVersion !== null
            ? 'Chats use your own Claude Code sign-in. There is nothing to set up.'
            : engine.installHint}
        >
          <span className={engine.binaryVersion !== null ? `${kit.value} ${kit.mono}` : kit.valueQuiet}>
            {engine.binaryVersion?.replace(/\s*\(.*\)\s*$/, '') ?? 'Not installed'}
          </span>
        </Row>
      ) : null}
      {saved.map((k) => (
        <Row key={k.kind} label={k.label} hint="Saved and sealed on this computer. The value is never shown.">
          {canManage ? (
            <ConfirmAction label="Remove" prompt={`Remove the ${k.label}?`} confirmLabel="Remove" workingLabel="Removing…" onConfirm={() => remove(k.kind, k.label)} />
          ) : null}
        </Row>
      ))}
      {showForm ? (
        <EngineCredentialForm orgId={orgId} engine={engine} onSaved={() => { setAdding(false); onChanged(); }} />
      ) : canManage ? (
        <Row
          label={saved.length > 0 ? 'Replace it' : 'Use a token instead'}
          hint={saved.length > 0 ? 'Connecting again replaces the saved value everywhere.' : 'Only needed when Claude Code should run on a different account than your sign-in.'}
        >
          <button type="button" className={kit.btn} onClick={() => setAdding(true)}>{saved.length > 0 ? 'Replace' : 'Add token'}</button>
        </Row>
      ) : null}
      <StatusLine state={state} />
    </Group>
  );
}

export function EnginesSection({ orgId, role }: { orgId: string; role: OrgRole }) {
  const enginesQuery = useQuery(`settings:engines:${orgId}`, () => desk.listEngines(orgId), [orgId]);
  const configQuery = useQuery(`settings:engines:config:${orgId}`, () => desk.getOrgConfig(orgId), [orgId]);
  const [modelState, setModelState] = useState<RowState>(IDLE);
  const canManage = can(role, 'config');
  const engines = enginesQuery.data;

  const pickModel = async (id: string): Promise<void> => {
    setModelState({ phase: 'working', sentence: 'Saving…' });
    try {
      // '' clears the pin back to the engine's own default.
      const res = await desk.updateOrgConfig(orgId, { deskModel: id === '' ? null : id });
      if (!res.ok) { setModelState({ phase: 'failed', sentence: 'Could not save the model.', detail: res.error }); return; }
      setModelState({ phase: 'done', sentence: 'Saved.' });
      configQuery.refetch();
    } catch (err) {
      setModelState({ phase: 'failed', sentence: 'Could not save the model.', detail: errorText(err) });
    }
  };

  if (enginesQuery.error !== undefined) {
    return <StatusLine state={{ phase: 'failed', sentence: 'Could not read the engines.', detail: enginesQuery.error }} />;
  }
  if (engines === undefined) return <Empty>Looking for engines on this computer…</Empty>;

  const ordered = [...engines.filter((e) => e.lane === 'cli'), ...engines.filter((e) => e.lane === 'api')];
  return (
    <>
      <Group title="Model">
        <Row label="Chats run on" htmlFor="settings-model" hint="Default lets the engine pick its own model.">
          <select
            id="settings-model"
            className={kit.select}
            value={configQuery.data?.deskModel ?? ''}
            disabled={!canManage || configQuery.data === undefined}
            onChange={(e) => void pickModel(e.target.value)}
          >
            <option value="">Default</option>
            {listRegistryModels().map((m) => <option key={m.id} value={m.id}>{m.display}</option>)}
          </select>
        </Row>
        <StatusLine state={modelState} />
      </Group>
      {ordered.map((engine) => (
        <EngineGroup key={engine.engineId} orgId={orgId} engine={engine} canManage={canManage} onChanged={() => enginesQuery.refetch()} />
      ))}
    </>
  );
}
