-- THE RE-HOUSING R5 (hub ruling 8d, §1.7): EVERGREEN RUNTIME — the serve default flips
-- to current-unless-locked; this column is the OPT-OUT pin ("Lock this app's engine
-- version", a quiet human row, zero cards). Migration 68 already re-pinned existing
-- scenes to the fixed generation; from here scenes.runtime records where a LOCKED app
-- stays (and where every app was last served from).
alter table scenes add column runtime_locked boolean not null default false;
