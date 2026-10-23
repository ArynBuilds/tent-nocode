-- Tier 25 I2 (FR-288/FR-290d): the workforce-creation stack's TABLES tombstone.
--
-- golden_tasks / tool_candidates / tool_sources lost their machinery in Tier 25 Phase G
-- (certification, evolution, tool growth) — no live reader or writer survives, so the tables
-- DROP. The append-only events log keeps the historical record (growth.*, tool.*, golden adds
-- were all evented); rows here were operational state, not the record.
--
-- chat_extract_cursor is DELIBERATELY KEPT: rebuildKnowledge's recovery arm (the one surviving
-- sweepChatExtraction caller, FR-207) still reads and resets it.
--
-- Inert COLUMNS are documented, never dropped (FR-290d — historical rows stay resolvable):
--   runs.model (telemetry), runs.verdict_note,
--   agent_versions.tool_scopes / test_cases / tools (unread by live code; the FR-291 legacy
--   seam still reads tool_scopes for grandfathered agents, incl. the Tab Builder).
-- The Operator agents row and retired forged-agent rows stay as status tombstones — run
-- attributions must keep resolving (FR-290d). Never row-delete.

drop table if exists tool_sources;
drop table if exists tool_candidates;
drop table if exists golden_tasks;
