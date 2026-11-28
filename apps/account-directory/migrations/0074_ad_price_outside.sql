-- Pricing v3 (`src/cloud/adPrice.ts`): an outside agent's message holds its
-- computer's full price until the brain's idle report after the turn it began.
-- This is that turn's first busy report (null: not begun yet). Only adds: the
-- live Worker and older apps read nothing here, and at `off` nothing writes it.
alter table cloud_ad_targets add column outside_busy_at integer;
