import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSyncCloudRelayStore, deriveRelayWssConnectUrl, httpToWsUrl } from "./syncCloudRelayStore";

describe("syncCloudRelayStore enablement default", () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cloud-relay-"));
    filePath = path.join(dir, "sync-cloud-relay.json");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("defaults to enabled on first run (no file)", () => {
    const store = createSyncCloudRelayStore({ filePath });
    expect(store.isEnabled()).toBe(true);
  });

  it("treats a legacy file without the enabled field as enabled", () => {
    const seeded = createSyncCloudRelayStore({ filePath });
    const { machineKey, secret } = seeded.getMachineIdentity();
    fs.writeFileSync(filePath, `${JSON.stringify({ machineKey, secret })}\n`);
    const store = createSyncCloudRelayStore({ filePath });
    expect(store.isEnabled()).toBe(true);
    expect(store.getMachineIdentity().machineKey).toBe(machineKey);
  });

  it("preserves an explicit kill-switch false across reads", () => {
    const store = createSyncCloudRelayStore({ filePath });
    store.setEnabled(false);
    expect(createSyncCloudRelayStore({ filePath }).isEnabled()).toBe(false);
    store.setEnabled(true);
    expect(createSyncCloudRelayStore({ filePath }).isEnabled()).toBe(true);
  });

  it("keeps the minted identity stable across reloads", () => {
    const first = createSyncCloudRelayStore({ filePath }).getMachineIdentity();
    const second = createSyncCloudRelayStore({ filePath }).getMachineIdentity();
    expect(second).toEqual(first);
    expect(first.machineKey).toMatch(/^[a-f0-9]{32}$/);
  });

  it("derives the phone-facing wss connect URL", () => {
    expect(httpToWsUrl("https://relay.example")).toBe("wss://relay.example");
    expect(deriveRelayWssConnectUrl("https://relay.example/", "abc123")).toBe(
      "wss://relay.example/connect/abc123",
    );
  });
});
