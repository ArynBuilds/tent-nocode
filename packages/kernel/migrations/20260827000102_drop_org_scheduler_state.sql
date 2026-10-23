-- The cleanup slate (2026-08-27, user-ruled): org_scheduler_state is dead outright -
-- the run scheduler's pause lane died with the loop collapse and nothing reads or
-- writes the table any more. Hard drop, the no-users norm.

drop table if exists org_scheduler_state;
