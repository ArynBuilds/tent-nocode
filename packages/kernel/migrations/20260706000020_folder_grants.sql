-- FR-149 fast-follow (standing folder grants): Claude Code's allowlist made durable. Approving
-- an operator_task card with "always allow this folder" records a grant; later operator_tasks
-- inside that exact folder auto-answer their consent (resolvedBy 'grant:<id>' — recorded, never
-- silent). Revocable from Settings; revocation is a tombstone, never a delete (audit holds).
create table folder_grants (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  path text not null,                -- stored verbatim as consented; matched normalized (case/trailing-slash)
  granted_by uuid not null,          -- the approving human
  created_at timestamptz not null default now(),
  revoked_at timestamptz null,
  revoked_by uuid null
);
alter table folder_grants enable row level security;
create policy member_read_folder_grants on folder_grants for select using (org_id in (select user_org_ids()));
alter publication supabase_realtime add table folder_grants;
