-- Tier 8 (FR-142/151): certified tools ride the immutable version row (metadata + hash);
-- nominations wait in tool_candidates until their trigger (rule-of-2 / schedule fast-path)
-- and review; tool SOURCE lives in tool_sources (versions are immutable, source is bulky).
alter table agent_versions add column tools jsonb not null default '[]';

create table tool_candidates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  agent_id uuid not null references agents(id) on delete cascade,
  name text not null,
  entry text not null,
  description text not null,
  source text not null,              -- captured at nomination (the run workspace is transient)
  runtime text not null default 'python-wasm',
  evidence_run_id uuid not null,
  status text not null default 'pending' check (status in ('pending', 'graduated', 'rejected')),
  reject_note text null,
  created_at timestamptz not null default now()
);
alter table tool_candidates enable row level security;
create policy member_read_tool_candidates on tool_candidates for select using (org_id in (select user_org_ids()));

create table tool_sources (
  agent_id uuid not null references agents(id) on delete cascade,
  version int not null,
  name text not null,
  source text not null,
  primary key (agent_id, version, name)
);
alter table tool_sources enable row level security;
create policy member_read_tool_sources on tool_sources for select using (
  agent_id in (select id from agents where org_id in (select user_org_ids()))
);
