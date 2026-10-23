-- Tier 42 Phase B (FR-410 the output ledger · FR-416 the operations registry · FR-417
-- executions; plan call 1: operation_executions is its OWN table — runs.agent_id stays
-- NOT NULL, the runs contract untouched). The desk_notify triggers land WITH the tables
-- (the T38 §4b lesson: a notify floor broken at birth is silent death later); the
-- type-exhaustive LiveTable allowlist widens in the SAME commit.

-- FR-410: the derived-output ledger — a typed DECLARATION of a produced array/raster
-- file. Payload bytes NEVER enter Postgres (§3 untouchable): path_key + content_hash +
-- descriptor are the record's whole knowledge. run_id is a provenance pointer with no FK:
-- outputs stay resolvable whatever happens to their producing run (FR-290 posture).
-- Append-only in spirit: re-registering a name inserts a new row; resolve reads the
-- newest REGISTERED row per name.
create table derived_outputs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  run_id uuid null,
  name text not null,
  kind text not null check (kind in ('array', 'raster')),
  descriptor jsonb not null,
  path_key text not null,
  content_hash text not null,
  status text not null default 'pending' check (status in ('pending', 'registered', 'missing')),
  created_at timestamptz not null default now()
);
create index derived_outputs_by_org_name on derived_outputs (org_id, name, created_at desc);
create index derived_outputs_by_run on derived_outputs (run_id);
alter table derived_outputs enable row level security;
create policy member_read_derived_outputs on derived_outputs for select using (org_id in (select user_org_ids()));

-- FR-416: engine-owned OPERATIONS — name@version immutable, code hash-pinned, declared io
-- contract, consent-born (the graduation gate raises through the one consent brain).
-- Retire = status tombstone; in-place edit is impossible by the unique + append law.
create table operations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  name text not null,
  version int not null,
  code text not null,
  code_hash text not null,
  runtime text not null check (runtime in ('wasm', 'native')),
  io_contract jsonb not null,
  provenance_run_id uuid null,
  status text not null default 'active' check (status in ('active', 'retired')),
  created_by text not null,
  created_at timestamptz not null default now(),
  unique (org_id, name, version)
);
alter table operations enable row level security;
create policy member_read_operations on operations for select using (org_id in (select user_org_ids()));

-- FR-417: executions — recorded, audited JOBS in the audit sense (row + events + duration
-- + trigger provenance), swept by the daemon lane with ZERO model involvement.
create table operation_executions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  operation text not null,
  version int not null,
  inputs jsonb not null default '{}'::jsonb,
  trigger jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'running', 'succeeded', 'failed')),
  error text null,
  started_at timestamptz null,
  finished_at timestamptz null,
  duration_ms int null,
  outputs jsonb null,
  created_at timestamptz not null default now()
);
create index operation_executions_by_org on operation_executions (org_id, status, created_at);
alter table operation_executions enable row level security;
create policy member_read_operation_executions on operation_executions for select using (org_id in (select user_org_ids()));

-- The notify floor, WITH the tables (T38 §4b).
create trigger desk_notify_derived_outputs
  after insert or update on derived_outputs
  for each row execute function public.desk_notify();
create trigger desk_notify_operations
  after insert or update on operations
  for each row execute function public.desk_notify();
create trigger desk_notify_operation_executions
  after insert or update on operation_executions
  for each row execute function public.desk_notify();
