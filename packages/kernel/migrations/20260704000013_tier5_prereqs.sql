-- Tier 5A prerequisites (spec Section 6c).

-- FR-106: bounded live tail, written at heartbeat, read by the Desk via RLS+Realtime.
alter table runs add column output_tail text;

-- FR-113: golden_tasks was the only org table without client read access.
grant select on golden_tasks to authenticated;
create policy member_read_golden_tasks on golden_tasks for select
  using (org_id in (select user_org_ids()));

-- FR-115: scheduler pause state is global and leaks no org data — make it readable
-- so the Desk can render "paused · resumes HH:MM" (FR-105).
grant select on scheduler_state to authenticated;
create policy member_read_scheduler_state on scheduler_state for select using (true);

-- FR-117 (with FR-107): human identities. Filled by an auth trigger on signup;
-- readable by users who share an org with the profile's owner (and by self).
create table profiles (
  user_id uuid primary key,
  email text not null,
  display_name text,
  created_at timestamptz not null default now()
);
alter table profiles enable row level security;
grant select on profiles to authenticated;
create policy member_read_profiles on profiles for select
  using (
    user_id = auth.uid()
    or exists (
      select 1 from org_members mine
      join org_members theirs on theirs.org_id = mine.org_id
      where mine.user_id = auth.uid() and theirs.user_id = profiles.user_id
    )
  );

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (user_id, email)
  values (new.id, new.email)
  on conflict (user_id) do update set email = excluded.email;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- FR-114: without this, FR-53's "Realtime everywhere" receives nothing.
alter publication supabase_realtime add table jobs, runs, messages, events, scheduler_state;
