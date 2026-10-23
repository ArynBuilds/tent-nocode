-- Tier 32 (FR-343, D-132): the isolation marker — how this run holds its pinned folder.
-- NULL = direct ownership (today's shape, the solo case); 'worktree' = the run executes in
-- an isolated git worktree branched from the folder's HEAD and merges at settle (D-133).
-- The FR-280 wall FORKS, never lifts: naked same-folder concurrency stays structurally
-- impossible — direct and isolated runs never mix on one folder. Additive only.
alter table runs add column isolation text null check (isolation in ('worktree'));
