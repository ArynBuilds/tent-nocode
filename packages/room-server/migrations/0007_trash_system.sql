-- THE TRASH SYSTEM (spec §5, 2026-08-03), the serving half: the columns the shared
-- kernel readers/writers now speak. Threads are a desktop-only organ (no sibling here);
-- the box's purge lane is the same idle sweep when a worker exists (part 3).
alter table project_notes add column deleted_at timestamptz null;
alter table project_notes add column purged_at timestamptz null;
alter table project_notes drop constraint if exists project_notes_body_check;
alter table project_notes add constraint project_notes_body_check check (char_length(body) <= 2000);
alter table datasets add column purged_at timestamptz null;
alter table scenes add column purged_at timestamptz null;
alter table projects add column purged_at timestamptz null;
alter table scenes add column deleted_at timestamptz null;
alter table tabs add column deleted_at timestamptz null;
update scenes set deleted_at = now() - interval '365 days' where status = 'deleted';
update tabs set deleted_at = now() - interval '365 days' where status = 'deleted';
