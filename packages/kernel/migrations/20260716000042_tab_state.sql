-- FR-298 (Tier 26, D-107): the per-tab private STATE POCKET — durable UI state (current view,
-- filters, drafts), deliberately OUTSIDE knowledge: never extracted, never recalled, never in
-- queryGraph (pinned). One row per tab; quota enforced kernel-side (domain.tabStateMaxKb);
-- dies with its tab (cascade). Org data never lands here — that is the dataset_write door.

create table tab_state (
  tab_id uuid primary key references tabs(id) on delete cascade,
  org_id uuid not null references orgs(id) on delete cascade,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table tab_state enable row level security;
create policy member_read_tab_state on tab_state for select using (org_id in (select user_org_ids()));
