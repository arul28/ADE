-- Machine power and sleep state.
--
-- ADE had no idea when a host machine went to sleep. A closed laptop lid and a
-- healthy laptop look identical from here: both stop heartbeating, and the last
-- `last_seen_at` is equally recent for a few minutes either way. So a phone
-- kept reporting "Connected" to an unconscious Mac.
--
-- These three columns make sleep a stated fact instead of an inference. A host
-- announces its own suspend in the beat BEFORE the machine goes dark, and the
-- announcement is what clients read. All three are nullable and all three are
-- optional on the wire: a host built before this shipped writes none of them,
-- and the register statement coalesces rather than overwrites so an old host
-- heartbeating alongside a new one cannot blank what the new one stored.

-- JSON: {"batteryPercent": 0-100 | null, "charging": bool | null,
--        "onExternalPower": bool | null}.
-- `batteryPercent` is null — never 0 — on machines with no battery. A desktop
-- reporting "0%" would be a lie about hardware it does not have.
alter table machines add column power text;

-- 'awake' | 'asleep', as last announced by the machine itself.
alter table machines add column sleep_state text;

-- Epoch ms at which `sleep_state` last changed on the machine. Distinct from
-- `last_seen_at`: a machine that announced sleep an hour ago and has been
-- silent since has an old timestamp on both, while one that just announced it
-- has a fresh `last_seen_at` and a fresh `sleep_state_at`.
alter table machines add column sleep_state_at integer;
