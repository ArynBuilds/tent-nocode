-- FR-307 (Tier 27, D-113): the app-owned MCP connections registry — org rows, never Claude
-- Code config files (the self-governance wall). Each row SNAPSHOTS the consented command
-- verbatim (a later gallery update never silently changes consented reach — new consent to
-- upgrade). Revocation is a tombstone (revoked_at), never a row delete (FR-20).

create table connections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  service_id text not null,
  title text not null,
  command jsonb not null,
  secret_name text not null,
  secret_env text not null,
  default_rules jsonb not null default '[]'::jsonb,
  created_by uuid,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create index connections_org_live on connections (org_id) where revoked_at is null;

alter table connections enable row level security;
create policy member_read_connections on connections for select using (org_id in (select user_org_ids()));
