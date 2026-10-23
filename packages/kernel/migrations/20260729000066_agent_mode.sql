-- THE SPEED ARC (2026-07-29, D-x13/FR-x18): the mode LADDER grows its third rung —
-- 'agent' = auto + team dispatch (N parallel role-named runs). It changes NO permission
-- answer; org_settings/thread_mode stay neverAuto (the injection wall makes the ladder
-- safe to climb).
alter type thread_mode add value if not exists 'agent';
