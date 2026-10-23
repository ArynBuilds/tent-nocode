-- The cleanup slate (2026-08-27, user-ruled, both traceless):
-- (1) the operator ORG ROLE dies - the library/marketplace serves sharing; multiplayer
--     comes much later. Stored 'operator' members become 'admin'; the enum recreates
--     without the value (Postgres cannot drop an enum member in place).
-- (2) the T0-T3 toolScope tier grammar dies - agent_versions.tool_scopes drops; run
--     permission rules are the one grammar.

update org_members set role = 'admin' where role = 'operator';

create type org_role_new as enum ('owner', 'admin', 'viewer');
alter table org_members
  alter column role type org_role_new using role::text::org_role_new;
drop type org_role;
alter type org_role_new rename to org_role;

alter table agent_versions drop column if exists tool_scopes;
