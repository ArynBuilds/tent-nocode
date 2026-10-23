-- Tier 52 (D-201, FR-464): PROJECTS ARE THE SPINE — threads adopt a project by gravity.
-- The tier's ONE migration: threads.project_id, nullable (null = General, the unscoped daily
-- layer). Adoption is mechanical at settle (kernel, adoption ONLY while null); reassign/detach
-- goes through the small governed door. on delete set null: archiving is a tombstone and never
-- deletes, but a hard project delete must re-home its threads to General, never orphan them.
alter table threads add column project_id uuid null references projects(id) on delete set null;
create index threads_project_idx on threads (project_id);
