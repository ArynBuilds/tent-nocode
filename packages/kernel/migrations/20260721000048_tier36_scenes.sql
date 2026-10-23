-- Tier 36 (FR-364, D-140..142): the LSG scene store — scenes are KERNEL CITIZENS, never a
-- tabs feature (§12a corollary 2; the tab is the scene's FIRST HOST, linked in a later
-- additive migration). The document column is the MATERIALIZED head (rebuildable from ops —
-- the FR-207 wipe+re-derive idiom, proven by test); scene_revisions is the append-only
-- truth. Two-pointer topology (parent + nullable merge parent) = the ENTIRE branching
-- down-payment (Onshape shape, research pass 3); v1 reads one head ('main' = the scenes row).
-- The (scene, actor, mutation_id) uniqueness is the retry wall's floor (D-142: a retried
-- batch is a detected duplicate, never a double-apply).

create table scenes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  slug text not null,
  title text not null,
  status text not null default 'active' check (status in ('active', 'deleted')),
  head_revision integer not null default 0,
  document jsonb not null,
  schema_version integer not null default 1,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  unique (org_id, slug)
);

create table scene_revisions (
  id uuid primary key default gen_random_uuid(),
  scene_id uuid not null references scenes(id) on delete cascade,
  org_id uuid not null references orgs(id) on delete cascade,
  revision_no integer not null,
  ops jsonb not null,
  actor text not null,
  mutation_id integer not null,
  parent_revision_id uuid null references scene_revisions(id),
  merge_parent_id uuid null references scene_revisions(id),
  schema_version integer not null default 1,
  created_at timestamptz not null default now(),
  unique (scene_id, revision_no),
  unique (scene_id, actor, mutation_id)
);

create index scene_revisions_by_scene on scene_revisions (scene_id, revision_no desc);

alter table scenes enable row level security;
alter table scene_revisions enable row level security;
create policy member_read_scenes on scenes for select using (org_id in (select user_org_ids()));
create policy member_read_scene_revisions on scene_revisions for select using (org_id in (select user_org_ids()));
