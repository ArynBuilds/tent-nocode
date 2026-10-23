-- FR-216 (Tier 12 live finding, 2026-07-10): persist the four raw usage components the driver
-- already parses — input / output / cache_read / cache_creation — beside the collapsed
-- tokens_used. Audit-only telemetry: powers the cache forensics (is the D-23 byte-stable
-- prefix actually being cache-read across desk-turn spawns?). Null for pre-FR-216 runs and
-- drivers that report no usage — honest mixed history, same posture as tokens_used.
alter table runs add column if not exists usage jsonb;
