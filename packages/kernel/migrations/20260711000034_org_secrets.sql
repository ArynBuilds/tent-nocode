-- FR-252 (Tier 20, D-76): the secrets vault, finally built. Stores ONLY ciphertext — the value is
-- encrypted in the MAIN process via Electron safeStorage (DPAPI on Windows) before it ever reaches
-- this table, decrypted in main at connector-spawn time and injected into the server's env like
-- DATABASE_URL. The value never crosses IPC to the renderer and never enters a prompt. A member
-- read may see the NAMES (to manage them) but the ciphertext column is never selected to the client.
create table org_secrets (
  org_id uuid not null references orgs(id) on delete cascade,
  name text not null,
  ciphertext text not null,          -- safeStorage-encrypted, base64; opaque to the kernel
  created_by uuid not null,
  created_at timestamptz not null default now(),
  primary key (org_id, name)
);
alter table org_secrets enable row level security;
-- Names are readable to members for management; the ciphertext is fetched only by the main process
-- over the service role, never through this member policy.
create policy member_read_org_secrets on org_secrets for select using (org_id in (select user_org_ids()));
