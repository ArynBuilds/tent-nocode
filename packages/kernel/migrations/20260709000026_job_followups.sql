-- Tier 11 (FR-179): mid-job follow-ups — the human types while work runs; the message is
-- consumed at the next claim boundary (merged into that run's input) or, if none remains,
-- becomes a desk turn at job settle. Steering, never a consent bypass.
create table job_followups (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  job_id uuid not null references jobs(id) on delete cascade,
  message_id uuid not null references messages(id) on delete cascade,
  text text not null,
  created_at timestamptz not null default now(),
  consumed_at timestamptz null,
  consumed_by uuid null references runs(id) on delete set null
);
alter table job_followups enable row level security;
create policy member_read_job_followups on job_followups for select using (org_id in (select user_org_ids()));
create index job_followups_pending on job_followups (job_id) where consumed_at is null;
