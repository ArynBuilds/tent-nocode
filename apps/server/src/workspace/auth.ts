import type postgres from 'postgres';
import { ensureAccountOrg, type WorkspaceIdentity } from '@nodeloom/kernel';
import { verifyAccountToken } from '../accountToken.js';

/** Workspace door auth: the bearer is the desktop's account token; the account's workspace org resolves idempotently. */
export async function resolveWorkspaceIdentity(
  sql: postgres.Sql,
  bearer: string,
  tokenSecret: string,
): Promise<WorkspaceIdentity | null> {
  const who = bearer !== '' ? verifyAccountToken(bearer, tokenSecret) : null;
  if (who === null) return null;
  return ensureAccountOrg(sql, {
    userId: who.userId,
    ...(who.email !== undefined ? { email: who.email } : {}),
    ...(who.displayName !== undefined ? { displayName: who.displayName } : {}),
  });
}
