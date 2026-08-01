import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const migrationsDirectory = path.join(import.meta.dirname, "..", "migrations");
const triggersPath = path.join(
  import.meta.dirname,
  "..",
  "schema",
  "attention_triggers.sql",
);
const migrationNames = fs
  .readdirSync(migrationsDirectory)
  .filter((name) => name.endsWith(".sql"))
  .sort();

const database = new DatabaseSync(":memory:");

function expectSqliteError(callback, expectedMessage) {
  try {
    callback();
  } catch (error) {
    if (error instanceof Error && error.message.includes(expectedMessage)) {
      return;
    }
    throw error;
  }
  throw new Error(`Expected SQLite error containing "${expectedMessage}"`);
}

try {
  for (const migrationName of migrationNames) {
    const sql = fs.readFileSync(
      path.join(migrationsDirectory, migrationName),
      "utf8",
    );
    if (/\bcreate\s+trigger\b/iu.test(sql)) {
      throw new Error(
        `${migrationName} contains a trigger that D1's remote migration query cannot parse`,
      );
    }
    database.exec(sql);
  }

  database.exec(fs.readFileSync(triggersPath, "utf8"));

  const triggerNames = database
    .prepare(
      "select name from sqlite_master where type = 'trigger' order by name",
    )
    .all()
    .map(({ name }) => name);

  const expectedTriggerNames = [
    "attention_device_ownership_reject_stale_v2",
    "attention_devices_enforce_user_limit",
  ];
  if (JSON.stringify(triggerNames) !== JSON.stringify(expectedTriggerNames)) {
    throw new Error(
      `Unexpected D1 triggers after schema install: ${triggerNames.join(", ")}`,
    );
  }

  const insertDevice = database.prepare(`
    insert into attention_devices(
      user_id, device_id, bundle_id, aps_environment, preferences_json,
      registered_at, updated_at, lease_expires_at
    ) values (?, ?, 'com.ade.ios', 'production', '{}', ?, ?, ?)
  `);
  const timestamp = "2026-07-28T00:00:00.000Z";
  for (let index = 0; index < 32; index += 1) {
    insertDevice.run(
      "user-limit",
      `device-${index}`,
      timestamp,
      timestamp,
      timestamp,
    );
  }
  expectSqliteError(
    () =>
      insertDevice.run(
        "user-limit",
        "device-over-limit",
        timestamp,
        timestamp,
        timestamp,
      ),
    "attention account device limit reached",
  );

  const insertOwnership = database.prepare(`
    insert into attention_device_ownership(
      device_id, user_id, ownership_epoch, apns_token, active, updated_at
    ) values (?, ?, ?, ?, 1, ?)
  `);
  insertOwnership.run("owned-device", "current-user", 2, "owned-token", timestamp);
  expectSqliteError(
    () =>
      insertOwnership.run(
        "owned-device",
        "stale-user",
        2,
        "new-token",
        timestamp,
      ),
    "stale attention device ownership",
  );

  const insertFcmOwnership = database.prepare(`
    insert into attention_device_ownership(
      device_id, user_id, ownership_epoch, fcm_token, active, updated_at
    ) values (?, ?, ?, ?, 1, ?)
  `);
  insertFcmOwnership.run("android-device", "current-user", 4, "fcm-owned-token", timestamp);
  expectSqliteError(
    () => insertFcmOwnership.run(
      "other-android-device",
      "stale-user",
      4,
      "fcm-owned-token",
      timestamp,
    ),
    "stale attention device ownership",
  );

  console.log(
    `Validated ${migrationNames.length} remote-safe D1 migrations and ${triggerNames.length} enforced triggers`,
  );
} finally {
  database.close();
}
