-- Where sponsored cards start on now depends on the US state, and Global
-- Privacy Control is an opt-out for the whole account (src/cloud/gravity.ts).
-- `cloud_sponsored_viewers.region`: the state (Cloudflare's `regionCode`) of
-- a person's latest look at an ADE Cloud chat, beside its country: the Index
-- checks the person's yes still holds where they last looked (California is
-- asked first, `ASK_FIRST_REGIONS`).
-- `cloud_sponsored_consent.gpc`: 1 when the yes was given from a browser that
-- sends Global Privacy Control, after the second confirm: that yes holds
-- there. A yes without it is turned into a no (`source` `gpc`) the first time
-- a browser of the person sends the signal from the US.
-- Additive only: apply before the Worker that reads it.
alter table cloud_sponsored_viewers add column region text;
alter table cloud_sponsored_consent add column gpc integer not null default 0;
