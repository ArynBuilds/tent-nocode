-- THE SPEED ARC (2026-07-29 spec D-x2/FR-x1): THE KNOWLEDGE NODE — knowledge is a project
-- citizen. One table, the simplest honest shape: append-only sentences a human would say;
-- corrections SUPERSEDE (a pointer), never edit in place; dedup at write is the store's law
-- (normalized-body hash within the project), not the schema's. No kinds, no confidence
-- tiers, no edges. Notes never grant permission (the advisory wall — no consent reader
-- ever touches this table, structurally).
create table project_notes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  -- 'user' | 'desk' | 'run:<id>' — process-bound at the write door, never a tool argument.
  author text not null,
  body text not null check (char_length(body) between 8 and 2000),
  superseded_by uuid null references project_notes(id),
  created_at timestamptz not null default now()
);
create index project_notes_by_project on project_notes (project_id, created_at);
create index project_notes_by_org on project_notes (org_id, created_at);
alter table project_notes enable row level security;
create policy member_read_project_notes on project_notes for select using (org_id in (select user_org_ids()));
