-- THE SERVING LINEAGE 0020 - the columns the workspace grew since 0016, mirrored so a publish
-- lands the same rows it reads: table and operation display names, the column order and
-- display, and a screen's design size.
alter table datasets add column if not exists display_name text;
alter table datasets add column if not exists column_order text[];
alter table datasets add column if not exists column_display jsonb;
alter table operations add column if not exists display_name text;
alter table scenes add column if not exists target_screen jsonb;
