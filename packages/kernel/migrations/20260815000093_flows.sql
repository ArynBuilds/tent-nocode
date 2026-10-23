-- F12 THE FLOW ENGINE (2026-08-16): flows + flow_executions - the Postgres
-- envelope substrate (decision 5: their in-memory stack + leader timers +
-- recovery bolt-ons REPLACED by our standing shape - the row IS the truth,
-- the one sweeper claims with SKIP LOCKED, every wait persists).
-- Template: 20260815000084_integration_executions.sql (the envelope precedent).

create table flows (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  name text not null,
  -- The compiled flow document (core flowDocSchema - branded, migratable).
  doc jsonb not null,
  enabled boolean not null default true,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create unique index flows_live_name on flows (project_id, name) where deleted_at is null;
create index flows_org on flows (org_id, created_at);

alter table flows enable row level security;
create policy member_read_flows on flows
  for select using (org_id in (select user_org_ids()));

create table flow_executions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  flow_id uuid not null references flows(id) on delete cascade,
  -- The doc SNAPSHOT the run executes against (edits never mutate a live run).
  doc jsonb not null,
  -- The branded envelope (core flowEnvelopeSchema): results + stack + waiting,
  -- persisted EVERY step - the sweeper resumes from this row alone.
  envelope jsonb not null,
  trigger jsonb not null default '{}'::jsonb,
  status text not null default 'pending'
    check (status in ('pending', 'running', 'waiting', 'succeeded', 'failed')),
  -- THE WAIT CONTRACT (their waitTill verbatim, ALL waits persisted): status
  -- 'waiting' + wait_till = the sweeper re-claims at/after the moment; a
  -- resume token (approval links, Q3) re-arms it early.
  wait_till timestamptz,
  -- THE LOOP GUARD + CRASH TIMEOUT, in the row (closes their two holes):
  steps_run int not null default 0,
  step_budget int not null default 500,
  deadline timestamptz not null default now() + interval '15 minutes',
  error text,
  -- F16 Run-a-flow: the parent execution this run answers to (parent parks
  -- 'waiting' with no wait_till; the child's settle re-arms it).
  parent_execution_id uuid references flow_executions(id) on delete set null,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now()
);

create index flow_executions_claim on flow_executions (org_id, status, created_at);
create index flow_executions_flow on flow_executions (flow_id, created_at);
create index flow_executions_waiting on flow_executions (status, wait_till);

alter table flow_executions enable row level security;
create policy member_read_flow_executions on flow_executions
  for select using (org_id in (select user_org_ids()));

-- The notify floor lands WITH the table (the T38 §4b law).
create trigger desk_notify_flows
  after insert or update on flows
  for each row execute function public.desk_notify();
create trigger desk_notify_flow_executions
  after insert or update on flow_executions
  for each row execute function public.desk_notify();
