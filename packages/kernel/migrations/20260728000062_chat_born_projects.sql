-- Tier 52 amendment (user-ruled 2026-07-28): EVERY chat birth creates its project —
-- chat-born projects have no folder, so the path becomes nullable. Folder projects
-- (create_project, the subtree grant) are unchanged; adoption's path matching skips
-- pathless rows by construction.
alter table projects alter column path drop not null;
