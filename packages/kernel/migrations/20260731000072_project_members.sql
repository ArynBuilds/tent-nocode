-- Server brain B-S3 (FR-579/580, D-271): PROJECT MEMBERS — the UNIFIED table (C0
-- adjudication b). SAME name + shape as the cloud serving lineage's
-- (cloud/migrations/0001) so ONE module (kernel rooms/members.ts) and ONE adversarial
-- suite serve both lineages — the one-security-brain dividend. The account law: orgs
-- die as a concept; collaboration is PER-PROJECT. `org_id` = the OWNING account's row
-- (plumbing name, account concept), denormalized for RLS predicates.

create type project_role as enum ('owner', 'builder', 'member');

create table project_members (
  project_id  uuid not null references projects(id) on delete cascade,
  user_id     uuid not null,
  role        project_role not null,
  org_id      uuid not null references orgs(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (project_id, user_id)
);
create index project_members_by_user on project_members (user_id);
create index project_members_by_org on project_members (org_id);

alter table project_members enable row level security;
-- The desktop client-read policy in the existing member_read idiom (service role bypasses;
-- clients see only their own account's project-member rows).
create policy member_read_project_members on project_members for select
  using (org_id in (select user_org_ids()));
