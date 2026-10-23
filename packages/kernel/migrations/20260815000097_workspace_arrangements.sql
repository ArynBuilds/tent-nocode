-- E12 THE ARRANGEMENT TRAVELS (the editor-in-the-map arc, 2026-08-19): where
-- every card and screen sits on the Workspace - positions + fold groups -
-- becomes PROJECT DATA (one record per project), like n8n's canvases travel.
-- The doc is presentation state (never published; the tproject export carries
-- it as an optional field). localStorage positions die renderer-side.

create table workspace_arrangements (
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  -- The whole arrangement: { positions: {nodeId: {x,y}}, folds: [...],
  -- foldSeeds: [...], compositeSeeds: [...] } - sections owned renderer-side.
  doc jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (org_id, project_id)
);

alter table workspace_arrangements enable row level security;
create policy member_read_workspace_arrangements on workspace_arrangements
  for select using (org_id in (select user_org_ids()));
