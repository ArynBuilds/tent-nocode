-- Tier 14 (FR-219, D-57): a project = a folder granted ONCE as a subtree, carrying a name and
-- an optional verifyCommand. All iterative work under the subtree binds to the project; its
-- graph entity anchors project memory cross-thread. Archive is a tombstone, never a delete.
create table projects (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  path text not null,                -- stored verbatim as consented; matched normalized (case/slash)
  name text not null,
  verify_command text null,          -- D-59: no command -> outcomes labeled unverified
  created_by uuid not null,
  created_at timestamptz not null default now(),
  archived_at timestamptz null
);
alter table projects enable row level security;
create policy member_read_projects on projects for select using (org_id in (select user_org_ids()));
alter publication supabase_realtime add table projects;
