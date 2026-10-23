-- Tier 48 E (FR-444, D-188): import origin on the scene row — the launcher renders
-- "imported from <org>" honestly (LAW 1: the row owns it). Nullable, additive; local
-- scenes stay null. The Phase-0 "no migration expected" adjudication deferred the
-- final call to the import phase — this is that call: components carry origin in
-- their definition jsonb (T37 precedent), scenes have no jsonb pocket, so the column
-- is the honest home. scenes.seeded_from stays vestigial (never repurposed).
alter table scenes add column if not exists imported_from text null;
