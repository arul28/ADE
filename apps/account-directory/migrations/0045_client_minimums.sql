-- The oldest ADE build each kind of install may run (src/clientMinimum.ts).
-- Additive only: apply this migration first, then deploy the Worker.
--
-- One row, id 1. `body` is the JSON the owner's script writes
-- (scripts/release-tools/client-minimum.mjs): desktop versions per track and
-- iPhone versions or builds per install source. No row, or a malformed body,
-- means no minimum: nothing is blocked.
create table if not exists client_minimums (
  id integer primary key check (id = 1),
  body text not null,
  updated_at text not null
);
