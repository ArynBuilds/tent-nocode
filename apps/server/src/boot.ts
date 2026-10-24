import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { DowngradeError, emitEvent, runMigrations, type RunMigrationsResult } from '@nodeloom/kernel';
import type { ServerConfig } from './config.js';
import { ConfigRefusal } from './config.js';

export interface ServerIdentity {
  orgId: string;
  ownerUserId: string;
  visitorUserId: string;
}

export interface BootResult {
  sql: postgres.Sql;
  identity: ServerIdentity;
  migrations: RunMigrationsResult;
}

const ORG_NAME = 'nodeloom-server';
const OWNER_EMAIL = 'owner@server.local';
const VISITOR_EMAIL = 'visitor@server.local';

async function ensureServerLocalTable(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(`
    create table if not exists server_local (
      id int primary key check (id = 1),
      org_id uuid not null,
      owner_user_id uuid not null,
      visitor_user_id uuid not null
    );
  `);
}

export async function bootstrapServerIdentity(sql: postgres.Sql): Promise<{ identity: ServerIdentity; created: boolean }> {
  await ensureServerLocalTable(sql);
  const existing = await sql<{ org_id: string; owner_user_id: string; visitor_user_id: string }[]>`
    select org_id, owner_user_id, visitor_user_id from server_local where id = 1`;
  const first = existing[0];
  if (first) {
    const [org] = await sql<{ id: string }[]>`select id from orgs where id = ${first.org_id}`;
    if (org) {
      return {
        identity: { orgId: first.org_id, ownerUserId: first.owner_user_id, visitorUserId: first.visitor_user_id },
        created: false,
      };
    }
    await sql`delete from server_local where id = 1`;
  }
  const identity = await sql.begin(async (txRaw) => {
    const tx = txRaw as unknown as postgres.Sql;
    const [org] = await tx<{ id: string }[]>`insert into orgs (name) values (${ORG_NAME}) returning id`;
    if (!org) throw new Error('failed to create the server org');
    const ownerUserId = randomUUID();
    const visitorUserId = randomUUID();
    await tx`insert into org_members (org_id, user_id, role) values (${org.id}, ${ownerUserId}, 'owner')`;
    await tx`insert into profiles (user_id, email, display_name) values (${ownerUserId}, ${OWNER_EMAIL}, ${'Owner'})`;
    await tx`insert into profiles (user_id, email, display_name) values (${visitorUserId}, ${VISITOR_EMAIL}, ${'Visitor'})`;
    await tx`insert into server_local (id, org_id, owner_user_id, visitor_user_id)
      values (1, ${org.id}, ${ownerUserId}, ${visitorUserId})`;
    return { orgId: org.id, ownerUserId, visitorUserId };
  });
  await emitEvent(sql, {
    orgId: identity.orgId, actor: 'server', type: 'server.provisioned',
    payload: { orgName: ORG_NAME },
  });
  return { identity, created: true };
}

/** Migrations first (downgrade guard BEFORE any DDL), then the identity bootstrap. */
export async function bootServer(cfg: ServerConfig): Promise<BootResult> {
  const migrations = await runMigrations(cfg.databaseUrl, cfg.migrationsDir);
  const sql = postgres(cfg.databaseUrl, { max: 8, onnotice: () => {} });
  const { identity } = await bootstrapServerIdentity(sql);
  return { sql, identity, migrations };
}


export function bootFailureSentence(err: unknown): { sentence: string; detail: string } {
  const detail = err instanceof Error ? `${err.name}: ${err.message}` : `non-Error throw: ${JSON.stringify(err)}`;
  if (err instanceof DowngradeError) {
    return {
      sentence: 'This database was created by a NEWER version of this app. '
        + 'Update the server (nodeloom update), or point DATABASE_URL at a fresh database. Nothing was changed.',
      detail,
    };
  }
  if (err instanceof ConfigRefusal) {
    return { sentence: err.message, detail };
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/ECONNREFUSED|ENOTFOUND|connect|CONNECTION_/i.test(msg)) {
    return {
      sentence: 'Could not reach the database at DATABASE_URL. '
        + 'Check that Postgres is running and the URL is right. Nothing was changed.',
      detail,
    };
  }
  if (/Migration failed:/.test(msg)) {
    return {
      sentence: 'A database migration failed partway. The failing step is named below; '
        + 'already-applied steps are safe (each runs in its own transaction).',
      detail,
    };
  }
  return { sentence: "The server couldn't start. The exact error is below.", detail };
}
