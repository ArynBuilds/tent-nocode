-- ㊴ THE THEME DEATH (B4 2026-08-05, spec 2026-08-05-freeform-and-data-wire-spec.md):
-- THERE IS NO PROJECT THEME. The column migration 73 added dies whole — every
-- color/font/corner/surface lives as a property ON the node (the ㊳ style aspect);
-- good-by-default = the components' own built-in defaults. Destructive by the
-- standing no-users ruling.
alter table projects drop column if exists theme;
