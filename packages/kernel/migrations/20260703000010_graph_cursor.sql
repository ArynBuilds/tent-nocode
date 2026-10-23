-- Per-org cursor: last event id folded into the graph by cartographer (FR-81).
create table graph_cursor (
  org_id uuid primary key references orgs(id) on delete cascade,
  last_event_id bigint not null default 0,
  updated_at timestamptz not null default now()
);
alter table graph_cursor enable row level security;
-- Intentionally no client policy/grant: graph_cursor is service-role-internal, read/written only
-- by the cartographer via the admin (RLS-bypassing) connection. A non-bypass kernel role would
-- read 0 rows here and never advance the cursor (readCursor's upsert would keep resetting to 0).

-- Edge idempotency (D-11): one edge per (org, source, target, relation).
create unique index graph_edges_identity_idx on graph_edges (org_id, source, target, relation);
