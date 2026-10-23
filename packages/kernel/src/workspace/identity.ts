import type postgres from 'postgres';
import type { WorkspaceIdentity } from './registry.js';

export interface AccountRef {
  /** The site account's user id (a uuid from the JWT sub). */
  userId: string;
  email?: string;
  displayName?: string;
}

export async function ensureAccountOrg(sql: postgres.Sql, who: AccountRef): Promise<WorkspaceIdentity> {
  const name = who.displayName ?? who.email ?? 'account';
  const existing = await sql<{ org_id: string }[]>`
    select org_id from org_members where user_id = ${who.userId}
    order by created_at asc, org_id asc limit 1`;
  const first = existing[0];
  if (first) {
    return { userId: who.userId, orgId: first.org_id, role: 'owner', displayName: name, email: who.email ?? '' };
  }
  const orgId = await sql.begin(async (txRaw) => {
    const tx = txRaw as unknown as postgres.Sql;
    const [again] = await tx<{ org_id: string }[]>`
      select org_id from org_members where user_id = ${who.userId}
      order by created_at asc, org_id asc limit 1`;
    if (again) return again.org_id;
    const [org] = await tx<{ id: string }[]>`
      insert into orgs (name) values (${`${name}'s workspace`}) returning id`;
    if (!org) throw new Error('failed to create the account workspace');
    await tx`insert into org_members (org_id, user_id, role) values (${org.id}, ${who.userId}, 'owner')`;
    await tx`
      insert into profiles (user_id, email, display_name)
      values (${who.userId}, ${who.email ?? ''}, ${name})
      on conflict (user_id) do nothing`;
    return org.id;
  });
  return { userId: who.userId, orgId, role: 'owner', displayName: name, email: who.email ?? '' };
}
