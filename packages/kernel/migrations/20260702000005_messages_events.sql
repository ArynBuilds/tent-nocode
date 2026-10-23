create type message_type as enum ('request', 'result', 'question', 'escalation');

create table messages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  from_run uuid references runs(id),
  to_run uuid references runs(id),
  type message_type not null,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index messages_org_idx on messages (org_id, created_at);

create table events (
  id bigint generated always as identity primary key,
  org_id uuid references orgs(id),
  actor text not null,
  type text not null,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index events_org_idx on events (org_id, id);

create trigger events_append_only
  before update or delete on events
  for each row execute function forbid_mutation();
