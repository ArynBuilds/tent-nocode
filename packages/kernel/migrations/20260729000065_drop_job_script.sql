-- THE SPEED ARC (2026-07-29, D-x13/FR-x19 — F5 ruled; the no-users ruling sanctions the
-- destructive drop): the workflow-script engine is DELETED — width is a MODE (agent)
-- dispatching N one-run jobs; deterministic automation is the engine's own job
-- (chains/triggers/schedules). The persisted script column dies with its writer.
alter table jobs drop column if exists script;
