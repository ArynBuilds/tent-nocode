-- FR-200: persist real token usage per run (input+output from the CLI result line's usage).
-- Display unit for spend is TOKENS (user decision 2026-07-10); cost_estimate stays for the ledger.
alter table runs add column if not exists tokens_used int;
