-- F4 (F0 slice 4d): the triggers kind CHECK widens additively - webhook_in
-- joins the closed kind vocabulary (the migration-57 constraint re-stated
-- whole; existing rows untouched).

alter table triggers drop constraint triggers_kind_check;
alter table triggers add constraint triggers_kind_check
  check (kind in ('dataset_threshold', 'output_registered', 'file_landed', 'webhook_in'));
