-- The committed per-app direction (AI-surface rebuild, Phase 7 completion):
-- {palette[], type, density, signature} stored on the project - written at
-- app_plan approval and at create_view's no-plan fast path, read by the
-- dialect lint and by every scene-editing run's compose tail.
alter table projects add column if not exists direction jsonb;
