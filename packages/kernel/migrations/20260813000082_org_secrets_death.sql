-- THE OLD VAULT DIES (E3's cleanup, user-ordered 2026-08-13: "you can just
-- delete the d[papi] table if that's unused"): org_secrets held machine-locked
-- Windows-encrypted ciphertext; the cloud vault (`secrets`, migration 0081)
-- replaced it whole and no secrets exist to carry (NO USERS YET).
drop table if exists org_secrets;
