-- Task 7 (FR-53, desktop form): Postgres LISTEN/NOTIFY bridge, replacing Supabase Realtime
-- for the desktop app. The desktop has no external Realtime server (D-9 lineage: embedded
-- Postgres only, must work fully offline) — main's dedicated LISTEN connection
-- (apps/desktop/src/main/live/notify.ts) receives these notifies and forwards a typed pointer
-- to every renderer window, which refetches the affected query over the existing typed IPC
-- reads (shared/ipc.ts). The payload is a POINTER only (table + op + org_id + id), never the
-- full row: pg_notify has an ~8KB payload limit, and trusting NOTIFY itself as a data channel
-- (rather than a "something changed, go refetch" signal) would reintroduce the same
-- stale-cache-vs-source-of-truth class of bug Realtime-as-cache is prone to.
--
-- This is a real, shared migration (not desktop-only): the kernel's Supabase schema gets these
-- triggers too (harmless there — nothing currently LISTENs on `desk_live` against Supabase),
-- and the desktop's migration runner (Task 4) picks this file up automatically on next boot.

create or replace function public.desk_notify() returns trigger
language plpgsql as $$
begin
  perform pg_notify('desk_live', json_build_object(
    'table', TG_TABLE_NAME,
    'op', TG_OP,
    'org_id', NEW.org_id,
    'id', NEW.id::text
  )::text);
  return NEW;
end;
$$;

create trigger desk_notify_jobs
  after insert or update on jobs
  for each row execute function public.desk_notify();

create trigger desk_notify_runs
  after insert or update on runs
  for each row execute function public.desk_notify();

create trigger desk_notify_messages
  after insert or update on messages
  for each row execute function public.desk_notify();

create trigger desk_notify_events
  after insert or update on events
  for each row execute function public.desk_notify();

-- scheduler_state is global (no org_id column, and its primary key is `id int`, not the
-- uuid `id` the other four tables use) — reusing desk_notify() would fail at
-- `NEW.org_id` (no such column), so it gets its own trigger function that hardcodes
-- org_id to null (FR-115: the scheduler pause banner is global, not org-scoped).
create or replace function public.desk_notify_scheduler_state() returns trigger
language plpgsql as $$
begin
  perform pg_notify('desk_live', json_build_object(
    'table', TG_TABLE_NAME,
    'op', TG_OP,
    'org_id', null,
    'id', NEW.id::text
  )::text);
  return NEW;
end;
$$;

create trigger desk_notify_scheduler_state
  after insert or update on scheduler_state
  for each row execute function public.desk_notify_scheduler_state();
