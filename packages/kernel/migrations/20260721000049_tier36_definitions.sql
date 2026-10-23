-- Tier 36 Phase B (FR-367, FR-375, D-143/D-146): definitions + redirects.
-- component_definitions: org-authored custom components — the Tier 37 door, EMPTY in
-- Tier 36 (the core set is kernel code, hash-stable with the build; this table exists
-- now so the format's storage is ready and 37 pays nothing). Immutable versions: a new
-- version is a NEW row (the HDA floor).
-- component_redirects: the CoreRedirects lesson as FOREVER data — the present maintains
-- a memory of every name the past ever used. Consulted at the mutation gate (stale-name
-- rewrite-or-reject) and at document open. KERNEL-OWNED format data: service-role only,
-- deliberately NO member_read (never rendered raw; the gate's notes speak for it).

create table component_definitions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  name text not null,
  version integer not null,
  definition jsonb not null,
  status text not null default 'active' check (status in ('active', 'retired')),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  unique (org_id, name, version)
);
alter table component_definitions enable row level security;
create policy member_read_component_definitions on component_definitions for select using (org_id in (select user_org_ids()));

create table component_redirects (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('componentType', 'property', 'enumValue')),
  old_name text not null,
  new_name text null,
  since_version integer not null default 1,
  removed boolean not null default false,
  created_at timestamptz not null default now(),
  unique (kind, old_name)
);
alter table component_redirects enable row level security;
