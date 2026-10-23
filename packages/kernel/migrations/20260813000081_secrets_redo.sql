-- THE SECRETS REDO (the link+eye E3, spec K8 - the Vercel model). The new
-- vault: values sealed SERVER-SIDE by the envelope (per-secret data key
-- wrapped by the host's master key - kernel/src/secrets/envelope.ts), scoped
-- to the ACCOUNT (project_id null - shared) or to ONE PROJECT. Write-only
-- readback is structural: no channel returns `sealed`; decryption happens in
-- executors alone with the host's master key.
--
-- THE DEATH RECORDED (executes at the E2 cutover flip, not here - the desktop
-- still runs the old lane pre-cutover): org_secrets + the DPAPI/safeStorage
-- seal die whole; machine-bound ciphertext cannot migrate (it only opens on
-- the founder's machine) and NO USERS YET rules re-entry over ceremony.
create table secrets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid null references projects(id) on delete cascade,
  name text not null,
  sealed text not null,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index secrets_account_scope on secrets (org_id, name) where project_id is null;
create unique index secrets_project_scope on secrets (org_id, project_id, name) where project_id is not null;

alter table secrets enable row level security;
-- Members may read METADATA to manage names; `sealed` is fetched only by the
-- host over the service role, never through this member policy's consumers.
create policy member_read_secrets on secrets for select using (org_id in (select user_org_ids()));
