-- Tier 28 (D-117/FR-315): work-run warm chains. The engine-side session reference a settled
-- run leaves behind (opaque to the kernel — the D-119 continuation contract). A later run on
-- the same pinned workspace may resume it within the freshness window, behind four walls
-- (artifact+cwd, freshness, approval hygiene, chain cap). Sessions are DISPOSABLE CACHE:
-- null or vanished files merely mean a cold start.
alter table runs add column if not exists session_id text;
