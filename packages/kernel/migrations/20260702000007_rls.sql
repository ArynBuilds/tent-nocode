-- Which orgs does the current (client) user belong to?
create or replace function public.user_org_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  select org_id from org_members where user_id = auth.uid()
$$;

-- Enable RLS everywhere. Kernel uses service role (bypasses RLS); clients get read-only, org-scoped.
alter table orgs           enable row level security;
alter table org_members    enable row level security;
alter table agents         enable row level security;
alter table agent_versions enable row level security;
alter table jobs           enable row level security;
alter table runs           enable row level security;
alter table messages       enable row level security;
alter table events         enable row level security;
alter table graph_nodes    enable row level security;
alter table graph_edges    enable row level security;

create policy member_read_orgs on orgs for select
  using (id in (select user_org_ids()));
create policy member_read_members on org_members for select
  using (org_id in (select user_org_ids()));
create policy member_read_agents on agents for select
  using (org_id in (select user_org_ids()));
create policy member_read_agent_versions on agent_versions for select
  using (agent_id in (select id from agents where org_id in (select user_org_ids())));
create policy member_read_jobs on jobs for select
  using (org_id in (select user_org_ids()));
create policy member_read_runs on runs for select
  using (org_id in (select user_org_ids()));
create policy member_read_messages on messages for select
  using (org_id in (select user_org_ids()));
create policy member_read_events on events for select
  using (org_id in (select user_org_ids()));
create policy member_read_graph_nodes on graph_nodes for select
  using (org_id in (select user_org_ids()));
create policy member_read_graph_edges on graph_edges for select
  using (org_id in (select user_org_ids()));

-- Client privileges: read-only. SELECT is granted (RLS narrows rows); write
-- privileges are deliberately NOT granted — client writes fail at the
-- privilege layer, one layer before RLS (defense in depth).
grant usage on schema public to authenticated;
grant select on all tables in schema public to authenticated;

-- Revoke dangerous pre-existing default privileges: TRUNCATE bypasses RLS
-- entirely (no per-row check), and clients need none of these.
-- VERSION-GUARDED 2026-08-13 (the link+eye E2 deploy): MAINTAIN is a PG17
-- privilege word; the workspace database runs this same lineage on the box's
-- PG16, where the word does not parse (and the privilege does not exist to
-- revoke). Same effect on both: clients hold none of these.
do $guard$
begin
  if current_setting('server_version_num')::int >= 170000 then
    execute 'revoke truncate, references, trigger, maintain on all tables in schema public from authenticated, anon';
    execute 'alter default privileges in schema public revoke truncate, references, trigger, maintain on tables from authenticated, anon';
  else
    execute 'revoke truncate, references, trigger on all tables in schema public from authenticated, anon';
    execute 'alter default privileges in schema public revoke truncate, references, trigger on tables from authenticated, anon';
  end if;
end
$guard$;
