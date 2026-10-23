-- F14 THE CLOCK KINDS (2026-08-16, user-ruled: exactly theirs, no folding):
-- Schedule - Cron - Interval join the closed trigger vocabulary (the 86
-- widening's idiom); all three fire off the one sweep clock.
alter table triggers drop constraint triggers_kind_check;
alter table triggers add constraint triggers_kind_check
  check (kind in ('dataset_threshold', 'output_registered', 'file_landed', 'webhook_in', 'schedule', 'cron', 'interval'));
