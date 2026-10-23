-- Tier 25 FR-283 (D-95): the persisted workflow script. A swarm-scale ask stores its
-- deterministic script ON the job; the kernel engine replays it over the run-DAG (restart-safe,
-- unattended, audited). Additive; jobs without a script ride the one-run floor.
alter table jobs add column if not exists script text;
