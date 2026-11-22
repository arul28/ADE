/**
 * Prints a cross-language test vector for the phone's Passwords decrypt
 * (`ADETests/PasswordsVaultTests.swift`): a sealed envelope made by the real
 * `sealPasswordItem` the brains use, with its key, binding and plaintext.
 *
 * The key and plaintext are fixed test data, never a real vault's. The nonce
 * is random, so each run prints a different (equally valid) envelope.
 *
 *   apps/ade-cli/node_modules/.bin/tsx apps/ios/Scripts/passwords-vector-fixture.ts
 */
import { sealPasswordItem } from "../../ade-cli/src/services/passwords/passwordCrypto";

const key = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
const binding = { accountId: "user_2pQxFixtureAccount", itemId: "pw_fixture_01ABCD", epoch: 3 };
const plaintext = {
  kind: "login",
  title: "Fixture Site",
  origins: ["https://fixture.example"],
  username: "fixture@example.com",
  password: "correct-horse-battery-staple",
  notes: "Fixture notes",
  totpUri: "otpauth://totp/Fixture?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", // gitleaks:allow (RFC 6238 test key)
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-02T00:00:00.000Z",
};

const envelope = sealPasswordItem(key, binding, plaintext);
process.stdout.write(
  `${JSON.stringify({ key: key.toString("base64"), binding, envelope: JSON.stringify(envelope), plaintext: JSON.stringify(plaintext) }, null, 2)}\n`,
);
