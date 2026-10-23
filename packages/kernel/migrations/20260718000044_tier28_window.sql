-- Tier 28 (D-118/FR-316): stepped windowing — the bounded chat view.
-- window_cutoff: transcript entries strictly BEFORE this instant have left the materialized
-- view in one chunk (the record keeps every word; retrieval serves them back on demand).
-- window_bridge: the model-authored handoff paragraph that opens the view after a step.
-- Both null = no step has ever fired (the common case; steps are rare by design).
alter table threads add column if not exists window_cutoff timestamptz;
alter table threads add column if not exists window_bridge text;
