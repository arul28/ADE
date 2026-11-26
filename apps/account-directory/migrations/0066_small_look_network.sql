-- Free Small's tripwire (src/cloud/sponsoredSmall.ts): a US look keeps Free's
-- Small free for 7 days, and a script on the person's own ADE Cloud computer
-- could send those looks with nobody watching. Nothing is refused for it: the
-- look still counts, and the owner is told (an email, Sentry, the daily report).
-- `cloud_computers.net_asn`: the network (Cloudflare's AS number) the
-- computer's brain calls ADE's server from, kept from its activity reports.
-- `cloud_computers.join_asn`: the network the computer joined from (its
-- launch join, made by the computer itself with a one-time code no person
-- holds), so no account can fake it: the networks ADE Cloud's computers use.
-- `cloud_sponsored_consent.looked_asn`: the network of the look or US yes that
-- last moved `looked_at`, cleared with it by a no. Neither is a person's address: an AS number names a
-- network (an ISP, a hosting company), never one connection.
-- Additive only: apply before the Worker that reads it.
alter table cloud_computers add column net_asn integer;
alter table cloud_computers add column join_asn integer;
alter table cloud_sponsored_consent add column looked_asn integer;
create index cloud_computers_join_asn on cloud_computers (join_asn, created_at) where join_asn is not null;
