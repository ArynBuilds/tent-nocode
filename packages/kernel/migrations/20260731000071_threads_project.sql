-- THE PROJECT LAW (user ruling, 2026-07-31): threads live under projects, PERIOD. The
-- D-201 unscoped layer ("General", the below-divider daily zone) is OVERRULED and dies
-- STRUCTURALLY: a project-less thread ceases to be representable. Every creation door
-- (chat birth, import offer, scene-request rooms, the health note) now carries a project
-- at the type level; adoption-by-gravity retires with the null state it existed to fix.
--
-- Live data was surgically cleaned before this lands (two content-free debris threads
-- deleted: 'Health', 'Home — scene requests'). The guard below is for any straggler on
-- other targets: a thread still unscoped at constraint time is pre-law debris with no
-- project to honestly claim — detach its jobs and delete it (the no-users ruling: hard
-- deletes, no ceremony). schedules/thread_intents cascade on the thread delete.
update jobs set thread_id = null
  where thread_id in (select id from threads where project_id is null);
delete from threads where project_id is null;

alter table threads alter column project_id set not null;

-- Migration 61's `on delete set null` re-homed a deleted project's threads to General;
-- with General gone that clause is a lie (set-null would violate NOT NULL with a worse
-- error). Re-shape to plain RESTRICT semantics: a project with threads cannot be deleted.
alter table threads drop constraint threads_project_id_fkey;
alter table threads add constraint threads_project_id_fkey
  foreign key (project_id) references projects(id);
