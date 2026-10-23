-- THE SERVING LINEAGE 0000 — local prelude (FR-560/D-260).
-- On a real Supabase project the auth schema exists and every statement here is a
-- no-op. On LOCAL scratch databases (spike/test clusters) this stub provides the one
-- auth surface the lineage's FKs need: auth.users. Nothing else of GoTrue is faked.
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key,
  email text,
  created_at timestamptz not null default now()
);
