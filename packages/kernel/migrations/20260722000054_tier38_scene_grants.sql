-- Tier 38 (FR-389, D-156): standing SCENE grants — the folder-grant idiom applied to
-- `scene:<slug>` write consent. Per-scene (never a kind grant: scene reach is shaped like
-- a folder path, and reach-shaped consents are structurally non-kind-grantable), tombstoned
-- revoke (the who-could-edit-what audit survives), grant-class NEVER floor-class (spec §4b:
-- the floor list is ratified law and a scene edit is org-internal state).
create table scene_grants (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  scene_slug text not null,
  granted_by uuid not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz null,
  revoked_by uuid null
);

create index scene_grants_by_org on scene_grants (org_id, scene_slug);
alter table scene_grants enable row level security;
create policy member_read_scene_grants on scene_grants for select using (org_id in (select user_org_ids()));
