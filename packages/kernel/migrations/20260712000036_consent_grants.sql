-- FR-267 (Tier 22, D-85): standing per-KIND consent grants — Claude Code's "allow always" /
-- Cursor's allowlist, applied to governed-action kinds. Walled: only the read-only/org-data
-- class is grantable (enforced in kernel code, KIND_GRANTABLE); neverAuto kinds and any
-- reach-carrying consent (folder paths) structurally never ride this table. Revocation is a
-- tombstone, never a delete (the audit of standing consents survives).
create table consent_grants (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  kind text not null,
  granted_by uuid not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz null,
  revoked_by uuid null
);
create index consent_grants_org_kind_idx on consent_grants (org_id, kind);
alter table consent_grants enable row level security;
create policy member_read_consent_grants on consent_grants for select using (org_id in (select user_org_ids()));
alter publication supabase_realtime add table consent_grants;
