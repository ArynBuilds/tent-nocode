import { randomBytes } from 'node:crypto';
import postgres from 'postgres';

/** One Postgres, two databases: rooms (published apps, its own lineage and RLS roles) and workspace
 * (everything authored). Idempotent; the serving roles take fresh passwords every boot. */

export interface HostDatabaseUrls {
  runtimeUrl: string;
  publishUrl: string;
  workspaceUrl: string;
}

export function withDatabase(superUrl: string, db: string, user?: { name: string; password: string }): string {
  const u = new URL(superUrl);
  u.pathname = `/${db}`;
  if (user !== undefined) {
    u.username = user.name;
    u.password = user.password;
  }
  return u.toString();
}

async function ensureDatabase(sql: postgres.Sql, name: string): Promise<void> {
  const [hit] = await sql<{ n: number }[]>`select 1 as n from pg_database where datname = ${name}`;
  if (hit === undefined) await sql.unsafe(`create database ${name}`);
}

/** Before the rooms lineage runs: the databases exist. */
export async function ensureHostDatabases(superUrl: string): Promise<void> {
  const sql = postgres(superUrl, { max: 1, onnotice: () => {} });
  try {
    await ensureDatabase(sql, 'rooms');
    await ensureDatabase(sql, 'workspace');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** After the rooms lineage created room_runtime and room_publish: they log in with this boot's passwords. */
export async function armServingRoles(superUrl: string): Promise<HostDatabaseUrls> {
  const runtime = { name: 'room_runtime', password: randomBytes(24).toString('hex') };
  const publish = { name: 'room_publish', password: randomBytes(24).toString('hex') };
  const sql = postgres(withDatabase(superUrl, 'rooms'), { max: 1, onnotice: () => {} });
  try {
    for (const role of [runtime, publish]) await sql.unsafe(`alter role ${role.name} login password '${role.password}'`);
  } finally {
    await sql.end({ timeout: 5 });
  }
  return {
    runtimeUrl: withDatabase(superUrl, 'rooms', runtime),
    publishUrl: withDatabase(superUrl, 'rooms', publish),
    workspaceUrl: withDatabase(superUrl, 'workspace'),
  };
}
