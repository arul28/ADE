-- A per-install secret proves that a request for a device id comes from the
-- install that registered it. The relay stores only SHA-256 hashes (hex) and
-- hands the key to the install once.
--
-- A new key waits in pending_device_key_hash until the install presents it,
-- which shows the install received and stored it. Only then does it move to
-- device_key_hash and become required from another account, so a lost
-- response can never lock the install out. Rows from before these columns,
-- and rows of app versions that never ask for a key, stay null and keep the
-- older checks.
alter table attention_device_ownership add column device_key_hash text;
alter table attention_device_ownership add column pending_device_key_hash text;
