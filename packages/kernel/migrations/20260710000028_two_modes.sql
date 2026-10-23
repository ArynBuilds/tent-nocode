-- Tier 12 Plan C (FR-187, D-47): modes collapse ask|standard|agentic -> ask|auto.
-- standard -> ask (it still auto-ran small plans; post-D-48 nothing plan-shaped blocks anyway),
-- agentic -> auto. The budget cap key follows the mode rename. This migration IS the
-- compatibility layer: the core schema accepts only ask|auto after it.
-- threads.mode is the thread_mode ENUM -> swap the type wholesale so the legacy values cannot exist.
create type thread_mode_v2 as enum ('ask', 'auto');
alter table threads alter column mode type thread_mode_v2 using (
  case mode::text when 'standard' then 'ask' when 'agentic' then 'auto' else mode::text end
)::thread_mode_v2;
drop type thread_mode;
alter type thread_mode_v2 rename to thread_mode;

-- schedules.mode is plain text (migration 18).
update schedules set mode = 'ask' where mode = 'standard';
update schedules set mode = 'auto' where mode = 'agentic';

update orgs set config = jsonb_set(config, '{chat,defaultMode}', '"ask"')
  where config->'chat'->>'defaultMode' = 'standard';
update orgs set config = jsonb_set(config, '{chat,defaultMode}', '"auto"')
  where config->'chat'->>'defaultMode' = 'agentic';
update orgs set config = jsonb_set(
    config #- '{chat,agenticBudgetUsdPerJob}',
    '{chat,autoBudgetUsdPerJob}',
    config->'chat'->'agenticBudgetUsdPerJob')
  where config->'chat' ? 'agenticBudgetUsdPerJob';
