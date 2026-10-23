import type postgres from 'postgres';
import { openEnvelope, sealEnvelope } from './envelope.js';

// The secrets store: account- or project-scoped, project-first resolution; write-only readback - resolveSecretValue is the executor-only door.

export interface SecretMeta {
  name: string;
  /** null = account-level (shared); a project id = that project alone. */
  projectId: string | null;
  updatedAt: string;
}

function assertName(name: string): void {
  if (name.trim() === '' || name.length > 128 || /\s/.test(name)) {
    throw new Error('a secret name must be 1-128 characters with no whitespace');
  }
}

/** Sets or blindly rotates a secret; the plaintext never lands in a row, a log, or a return value. */
export async function setSecretValue(
  sql: postgres.Sql, masterKey: Buffer,
  input: { orgId: string; projectId: string | null; name: string; value: string; createdBy: string },
): Promise<void> {
  assertName(input.name);
  const sealed = sealEnvelope(masterKey, input.value);
  if (input.projectId === null) {
    await sql`
      insert into secrets (org_id, project_id, name, sealed, created_by)
      values (${input.orgId}, null, ${input.name}, ${sealed}, ${input.createdBy})
      on conflict (org_id, name) where project_id is null do update
        set sealed = excluded.sealed, created_by = excluded.created_by, updated_at = now()`;
  } else {
    await sql`
      insert into secrets (org_id, project_id, name, sealed, created_by)
      values (${input.orgId}, ${input.projectId}, ${input.name}, ${sealed}, ${input.createdBy})
      on conflict (org_id, project_id, name) where project_id is not null do update
        set sealed = excluded.sealed, created_by = excluded.created_by, updated_at = now()`;
  }
}

export async function deleteSecretValue(
  sql: postgres.Sql, input: { orgId: string; projectId: string | null; name: string },
): Promise<void> {
  if (input.projectId === null) {
    await sql`delete from secrets where org_id = ${input.orgId} and project_id is null and name = ${input.name}`;
  } else {
    await sql`delete from secrets where org_id = ${input.orgId} and project_id = ${input.projectId} and name = ${input.name}`;
  }
}

/** Lists metadata alone - names, scopes, freshness; never sealed bytes. */
export async function listSecretMeta(sql: postgres.Sql, orgId: string): Promise<SecretMeta[]> {
  const rows = await sql<{ name: string; project_id: string | null; updated_at: Date }[]>`
    select name, project_id, updated_at from secrets
    where org_id = ${orgId}
    order by project_id nulls first, name asc`;
  return rows.map((r) => ({ name: r.name, projectId: r.project_id, updatedAt: r.updated_at.toISOString() }));
}

/** Executor-only: resolves a secret's plaintext, project scope first with account fallback; the value must never reach disk, the renderer, or an export. */
export async function resolveSecretValue(
  sql: postgres.Sql, masterKey: Buffer,
  input: { orgId: string; projectId: string | null; name: string },
): Promise<string | null> {
  const rows = input.projectId === null
    ? await sql<{ sealed: string; project_id: string | null }[]>`
        select sealed, project_id from secrets
        where org_id = ${input.orgId} and project_id is null and name = ${input.name}`
    : await sql<{ sealed: string; project_id: string | null }[]>`
        select sealed, project_id from secrets
        where org_id = ${input.orgId} and name = ${input.name}
          and (project_id = ${input.projectId} or project_id is null)
        order by project_id nulls last
        limit 1`;
  const row = rows[0];
  if (row === undefined) return null;
  return openEnvelope(masterKey, row.sealed);
}
