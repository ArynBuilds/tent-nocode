-- Tier 46 Phase C+D (FR-418/419 the reactive graph · FR-420 event-condition triggers;
-- D-170/D-171): ONE migration for the tier's whole data plane. The desk_notify triggers
-- land WITH the tables (the T38 §4b law: tables notify from birth) and the type-exhaustive
-- LiveTable allowlist widens in the SAME commit.

-- FR-418/419 (D-170): reactive chains — output→operation dependency records that are ALSO
-- the standing grant (one row, two duties — the adjudication recorded in the plan C0).
-- `operation` is name-keyed with NO FK (the registry's own resolution law; FR-290 posture):
-- chains run the newest ACTIVE version; a retired operation stops the chain honestly.
-- `watch` is derived from the input template's output-typed values at creation, stored
-- explicit for the cheap fire-time lookup. Revoke = tombstone (revoked_at), never delete.
create table reactive_chains (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  operation text not null,
  inputs jsonb not null default '{}'::jsonb,
  watch text[] not null,
  enabled boolean not null default true,
  grant_mode text not null check (grant_mode in ('ask-approved', 'auto')),
  created_by text not null,
  revoked_at timestamptz null,
  created_at timestamptz not null default now()
);
create index reactive_chains_by_org on reactive_chains (org_id, created_at);
alter table reactive_chains enable row level security;
create policy member_read_reactive_chains on reactive_chains for select using (org_id in (select user_org_ids()));

-- D-170.3 (staleness honesty): a registered output whose successor has landed renders
-- STALE — regardless of whether auto-recompute is granted. ADDITIVE: the status CHECK is
-- untouched; re-registration of the same name clears staleness on the NEW row by
-- construction (fresh rows are born with stale_at null).
alter table derived_outputs add column stale_at timestamptz null;

-- FR-420 (D-171): event-condition triggers — the second automation organ beside cron.
-- `edge_state` holds the last-observed state for edge detection (fired once per crossing,
-- never level-spam). Consent rides the EXISTING machinery (schedule-family posture);
-- revoked_at is the tombstone.
create table triggers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  kind text not null check (kind in ('dataset_threshold', 'output_registered', 'file_landed')),
  spec jsonb not null,
  action jsonb not null,
  enabled boolean not null default true,
  edge_state jsonb not null default '{}'::jsonb,
  created_by text not null,
  revoked_at timestamptz null,
  created_at timestamptz not null default now()
);
create index triggers_by_org on triggers (org_id, created_at);
alter table triggers enable row level security;
create policy member_read_triggers on triggers for select using (org_id in (select user_org_ids()));

-- The notify floor, WITH the tables (T38 §4b — never a silently-dead LiveTable).
create trigger desk_notify_reactive_chains
  after insert or update on reactive_chains
  for each row execute function public.desk_notify();
create trigger desk_notify_triggers
  after insert or update on triggers
  for each row execute function public.desk_notify();
