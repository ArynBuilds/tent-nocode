-- Tier 7 (FR-141/FR-145, D-28): recurring jobs into standing threads. A schedule is nothing but
-- a job a daemon tick creates on cadence — every existing gate applies to what it fires.
create table schedules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  thread_id uuid not null references threads(id) on delete cascade,
  prompt text not null,
  cadence text not null,             -- 5-field cron expression (kernel boundary accepts cron only)
  mode text null,                    -- nullable thread-mode override (resolved at fire time)
  workspace_path text null,          -- FR-145e: pinned run workspace for fired jobs (T1 jail applies to it)
  enabled boolean not null default true,
  created_by uuid not null,          -- the approving human (agentic auto-approval provenance lives on the escalation answer)
  last_fired_at timestamptz null,
  created_at timestamptz not null default now()
);
alter table schedules enable row level security;
create policy member_read_schedules on schedules for select using (org_id in (select user_org_ids()));
alter publication supabase_realtime add table schedules;

-- FR-145e: a fired job pins the workspace its runs execute in (consented verbatim on the card).
alter table jobs add column workspace_path text null;
