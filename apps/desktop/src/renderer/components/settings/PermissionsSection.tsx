import type { OrgRole } from '@tent-nocode/core';
import type { ConsentGrantRow } from '../../../shared/ipc.js';
import { can } from '../../../shared/roles.js';
import { useLive } from '../../lib/data/useLive.js';
import { useQuery } from '../../lib/data/useQuery.js';
import { desk } from '../../lib/desk.js';
import styles from './settings.module.css';

// Permissions section: the ONE grant store, listed and revocable — grants are
// written only by approving an ask-once card; revoking makes the next ask card again.

/** Plain words for a grant subject. */
function subjectWords(subject: string): { title: string; mono: boolean } {
  if (subject.startsWith('folder:')) return { title: subject.slice('folder:'.length), mono: true };
  if (subject.startsWith('scene:')) return { title: `screen · ${subject.slice('scene:'.length)}`, mono: true };
  if (subject.startsWith('impact:')) {
    const rest = subject.slice('impact:'.length);
    const action = rest.slice(rest.indexOf(':') + 1);
    return { title: `real-world action · ${action}`, mono: false };
  }
  if (subject.startsWith('verb:')) return { title: subject.slice('verb:'.length).replace(/_/g, ' '), mono: false };
  return { title: subject, mono: false };
}

export function PermissionsSection({ orgId, role }: { orgId: string; role: OrgRole }) {
  const grantsQuery = useQuery(`settings-consentgrants:${orgId}`, () => desk.listConsentGrants(orgId), [orgId]);
  useLive(['events'], () => grantsQuery.refetch());
  const grants = grantsQuery.data ?? [];
  const canRevoke = can(role, 'approve_plan');

  async function revoke(g: ConsentGrantRow): Promise<void> {
    await desk.revokeConsentGrant(orgId, g.id);
    grantsQuery.refetch();
  }

  return (
    <>
      <div className={styles.groupH}>Standing consents</div>
      <div className={styles.groupDesc}>
        What may run without asking again — each granted by approving its card once. Revoking makes the next one ask.
      </div>
      {grants.length === 0 ? (
        <div className={styles.zero}>no standing consents</div>
      ) : (
        grants.map((g) => {
          const s = subjectWords(g.subject);
          return (
            <div className={styles.row} key={g.id}>
              <div className={styles.rowText}>
                <div className={[s.mono ? styles.rowMono : styles.rowTitle, g.revokedAt ? styles.rowStruck : ''].filter(Boolean).join(' ')}>
                  {s.title}
                </div>
                <div className={styles.rowDesc}>
                  {g.revokedAt ? `revoked ${new Date(g.revokedAt).toLocaleString()}` : `granted ${new Date(g.grantedAt).toLocaleString()}`}
                </div>
              </div>
              {canRevoke && g.revokedAt === null ? (
                <div className={styles.rowCtl}>
                  <button type="button" className={styles.rowBtn} onClick={() => void revoke(g)}>
                    revoke
                  </button>
                </div>
              ) : null}
            </div>
          );
        })
      )}
    </>
  );
}
