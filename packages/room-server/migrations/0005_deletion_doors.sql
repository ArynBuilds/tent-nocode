-- THE DELETION DOORS (user-ruled 2026-08-02), the serving half: the datasets tombstone
-- column the shared kernel readers now filter by (threads are a desktop-only organ —
-- no sibling column here). Rows survive under a tombstoned dataset; a tombstoned NAME
-- becomes reusable — live-name uniqueness narrows to undeleted rows.
alter table datasets add column deleted_at timestamptz null;
alter table datasets drop constraint datasets_org_id_name_key;
create unique index datasets_org_name_live on datasets (org_id, name) where deleted_at is null;
