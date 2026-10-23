-- Tier 15 (FR-232): the living checklist rides desk_live — every intent write (create, part
-- claim, revision, park, complete, cancel) pings the renderer, which refetches the typed
-- threadIntent read. thread_intents has org_id + uuid id, so the shared desk_notify() applies.
create trigger desk_notify_thread_intents
  after insert or update on thread_intents
  for each row execute function public.desk_notify();
