-- THE VAULT WRITER COLUMN WIDENS TO TEXT (the OAuth full-landing certification
-- caught it): machinery actors seal secrets too - the fleet's oauth callback
-- writes as 'oauth', the same way the record's events.actor carries machinery
-- names. A uuid-only created_by crashes every OAuth landing. Text matches the
-- house posture: the column says WHO wrote (a user id or a machinery name),
-- never joins.
alter table secrets alter column created_by type text using created_by::text;
