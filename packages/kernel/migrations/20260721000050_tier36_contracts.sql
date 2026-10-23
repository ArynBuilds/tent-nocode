-- Tier 36 Phase C (FR-368/FR-369, D-144): the scene's data contracts live on the SCENES
-- ROW (consent-class declarations — the tab-era manifest/content split kept: contracts at
-- consent, document content through the op wall). Additive only.
alter table scenes add column bindings jsonb not null default '[]'::jsonb;
alter table scenes add column actions jsonb not null default '[]'::jsonb;
