-- THE TRASH SYSTEM (containment+cleanup spec §5, 2026-08-03): tombstone → window →
-- purge. Delete stays a TOMBSTONE for every kind; a tombstone sits restorable for
-- `cleanup.trashDays` (config, default 7); past the window the idle purge sweep
-- hard-deletes the FLESH only. THE STRUCTURE LAW: data never outlives its structure
-- and structure never orphans its data — the dataset's row, the scene's row, the
-- thread's row, the note's row survive forever as tiny permanent skeletons (purged_at
-- is the skeleton's own honest marker), and the EVENT RECORD survives forever.
--
-- Notes join the tombstone family (their delete door was the last hard delete of a
-- content kind); the purge empties a note's BODY — the length floor narrows to the
-- write door (kernel-validated) so an emptied skeleton stays representable.
alter table project_notes add column deleted_at timestamptz null;
alter table project_notes add column purged_at timestamptz null;
alter table project_notes drop constraint project_notes_body_check;
alter table project_notes add constraint project_notes_body_check check (char_length(body) <= 2000);

alter table datasets add column purged_at timestamptz null;
alter table scenes add column purged_at timestamptz null;
alter table threads add column purged_at timestamptz null;
-- Projects purge as the cascade root: the archived row is already the skeleton.
alter table projects add column purged_at timestamptz null;

-- Scenes/tabs tombstone by STATUS with no clock — the window needs one. The doors set
-- deleted_at beside the status flip from now on; pre-law tombstones backfill PAST the
-- window so the first sweep purges the accumulated test-era debris on arrival (§8).
alter table scenes add column deleted_at timestamptz null;
alter table tabs add column deleted_at timestamptz null;
update scenes set deleted_at = now() - interval '365 days' where status = 'deleted';
update tabs set deleted_at = now() - interval '365 days' where status = 'deleted';
