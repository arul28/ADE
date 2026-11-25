-- Sponsored cards start on where the law lets them (src/cloud/gravity.ts
-- `startsOnFor`, `GRAVITY_DEFAULT_ON_COUNTRIES`, the US by default): the
-- person is told they are on and can turn them off, instead of being asked.
-- `source` `answer`: the person's own yes or no (every row before this one).
-- `source` `notice`: the yes saved when the person was shown the notice that
-- cards are on; it holds only where cards start on, and anywhere else the
-- person is asked. `country`: where the answer was given (Cloudflare's country
-- of the request). A no given where cards start on is not asked again for 12
-- months (California's rule); elsewhere after two weeks. Additive only: apply
-- before the Worker that reads it.
alter table cloud_sponsored_consent add column source text not null default 'answer';
alter table cloud_sponsored_consent add column country text;
