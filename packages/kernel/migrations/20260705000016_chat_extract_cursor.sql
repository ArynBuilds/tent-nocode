-- Chat extraction cursor (FR-129 Task 15, verify-first fork resolved): extractDomainEntities's
-- existing "already extracted" bookkeeping is NOT a queryable marker at all — it's a call-once-at-
-- job-completion idiom, driven entirely by the runner's `justCompleted` transition flag (see
-- extractEntitiesIfDone in runner.ts). That mechanism structurally EXCLUDES chat jobs:
-- completeJobIfDone (orchestration/summary.ts) returns `{ done: false, justCompleted: false }`
-- unconditionally when `jobRow.kind === 'chat'`, because a chat job never terminates (FR-122) — so
-- there is no "job just completed" transition to hang extraction off of, ever, for chat. Since the
-- extraction candidates here are individual succeeded RUNS (chat turns), not a job-completion
-- event, a run-level high-water mark is needed instead. This mirrors graph_cursor's per-org
-- cursor idiom (20260703000010_graph_cursor.sql) but keys on a timestamp rather than an event id:
-- runs have no shared monotonic id sequence the way the org-scoped events table does, so the
-- ordering key is `created_at` instead.
create table chat_extract_cursor (
  org_id uuid primary key references orgs(id) on delete cascade,
  last_run_created timestamptz not null
);
alter table chat_extract_cursor enable row level security;
-- Same service-role-internal posture as graph_cursor: no client policy/grant. Read/written only
-- by sweepChatExtraction via the admin (RLS-bypassing) connection.
