-- THE GEOMETRY WIPE (Phase 12R): every scene document and saved library item carries the old
-- geometry words (stack/free, position/left/top, margin, chart channels at the top level) - there
-- is no migration lane; previous lives in documents are not important. Deletes for scenes, not
-- truncate: tabs keeps a foreign key on scenes (truncate refuses any referencing table, rows or
-- not); scene_revisions cascades from scenes. Nothing references component_definitions - truncate.
-- At deploy record the counts before and after: select count(*) from scenes; select count(*) from
-- scene_revisions; select count(*) from component_definitions; select count(*) from tabs where scene_id is not null.
update tabs set scene_id = null where scene_id is not null;
delete from scenes;
truncate table component_definitions;
