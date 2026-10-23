-- THE SERVING LINEAGE 0002 — the rooms control plane (FR-561/D-260..261).
-- A room is ROWS, never a process (D-260.1). Minted at the account's first publish.

create table rooms (
  id uuid primary key default gen_random_uuid(),
  org_id uuid unique not null references orgs(id) on delete cascade,
  slug text unique not null,
  status text not null default 'live' check (status in ('live', 'suspended')),
  created_at timestamptz not null default now()
);

-- (x-app) in the URL is room_apps.app_slug — globally unique, reserved-slug walled
-- (the wall itself is kernel code: rooms/registry.ts RESERVED_APP_SLUGS).
create table room_apps (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references rooms(id) on delete cascade,
  org_id uuid not null references orgs(id) on delete cascade,
  app_slug text unique not null,
  title text not null,
  current_release_id uuid,
  visibility text not null default 'public' check (visibility in ('public', 'unlisted', 'off')),
  created_at timestamptz not null default now()
);

-- APPEND-ONLY release log; the hash chain is packaging §8.3's, consumed not reinvented.
create table room_releases (
  id uuid primary key default gen_random_uuid(),
  room_app_id uuid not null references room_apps(id) on delete cascade,
  org_id uuid not null references orgs(id) on delete cascade,
  package_hash text not null,
  envelope jsonb not null,
  prev_release_hash text,
  release_hash text not null,
  entry_scene_slug text,
  landed jsonb not null default '{}'::jsonb,
  published_at timestamptz not null default now()
);
create index room_releases_by_app on room_releases (room_app_id, published_at desc);
create trigger room_releases_append_only before delete or update on room_releases
  for each row execute function forbid_mutation();

alter table room_apps
  add constraint room_apps_current_release_fkey
  foreign key (current_release_id) references room_releases(id);

create table room_domains (
  id uuid primary key default gen_random_uuid(),
  room_app_id uuid not null references room_apps(id) on delete cascade,
  org_id uuid not null references orgs(id) on delete cascade,
  domain text unique not null,
  cname_verified_at timestamptz,
  tls_status text not null default 'pending' check (tls_status in ('pending', 'issued', 'failed')),
  status text not null default 'waiting-dns' check (status in ('waiting-dns', 'connected', 'misconfigured', 'removed')),
  created_at timestamptz not null default now()
);

