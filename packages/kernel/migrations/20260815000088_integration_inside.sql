-- THE COMPOSITE MACHINERY M1 (user-ruled mid-flight 2026-08-15: the unfold /
-- inner-table machinery is CORE built once - agents only declare). The
-- connection row records WHICH real datasets its declared inside tables were
-- born as at placement: inside = {"tables": {"sent-messages": "slack-sent-messages"}}.
-- The datasets themselves are ordinary project Tables (the one dataset law);
-- they die with the node (revoke tombstones them) and refuse lone deletion
-- (the insides are undeletable - delete the whole node, the ruling verbatim).

alter table integration_connections add column inside jsonb not null default '{}';
