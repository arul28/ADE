-- Free Small's tripwire (src/cloud/sponsoredSmall.ts): a US look keeps Free's
-- Small free for 7 days, and a script on the person's own ADE Cloud computer
-- could send those looks with nobody watching. Nothing is refused for it: the
-- look still counts, and the owner is told (an email, Sentry, the daily report).
-- `cloud_computers.net_asn`: the network (Cloudflare's AS number) the
-- computer's brain calls ADE's server from, kept from its activity reports.
-- `cloud_sponsored_consent.looked_asn`: the network of the look or US yes that
-- last moved `looked_at`, cleared with it by a no. Neither is a person's address: an AS number names a
-- network (an ISP, a hosting company), never one connection.
-- Additive only: apply before the Worker that reads it.
alter table cloud_computers add column net_asn integer;
alter table cloud_sponsored_consent add column looked_asn integer;
-- The tripwire also counts how many accounts' live computers call from a
-- network (the provider's, which one account can't rewrite for everyone).
create index cloud_computers_net_asn on cloud_computers (net_asn, user_id) where deleted_at is null and net_asn is not null;
