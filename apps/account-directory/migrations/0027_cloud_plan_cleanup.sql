-- A cheaper plan's limits free the oldest computers past them, each after its
-- own ADE pushed its work to GitHub (src/cloud/planCleanup.ts), and the person
-- hears once when timed wake-ups are cancelled. Additive only: apply this
-- migration first, then deploy the Worker.

-- When ADE frees what is over the plan in force (the person was told when it
-- was set); null while the account fits its plan.
alter table cloud_accounts add column plan_cleanup_due_at integer;
-- The last run that freed or kept something, as JSON (`CloudPlanCleanupDone`), and when.
alter table cloud_accounts add column plan_cleanup_result_json text;
alter table cloud_accounts add column plan_cleanup_result_at integer;
-- Timed wake-ups deleted because the computers may not wake: when (once a
-- period), how many, and why ('out_of_hours' or 'over_plan_disk').
alter table cloud_accounts add column wakes_cancelled_at integer;
alter table cloud_accounts add column wakes_cancelled_count integer;
alter table cloud_accounts add column wakes_cancelled_reason text;

-- A cleanup run working on this computer (a claim, so overlapping ticks run it
-- once), and the last time its work couldn't all be pushed (it stays, and is
-- tried again a day later).
alter table cloud_computers add column plan_cleanup_claimed_at integer;
alter table cloud_computers add column plan_cleanup_failed_at integer;

