-- Pricing v3's cloud iPhone (`src/cloud/adPrice.ts`). Only adds.

-- Where the ad minutes already taken off a phone end. Kept when its price
-- goes back to full (`ad_mark_at` clears), and only grows: a minute is taken
-- off once, however often the price moves inside it.
alter table cloud_phones add column ad_paid_until integer;

-- The lowest ad rate a minute any of its minutes was taken off at (null: none
-- taken off). Its charge is never below its minutes at this rate (`credits.ts`).
alter table cloud_phones add column ad_rate_milli integer;
