-- The scene's engine pin died with the engine registry: the engine is the tentkit build served
-- by content hash, and no reader of either column exists (the rooms lineage dropped them in 0018).
alter table scenes drop column if exists runtime;
alter table scenes drop column if exists runtime_locked;
