-- Tier 9 (FR-152/155): chat-built tabs. Versions are immutable; bundles hash-pinned;
-- datasets are the one agent-writable surface, schema-verified at append (FR-155).
-- (Plan named this file ...000022_tabs.sql; slot 22 was taken by tool_consent — renumbered.)

create table tabs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  slug text not null,
  title text not null,
  status text not null default 'building' check (status in ('building', 'active', 'failed', 'deleted')),
  current_version int not null default 0,
  created_by text not null,
  created_at timestamptz not null default now(),
  unique (org_id, slug)
);

create table tab_versions (
  id uuid primary key default gen_random_uuid(),
  tab_id uuid not null references tabs(id) on delete cascade,
  version int not null,
  bundle text not null,
  sha256 text not null,
  manifest jsonb not null,
  parent_version int null,
  lineage_note text null,
  created_by text not null,
  created_at timestamptz not null default now(),
  unique (tab_id, version)
);

create table datasets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  name text not null,
  row_schema jsonb not null,
  created_at timestamptz not null default now(),
  unique (org_id, name)
);

create table dataset_rows (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  dataset_id uuid not null references datasets(id) on delete cascade,
  row jsonb not null,
  evidence_run_id uuid null,
  created_at timestamptz not null default now()
);

alter table tabs enable row level security;
alter table tab_versions enable row level security;
alter table datasets enable row level security;
alter table dataset_rows enable row level security;
create policy member_read_tabs on tabs for select using (org_id in (select user_org_ids()));
create policy member_read_tab_versions on tab_versions for select using (tab_id in (select id from tabs where org_id in (select user_org_ids())));
create policy member_read_datasets on datasets for select using (org_id in (select user_org_ids()));
create policy member_read_dataset_rows on dataset_rows for select using (org_id in (select user_org_ids()));

-- Live pointers (FR-157 sidebar + FR-154 refetch): reuse the Tier-5 notify function.
create trigger tabs_notify after insert or update on tabs for each row execute function desk_notify();
create trigger dataset_rows_notify after insert on dataset_rows for each row execute function desk_notify();

-- D-33: the Artisan is the third reserved genome — widen the FR-148 CHECK for 'workshop'.
alter table agents drop constraint agents_reserved_check;
alter table agents add constraint agents_reserved_check check (reserved in ('voice', 'hands', 'workshop'));
