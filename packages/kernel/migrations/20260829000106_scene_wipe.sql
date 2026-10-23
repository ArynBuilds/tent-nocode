-- THE SCENE WIPE (Phase 12, ruling 15): every scene document on the fleet dies - the old
-- component system has no migration lane. Deletes, not truncates: tabs keeps a foreign key
-- on scenes (truncate refuses any referencing table, rows or not); scene_revisions cascades
-- from scenes. At deploy record the three counts before and after: select count(*) from
-- scenes; select count(*) from scene_revisions; select count(*) from tabs where scene_id is not null.
update tabs set scene_id = null where scene_id is not null;
delete from scenes;
alter table scenes drop column if exists runtime_locked;
