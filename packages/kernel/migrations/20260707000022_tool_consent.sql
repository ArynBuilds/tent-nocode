-- Tier 8 Part 2 (FR-151): native/T2/T3 tool graduations wait on a human consent card. A candidate
-- that reached the card leaves 'pending' so it can't re-fire the trigger while the card is open.
alter table tool_candidates drop constraint if exists tool_candidates_status_check;
alter table tool_candidates add constraint tool_candidates_status_check
  check (status in ('pending', 'awaiting_consent', 'graduated', 'rejected'));
