-- THE SERVING LINEAGE 0003 — born hardened (FR-565/D-261 the three walls' Wall 2+3;
-- the §2 gap-closure inventory executed at lineage birth, not patched later).
--
-- SPIKE S1 LAWS (2026-07-30, measured): every GUC reference in a policy is the
-- SELECT-WRAPPED form (InitPlan, once per query — bare current_setting() measured 48%
-- p95 overhead; wrapped 0.5%). Role creation is idempotent (PG roles are cluster-wide).
-- No password ever appears in a migration (audit gap 18 birth-law): roles are born
-- NOLOGIN; ops grants LOGIN + password out-of-band.

-- ---- Wall 2: privilege — two roles, least grant ----
do $$ begin
  create role room_runtime nologin nosuperuser nocreatedb nocreaterole;
exception when duplicate_object then null; end $$;
do $$ begin
  create role room_publish nologin nosuperuser nocreatedb nocreaterole;
exception when duplicate_object then null; end $$;

grant usage on schema public to room_runtime, room_publish;

-- room_runtime (visitor lanes): SELECT on the serving set; writes ONLY where visitor
-- lanes write (declared actions: dataset rows incl. T51 update/delete-by-row-id;
-- op-execution enqueue; the record). NO grant on any identity table.
grant select on orgs, projects, project_members, project_notes, scenes, scene_revisions,
  component_definitions, component_redirects, tabs, datasets, dataset_rows, operations,
  operation_executions, derived_outputs, reactive_chains, triggers, events,
  rooms, room_apps, room_releases, room_domains to room_runtime;
grant insert, update, delete on dataset_rows to room_runtime;
grant insert on operation_executions, events to room_runtime;

-- room_publish (the publish door): the T48 import set, transactional landing +
-- compensating deletes. events stays append-only via trigger regardless of grants.
grant select on orgs, projects, project_members, project_notes, scenes, scene_revisions,
  component_definitions, component_redirects, tabs, datasets, dataset_rows, operations,
  events, rooms, room_apps, room_releases, room_domains to room_publish;
grant insert, update, delete on projects, project_notes, scenes, scene_revisions,
  component_definitions, tabs, datasets, dataset_rows, operations to room_publish;
grant insert on events, room_releases to room_publish;
grant insert, update on rooms, room_apps, room_domains to room_publish;

grant usage on all sequences in schema public to room_runtime, room_publish;

-- THE S1 FIX (gap 4 — the 24-unreachable-policies find): later-born tables are
-- reachable without a fresh grant ceremony; policies still narrow every row.
alter default privileges in schema public grant select on tables to room_runtime, room_publish;
alter default privileges in schema public grant usage on sequences to room_runtime, room_publish;

-- ---- identity resolution without table exposure (the publish door's only identity
-- surface): SECURITY DEFINER pair — resolve or mint the 1:1 account org row. ----
create or replace function resolve_account_org(p_user uuid) returns uuid
language sql security definer stable set search_path = public as $$
  select id from orgs where account_user_id = p_user
$$;
create or replace function mint_account_org(p_user uuid, p_name text, p_email text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_org uuid;
begin
  select id into v_org from orgs where account_user_id = p_user;
  if v_org is not null then return v_org; end if;
  insert into orgs (name, account_user_id) values (p_name, p_user) returning id into v_org;
  insert into org_members (org_id, user_id, role) values (v_org, p_user, 'owner');
  insert into profiles (user_id, email, display_name) values (p_user, p_email, p_name)
    on conflict (user_id) do nothing;
  return v_org;
end $$;
revoke all on function resolve_account_org(uuid), mint_account_org(uuid, text, text) from public;
grant execute on function resolve_account_org(uuid) to room_publish, room_runtime;
grant execute on function mint_account_org(uuid, text, text) to room_publish;

-- The routing lookup runs BEFORE tenant context exists (it is what establishes it):
-- a SECURITY DEFINER window exposing exactly the routing row, nothing else.
create or replace function lookup_app(p_slug text)
returns table (org_id uuid, room_id uuid, app_id uuid, app_slug text,
               current_release_id uuid, visibility text, room_status text)
language sql security definer stable set search_path = public as $$
  select a.org_id, a.room_id, a.id, a.app_slug, a.current_release_id, a.visibility, r.status
  from room_apps a join rooms r on r.id = a.room_id
  where a.app_slug = p_slug
$$;
revoke all on function lookup_app(text) from public;
grant execute on function lookup_app(text) to room_runtime, room_publish;

-- ---- Wall 3: RLS, finally enforced — FORCE everywhere, GUC policies ----
do $$
declare t text;
begin
  foreach t in array array[
    'orgs','org_members','profiles','projects','project_members','project_notes',
    'scenes','scene_revisions','component_definitions','component_redirects','tabs',
    'datasets','dataset_rows','operations','operation_executions','derived_outputs',
    'reactive_chains','triggers','events','rooms','room_apps','room_releases',
    'room_domains']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
  end loop;
end $$;

-- Org-scoped read+write policies for the serving roles. The PROJECT PAIR (account law):
-- project-reachable tables additionally honor app.project_id when set — a shared user's
-- context resolves to (owning account, project) and reaches ONE project's slice.
do $$
declare t text;
begin
  -- plain org-scoped tables (no project column)
  foreach t in array array[
    'org_members','project_notes','scene_revisions','component_definitions','tabs',
    'dataset_rows','operations','operation_executions','derived_outputs',
    'reactive_chains','triggers','events','rooms','room_apps','room_releases',
    'room_domains']
  loop
    execute format(
      'create policy %I on %I as permissive for all to room_runtime, room_publish '
      || 'using (org_id = (select nullif(current_setting(''app.org_id'', true), '''')::uuid)) '
      || 'with check (org_id = (select nullif(current_setting(''app.org_id'', true), '''')::uuid))',
      t || '_org', t);
  end loop;
  -- project-reachable tables: the (account, project) pair predicate
  foreach t in array array['projects', 'project_members', 'scenes', 'datasets']
  loop
    execute format(
      'create policy %I on %I as permissive for all to room_runtime, room_publish '
      || 'using (org_id = (select nullif(current_setting(''app.org_id'', true), '''')::uuid) and '
      || '  ((select nullif(current_setting(''app.project_id'', true), '''')::uuid) is null or %s = '
      || '   (select nullif(current_setting(''app.project_id'', true), '''')::uuid))) '
      || 'with check (org_id = (select nullif(current_setting(''app.org_id'', true), '''')::uuid))',
      t || '_org_project', t, case when t = 'projects' then 'id' else 'project_id' end);
  end loop;
end $$;

create policy orgs_self on orgs as permissive for select to room_runtime, room_publish
  using (id = (select nullif(current_setting('app.org_id', true), '')::uuid));
create policy profiles_org on profiles as permissive for select to room_runtime, room_publish
  using (user_id in (select user_id from org_members
                     where org_id = (select nullif(current_setting('app.org_id', true), '')::uuid)));
create policy redirects_global_read on component_redirects as permissive for select
  to room_runtime, room_publish using (true);
