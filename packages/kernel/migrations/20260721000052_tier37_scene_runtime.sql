-- Tier 37 B1 (FR-377, D-149; spec §0 checkpoint finding 5): the per-scene RUNTIME PIN
-- becomes a real stored column. Tier 36 served every scene cheirkit-1 from a hardcoded
-- host page; the backend seam ships as cheirkit@2 (a NEW hash-pinned entry — the
-- edit⇒bump⇒new-entry law), so the pin must be data: existing scenes keep cheirkit@1
-- (bytes untouched, pinned forever), new scenes mint at the kernel's current default.
-- Additive-only (D-146 posture).

alter table scenes add column runtime text not null default 'cheirkit@1';
