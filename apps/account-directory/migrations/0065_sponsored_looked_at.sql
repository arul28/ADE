-- Free's Small computers are free for sponsored cards only in the US, and
-- only while the person opens their ADE Cloud chats from there at least once
-- a week (src/cloud/gravity.ts `SMALL_FREE_LOOK_MS`). A yes alone no longer
-- keeps Small free while the person is away, or for someone who said yes
-- through a VPN once and never sees a card.
-- `looked_at`: the last time a yes was given from the US, or a look at one of
-- the account's ADE Cloud chats from the US found the yes holding
-- (`/cloud/sponsored/seen`). Null for a no.
-- Every yes saved before this starts a fresh week now, so no one's Small
-- starts using credits on the deploy.
-- Additive only: apply before the Worker that reads it.
alter table cloud_sponsored_consent add column looked_at integer;
update cloud_sponsored_consent set looked_at = cast(strftime('%s', 'now') as integer) * 1000 where consent = 'granted';
