-- Free's Small computers are free for sponsored cards only while the person
-- looks at their ADE Cloud chats from where the cards can show
-- (src/cloud/gravity.ts `SMALL_FREE_LOOK_MS`). A yes alone no longer keeps
-- Small free while the person is away, or for someone who said yes through a
-- VPN once and never sees a card.
-- `looked_at`: the last time a yes was given, or a look at one of the
-- account's ADE Cloud chats found the yes holding where the person was
-- (`/cloud/sponsored/seen`). Null for a no.
-- Every yes saved before this starts a fresh window now, so no one's Small
-- starts using credits on the deploy.
-- Additive only: apply before the Worker that reads it.
alter table cloud_sponsored_consent add column looked_at integer;
update cloud_sponsored_consent set looked_at = cast(strftime('%s', 'now') as integer) * 1000 where consent = 'granted';
