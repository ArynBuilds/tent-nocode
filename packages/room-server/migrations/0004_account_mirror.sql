-- THE SERVING LINEAGE 0004 — the identity MIRROR (cloud part 2; the ALL-AWS reality).
-- Supabase/GoTrue retired end-to-end (hub ruling 2026-07-31): account identity lives in
-- the SITE's own database (users), not in this cluster — so the lineage's auth.users
-- stub is now the rooms-side identity MIRROR, fed at first publish. The publish door's
-- VERIFIED contract-v2 JWT is the identity proof (signed by our site with the shared
-- secret); mint_account_org (SECURITY DEFINER, execute = room_publish only — the 0003
-- grants survive create-or-replace) self-provisions the 1:1 mirror row before minting
-- the account org. Without this, every real publish dies on the account_user_id FK.
create or replace function mint_account_org(p_user uuid, p_name text, p_email text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_org uuid;
begin
  select id into v_org from orgs where account_user_id = p_user;
  if v_org is not null then return v_org; end if;
  insert into auth.users (id, email) values (p_user, p_email) on conflict (id) do nothing;
  insert into orgs (name, account_user_id) values (p_name, p_user) returning id into v_org;
  insert into org_members (org_id, user_id, role) values (v_org, p_user, 'owner');
  insert into profiles (user_id, email, display_name) values (p_user, p_email, p_name)
    on conflict (user_id) do nothing;
  return v_org;
end $$;
