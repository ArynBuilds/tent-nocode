-- THE DELETION DOORS (user-ruled 2026-08-02): tombstones for datasets + threads —
-- projects already carry archived_at (D-57: archive is a tombstone, never a delete),
-- scenes/tabs already carry status. Rows survive under a tombstoned dataset (the
-- record posture, FR-290); a tombstoned NAME becomes reusable — live-name uniqueness
-- narrows to undeleted rows.
alter table datasets add column deleted_at timestamptz null;
alter table threads add column deleted_at timestamptz null;
alter table datasets drop constraint datasets_org_id_name_key;
create unique index datasets_org_name_live on datasets (org_id, name) where deleted_at is null;
