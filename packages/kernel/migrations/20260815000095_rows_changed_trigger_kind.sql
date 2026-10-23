-- F14/F31 (2026-08-16): ROWS CHANGE joins the closed trigger vocabulary - a
-- Table gains a row, the Watcher fires (the poll composition's second half:
-- mirror-sync feeds the inner table, this kind fires per fresh row).
alter table triggers drop constraint triggers_kind_check;
alter table triggers add constraint triggers_kind_check
  check (kind in ('dataset_threshold', 'output_registered', 'file_landed', 'webhook_in', 'schedule', 'cron', 'interval', 'rows_changed'));
