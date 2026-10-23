import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';

// Applies the published-apps (rooms) migration lineage in filename order with a tracking table.

const DEFAULT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export async function applyRoomsLineage(sql: postgres.Sql, dir: string = DEFAULT_DIR): Promise<string[]> {
  await sql.unsafe(`
    create table if not exists rooms_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )`);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const done = new Set((await sql<{ name: string }[]>`select name from rooms_migrations`).map((r) => r.name));
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const body = await readFile(join(dir, file), 'utf8');
    await sql.unsafe(body);
    await sql`insert into rooms_migrations (name) values (${file})`;
    applied.push(file);
  }
  return applied;
}
