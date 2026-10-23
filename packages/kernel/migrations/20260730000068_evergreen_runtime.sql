-- THE EVERGREEN RUNTIME ruling (hub rulings 8d, 2026-07-30): apps follow the current
-- runtime; the pin becomes the opt-out. This one-time re-pin lifts every existing scene
-- to the fixed generation (cheirkit@11 — the root-components rendering fix); the
-- current-unless-locked serve default lands with the re-housing build. Sanctioned by the
-- no-users ruling (hard update, no compat ceremony). New scenes already mint at current.
update scenes set runtime = 'cheirkit@11';
