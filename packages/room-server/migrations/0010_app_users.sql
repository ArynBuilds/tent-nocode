-- THE SERVING LINEAGE 0010 - THE PER-VISITOR GRAIN. Born hardened like 0003: FORCE RLS,
-- SELECT-wrapped GUC policies, least grants, no password ever.
--
-- app.end_user_id - the OPAQUE per-app user id inside a served app: only app_users.id
-- rides this leg, never the account id behind it.

-- ---- THE OPAQUE PER-APP USER IDS (M21/Q8: the tentis account id never leaves
-- the platform; a creator lane cannot join opaque to account by construction) ----
create table app_users (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  room_app_id uuid not null references room_apps(id) on delete cascade,
  account_user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (room_app_id, account_user_id)
);

-- ---- Q8 THE PER-TABLE GRAINS: each user's own (DEFAULT) · shared between the
-- app's users · submitted to the creator. app_user_id null = app-level row. ----
alter table datasets add column user_scope text not null default 'own'
  check (user_scope in ('own', 'shared', 'submitted'));
alter table dataset_rows add column app_user_id uuid;
create index dataset_rows_by_app_user on dataset_rows (dataset_id, app_user_id);

-- THE STAMP: every row born inside an end-user session belongs to that user -
-- structurally, whatever code inserted it (no kernel write path needs teaching;
-- the GUC is the actor context; creator/publish lanes leave it null).
create or replace function stamp_app_user() returns trigger
language plpgsql as $$
begin
  if new.app_user_id is null then
    new.app_user_id := nullif(current_setting('app.end_user_id', true), '')::uuid;
  end if;
  return new;
end $$;
create trigger dataset_rows_stamp_app_user before insert on dataset_rows
  for each row execute function stamp_app_user();


-- app_users is DEFINER-ONLY: no role reads or writes the mapping table directly.
revoke all on app_users from room_runtime, room_publish;

-- ---- FORCE RLS on the mapping table ----
alter table app_users enable row level security;
alter table app_users force row level security;

-- ---- THE PER-USER ROW WALL (Q8): the policy splits by ROLE. The publish lane
-- keeps the whole-org view; the runtime (serving) lane sees app-level rows, its
-- OWN user's rows, and all rows of 'shared'-scope datasets - never another
-- user's 'own' or 'submitted' rows, whatever the query says (Wall 3 physics). ----
drop policy dataset_rows_org on dataset_rows;
create policy dataset_rows_publish on dataset_rows as permissive for all
  to room_publish
  using (org_id = (select nullif(current_setting('app.org_id', true), '')::uuid))
  with check (org_id = (select nullif(current_setting('app.org_id', true), '')::uuid));
create policy dataset_rows_runtime on dataset_rows as permissive for all
  to room_runtime
  using (org_id = (select nullif(current_setting('app.org_id', true), '')::uuid)
    and (app_user_id is null
      or app_user_id = (select nullif(current_setting('app.end_user_id', true), '')::uuid)
      or exists (select 1 from datasets d
                 where d.id = dataset_rows.dataset_id and d.user_scope = 'shared')))
  with check (org_id = (select nullif(current_setting('app.org_id', true), '')::uuid)
    and (app_user_id is null
      or app_user_id = (select nullif(current_setting('app.end_user_id', true), '')::uuid)));

-- ---- The definer doors (no table exposure) ----
-- The opaque-id mint/resolve: the ONE door to app_users.
create or replace function resolve_app_user(p_room_app uuid, p_account uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_org uuid;
begin
  select id into v_id from app_users
    where room_app_id = p_room_app and account_user_id = p_account;
  if v_id is not null then return v_id; end if;
  select org_id into v_org from room_apps where id = p_room_app;
  if v_org is null then return null; end if;
  insert into app_users (org_id, room_app_id, account_user_id)
    values (v_org, p_room_app, p_account)
    on conflict (room_app_id, account_user_id) do nothing;
  select id into v_id from app_users
    where room_app_id = p_room_app and account_user_id = p_account;
  return v_id;
end $$;
revoke all on function resolve_app_user(uuid, uuid) from public;
grant execute on function resolve_app_user(uuid, uuid) to room_runtime, room_publish;

