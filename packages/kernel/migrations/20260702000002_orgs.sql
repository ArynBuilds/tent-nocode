create table orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create type org_role as enum ('owner', 'admin', 'operator', 'viewer');

create table org_members (
  org_id uuid not null references orgs(id) on delete cascade,
  user_id uuid not null,
  role org_role not null,
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
