-- Pricing v3: a new computer whose create was priced at the ad price for a
-- person's first message (`src/cloud/adPrice.ts` `countStoredFirstProof`).
-- The create's reservation keeps that message here (`[chat id, message id]`)
-- until it counts as the computer's proof, so a create that died after the
-- provider made the computer still counts it once: on a replay of the create,
-- or in the minute tick. Only adds.
alter table cloud_computers add column ad_first_proof text;
