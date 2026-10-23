-- THE LINK + THE EYE (E2, the fleet's authoring runner): the workspace DB
-- hosts MANY accounts - a vendor rate limit on ONE user's own key must pause
-- THAT account's lane alone, never everyone. The singleton scheduler_state
-- row stays the GLOBAL switch (ops/founder scope); claims honor BOTH: the
-- global pause and the claiming run's org pause. Rows mint lazily at the
-- first org-scoped pause; auto-resume is the timestamp passing, same as the
-- global row.
create table org_scheduler_state (
  org_id uuid primary key references orgs(id) on delete cascade,
  paused_until timestamptz,
  pause_reason text,
  updated_at timestamptz not null default now()
);

alter table org_scheduler_state enable row level security;
create policy member_read_org_scheduler_state on org_scheduler_state
  for select using (org_id in (select user_org_ids()));
