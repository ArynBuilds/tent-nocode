-- THE PROJECT CONTAINMENT RULING (user-ruled 2026-08-03, containment+cleanup spec §1 —
-- supersedes "NODES ARE FREE ENTITIES" 2026-08-02): a project is a CONTAINER, not a
-- composition. Everything the user makes lives IN its project: datasets, component
-- definitions, operations, derived outputs, executions, triggers, chains, scenes, tabs.
-- Engine stock (core::/chart::/media::/c2d::/three:: + runtimes) ships with the app and
-- has no rows here; org-global stays login-shell only (roles/agents, settings, grants).
-- Existing rows migrate to their record-derived project (the Observatory's provenance
-- chains, run once and persisted — the migration-69 playbook); unattributable rows land
-- honestly in a per-org 'Recovered' project. Destructive where needed (no-users ruling).

-- ---- 1 · The containment columns (nullable first; NOT NULL after backfill). ----
alter table datasets add column project_id uuid null;
alter table scenes add column project_id uuid null;
alter table component_definitions add column project_id uuid null;
alter table operations add column project_id uuid null;
alter table operation_executions add column project_id uuid null;
alter table derived_outputs add column project_id uuid null;
alter table triggers add column project_id uuid null;
alter table reactive_chains add column project_id uuid null;
-- Redirects: kernel-owned format memory — null = a GLOBAL kernel redirect (the only kind
-- that exists today); a project-authored rename would carry its project. Stays nullable.
alter table component_redirects add column project_id uuid null references projects(id);

-- ---- 2 · Record-derived backfills, dependency order. ----

-- Scenes ride their hosting tab (the T52 chain, persisted once — live tabs first).
update scenes s set project_id = (
  select t.project_id from tabs t
  where t.scene_id = s.id and t.project_id is not null
  order by (t.status != 'deleted') desc, t.created_at desc limit 1)
where s.project_id is null;

-- Datasets: the evidence chain (dataset_rows ⋈ runs ⋈ jobs ⋈ threads.project_id —
-- the chat/context + notes.ts derivation, run once and persisted).
update datasets d set project_id = (
  select th.project_id from dataset_rows r
  join runs ru on ru.id = r.evidence_run_id
  join jobs j on j.id = ru.job_id
  join threads th on th.id = j.thread_id
  where r.dataset_id = d.id
  order by r.created_at desc limit 1)
where d.project_id is null;
-- Second pass: a rowless/evidence-less dataset bound by a scene lives with that scene.
update datasets d set project_id = (
  select s.project_id from scenes s
  where s.org_id = d.org_id and s.project_id is not null and s.status != 'deleted'
    and exists (
      select 1 from jsonb_array_elements(coalesce(s.bindings, '[]'::jsonb)) b
      where b->>'dataset' = d.name)
  order by s.created_at desc limit 1)
where d.project_id is null;

-- Component definitions: usage — the scene that renders the component names its home.
update component_definitions cd set project_id = (
  select s.project_id from scenes s
  where s.org_id = cd.org_id and s.project_id is not null and s.status != 'deleted'
    and exists (
      select 1
      from jsonb_each(coalesce(s.document->'nodes', '{}'::jsonb)) as node(id, value),
           jsonb_each(coalesce(node.value->'components', '{}'::jsonb)) as comp(key, value)
      where split_part(comp.key, '@', 1) = cd.name)
  order by s.created_at desc limit 1)
where cd.project_id is null;

-- Operations: the provenance chain (observatory's run ⋈ job ⋈ thread join, persisted —
-- the hack in observatory.ts dies for this column in the same phase).
update operations o set project_id = (
  select th.project_id from runs r
  join jobs j on j.id = r.job_id
  join threads th on th.id = j.thread_id
  where r.id = o.provenance_run_id
  limit 1)
where o.project_id is null;
-- Second pass: an op wired into a scene's action rules lives with that scene.
update operations o set project_id = (
  select s.project_id from scenes s
  where s.org_id = o.org_id and s.project_id is not null and s.status != 'deleted'
    and exists (
      select 1 from jsonb_array_elements(coalesce(s.actions, '[]'::jsonb)) a,
                    jsonb_array_elements(coalesce(a->'rules', '[]'::jsonb)) r
      where r->>'operation' = o.name)
  order by s.created_at desc limit 1)
where o.project_id is null;

-- Derived outputs: the producing run's chain.
update derived_outputs d set project_id = (
  select th.project_id from runs r
  join jobs j on j.id = r.job_id
  join threads th on th.id = j.thread_id
  where r.id = d.run_id
  limit 1)
where d.project_id is null;

-- Executions ride their operation (newest version's home).
update operation_executions e set project_id = (
  select o.project_id from operations o
  where o.org_id = e.org_id and o.name = e.operation and o.project_id is not null
  order by o.version desc limit 1)
where e.project_id is null;

-- Triggers ride what they watch (dataset first, then output, then the acted operation).
update triggers t set project_id = coalesce(
  (select d.project_id from datasets d
   where d.org_id = t.org_id and d.name = t.spec->>'dataset' and d.project_id is not null
   order by d.created_at desc limit 1),
  (select o.project_id from derived_outputs o
   where o.org_id = t.org_id and o.name = t.spec->>'output' and o.project_id is not null
   order by o.created_at desc limit 1),
  (select op.project_id from operations op
   where op.org_id = t.org_id and op.name = t.action->>'operation' and op.project_id is not null
   order by op.version desc limit 1))
where t.project_id is null;

-- Chains ride their operation, else the first watched name that resolves.
update reactive_chains c set project_id = coalesce(
  (select op.project_id from operations op
   where op.org_id = c.org_id and op.name = c.operation and op.project_id is not null
   order by op.version desc limit 1),
  (select d.project_id from datasets d
   where d.org_id = c.org_id and d.name = any(c.watch) and d.project_id is not null
   order by d.created_at desc limit 1),
  (select o.project_id from derived_outputs o
   where o.org_id = c.org_id and o.name = any(c.watch) and o.project_id is not null
   order by o.created_at desc limit 1))
where c.project_id is null;

-- ---- 3 · The honest fallback: per-org 'Recovered' project for unattributable rows. ----
insert into projects (org_id, path, name, created_by)
select u.org_id, null, 'Recovered', coalesce(
  (select m.user_id from org_members m where m.org_id = u.org_id order by m.role asc limit 1),
  '00000000-0000-0000-0000-000000000000')
from (
  select distinct org_id from (
    select org_id from datasets where project_id is null
    union all select org_id from scenes where project_id is null
    union all select org_id from component_definitions where project_id is null
    union all select org_id from operations where project_id is null
    union all select org_id from operation_executions where project_id is null
    union all select org_id from derived_outputs where project_id is null
    union all select org_id from triggers where project_id is null
    union all select org_id from reactive_chains where project_id is null
    union all select org_id from tabs where project_id is null
  ) nulls_by_org
) u
where not exists (
  select 1 from projects p
  where p.org_id = u.org_id and p.name = 'Recovered' and p.archived_at is null);

update datasets t set project_id = (select p.id from projects p where p.org_id = t.org_id and p.name = 'Recovered' and p.archived_at is null order by p.created_at asc limit 1) where t.project_id is null;
update scenes t set project_id = (select p.id from projects p where p.org_id = t.org_id and p.name = 'Recovered' and p.archived_at is null order by p.created_at asc limit 1) where t.project_id is null;
update component_definitions t set project_id = (select p.id from projects p where p.org_id = t.org_id and p.name = 'Recovered' and p.archived_at is null order by p.created_at asc limit 1) where t.project_id is null;
update operations t set project_id = (select p.id from projects p where p.org_id = t.org_id and p.name = 'Recovered' and p.archived_at is null order by p.created_at asc limit 1) where t.project_id is null;
update operation_executions t set project_id = (select p.id from projects p where p.org_id = t.org_id and p.name = 'Recovered' and p.archived_at is null order by p.created_at asc limit 1) where t.project_id is null;
update derived_outputs t set project_id = (select p.id from projects p where p.org_id = t.org_id and p.name = 'Recovered' and p.archived_at is null order by p.created_at asc limit 1) where t.project_id is null;
update triggers t set project_id = (select p.id from projects p where p.org_id = t.org_id and p.name = 'Recovered' and p.archived_at is null order by p.created_at asc limit 1) where t.project_id is null;
update reactive_chains t set project_id = (select p.id from projects p where p.org_id = t.org_id and p.name = 'Recovered' and p.archived_at is null order by p.created_at asc limit 1) where t.project_id is null;
update tabs t set project_id = (select p.id from projects p where p.org_id = t.org_id and p.name = 'Recovered' and p.archived_at is null order by p.created_at asc limit 1) where t.project_id is null;

-- ---- 4 · Containment becomes structural: NOT NULL + plain RESTRICT FKs. ----
-- (THE STRUCTURE LAW, §5: project rows are immortal skeletons — RESTRICT never bites a
-- purge; app-side cascade tombstones/purges citizens BEFORE any structure row could go.)
alter table datasets alter column project_id set not null;
alter table datasets add constraint datasets_project_id_fkey foreign key (project_id) references projects(id);
alter table scenes alter column project_id set not null;
alter table scenes add constraint scenes_project_id_fkey foreign key (project_id) references projects(id);
alter table component_definitions alter column project_id set not null;
alter table component_definitions add constraint component_definitions_project_id_fkey foreign key (project_id) references projects(id);
alter table operations alter column project_id set not null;
alter table operations add constraint operations_project_id_fkey foreign key (project_id) references projects(id);
alter table operation_executions alter column project_id set not null;
alter table operation_executions add constraint operation_executions_project_id_fkey foreign key (project_id) references projects(id);
alter table derived_outputs alter column project_id set not null;
alter table derived_outputs add constraint derived_outputs_project_id_fkey foreign key (project_id) references projects(id);
alter table triggers alter column project_id set not null;
alter table triggers add constraint triggers_project_id_fkey foreign key (project_id) references projects(id);
alter table reactive_chains alter column project_id set not null;
alter table reactive_chains add constraint reactive_chains_project_id_fkey foreign key (project_id) references projects(id);

-- Tabs: the T52 unowned lane retires STRUCTURALLY (every screen has a project) — the
-- migration-71 shape applied to views: NOT NULL + the set-null clause dies.
alter table tabs alter column project_id set not null;
alter table tabs drop constraint tabs_project_id_fkey;
alter table tabs add constraint tabs_project_id_fkey foreign key (project_id) references projects(id);

-- ---- 5 · Per-project live-name uniqueness (spec §1: name uniqueness is per-project). ----
drop index datasets_org_name_live;
create unique index datasets_project_name_live on datasets (project_id, name) where deleted_at is null;
alter table component_definitions drop constraint component_definitions_org_id_name_version_key;
create unique index component_definitions_project_name_version on component_definitions (project_id, name, version);
alter table operations drop constraint operations_org_id_name_version_key;
create unique index operations_project_name_version on operations (project_id, name, version);
-- Scenes keep unique (org_id, slug): a slug is a serving ADDRESS (publish routes, set_ref
-- targets, the supersede wall) — cross-project copies mint fresh slugs (copy-rename).

-- Reader-path indexes (project-first listing).
create index datasets_by_project on datasets (project_id, created_at);
create index scenes_by_project on scenes (project_id, created_at);
create index operations_by_project on operations (project_id, name, version desc);
create index derived_outputs_by_project_name on derived_outputs (project_id, name, created_at desc);
create index operation_executions_by_project on operation_executions (project_id, status, created_at);

-- ---- 6 · Vestigial debt swept in the same migration (spec §8, no-users era). ----
-- T41 vestige: no live code ever read or wrote it (survey 2026-08-03 — zero TS refs).
alter table scenes drop column seeded_from;
