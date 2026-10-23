-- Tier 51 Phase C (FR-455/FR-456, D-194): THE DATA DOORS' schema half.
-- deprecated_columns: cols that left the rowSchema for NEW writes but stay on stored rows
--   (FR-20 — never rename/retype/drop in place; the list is append-only in practice).
-- key_columns: declared upsert identity — the load door and append UPDATE on a key match
--   (keeping _id) instead of inserting a duplicate (the recurring-export idiom).
alter table datasets add column deprecated_columns jsonb not null default '[]';
alter table datasets add column key_columns jsonb null;
