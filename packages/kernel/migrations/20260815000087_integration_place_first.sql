-- THE EMPTY-CONNECTS LAW applied to placement (F0 slice 5a): "anything empty
-- should be able to be connected no matter" - placing an integration node is a
-- HUMAN GESTURE needing zero dialogs, so the node row is born 'unconnected'
-- (the honest empty state renders); the Connect card is the LATER activation
-- moment (credentials + the owner-pinned host). STATE never refuses; calls
-- against an unconnected node refuse AT FIRE with one plain sentence.

alter table integration_connections drop constraint integration_connections_status_check;
alter table integration_connections add constraint integration_connections_status_check
  check (status in ('unconnected', 'active', 'revoked'));
alter table integration_connections alter column status set default 'unconnected';
