import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';

// Migration machinery shared by both hosts; the prelude and transform make Supabase-shaped DDL run on vanilla Postgres.

export const DESK_PRELUDE_NAME = '0000_desk_prelude.sql';

// Vanilla-PG prelude applied first; never run against real Supabase.
export const DESK_PRELUDE_SQL = `-- Desktop-only prelude, applied FIRST (before packages/kernel/migrations/0001...).
-- Shipped as a kernel constant (packages/kernel/src/migrate.ts), NOT under
-- packages/kernel/migrations: it is never run against real Supabase (which already
-- has all of this built in).
--
-- Its job is to make a bare Postgres look enough like Supabase that
-- migrations 0001-0013 apply completely unmodified (aside from the
-- vector transform in applyDesktopTransform, per D-9). Single-user hosts
-- connect as the cluster superuser, so RLS policies that reference these
-- stand-ins are inert by construction.

-- auth.users + auth.uid(): migration 0013 creates a trigger on auth.users,
-- and RLS policies across 0007/0008/0013 call auth.uid(). The trigger never
-- fires on desktop (Task 5 seeds profiles directly); auth.uid() is only
-- evaluated for RLS, which the superuser bypasses anyway.
create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key,
  email text
);

create or replace function auth.uid() returns uuid
language sql stable
as $$ select null::uuid $$;

-- Client roles referenced as GRANT/REVOKE targets in 0007/0008/0013. No
-- client role ever connects on desktop (main uses the superuser connection),
-- so these exist only so the GRANT/REVOKE statements parse and succeed.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role;
  end if;
end $$;

-- Stub publication: migration 0013 adds tables to supabase_realtime for
-- Supabase Realtime. Nothing subscribes to it on desktop, but the ALTER
-- PUBLICATION ... ADD TABLE statement must have a publication to target.
-- CREATE PUBLICATION has no IF NOT EXISTS, so guard it explicitly.
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;
`;

export interface MigrationFile {
  name: string;
  /** Absolute path on disk; empty string for the prelude. */
  path: string;
}

/** Prelude first, then every `<migrationsDir>/*.sql` file in filename order. */
export function getOrderedMigrations(migrationsDir: string): MigrationFile[] {
  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b));
  return [
    { name: DESK_PRELUDE_NAME, path: '' },
    ...files.map((name) => ({ name, path: join(migrationsDir, name) })),
  ];
}

// Drops the pgvector extension statement and swaps the embedding column to jsonb; never touches files on disk.
export function applyDesktopTransform(sql: string): string {
  return sql
    .replace(
      /^\s*create extension if not exists vector;\s*$/im,
      '-- (desktop) vector extension skipped: no pgvector in embedded Postgres, see D-9',
    )
    .replace(/capability_embedding\s+vector\(768\)/i, 'capability_embedding jsonb');
}

export interface RunMigrationsResult {
  applied: string[];
  skipped: string[];
}

// Downgrade guard: an older app refuses to boot over a newer database before any DDL runs.
export class DowngradeError extends Error {
  readonly unknownApplied: string[];
  constructor(unknownApplied: string[]) {
    super(
      `database is newer than this app: ${unknownApplied.length} applied migration(s) this build does not ship `
      + `(${unknownApplied.slice(0, 3).join(', ')}${unknownApplied.length > 3 ? ', …' : ''})`,
    );
    this.name = 'DowngradeError';
    this.unknownApplied = unknownApplied;
  }
}

// Applied names the shipped set does not carry.
export function detectDowngrade(appliedNames: readonly string[], shippedNames: readonly string[]): string[] {
  const shipped = new Set(shippedNames);
  return appliedNames.filter((name) => !shipped.has(name)).sort();
}

// Prelude comes from the constant, everything else from disk.
function readMigrationSource(migration: MigrationFile): string {
  return migration.name === DESK_PRELUDE_NAME ? DESK_PRELUDE_SQL : readFileSync(migration.path, 'utf8');
}

async function ensureTrackingTable(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(`
    create table if not exists _desk_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    );
  `);
}

// Apply the prelude then every .sql file in order, idempotently; each file runs in one transaction.
export async function runMigrations(connectionString: string, migrationsDir: string): Promise<RunMigrationsResult> {
  const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
  const applied: string[] = [];
  const skipped: string[] = [];
  try {
    await ensureTrackingTable(sql);
    const migrations = getOrderedMigrations(migrationsDir);
    // Refuse a newer database before any DDL runs.
    const appliedRows = await sql<{ name: string }[]>`select name from _desk_migrations`;
    const appliedSet = new Set(appliedRows.map((r) => r.name));
    const unknown = detectDowngrade([...appliedSet], migrations.map((m) => m.name));
    if (unknown.length > 0) throw new DowngradeError(unknown);
    for (const migration of migrations) {
      if (appliedSet.has(migration.name)) {
        skipped.push(migration.name);
        continue;
      }
      const raw = readMigrationSource(migration);
      const transformed = applyDesktopTransform(raw);
      try {
        await sql.begin(async (tx) => {
          await tx.unsafe(transformed);
          await tx`insert into _desk_migrations (name) values (${migration.name})`;
        });
      } catch (err) {
        throw new Error(`Migration failed: ${migration.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
      applied.push(migration.name);
    }
  } finally {
    await sql.end();
  }
  return { applied, skipped };
}
