-- FR-148: reserved genomes — the app's own agents (Desk = the voice, Operator = the hands),
-- implemented as real agents rows (versioning, run attribution, audit) but tagged so the
-- management view can hide them. NEVER model-authored: only kernel seeding code stamps this.
alter table agents add column reserved text check (reserved in ('voice', 'hands'));
