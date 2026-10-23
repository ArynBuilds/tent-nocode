-- Tier 41 (FR-402, D-161): template provenance. TIER 41 WAS REVERTED 2026-07-23
-- (user-ruled: first-party templates are the wrong move — the system must be
-- customizable enough that orgs mint their own starting points; work preserved on
-- branch tier41-seeded-gallery-set-aside). This migration had already applied to BOTH
-- DBs, so the file stays per the append-only law and `scenes.seeded_from` remains as a
-- vestigial nullable column — no live code writes or reads it. Never repurpose the
-- name; a future provenance feature mints its own column.
alter table scenes add column seeded_from text null;
