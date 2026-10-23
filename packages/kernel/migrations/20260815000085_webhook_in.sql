-- THE F4 WEBHOOK-IN DOOR (the 2026-08-14 factory spec, F0 slice 4d; F4 ruled
-- IN v1 at the build-open round). The outside world calling US: a per-endpoint
-- unguessable token URL, a vault-held signing secret (HMAC-SHA256 over the raw
-- body - a stranger cannot fake an event), received events landing as rows
-- that the webhook_in trigger kind edge-fires on. The listener is a different
-- security animal: signature verification IS the wall.

create table webhook_endpoints (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  token text not null unique,
  label text not null,
  -- The VAULT NAME of the signing secret (sealed in secrets; shown once at mint).
  secret_name text not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz null
);

create index webhook_endpoints_live
  on webhook_endpoints (org_id, project_id)
  where revoked_at is null;

alter table webhook_endpoints enable row level security;
create policy member_read_webhook_endpoints on webhook_endpoints
  for select using (org_id in (select user_org_ids()));

create table integration_webhook_events (
  id bigint generated always as identity primary key,
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  endpoint_id uuid not null references webhook_endpoints(id) on delete cascade,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index integration_webhook_events_by_endpoint
  on integration_webhook_events (endpoint_id, id desc);

alter table integration_webhook_events enable row level security;
create policy member_read_integration_webhook_events on integration_webhook_events
  for select using (org_id in (select user_org_ids()));

-- The notify floor, WITH the tables (the T38 §4b law).
create trigger desk_notify_webhook_endpoints
  after insert or update on webhook_endpoints
  for each row execute function public.desk_notify();
create trigger desk_notify_integration_webhook_events
  after insert or update on integration_webhook_events
  for each row execute function public.desk_notify();
