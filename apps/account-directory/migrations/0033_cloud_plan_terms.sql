-- Cloud 7's plans (Free, Plus, Pro, Max) change Plus's and Pro's disk. A
-- period that began before them keeps the old disk until the next period
-- starts, so nobody's disk shrinks mid-period: every account that exists now
-- is marked, and the next period start clears the mark (`store.ts`
-- `startFreshPeriod`). Accounts made from here on have the new terms. Hours
-- need no mark: each period stores its own (`included_milli`).
alter table cloud_accounts add column old_plan_terms integer not null default 0;
update cloud_accounts set old_plan_terms = 1;
-- When an account on the old terms whose computers hold more than the new
-- disk was told, before its renewal, that the new disk starts then (once).
alter table cloud_accounts add column old_terms_told_at integer;
-- Additive: apply it first, then deploy the Worker. A period that starts in
-- between keeps its mark one period longer (the old Worker doesn't clear it),
-- which only gives that account the larger disk a little longer.
