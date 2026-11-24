-- Credits (`src/cloud/credits.ts`): the ADE Cloud iPhone draws from the
-- account's one balance at one credit a minute.
--
-- `credits`: 1 when the phone started while the `cloud_credits` switch reached
-- its account. Such a phone's minutes count as credits (into
-- `cloud_accounts.used_milli`), never as the old iPhone minutes.
-- `credited_milli`: how much of its billed minutes is already in `used_milli`,
-- so a settle adds only what is new and a repeat adds nothing.
alter table cloud_phones add column credits integer not null default 0;
alter table cloud_phones add column credited_milli integer not null default 0;
