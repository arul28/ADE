-- The name of the computer that started this device authorization, so the
-- confirmation page can say which computer asked. The client supplies it and
-- nothing trusts it: the page shows it as a claim, never as proof. Nullable: an
-- older client sends none and the page says "your computer".
alter table device_authorizations add column machine_name text;
