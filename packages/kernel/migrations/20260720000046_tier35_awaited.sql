-- Tier 35 (FR-355, D-137): the awaited marker — the chat run currently holding its turn open
-- over this mission's settles (await_work). While that run is live the wake gate stays quiet
-- (the awaiting turn IS the reporter, D-138 one-reporter law); a marker pointing at a dead
-- run is stale (app death mid-await) and self-heals inside the gate. Additive only.
alter table thread_intents add column awaited_by uuid null;
