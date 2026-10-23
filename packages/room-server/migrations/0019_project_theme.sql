-- THE SERVING LINEAGE 0019 - the project theme mirrors the workspace (20260827000105): the
-- publish lands the project's design tokens as one jsonb and every served page reads them.
alter table projects add column if not exists theme jsonb;
alter table projects drop column if exists direction;
