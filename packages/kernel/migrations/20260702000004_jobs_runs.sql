create type job_status as enum
  ('planning', 'awaiting_approval', 'running', 'partial', 'completed', 'failed', 'cancelled');

create table jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  prompt text not null,
  decomposition jsonb,
  status job_status not null default 'planning',
  summary text,
  created_by uuid not null,
  created_at timestamptz not null default now()
);

create type run_status as enum ('queued', 'running', 'paused', 'succeeded', 'failed', 'cancelled');
create type run_verdict as enum ('success', 'partial', 'failure');

create table runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  job_id uuid not null references jobs(id) on delete cascade,
  agent_id uuid not null,
  agent_version int not null,
  input jsonb not null default '{}',
  output jsonb,
  status run_status not null default 'queued',
  verdict run_verdict,
  verdict_by text check (verdict_by in ('auditor', 'human')),
  cost_estimate numeric,
  duration_ms int,
  heartbeat_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (agent_id, agent_version) references agent_versions (agent_id, version)
);

create index runs_job_idx on runs (job_id);
create index runs_org_status_idx on runs (org_id, status);
