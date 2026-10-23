-- Tier 38 Phase A (D-153 pre-build, spec §4b): scenes/scene_revisions join the desktop's
-- desk_live NOTIFY set. Migration 51 added them to the supabase_realtime PUBLICATION —
-- which the desktop never listens to (its Realtime replacement is the Tier 5 LISTEN/NOTIFY
-- bridge, 20260704000014) — so SceneScreen's live refetch has been silently dead since
-- Tier 36. Both tables carry org_id + uuid id, so the shared desk_notify() applies.
-- scene_revisions is append-only by law (FR-364): insert-only trigger, the dataset_rows
-- precedent.

create trigger desk_notify_scenes
  after insert or update on scenes
  for each row execute function public.desk_notify();

create trigger desk_notify_scene_revisions
  after insert on scene_revisions
  for each row execute function public.desk_notify();
