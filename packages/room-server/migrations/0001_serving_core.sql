-- THE SERVING LINEAGE 0001 — the curated serving core (FR-560/D-260, cloud plan Phase A).
-- Exactly the tables the imported kernel modules touch on the publish/serve/data paths,
-- shapes copied from the desktop lineage's live truth (pg_dump 2026-07-30), CURATED:
--   · desktop-only organs (threads/chat, jobs/runs, agents, genomes, browser, workspace
--     ledger, folder_grants, schedules — schedules are PROMPT-class, engine-driven, and
--     the room import graph carries no engine driver: they never enter the lineage) DO
--     NOT EXIST here; room binding kinds that would read them starve honestly (C-C).
--   · org_id columns = THE ACCOUNT's own org row (the account law, C0 adjudication a).
--   · org_members is the 1:1 account spine only — no membership lane exists.
--   · project_members is THE unified collaboration table (C0 adjudication b) — the
--     cloud plan's project_shares name died pre-birth.
-- Hardening (roles, FORCE RLS, grants, GUC policies) is 0003 — the lineage is born
-- hardened as a WHOLE; no serving table exists un-walled because 0003 ships in the
-- same lineage birth.

-- ---- identity spine ----
create table orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now(),
  config jsonb not null default '{}'::jsonb,
  -- THE 1:1 ACCOUNT JOIN (cloud spec §1.6): signup mints the account's own org row.
  account_user_id uuid unique not null references auth.users(id) on delete cascade
);

create type org_role as enum ('owner', 'admin', 'operator', 'viewer');
create table org_members (
  org_id uuid not null references orgs(id) on delete cascade,
  user_id uuid not null,
  role org_role not null,
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);

create table profiles (
  user_id uuid primary key,
  email text not null,
  display_name text,
  created_at timestamptz not null default now()
);

-- ---- projects + the unified members table ----
create table projects (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  path text,
  name text not null,
  verify_command text,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  -- Desktop migration 73 (THE EXPRESSION ARC E1, D-EX1) mirrored: the project's theme@1
  -- value set — the serving plane's themeCssForScene reads it to dress served scenes.
  theme jsonb
);

create type project_role as enum ('owner', 'builder', 'member');
create table project_members (
  project_id uuid not null references projects(id) on delete cascade,
  user_id uuid not null,
  role project_role not null,
  org_id uuid not null references orgs(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (project_id, user_id)
);
create index project_members_by_user on project_members (user_id);
create index project_members_by_org on project_members (org_id);

create table project_notes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  author text not null,
  body text not null check (char_length(body) >= 8 and char_length(body) <= 2000),
  superseded_by uuid references project_notes(id),
  created_at timestamptz not null default now()
);
create index project_notes_by_org on project_notes (org_id, created_at);
create index project_notes_by_project on project_notes (project_id, created_at);

-- ---- the record ----
create table events (
  id bigint generated always as identity primary key,
  org_id uuid references orgs(id),
  actor text not null,
  type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index events_org_idx on events (org_id, id);

create or replace function forbid_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'append-only: % rows are immutable', tg_table_name;
end $$;
create trigger events_append_only before delete or update on events
  for each row execute function forbid_mutation();

-- ---- scenes ----
create table scenes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  slug text not null,
  title text not null,
  status text not null default 'active' check (status in ('active', 'deleted')),
  head_revision integer not null default 0,
  document jsonb not null,
  schema_version integer not null default 1,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  bindings jsonb not null default '[]'::jsonb,
  actions jsonb not null default '[]'::jsonb,
  runtime text not null default 'cheirkit@1',
  -- Desktop migration 70 (R5, ruling 8d) mirrored: the evergreen opt-out pin —
  -- getSceneForServe reads it on the room path exactly as on tab://.
  runtime_locked boolean not null default false,
  seeded_from text,
  imported_from text,
  -- Cloud-curated widening: the project the scene belongs to (nullable — kernel
  -- authoring inserts don't set it). The account law's project-pair predicate reads it.
  project_id uuid references projects(id) on delete set null,
  unique (org_id, slug)
);

create table scene_revisions (
  id uuid primary key default gen_random_uuid(),
  scene_id uuid not null references scenes(id) on delete cascade,
  org_id uuid not null references orgs(id) on delete cascade,
  revision_no integer not null,
  ops jsonb not null,
  actor text not null,
  mutation_id integer not null,
  parent_revision_id uuid references scene_revisions(id),
  merge_parent_id uuid references scene_revisions(id),
  schema_version integer not null default 1,
  created_at timestamptz not null default now(),
  unique (scene_id, actor, mutation_id),
  unique (scene_id, revision_no)
);
create index scene_revisions_by_scene on scene_revisions (scene_id, revision_no desc);

create table component_definitions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  name text not null,
  version integer not null,
  definition jsonb not null,
  status text not null default 'active' check (status in ('active', 'retired')),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  unique (org_id, name, version)
);

-- Global redirect table (T36 longevity laws) — read by applyRevision; empty at birth.
create table component_redirects (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('componentType', 'property', 'enumValue')),
  old_name text not null,
  new_name text,
  since_version integer not null default 1,
  removed boolean not null default false,
  created_at timestamptz not null default now()
);

-- The sidebar-door row the import path mints (createSceneTab) — an imported scene
-- without one would land invisible (T36 law); rooms serve scenes, tabs are inert data.
create table tabs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  slug text not null,
  title text not null,
  status text not null default 'building' check (status in ('building', 'active', 'failed', 'deleted')),
  current_version integer not null default 0,
  created_by text not null,
  created_at timestamptz not null default now(),
  scene_id uuid references scenes(id),
  -- Desktop migration 69 (the project-landing ruling) mirrored: createSceneTab writes
  -- a real project_id at creation (nullable here — rooms serve scenes, tabs are inert).
  project_id uuid references projects(id) on delete set null,
  unique (org_id, slug)
);

-- ---- data ----
create table datasets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  name text not null,
  row_schema jsonb not null,
  created_at timestamptz not null default now(),
  deprecated_columns jsonb not null default '[]'::jsonb,
  key_columns jsonb,
  -- Cloud-curated widening (same rationale as scenes.project_id).
  project_id uuid references projects(id) on delete set null,
  unique (org_id, name)
);

create table dataset_rows (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  dataset_id uuid not null references datasets(id) on delete cascade,
  "row" jsonb not null,
  evidence_run_id uuid,
  created_at timestamptz not null default now()
);
create index dataset_rows_by_dataset on dataset_rows (dataset_id, created_at);

-- ---- the muscle's data half (execution happens in Part 2's fleet lanes) ----
create table operations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  name text not null,
  version integer not null,
  code text not null,
  code_hash text not null,
  runtime text not null check (runtime in ('wasm', 'native')),
  io_contract jsonb not null,
  provenance_run_id uuid,
  status text not null default 'active' check (status in ('active', 'retired')),
  created_by text not null,
  created_at timestamptz not null default now(),
  model_hash text,
  model_path text,
  model_license text,
  unique (org_id, name, version)
);

create table operation_executions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  operation text not null,
  version integer not null,
  inputs jsonb not null default '{}'::jsonb,
  trigger jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'running', 'succeeded', 'failed')),
  error text,
  started_at timestamptz,
  finished_at timestamptz,
  duration_ms integer,
  outputs jsonb,
  created_at timestamptz not null default now()
);
create index operation_executions_by_org on operation_executions (org_id, status, created_at);

create table derived_outputs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  run_id uuid,
  name text not null,
  kind text not null check (kind in ('array', 'raster')),
  descriptor jsonb not null,
  path_key text not null,
  content_hash text not null,
  status text not null default 'pending' check (status in ('pending', 'registered', 'missing')),
  created_at timestamptz not null default now(),
  stale_at timestamptz
);
create index derived_outputs_by_org_name on derived_outputs (org_id, name, created_at desc);

-- ---- the zero-model pulse (edge-fired; the room pulse mounts these in Part 2) ----
create table reactive_chains (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  operation text not null,
  inputs jsonb not null default '{}'::jsonb,
  watch text[] not null,
  enabled boolean not null default true,
  grant_mode text not null check (grant_mode in ('ask-approved', 'auto')),
  created_by text not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index reactive_chains_by_org on reactive_chains (org_id, created_at);

create table triggers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  kind text not null check (kind in ('dataset_threshold', 'output_registered', 'file_landed')),
  spec jsonb not null,
  action jsonb not null,
  enabled boolean not null default true,
  edge_state jsonb not null default '{}'::jsonb,
  created_by text not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index triggers_by_org on triggers (org_id, created_at);
