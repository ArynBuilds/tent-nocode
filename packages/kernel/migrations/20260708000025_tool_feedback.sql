-- Proving-pass F10 (2026-07-08): the graduation bounce → next-run feedback loop (FR-143's
-- "bounce feedback returns to the agent's next run like lint findings"). The auditor's rejection
-- note (e.g. "hardcoded absolute path — parameterize and constrain to /workspace, then resubmit")
-- was terminal: the agent never saw it, so it would re-nominate the same flawed script forever.
-- This flag lets the runner deliver each rejection note to the agent's next work run EXACTLY once.
alter table tool_candidates add column feedback_delivered boolean not null default false;
