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
-- 1 while the subscription's extra-disk item is on the price from before
-- Cloud 7 ($1 for each 10 GB): the extra-disk limit and usage are priced at
-- what Stripe actually charges, apart from the plan's disk terms above. Set
-- when extra disk is turned on (from the item found or attached) and cleared
-- when a renewal moves the item to the current price (`billing.ts`). An
-- account with extra disk on now holds the item from before Cloud 7.
alter table cloud_accounts add column extra_disk_old_price integer not null default 0;
update cloud_accounts set extra_disk_old_price = 1 where extra_disk_state = 'on' and stripe_subscription_id is not null;
-- The hours a paid period had when a failed payment cut it short, given back
-- if that same period is restored (an upgrade mid-period changes them, so the
-- plan alone can't say).
alter table cloud_accounts add column past_due_included_milli integer;
-- Additive: apply it first, then deploy the Worker. A period that starts in
-- between keeps its mark one period longer (the old Worker doesn't clear it),
-- which only gives that account the larger disk a little longer.
