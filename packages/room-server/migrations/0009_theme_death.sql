-- ㊴ THE THEME DEATH (B4 2026-08-05) — desktop migration 77 mirrored: the projects
-- theme column (0001's mirror of desktop 73) dies whole; served scenes render the
-- house tokens + their own per-node style (the ㊳ aspect). Release envelopes keep any
-- stray `theme` keys as inert json (the reader died). Destructive per the no-users
-- ruling.
alter table projects drop column if exists theme;
