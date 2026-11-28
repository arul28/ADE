-- The model picker's favorites, one list per account
-- (src/accountModelFavorites/routes.ts), so every computer, the web client
-- and the phone show the same stars. `favorites` is a JSON array of model
-- ids in the order they were starred. `revision` counts writes: a write
-- names the revision it read, so two devices changing the list at once both
-- land instead of one overwriting the other. Additive only: apply before the
-- Worker that reads it.
create table if not exists account_model_favorites (
  user_id text primary key,
  favorites text not null,
  revision integer not null,
  updated_at integer not null
);
