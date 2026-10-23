-- THE INTEGRATION CONNECTIONS REGISTRY (the 2026-08-14 factory spec, F0 slice 2).
-- A catalog entry is inert; CONNECTING is the consent moment. The row snapshots
-- the consented spec hash (a catalog update never silently changes consented
-- reach - new version, new consent), carries the owner-pinned host where the
-- def declares that class, holds the node's settings (the node settings law),
-- and dies by tombstone, never delete. Credentials are NOT here - the token
-- flows UI -> vault directly (the secret wall); the def names WHICH secret.

create table integration_connections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  integration text not null,
  version int not null,
  spec_hash text not null,
  -- The one host exception (owner-pinned class): supplied BY THE OWNER at
  -- Connect, snapshotted here, thereafter exactly as fixed as a catalog host.
  owner_host text null,
  scope text not null default 'builder' check (scope in ('builder', 'app-user')),
  label text not null,
  settings jsonb not null default '{}',
  status text not null default 'active' check (status in ('active', 'revoked')),
  created_by text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz null
);

create index integration_connections_live
  on integration_connections (org_id, project_id)
  where revoked_at is null;

alter table integration_connections enable row level security;
create policy member_read_integration_connections on integration_connections
  for select using (org_id in (select user_org_ids()));

-- The notify floor, WITH the table (the T38 §4b law).
create trigger desk_notify_integration_connections
  after insert or update on integration_connections
  for each row execute function public.desk_notify();
