-- Tier 25 FR-291 (D-96/D-101): the run permission-declaration column. Runs carry their OWN
-- pattern ruleset; claimNextRun reads the row (genome-shim fallback for legacy rows), which is
-- the seam that lets scopes leave agent_versions without a big-bang. Additive; `if not exists`
-- because this exact migration was pre-applied to the live local DB during design (2026-07-14).
alter table runs add column if not exists permission_rules jsonb;
