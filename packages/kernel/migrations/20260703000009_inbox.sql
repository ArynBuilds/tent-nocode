alter table messages
  add column answered_at timestamptz,
  add column answer jsonb;

create index messages_open_escalations_idx on messages (org_id, created_at)
  where type = 'escalation' and answered_at is null;
