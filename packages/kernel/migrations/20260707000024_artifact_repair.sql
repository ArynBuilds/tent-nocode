-- Proving-pass D2 repair (2026-07-07): the artifact fold used to run on CHAT runs too, flooding
-- the graph with indistinguishable bare-"output" nodes (one per desk reply). The fold is now
-- work-jobs-only with a task→prompt label fallback (cartographer.ts); this migration repairs
-- already-folded data the same deterministic way — everything below derives from the record.

-- 1a. Chat entity mentions were anchored to the chat artifact; re-anchor them to the RUN node
--     (the reply's true provenance — extract.ts now writes them there) before the artifact
--     nodes are deleted, so no entity orphans. Skips any edge that already exists run-side.
update graph_edges e
set source = rn.id
from graph_nodes an
join runs r on an.key = 'artifact:' || r.id::text and an.org_id = r.org_id
join jobs j on j.id = r.job_id and j.kind = 'chat'
join graph_nodes rn on rn.key = 'run:' || r.id::text and rn.org_id = an.org_id
where e.source = an.id
  and an.kind = 'artifact'
  and e.relation = 'mentions'
  and not exists (
    select 1 from graph_edges dup
    where dup.org_id = e.org_id and dup.source = rn.id and dup.target = e.target and dup.relation = e.relation);

-- 1b. Chat-run artifacts should never have existed: delete them (remaining edges cascade via FK).
delete from graph_nodes n
using runs r, jobs j
where n.kind = 'artifact'
  and n.key = 'artifact:' || r.id::text
  and n.org_id = r.org_id
  and j.id = r.job_id
  and j.kind = 'chat';

-- 2. Remaining bare-"output" artifacts (work runs whose input carried no task string):
--    relabel from the same fallback chain the fold now uses — run input task, else job prompt.
update graph_nodes n
set label = 'output: ' || left(coalesce(nullif(r.input->>'task', ''), j.prompt), 60)
from runs r
join jobs j on j.id = r.job_id
where n.kind = 'artifact'
  and n.label = 'output'
  and n.key = 'artifact:' || r.id::text
  and n.org_id = r.org_id
  and length(coalesce(nullif(r.input->>'task', ''), j.prompt)) > 0;
