alter table runs
  add column attempt int not null default 1,
  add column max_attempts int not null default 3,
  add column claimed_at timestamptz,
  add column started_at timestamptz,
  add column finished_at timestamptz,
  add column failure text;

create index runs_queued_idx on runs (status, created_at) where status = 'queued';

-- Standing T3 grants (FR-41): owner/admin pre-approves a named impact action for an agent.
create table t3_grants (
  org_id uuid not null references orgs(id) on delete cascade,
  agent_id uuid not null references agents(id) on delete cascade,
  action text not null,
  granted_by uuid not null,
  created_at timestamptz not null default now(),
  primary key (org_id, agent_id, action)
);

alter table t3_grants enable row level security;
create policy member_read_t3_grants on t3_grants for select
  using (org_id in (select user_org_ids()));
grant select on t3_grants to authenticated;

-- Kernel-internal scheduler pause state (FR-58): singleton row, no client access at all.
create table scheduler_state (
  id int primary key check (id = 1),
  paused_until timestamptz,
  pause_reason text,
  updated_at timestamptz not null default now()
);
alter table scheduler_state enable row level security;
insert into scheduler_state (id) values (1);
