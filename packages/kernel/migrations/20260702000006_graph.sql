create type edge_confidence as enum ('EXTRACTED', 'INFERRED', 'AMBIGUOUS');

create table graph_nodes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  key text not null,
  kind text not null,
  label text not null,
  data jsonb not null default '{}',
  community_id int,
  untrusted boolean not null default false,
  created_at timestamptz not null default now(),
  unique (org_id, key)
);

create table graph_edges (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  source uuid not null references graph_nodes(id) on delete cascade,
  target uuid not null references graph_nodes(id) on delete cascade,
  relation text not null,
  confidence edge_confidence not null,
  source_location text,
  created_at timestamptz not null default now()
);

create index graph_edges_source_idx on graph_edges (source);
create index graph_edges_target_idx on graph_edges (target);
