-- Phase 13.9: the rooms scenes table's runtime pin died with the engine registry (Phase 12) -
-- the engine is the tentkit build served by content hash; no reader of either column exists.
alter table scenes drop column if exists runtime;
alter table scenes drop column if exists runtime_locked;
