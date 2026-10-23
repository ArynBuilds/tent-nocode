-- THE OWN LOOP + BYOK (spec 2026-08-11, L8): CONTINUATION BECOMES TRUTH — the API lane
-- persists REAL per-thread message arrays (verbatim tool-call texture between turns) in
-- Postgres, replacing the fake Claude-session JSONL trick for this lane. The row is a
-- DISPOSABLE CACHE in the Tier 28 stance: the record stays the truth; past the driver's
-- cap the next turn re-seeds from the kernel's windowed history. Cache breakpoints are
-- applied fresh at request time and never persisted.
create table api_thread_messages (
  thread_id uuid primary key references threads(id) on delete cascade,
  org_id uuid not null references orgs(id) on delete cascade,
  messages jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);
create index api_thread_messages_by_org on api_thread_messages (org_id, updated_at);
alter table api_thread_messages enable row level security;
create policy member_read_api_thread_messages on api_thread_messages for select using (org_id in (select user_org_ids()));
