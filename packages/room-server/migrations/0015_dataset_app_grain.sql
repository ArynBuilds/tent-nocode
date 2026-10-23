-- THE SERVING LINEAGE 0015 - THE APP GRAIN (F22 THE VISIT SOURCE, 2026-08-16).
-- Fleet parity with the workspace 4-value chain (supabase migration
-- 20260815000092): the user_scope check widens to admit 'app' - required
-- before app-grain tables (the visits Table) land on the runtime DB.

alter table datasets drop constraint datasets_user_scope_check;
alter table datasets add constraint datasets_user_scope_check
  check (user_scope in ('own', 'shared', 'submitted', 'app'));

-- F22: the visits Table is BORN on the serve path (ensureDataset inside the
-- visitor lane), so the runtime role gains exactly the datasets insert it
-- needs - RLS still narrows every row to the tenant (0003 Wall 3).
grant insert on datasets to room_runtime;
