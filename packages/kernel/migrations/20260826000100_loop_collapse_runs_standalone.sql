-- THE LOOP COLLAPSE (Phase 5): runs become standalone record entities.
-- A run exists without a job; the jobs queue/claim/planning machinery dies in code.
-- The jobs table itself stays (writeless) until the Phase 3 drop-migration family.

-- The FK dies first so a later `drop table jobs` can never cascade historical runs away (wall 7).
alter table runs drop constraint if exists runs_job_id_fkey;
alter table runs alter column job_id drop not null;

-- The job facts a run needs ride the run row itself now.
alter table runs add column if not exists kind text not null default 'work' check (kind in ('chat', 'work'));
alter table runs add column if not exists thread_id uuid;
alter table runs add column if not exists workspace_path text;
alter table runs add column if not exists prompt text;

-- Backfill from the dying parents; historical rows stay whole record entities.
update runs r set
  kind = j.kind,
  thread_id = j.thread_id,
  workspace_path = j.workspace_path,
  prompt = j.prompt
from jobs j where j.id = r.job_id;

create index if not exists runs_org_thread_idx on runs (org_id, thread_id);

-- Stranded queue rows: the queue no longer exists to claim them; settle them honestly.
update runs set status = 'failed', finished_at = now(),
  failure = 'the run queue was removed (loop collapse) — this queued run never started'
where status = 'queued';
