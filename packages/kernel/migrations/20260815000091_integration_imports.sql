-- THE IMPORT DOORS (the 2026-08-14 factory spec §8.3 + the overnight ruling
-- "leave them last, but build them all"): a migration door pulls a service's
-- data ONCE (page by page through the ONE integration dispatch door, {kind:
-- 'import'} provenance) and RECREATES it as an ordinary Tent NoCode Table -
-- schema inferred from the rows themselves, landed upsert-by-key (repeatable,
-- additive, the REC). This row is the import's whole record: what was asked,
-- where it lands, how far it got, and its one honest error.

create table integration_imports (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  connection_id uuid not null references integration_connections(id) on delete cascade,
  integration text not null,
  dataset text not null,
  params jsonb not null default '{}',
  status text not null default 'pending' check (status in ('pending', 'running', 'done', 'failed')),
  cursor text null,
  pages int not null default 0,
  rows_landed int not null default 0,
  error text null,
  created_by text not null,
  created_at timestamptz not null default now(),
  finished_at timestamptz null
);

create index integration_imports_by_org on integration_imports (org_id, status, created_at);
create index integration_imports_by_connection on integration_imports (connection_id, created_at);

alter table integration_imports enable row level security;
create policy member_read_integration_imports on integration_imports
  for select using (org_id in (select user_org_ids()));

-- The notify floor, WITH the table (the T38 §4b law).
create trigger desk_notify_integration_imports
  after insert or update on integration_imports
  for each row execute function public.desk_notify();
