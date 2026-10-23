-- FR-292 (D-102): the workspace self-import dirty ledger.
--
-- A settling run that WROTE files under a granted folder / project root upserts one row per
-- root here (markCorpusDirty); the runner's truly-idle housekeeping lane imports quiet rows
-- via graphify update (deterministic, zero LLM) and deletes them on success. attempts caps
-- runaway retries (parked at 3 with a domain.import_failed event). marked_by carries the
-- dirtying job's created_by for the audited import job row's provenance.
--
-- path is stored NORMALIZED (lower-case, forward slashes, no trailing slash — the
-- corpusKeyForPath idiom), so one folder can never hold two rows under different spellings.

create table corpus_dirty (
  org_id uuid not null references orgs(id) on delete cascade,
  path text not null,
  marked_by uuid not null,
  attempts int not null default 0,
  last_write_at timestamptz not null default now(),
  primary key (org_id, path)
);
