-- FR-258 (Tier 21, D-78): a maintained global degree per node + trigram seeding, so queryGraph can
-- narrow the load in SQL instead of pulling the whole graph. Semantics-preserving: degree is the same
-- global incident-edge count the JS used to compute from a full edge load.
create extension if not exists pg_trgm;
create index graph_nodes_label_trgm_idx on graph_nodes using gin (label gin_trgm_ops);

alter table graph_nodes add column degree int not null default 0;

create or replace function graph_edge_degree() returns trigger language plpgsql as $$
begin
  if (tg_op = 'INSERT') then
    update graph_nodes set degree = degree + 1 where id in (new.source, new.target);
  elsif (tg_op = 'DELETE') then
    update graph_nodes set degree = degree - 1 where id in (old.source, old.target);
  end if;
  return null;
end $$;

create trigger graph_edge_degree_trg
  after insert or delete on graph_edges
  for each row execute function graph_edge_degree();

-- Backfill existing degrees from current edges (both endpoints).
update graph_nodes n set degree = (
  select count(*) from graph_edges e where e.source = n.id or e.target = n.id);
