import { describe, expect, it } from "vitest";
import {
  generatePasswordVaultKey,
  generateSitePassword,
  openPasswordItem,
  parsePasswordEnvelope,
  sealPasswordItem,
  type PasswordEnvelope,
} from "./passwordCrypto";

const binding = { accountId: "user_123", itemId: "item_abc", epoch: 1 };
const item = { kind: "login", origins: ["https://example.com"], username: "arul", password: "correct horse battery" };

describe("password item sealing", () => {
  it("opens what it sealed, and nothing readable is left in the envelope", () => {
    const key = generatePasswordVaultKey();
    const envelope = sealPasswordItem(key, binding, item);
    expect(openPasswordItem(key, binding, envelope)).toEqual(item);
    const stored = JSON.stringify(envelope);
    for (const visible of ["example.com", "arul", "correct horse"]) expect(stored).not.toContain(visible);
    // Two seals of the same item never share a nonce or ciphertext.
    const again = sealPasswordItem(key, binding, item);
    expect(again.nonce).not.toBe(envelope.nonce);
    expect(parsePasswordEnvelope(stored)).toEqual(envelope);
  });

  const tamperCases: Array<[string, (key: Buffer, envelope: PasswordEnvelope) => [Buffer, typeof binding, PasswordEnvelope]]> = [
    ["another account", (key, envelope) => [key, { ...binding, accountId: "user_other" }, envelope]],
    ["another item", (key, envelope) => [key, { ...binding, itemId: "item_other" }, envelope]],
    ["an envelope from an older key epoch", (key, envelope) => [key, { ...binding, epoch: 2 }, envelope]],
    ["a different vault key", (_key, envelope) => [generatePasswordVaultKey(), binding, envelope]],
    ["one flipped ciphertext byte", (key, envelope) => {
      const body = Buffer.from(envelope.ct, "base64");
      body[0] = body[0]! ^ 0x01;
      return [key, binding, { ...envelope, ct: body.toString("base64") }];
    }],
  ];

  it.each(tamperCases)("refuses to open it under %s, without quoting the content", (_label, mutate) => {
    const key = generatePasswordVaultKey();
    const [useKey, useBinding, useEnvelope] = mutate(key, sealPasswordItem(key, binding, item));
    let message = "";
    try {
      openPasswordItem(useKey, useBinding, useEnvelope);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toBe("");
    expect(message).not.toContain("correct horse");
    expect(message).not.toContain("arul");
  });

  it("generates site passwords with every character class and no repeats across calls", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      const password = generateSitePassword();
      expect(password).toHaveLength(20);
      expect(password).toMatch(/[a-z]/);
      expect(password).toMatch(/[A-Z]/);
      expect(password).toMatch(/[0-9]/);
      expect(password).toMatch(/[-_.!@#%]/);
      seen.add(password);
    }
    expect(seen.size).toBe(50);
  });
});
