-- AI-surface rebuild Phase 3: the app plan store, the consent grant store's
-- ruled shape {projectId, class, subject, grantedAt}, and the dead-table drops.

-- 1 · app_plans: plans persist per project, append-only; a new revision
-- supersedes the prior one (superseded_at is a status mark, never a delete).
create table app_plans (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  thread_id uuid null,
  revision int not null,
  plan jsonb not null,
  approved_by uuid not null,
  created_at timestamptz not null default now(),
  superseded_at timestamptz null,
  unique (project_id, revision)
);
create index app_plans_org_project_idx on app_plans (org_id, project_id);
create unique index app_plans_active_idx on app_plans (project_id) where superseded_at is null;
alter table app_plans enable row level security;
create policy member_read_app_plans on app_plans for select using (org_id in (select user_org_ids()));

-- 2 · consent_grants lands the ruled shape: subject (was kind), granted_at
-- (was created_at), plus project_id and class columns.
alter table consent_grants rename column kind to subject;
alter table consent_grants rename column created_at to granted_at;
alter table consent_grants add column project_id uuid null references projects(id) on delete set null;
alter table consent_grants add column class text not null default 'ask-once'
  check (class in ('free', 'ask-once', 'always-ask'));
-- Pre-class-law rows outside the subject grammar are dead vocabulary (no users; re-grant by approving once).
delete from consent_grants where subject !~ '^(folder|scene|impact|verb):';
drop index if exists consent_grants_org_kind_idx;
create index consent_grants_org_subject_idx on consent_grants (org_id, subject);

-- 3 · The drop family: writeless and readless since Phases 1/5; the record's
-- events keep their history forever (wall 7).
drop table if exists job_followups;
drop table if exists jobs;
drop table if exists scheduler_state;
drop table if exists schedules;
drop table if exists folder_grants;
drop table if exists scene_grants;
drop table if exists t3_grants;
