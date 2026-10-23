-- Tier 36 Phase E (FR-371, D-148): the tab becomes the scene's FIRST HOST — a tab row may
-- point at a scene; scene-backed tabs render through CheirKit, bundle-era tabs tombstone at
-- Phase F (rows survive, FR-290). Realtime on scenes/scene_revisions powers the host's live
-- refetch (FR-114 idiom). Additive only.
alter table tabs add column scene_id uuid null references scenes(id);
alter publication supabase_realtime add table scenes, scene_revisions;
