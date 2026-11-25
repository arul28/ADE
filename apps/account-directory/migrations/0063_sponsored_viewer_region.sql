-- The state (Cloudflare's `regionCode`) of a person's latest look at an ADE
-- Cloud chat, beside its country: the Index checks the person's yes still
-- holds where they last looked, and in the US that depends on the state
-- (src/cloud/gravity.ts `ASK_FIRST_REGIONS`: California is asked first).
-- Additive only: apply before the Worker that reads it.
alter table cloud_sponsored_viewers add column region text;
