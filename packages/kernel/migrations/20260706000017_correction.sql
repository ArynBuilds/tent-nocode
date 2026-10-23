-- Tier 7 (FR-133/FR-134): in-flight verification + the three-speed correction ladder.
--
-- verdict_note: the auditor/human verdict's cited unmet requirement (FR-133 criterion 3 must
-- cite what it objects to — a verdict without a citation can't feed the correction loop or the
-- forge's negative exemplars).
alter table runs add column verdict_note text;

-- correction_of: chains an evidence-appending correction run (FR-134 speed 1) to the run whose
-- contract failure it corrects. The chain's length per task IS the ladder state — no separate
-- counter table to drift.
alter table runs add column correction_of uuid references runs(id);
