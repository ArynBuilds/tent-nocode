-- THE SERVING LINEAGE 0016 - FLOWS ON THE SERVING PLANE: the flow tables join the rooms lineage so
-- published apps can run flows; publishes become project-homed (publish.ts); the host sweeps flows +
-- triggers over THIS database beside the workspace pool (host.ts).
--
-- ---- §2 THE PROJECT HOME'S OWN SHAPE --------------------------------------
-- createChatProject (the ONE birth door, D-PT1) writes `kind` - the workspace
-- gained it at 20260813000079; the serving lineage mirrors it here so
-- findOrBirthProjectForPackage runs on the publish lane.
alter table projects add column kind text null check (kind in ('app', 'website'));

-- Per-project live-name uniqueness (the workspace containment migration 075 §5
-- mirrored, with the serving plane's nullable-project twist): project-homed
-- publishes collide within THEIR project alone; the null-project (whole-account)
-- lane keeps its org-wide uniqueness. Tables are empty here (§1) - no conflicts.
alter table component_definitions drop constraint component_definitions_org_id_name_version_key;
create unique index component_definitions_project_name_version
  on component_definitions (project_id, name, version) where project_id is not null;
create unique index component_definitions_org_name_version_nullproj
  on component_definitions (org_id, name, version) where project_id is null;
alter table operations drop constraint operations_org_id_name_version_key;
create unique index operations_project_name_version
  on operations (project_id, name, version) where project_id is not null;
create unique index operations_org_name_version_nullproj
  on operations (org_id, name, version) where project_id is null;
drop index datasets_org_name_live;
create unique index datasets_project_name_live
  on datasets (project_id, name) where project_id is not null and deleted_at is null;
create unique index datasets_org_name_live_nullproj
  on datasets (org_id, name) where project_id is null and deleted_at is null;

-- ---- §3 THE TRIGGER VOCABULARY CATCHES UP (workspace 86/94/95 mirrored) ----
alter table triggers drop constraint triggers_kind_check;
alter table triggers add constraint triggers_kind_check
  check (kind in ('dataset_threshold', 'output_registered', 'file_landed', 'webhook_in', 'schedule', 'cron', 'interval', 'rows_changed'));

-- ---- §4 THE FLOW TABLES (workspace 20260815000093 mirrored, born hardened) --
-- NO desk_notify here: the function is a desk organ that never entered this
-- lineage - serving liveness is the served feeder's short poll (fork-7 ruling).
create table flows (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  name text not null,
  -- The compiled flow document (core flowDocSchema - branded, migratable).
  doc jsonb not null,
  enabled boolean not null default true,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index flows_live_name on flows (project_id, name) where deleted_at is null;
create index flows_org on flows (org_id, created_at);

create table flow_executions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  flow_id uuid not null references flows(id) on delete cascade,
  -- The doc SNAPSHOT the run executes against (edits never mutate a live run).
  doc jsonb not null,
  -- The branded envelope (core flowEnvelopeSchema), persisted EVERY step.
  envelope jsonb not null,
  trigger jsonb not null default '{}'::jsonb,
  status text not null default 'pending'
    check (status in ('pending', 'running', 'waiting', 'succeeded', 'failed')),
  wait_till timestamptz,
  steps_run int not null default 0,
  step_budget int not null default 500,
  deadline timestamptz not null default now() + interval '15 minutes',
  error text,
  parent_execution_id uuid references flow_executions(id) on delete set null,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now()
);
create index flow_executions_claim on flow_executions (org_id, status, created_at);
create index flow_executions_flow on flow_executions (flow_id, created_at);
create index flow_executions_waiting on flow_executions (status, wait_till);

-- Wall 2: least grants. SELECT arrives via 0003's default privileges.
-- room_publish lands travel entries (saveFlow insert/update + the disabled
-- Watcher rows) and compensates a failed release append (the deletes).
grant insert, update, delete on flows to room_publish;
-- select included: the 0003 grant list omitted triggers for room_publish and
-- default privileges cover post-0003 tables alone - the landing's
-- insert..returning needs it.
grant select, insert, delete on triggers to room_publish;
-- room_runtime queues visitor runs (the act door's start_flow arm), claims and
-- settles them (the rooms sweep), and moves trigger edge_state / auto-disables.
grant insert, update on flow_executions to room_runtime;
grant update on triggers to room_runtime;

-- Wall 3: FORCE RLS + the (account, project) pair predicate (the 0003 idiom -
-- both tables carry project_id, so they join the scenes/datasets policy class).
do $$
declare t text;
begin
  foreach t in array array['flows', 'flow_executions']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy %I on %I as permissive for all to room_runtime, room_publish '
      || 'using (org_id = (select nullif(current_setting(''app.org_id'', true), '''')::uuid) and '
      || '  ((select nullif(current_setting(''app.project_id'', true), '''')::uuid) is null or project_id = '
      || '   (select nullif(current_setting(''app.project_id'', true), '''')::uuid))) '
      || 'with check (org_id = (select nullif(current_setting(''app.org_id'', true), '''')::uuid))',
      t || '_org_project', t);
  end loop;
end $$;

-- ---- §5 THE SWEEP DISCOVERY DOORS -----------------------------------------
-- FORCE RLS means room_runtime with no tenant context honestly sees ZERO rows -
-- so the host's rooms sweep discovers due orgs through SECURITY DEFINER
-- windows (the lookup_app idiom) and then runs each org's sweep on a
-- session-pinned connection (born, used once, ended - the publish-door S1
-- discipline; host.ts owns the loop).
create or replace function flow_sweep_due_orgs(p_limit int default 5) returns setof uuid
language sql security definer stable set search_path = public as $$
  select org_id from flow_executions
  where status = 'pending' or (status = 'waiting' and wait_till is not null and wait_till <= now())
  group by org_id
  order by min(created_at) asc
  limit p_limit
$$;
create or replace function trigger_sweep_due_orgs(p_limit int default 5) returns setof uuid
language sql security definer stable set search_path = public as $$
  select distinct org_id from triggers where enabled = true and revoked_at is null limit p_limit
$$;
revoke all on function flow_sweep_due_orgs(int), trigger_sweep_due_orgs(int) from public;
grant execute on function flow_sweep_due_orgs(int) to room_runtime;
grant execute on function trigger_sweep_due_orgs(int) to room_runtime;
