create type agent_status as enum ('draft', 'active', 'deprecated');

create table agents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  slug text not null,
  status agent_status not null default 'draft',
  current_version int not null default 0,
  capability text not null default '',
  capability_embedding vector(768),
  created_at timestamptz not null default now(),
  unique (org_id, slug)
);

-- Agents are never hard-deleted (status -> 'deprecated'); versions are immutable history.
create table agent_versions (
  agent_id uuid not null references agents(id),
  version int not null,
  instructions text not null,
  io_contract jsonb not null default '{}',
  tool_scopes jsonb not null default '[]',
  test_cases jsonb not null default '[]',
  parent_version int,
  lineage_note text,
  created_by text not null check (created_by in ('human', 'forge', 'evolve')),
  created_at timestamptz not null default now(),
  primary key (agent_id, version)
);

create or replace function forbid_mutation() returns trigger
language plpgsql as $$
begin
  raise exception '% is append-only', tg_table_name;
end $$;

create trigger agent_versions_immutable
  before update or delete on agent_versions
  for each row execute function forbid_mutation();
