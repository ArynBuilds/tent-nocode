import { useState } from 'react';
import type { OrgRole } from '@tent-nocode/core';
import type { ConsentGrantRow } from '../../../shared/ipc.js';
import { can } from '../../../shared/roles.js';
import { useLive } from '../../lib/data/useLive.js';
import { useQuery } from '../../lib/data/useQuery.js';
import { desk } from '../../lib/desk.js';
import { ConfirmAction, Empty, Group, IDLE, Row, StatusLine, errorText, type RowState } from '../kit/kit.js';

// Permissions: the one grant store, listed and revocable; grants are written only by approving an ask-once card.

/** Plain words for a grant subject. */
function subjectWords(subject: string): string {
  if (subject.startsWith('folder:')) return `The folder ${subject.slice('folder:'.length)}`;
  if (subject.startsWith('scene:')) return `The screen ${subject.slice('scene:'.length)}`;
  if (subject.startsWith('impact:')) {
    const rest = subject.slice('impact:'.length);
    return `Outside action: ${rest.slice(rest.indexOf(':') + 1).replace(/_/g, ' ')}`;
  }
  if (subject.startsWith('verb:')) {
    const words = subject.slice('verb:'.length).replace(/_/g, ' ');
    return words.charAt(0).toUpperCase() + words.slice(1);
  }
  return subject;
}

const when = (iso: string): string => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function PermissionsSection({ orgId, role }: { orgId: string; role: OrgRole }) {
  const grantsQuery = useQuery(`settings-consentgrants:${orgId}`, () => desk.listConsentGrants(orgId), [orgId]);
  useLive(['events'], () => grantsQuery.refetch());
  const [state, setState] = useState<RowState>(IDLE);
  const grants = grantsQuery.data ?? [];
  const standing = grants.filter((g) => g.revokedAt === null);
  const revoked = grants.filter((g) => g.revokedAt !== null);
  const canRevoke = can(role, 'approve_plan');

  const revoke = async (g: ConsentGrantRow): Promise<void> => {
    setState(IDLE);
    try {
      await desk.revokeConsentGrant(orgId, g.id);
      grantsQuery.refetch();
    } catch (err) {
      setState({ phase: 'failed', sentence: 'Could not take it back.', detail: errorText(err) });
    }
  };

  return (
    <>
      <Group title="Allowed without asking">
        {grantsQuery.error !== undefined ? <StatusLine state={{ phase: 'failed', sentence: 'Could not read the permissions.', detail: grantsQuery.error }} /> : null}
        {grantsQuery.data === undefined && grantsQuery.error === undefined ? <Empty>Loading…</Empty> : null}
        {grantsQuery.data !== undefined && standing.length === 0 ? (
          <Empty>Nothing yet. The AI asks every time until you approve a card that offers to remember.</Empty>
        ) : null}
        {standing.map((g) => (
          <Row key={g.id} label={subjectWords(g.subject)} hint={`Allowed ${when(g.grantedAt)}`}>
            {canRevoke ? (
              <ConfirmAction label="Take back" prompt="Ask every time again?" confirmLabel="Take back" workingLabel="Taking back…" onConfirm={() => revoke(g)} />
            ) : null}
          </Row>
        ))}
        <StatusLine state={state} />
      </Group>
      {revoked.length > 0 ? (
        <Group title="Taken back">
          {revoked.map((g) => (
            <Row key={g.id} label={subjectWords(g.subject)} hint={`Taken back ${when(g.revokedAt!)}`} />
          ))}
        </Group>
      ) : null}
    </>
  );
}
