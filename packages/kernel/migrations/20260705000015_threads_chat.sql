-- Task 1 (FR-121): threads (chat-first Desk) — threads table, jobs.thread_id/kind, message_type
-- gains 'chat'. Every pre-existing job is backfilled into its own thread so the client can
-- always render jobs through a thread; no legacy null-thread special-casing.

create type thread_mode as enum ('ask', 'standard', 'agentic');

create table threads (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  title text not null,
  mode thread_mode,                -- null = inherit orgConfig.chat.defaultMode (FR-126)
  created_by uuid not null,
  created_at timestamptz not null default now()
);
create index threads_org_idx on threads (org_id, created_at desc);

alter table jobs
  add column thread_id uuid references threads(id),
  add column kind text not null default 'work' check (kind in ('work', 'chat'));

alter type message_type add value if not exists 'chat';

-- Chat user messages carry threadId in payload (escalations carry jobId the same way). This is
-- a plain expression index rather than a partial index on `type = 'chat'`: referencing a just-
-- added enum value in a WHERE predicate within the SAME migration transaction that adds the
-- value fails with "unsafe use of new value 'chat' of enum type message_type" (each migration
-- runs in one transaction, both here and in the desktop's per-migration runner). The plain
-- expression index serves the same threadId lookups without touching the enum value.
create index messages_thread_payload_idx on messages ((payload->>'threadId'));

-- FR-121 backfill: one thread per existing job, title = prompt head
insert into threads (org_id, title, created_by, created_at)
select org_id, left(prompt, 120), created_by, created_at from jobs where thread_id is null;
update jobs j set thread_id = t.id
from threads t
where j.thread_id is null and t.org_id = j.org_id
  and t.title = left(j.prompt, 120) and t.created_at = j.created_at;

-- RLS: same org-member read-only policy shape as jobs (20260702000007_rls.sql). The blanket
-- `grant select on all tables in schema public` in that migration only covers tables that
-- existed at the time it ran, so new tables (see 20260703000008_execution.sql,
-- 20260704000013_tier5_prereqs.sql) grant select individually.
alter table threads enable row level security;
grant select on threads to authenticated;
create policy member_read_threads on threads for select
  using (org_id in (select user_org_ids()));

-- Live channel (FR-121): same trigger shape + function as jobs/runs/messages/events in
-- 20260704000014_notify_triggers.sql (public.desk_notify(), reads NEW.org_id).
create trigger desk_notify_threads
  after insert or update on threads
  for each row execute function public.desk_notify();
