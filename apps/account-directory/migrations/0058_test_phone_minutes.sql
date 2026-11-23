-- The account test tool's iPhone minutes (src/cloud/ownerAccounts.ts,
-- src/cloud/phones.ts `phoneMinutesForLimits`). Additive only: apply before
-- the Worker that reads it.

-- The minutes the account's phone limits count this period instead of its
-- plan's (null: the plan's). Billing never reads it: extra minutes are counted
-- past the real plan's minutes. Cleared with the other test fields.
alter table cloud_accounts add column test_phone_minutes integer;
