import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CredentialStore } from "../credentials/credentialStore";
import type { PasswordRelayItem, PasswordRelayWrite } from "../push/pushRelayClient";
import { createPasswordService, type PasswordsRelay } from "./passwordService";

/** One account's relay, as the push-relay routes behave: opaque rows, revisions, one key per epoch. */
function fakeRelay() {
  const rows = new Map<string, PasswordRelayItem>();
  let clock = 0;
  let key = { dek: crypto.randomBytes(32).toString("base64"), epoch: 1 };
  const relay: PasswordsRelay = {
    async getPasswordItems() {
      return { items: [...rows.values()], cursor: null, truncated: false };
    },
    async putPasswordItems(items: PasswordRelayWrite[]) {
      return items.map((item) => {
        const stored = rows.get(item.id);
        const stale = item.ifRevision === "absent" ? Boolean(stored) : item.ifRevision ? stored?.revision !== item.ifRevision : false;
        if (stale) return { id: item.id, status: "stale" as const, revision: stored?.revision ?? null };
        const revision = `r${(clock += 1)}`;
        rows.set(item.id, { id: item.id, ciphertext: item.deleted ? null : item.ciphertext ?? null, revision, deleted: Boolean(item.deleted) });
        return { id: item.id, status: "ok" as const, revision };
      });
    },
    async requestPasswordKey({ reset }) {
      if (reset) key = { dek: crypto.randomBytes(32).toString("base64"), epoch: key.epoch + 1 };
      return key;
    },
  };
  return { relay, rows, reset: () => relay.requestPasswordKey({ deviceId: "x", machineKind: "desktop", reset: true }) };
}

function memoryStore(): CredentialStore {
  const values = new Map<string, string>();
  return {
    get: async (k) => values.get(k) ?? null,
    set: async (k, v) => void values.set(k, v),
    delete: async (k) => void values.delete(k),
  };
}

async function machine(relay: PasswordsRelay, deviceId: string) {
  const service = createPasswordService({
    adeDir: fs.mkdtempSync(path.join(os.tmpdir(), "ade-passwords-")),
    relay,
    getAccountUserId: () => "user_a",
    getDeviceId: () => deviceId,
    machineKind: "desktop",
    store: memoryStore(),
  });
  await service.setEnabled(true);
  return service;
}

describe("password service", () => {
  it("lets a second machine use what the first saved, and never shows a value in a summary or on the relay", async () => {
    const { relay, rows } = fakeRelay();
    const mac = await machine(relay, "mac");
    await mac.saveLogin({ origins: ["https://github.com/login"], username: "arul28", password: "s3cret-pass-123" });
    await mac.saveSecret({ name: "OPENAI_API_KEY", value: "key-value-xyz", projectScope: null });
    await mac.sync();

    expect(JSON.stringify([...rows.values()])).not.toMatch(/github|arul28|s3cret|key-value|OPENAI/);

    const laptop = await machine(relay, "laptop");
    await laptop.sync();
    const summaries = await laptop.listSummaries();
    expect(summaries.map((s) => [s.kind, s.title, s.sites, s.username])).toEqual([
      ["login", "github.com", ["github.com"], "arul28"],
      ["secret", "OPENAI_API_KEY", [], null],
    ]);
    expect(JSON.stringify(summaries)).not.toMatch(/s3cret|key-value/);
    expect(await laptop.resolveSecretValue({ name: "OPENAI_API_KEY", projectScope: "repo:x" })).toBe("key-value-xyz");
  });

  it("fills a login only into a page on its own site", async () => {
    const { relay } = fakeRelay();
    const mac = await machine(relay, "mac");
    const saved = await mac.saveLogin({ origins: ["https://github.com"], username: "arul28", password: "s3cret-pass-123" });
    expect(await mac.resolveForFill({ itemId: saved.id, pageUrl: "https://github.com/session" })).toMatchObject({ password: "s3cret-pass-123" });
    for (const page of ["https://github.com.evil.io/login", "https://gitlab.com/", "http://github.com/login"]) {
      expect(await mac.resolveForFill({ itemId: saved.id, pageUrl: page })).toBeNull();
    }
    expect((await mac.loginsForPage("https://evil.example/")).length).toBe(0);
  });

  it("picks up a reset made on another machine instead of failing to open new items", async () => {
    const { relay, reset } = fakeRelay();
    const mac = await machine(relay, "mac");
    const laptop = await machine(relay, "laptop");
    await mac.saveLogin({ origins: ["https://old.example"], username: "a", password: "old-pass-1" });
    await mac.sync();
    await laptop.sync();
    expect((await laptop.listSummaries()).length).toBe(1);

    // The laptop resets; the Mac still has the old key cached.
    await reset();
    await laptop.purge();
    await laptop.saveLogin({ origins: ["https://new.example"], username: "b", password: "new-pass-2" });
    await laptop.sync();

    await mac.sync();
    const titles = (await mac.listSummaries()).map((s) => s.title);
    expect(titles).toContain("new.example");
  });
});
