import { useState } from 'react';
import type { ProjectRoleDto } from '../../../shared/ipc.js';
import { desk } from '../../lib/desk.js';
import { useQuery } from '../../lib/data/useQuery.js';
import { useOrg } from '../../lib/OrgContext.js';
import { ConfirmAction, CopyValue, Empty, Group, IDLE, Item, Row, SectionHead, StatusLine, errorText, kit, refusalOf, type RowState } from './kit.js';
import type { ProjectNavItem } from './projectNav.js';
import styles from './project.module.css';

// Project people: add by account id, change a role in place, remove; the account owner owns every project.

const ROLES: Array<{ id: ProjectRoleDto; label: string }> = [
  { id: 'member', label: 'Member' },
  { id: 'builder', label: 'Builder' },
  { id: 'owner', label: 'Owner' },
];

type Write = Promise<{ ok: boolean; error?: string; data?: unknown }>;

export function PeopleSection({ item, orgId, projectId }: { item: ProjectNavItem; orgId: string; projectId: string }) {
  const me = useOrg();
  const members = useQuery(`project-members:${projectId}`, () => desk.listProjectMembers(orgId, projectId), [orgId, projectId]);
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState<ProjectRoleDto>('member');
  const [addState, setAddState] = useState<RowState>(IDLE);
  const [listState, setListState] = useState<RowState>(IDLE);
  const rows = members.data?.members ?? [];

  const run = async (p: Write, failed: string, onState: (s: RowState) => void): Promise<boolean> => {
    try {
      const refusal = refusalOf(await p);
      members.refetch();
      if (refusal !== null) { onState({ phase: 'failed', sentence: failed, detail: refusal }); return false; }
      return true;
    } catch (err) {
      onState({ phase: 'failed', sentence: failed, detail: errorText(err) });
      return false;
    }
  };

  const add = (): void => {
    const id = userId.trim();
    if (id === '') return;
    setAddState({ phase: 'working', sentence: 'Adding…' });
    void run(desk.addProjectMember(orgId, projectId, id, role), 'Could not add this person.', setAddState).then((ok) => {
      if (!ok) return;
      setAddState({ phase: 'done', sentence: 'Added.' });
      setUserId('');
    });
  };

  return (
    <>
      <SectionHead title={item.label} description={item.description} />
      <Group title="Your account">
        {me.role === 'owner' ? (
          <Row label={me.displayName !== '' ? me.displayName : me.email} hint="You own every project in this account.">
            <span className={kit.value}>Owner</span>
          </Row>
        ) : null}
        <Row label="Your account id" hint="Give this to someone who wants to add you to their project." stack>
          <CopyValue value={me.userId} />
        </Row>
      </Group>
      <Group title="Add someone">
        <form className={styles.inlineForm} onSubmit={(e) => { e.preventDefault(); add(); }}>
          <input
            className={`${kit.input} ${kit.mono}`}
            placeholder="Account id"
            aria-label="Account id"
            value={userId}
            spellCheck={false}
            onChange={(e) => { setUserId(e.target.value); setAddState(IDLE); }}
          />
          <select className={kit.select} value={role} aria-label="Role" onChange={(e) => setRole(e.target.value as ProjectRoleDto)}>
            {ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
          </select>
          <button type="submit" className={kit.btn} disabled={userId.trim() === '' || addState.phase === 'working'}>Add</button>
        </form>
        <StatusLine state={addState} />
      </Group>
      <Group title="People on this project">
        {members.error !== undefined ? <StatusLine state={{ phase: 'failed', sentence: 'Could not read the people on this project.', detail: members.error }} /> : null}
        {members.data === undefined && members.error === undefined ? <Empty>Loading…</Empty> : null}
        {members.data !== undefined && rows.length === 0 ? <Empty>Only you so far.</Empty> : null}
        {rows.map((m) => (
          <Item key={m.userId} name={m.userId} note={`Added ${new Date(m.createdAt).toLocaleDateString()}`}>
            <select
              className={kit.select}
              value={m.role}
              aria-label={`Role for ${m.userId}`}
              onChange={(e) => {
                setListState(IDLE);
                void run(desk.changeProjectMemberRole(orgId, projectId, m.userId, e.target.value as ProjectRoleDto), 'Could not change the role.', setListState);
              }}
            >
              {ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </select>
            <ConfirmAction
              label="Remove"
              prompt="Remove from this project?"
              confirmLabel="Remove"
              workingLabel="Removing…"
              onConfirm={async () => {
                setListState(IDLE);
                await run(desk.removeProjectMember(orgId, projectId, m.userId), 'Could not remove this person.', setListState);
              }}
            />
          </Item>
        ))}
        <StatusLine state={listState} />
      </Group>
    </>
  );
}
