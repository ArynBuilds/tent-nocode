-- Bug 13 (the human walk): jsonb key sort scrambled column positions - the
-- declared order is its own record; new columns append where you added them.
alter table datasets add column if not exists column_order text[];
