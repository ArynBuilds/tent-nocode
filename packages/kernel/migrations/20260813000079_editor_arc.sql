-- RENUMBERED 2026-08-13 (the link+eye E2, the duplicate-0067 repair): this file
-- was born as 20260730000067_editor_arc.sql SHARING its version number with
-- 20260730000067_delivery_channels.sql — the history table can hold one row per
-- version, so this one could never be recorded and every `migration up` since
-- tried to re-apply it. Moved to the lineage tail with IF NOT EXISTS guards so
-- every database converges: already-applied DBs no-op, fresh DBs apply late
-- (verified 2026-08-13: no migration 68-78 references these columns).
-- THE EDITOR ARC migration (2026-07-30, additive — D-e1/D-e8/D-e5):
--   projects.kind          — what the project surfaces as on human surfaces ('app' | 'website';
--                            null = pre-arc rows, read as 'app').
--   scenes.target_screen   — the design size the scene is designed against ({ w, h } jsonb;
--                            null = the project kind's default). Internal name stays
--                            (internals never rename); human surfaces speak "Designed for WxH".
--   datasets.column_display — optional per-column display-name overrides ({ "kebab-key": "Word" });
--                            null = mechanical prettify only. The underlying key NEVER renames.
alter table projects add column if not exists kind text null check (kind in ('app', 'website'));
alter table scenes add column if not exists target_screen jsonb null;
alter table datasets add column if not exists column_display jsonb null;
