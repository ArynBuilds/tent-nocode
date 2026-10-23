-- FR-247 (Tier 19, D-69/D-71): record the ROUTED model on every run at claim time — the
-- per-model split is the execution tier's live quality gate (failure/correction/verdict rates
-- by model in health/fitness reads). Null = the CLI default model (judgment tier unpinned).
alter table runs add column model text;
