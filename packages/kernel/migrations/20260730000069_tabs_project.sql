-- THE PROJECT-LANDING RULING (user, 2026-07-30, relayed mid-rehousing): everything the
-- user creates lands INSIDE a project. Views (tabs) gain a REAL project_id written at
-- creation by every lane; the brittle record-derivation (runs' create_tab messages
-- matched by title) dies with this backfill. General stays the ruled unscoped layer for
-- THREADS only (D-201) — a view can never land there again.

alter table tabs add column project_id uuid null references projects(id) on delete set null;

-- Backfill: the exact derivation listTabs used until now, run once, persisted.
update tabs t
set project_id = (
  select th.project_id
  from messages m
  join runs r on r.id = (m.payload->>'runId')::uuid
  join jobs j on j.id = r.job_id
  join threads th on th.id = j.thread_id
  where j.org_id = t.org_id
    and m.payload->>'kind' = 'create_tab'
    and m.payload->>'title' = t.title
    and th.project_id is not null
  order by m.created_at desc
  limit 1
)
where t.project_id is null;
