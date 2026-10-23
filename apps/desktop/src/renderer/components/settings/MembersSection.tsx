import { useQuery } from '../../lib/data/useQuery.js';
import { desk } from '../../lib/desk.js';
import threadStyles from '../thread/thread.module.css';
import styles from './settings.module.css';

// Members section: renders whatever listMembers returns; role is read-only text.
export function MembersSection({ orgId }: { orgId: string }) {
  const membersQuery = useQuery('settings:members', () => desk.listMembers(orgId), [orgId]);
  const members = membersQuery.data ?? [];

  return (
    <>
      <div className={styles.groupDesc}>Invites and role changes arrive with team mode — single-user today.</div>
      {membersQuery.loading && members.length === 0 ? (
        <div className={threadStyles.placeholder}>loading members…</div>
      ) : (
        members.map((m) => (
          <div className={styles.row} key={m.userId}>
            <div className={styles.rowText}>
              <div className={styles.rowTitle}>{m.displayName ?? m.email}</div>
              {m.displayName ? <div className={styles.rowDesc}>{m.email}</div> : null}
            </div>
            <div className={styles.rowCtl}>
              <span className={styles.rowUnit}>{m.role}</span>
            </div>
          </div>
        ))
      )}
    </>
  );
}
