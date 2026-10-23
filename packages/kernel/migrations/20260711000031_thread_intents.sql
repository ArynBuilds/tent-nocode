-- Tier 15 (FR-229, D-62): the intent is the loop variable. Every user ask writes a durable,
-- thread-attached intent — outcome-shaped parts each carrying a one-line acceptance test and a
-- status. The loop lives in THIS row, not in any session: wakes read it, mark it, act on it.
-- parts jsonb: [{ text, acceptance, status: pending|in_flight|done|blocked|dropped, jobId?, note? }]
create table thread_intents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  thread_id uuid not null references threads(id) on delete cascade,
  status text not null default 'open' check (status in ('open','done','parked','cancelled')),
  parts jsonb not null,
  wakes_used int not null default 0,
  note text null,                    -- the parked question / latest revision note
  created_by uuid null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index thread_intents_live on thread_intents(thread_id) where status in ('open','parked');
alter table thread_intents enable row level security;
create policy member_read_thread_intents on thread_intents for select using (org_id in (select user_org_ids()));
alter publication supabase_realtime add table thread_intents;
