-- FR-13 delivery idempotency: routeResults may be re-invoked for the same run
-- (retry, replayed transaction, concurrent callers) — a partial unique index
-- on the (org_id, from_run, to_run) triple for 'result' messages guarantees at
-- most one result message per producer/dependent pair, so `on conflict ... do
-- nothing` in routeResults' insert makes delivery idempotent.
create unique index messages_result_delivery_idx on messages (org_id, from_run, to_run) where type = 'result';
