-- THE INTEGRATION EXECUTIONS LANE (the 2026-08-14 factory spec, F0 slice 3).
-- The operation_executions idiom applied to reach: one door enqueues, the
-- server-side sweep claims (for update skip locked), settles, and events -
-- zero model in the loop, always. The row records WHAT was asked (endpoint +
-- validated params + trigger provenance) and what came back (status, capped
-- result); the credential appears NOWHERE - it meets the request only inside
-- the executor at send time, and every stored error/result passes the scrub.

create table integration_executions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  connection_id uuid not null references integration_connections(id) on delete cascade,
  integration text not null,
  version int not null,
  endpoint text not null,
  class text not null check (class in ('read', 'write', 'send')),
  params jsonb not null default '{}',
  trigger jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'running', 'succeeded', 'failed')),
  error text null,
  http_status int null,
  result jsonb null,
  started_at timestamptz null,
  finished_at timestamptz null,
  duration_ms int null,
  created_at timestamptz not null default now()
);

create index integration_executions_by_org on integration_executions (org_id, status, created_at);
-- The daily-budget count rides this (connection, day) shape.
create index integration_executions_budget on integration_executions (connection_id, created_at);

alter table integration_executions enable row level security;
create policy member_read_integration_executions on integration_executions
  for select using (org_id in (select user_org_ids()));

-- The notify floor, WITH the table (the T38 §4b law).
create trigger desk_notify_integration_executions
  after insert or update on integration_executions
  for each row execute function public.desk_notify();
