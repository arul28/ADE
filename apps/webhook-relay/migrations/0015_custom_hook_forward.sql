-- A custom webhook whose automation runs on ADE Cloud (C9) is forwarded: each
-- delivery is sent to the account directory (`forward_url`), signed with the
-- hook's own key (`forward_secret`, HMAC-SHA256), and kept here until the
-- directory answers 2xx. Machines never drain a forwarded hook's deliveries.
-- The key signs only what the hook's own URL token already lets anyone send.
-- Additive only: apply this migration first, then deploy the Worker.
alter table custom_hooks add column forward_url text;
alter table custom_hooks add column forward_secret text;

create index if not exists idx_custom_hooks_forwarded
  on custom_hooks(account_id, hook_id) where forward_url is not null;
