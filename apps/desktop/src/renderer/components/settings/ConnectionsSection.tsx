import { useState } from 'react';
import type { OrgRole } from '@nodeloom/core';
import { can } from '../../../shared/roles.js';
import { useQuery } from '../../lib/data/useQuery.js';
import { desk } from '../../lib/desk.js';
import { ConfirmAction, Empty, Group, IDLE, Row, StatusLine, errorText, kit, refusalOf, type RowState } from '../kit/kit.js';

// Connections: chat tools from outside services, each one consented; its token goes to the encrypted vault alone.

export function ConnectionsSection({ orgId, role }: { orgId: string; role: OrgRole }) {
  const gallery = useQuery(`settings:gallery:${orgId}`, () => desk.listGalleryServices(orgId), [orgId]);
  const conns = useQuery(`settings:connections:${orgId}`, () => desk.listConnections(orgId), [orgId]);
  const [tokenFor, setTokenFor] = useState<string | null>(null);
  const [token, setToken] = useState('');
  const [state, setState] = useState<RowState>(IDLE);
  const [listState, setListState] = useState<RowState>(IDLE);
  const canManage = can(role, 'config');

  const connected = conns.data ?? [];
  const available = (gallery.data ?? []).filter((g) => !connected.some((c) => c.serviceId === g.id));
  const busy = state.phase === 'working';

  const connect = async (serviceId: string, title: string, secretName: string): Promise<void> => {
    setState({ phase: 'working', sentence: `Connecting ${title}…` });
    try {
      if (token !== '') {
        const saved = await desk.setSecret(orgId, secretName, token);
        if (!saved.ok) { setState({ phase: 'failed', sentence: 'Could not save the token.', detail: saved.error }); return; }
      }
      const refusal = refusalOf(await desk.addConnection(orgId, serviceId));
      if (refusal !== null) { setState({ phase: 'failed', sentence: `Could not connect ${title}.`, detail: refusal }); return; }
      setToken('');
      setTokenFor(null);
      setState({ phase: 'done', sentence: `${title} is connected.` });
      conns.refetch();
    } catch (err) {
      setState({ phase: 'failed', sentence: `Could not connect ${title}.`, detail: errorText(err) });
    }
  };

  const revoke = async (connectionId: string, title: string): Promise<void> => {
    setListState(IDLE);
    try {
      const refusal = refusalOf(await desk.revokeConnection(orgId, connectionId));
      if (refusal !== null) setListState({ phase: 'failed', sentence: `Could not disconnect ${title}.`, detail: refusal });
      conns.refetch();
    } catch (err) {
      setListState({ phase: 'failed', sentence: `Could not disconnect ${title}.`, detail: errorText(err) });
    }
  };

  const failed = gallery.error ?? conns.error;
  return (
    <>
      <Group title="Connected">
        {failed !== undefined ? <StatusLine state={{ phase: 'failed', sentence: 'Could not read the connections.', detail: failed }} /> : null}
        {conns.data === undefined && failed === undefined ? <Empty>Loading…</Empty> : null}
        {conns.data !== undefined && connected.length === 0 ? <Empty>Nothing connected yet.</Empty> : null}
        {connected.map((c) => (
          <Row key={c.id} label={c.title} hint={<>Token saved as <code>{c.secretName}</code></>}>
            {canManage ? (
              <ConfirmAction label="Disconnect" prompt={`Disconnect ${c.title}?`} confirmLabel="Disconnect" workingLabel="Disconnecting…" onConfirm={() => revoke(c.id, c.title)} />
            ) : null}
          </Row>
        ))}
        <StatusLine state={listState} />
      </Group>
      {available.length > 0 ? (
        <Group title="Available">
          {available.map((g) => (tokenFor === g.id ? (
            <form key={g.id} className={kit.form} onSubmit={(e) => { e.preventDefault(); void connect(g.id, g.title, g.secretName); }}>
              <Row label={`${g.title} token`} htmlFor={`conn-${g.id}`} hint={g.tokenHelp} stack>
                <input
                  id={`conn-${g.id}`}
                  className={`${kit.input} ${kit.mono}`}
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={g.secretName}
                  value={token}
                  disabled={busy}
                  autoFocus
                  onChange={(e) => setToken(e.target.value)}
                />
              </Row>
              <div className={kit.formFoot}>
                <StatusLine state={state} />
                <button type="button" className={`${kit.btn} ${kit.btnQuiet}`} disabled={busy} onClick={() => { setTokenFor(null); setState(IDLE); }}>Cancel</button>
                <button type="submit" className={`${kit.btn} ${kit.btnPrimary}`} disabled={busy}>{busy ? 'Connecting…' : 'Connect'}</button>
              </div>
            </form>
          ) : (
            <Row key={g.id} label={g.title} hint={g.blurb}>
              {canManage ? (
                <button type="button" className={kit.btn} disabled={busy} onClick={() => { setTokenFor(g.id); setToken(''); setState(IDLE); }}>Connect</button>
              ) : null}
            </Row>
          )))}
          {tokenFor === null ? <StatusLine state={state} /> : null}
        </Group>
      ) : null}
      <Empty>To connect something else, ask for it in a chat. The card shows the exact command before anything runs.</Empty>
    </>
  );
}
