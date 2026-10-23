-- Dependency-gated task runs (FR-88, D-15): a run is claimable only when every
-- id in depends_on belongs to a succeeded run. task_idx links a run back to its
-- entry in jobs.decomposition.
alter table runs add column depends_on uuid[] not null default '{}';
alter table runs add column task_idx int;

-- Golden-task suite (FR-94, FR-66): per-capability benchmark of known
-- inputs -> expected outcomes, gating evolve activation.
create table golden_tasks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  capability text not null,
  name text not null,
  input jsonb not null default '{}',
  expectation text not null,
  created_at timestamptz not null default now()
);
alter table golden_tasks enable row level security;
create index golden_tasks_org_capability_idx on golden_tasks (org_id, capability, created_at);

-- Org-level tunable config (FR-26: thresholds are config, not code).
alter table orgs add column config jsonb not null default '{}';
