import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildHostSignatureBase,
  buildPipeSignatureBase,
  createSyncCloudRelayStore,
  defaultRelayUrl,
  deriveRelayWssConnectUrl,
  httpToWsUrl,
  signRelayHmacHex,
} from "./syncCloudRelayStore";

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

  it("migrates a legacy implicit enabled:false (no user marker) to enabled", () => {
    // Pre-default-on builds persisted `enabled: false` on first run without any
    // user action. Those files must read as enabled after the flip; only a
    // marker-stamped false (setEnabled) is a real kill-switch choice.
    const seeded = createSyncCloudRelayStore({ filePath });
    const { machineKey, secret } = seeded.getMachineIdentity();
    fs.writeFileSync(filePath, `${JSON.stringify({ enabled: false, machineKey, secret })}\n`);
    expect(createSyncCloudRelayStore({ filePath }).isEnabled()).toBe(true);
  });

  it("preserves an explicit kill-switch false across reads", () => {
    const store = createSyncCloudRelayStore({ filePath });
    store.setEnabled(false);
    expect(createSyncCloudRelayStore({ filePath }).isEnabled()).toBe(false);
    store.setEnabled(true);
    expect(createSyncCloudRelayStore({ filePath }).isEnabled()).toBe(true);
  });

  it("keeps the explicit kill-switch false when other settings rewrite the file", () => {
    const store = createSyncCloudRelayStore({ filePath });
    store.setEnabled(false);
    store.setRelayUrl("http://127.0.0.1:8787");
    expect(createSyncCloudRelayStore({ filePath }).isEnabled()).toBe(false);
  });

  it("mints a stable identity and persists the file chmod 600", () => {
    const store = createSyncCloudRelayStore({ filePath });
    const first = store.getMachineIdentity();
    expect(first.machineKey).toMatch(/^[a-f0-9]{32}$/);
    expect(first.secret.length).toBe(48);
    expect(createSyncCloudRelayStore({ filePath }).getMachineIdentity()).toEqual(first);
    if (process.platform !== "win32") {
      expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    }
  });

  it("toggles enabled and exposes the connect url", () => {
    const store = createSyncCloudRelayStore({ filePath });
    expect(store.setEnabled(true).enabled).toBe(true);
    expect(store.isEnabled()).toBe(true);
    const { machineKey } = store.getMachineIdentity();
    expect(store.getRelayWssUrl()).toBe(
      `wss://ade-tunnel-relay.arulsharma1028.workers.dev/connect/${machineKey}`,
    );
  });

  it("honors a relay url override for the connect url", () => {
    const store = createSyncCloudRelayStore({ filePath });
    store.setRelayUrl("http://127.0.0.1:8787");
    const { machineKey } = store.getMachineIdentity();
    expect(store.getRelayWssUrl()).toBe(`ws://127.0.0.1:8787/connect/${machineKey}`);
  });
});

describe("url derivation", () => {
  afterEach(() => {
    delete process.env.ADE_TUNNEL_RELAY_URL;
  });

  it("swaps http(s) to ws(s) and drops trailing slashes", () => {
    expect(httpToWsUrl("https://relay.example.com/")).toBe("wss://relay.example.com");
    expect(httpToWsUrl("http://127.0.0.1:8787")).toBe("ws://127.0.0.1:8787");
    expect(httpToWsUrl("wss://already.ws")).toBe("wss://already.ws");
    expect(httpToWsUrl("relay.example.com")).toBe("wss://relay.example.com");
  });

  it("builds the phone-facing connect url", () => {
    expect(deriveRelayWssConnectUrl("https://relay.example.com", "abc123")).toBe(
      "wss://relay.example.com/connect/abc123",
    );
    expect(deriveRelayWssConnectUrl("http://127.0.0.1:8787", "deadbeef")).toBe(
      "ws://127.0.0.1:8787/connect/deadbeef",
    );
  });

  it("prefers the env override for the default relay url", () => {
    expect(defaultRelayUrl()).toBe("https://ade-tunnel-relay.arulsharma1028.workers.dev");
    process.env.ADE_TUNNEL_RELAY_URL = "http://127.0.0.1:8787";
    expect(defaultRelayUrl()).toBe("http://127.0.0.1:8787");
  });
});

describe("signature builders", () => {
  it("use the canonical strings the worker verifies against", () => {
    expect(buildHostSignatureBase("key", "1700")).toBe("host:key:1700");
    expect(buildPipeSignatureBase("key", "id0", "1700")).toBe("pipe:key:id0:1700");
  });

  it("produce a deterministic 64-char hex hmac", () => {
    const a = signRelayHmacHex("secret", buildHostSignatureBase("key", "1700"));
    const b = signRelayHmacHex("secret", buildHostSignatureBase("key", "1700"));
    expect(a).toBe(b);
    expect(/^[a-f0-9]{64}$/.test(a)).toBe(true);
    expect(signRelayHmacHex("secret", buildHostSignatureBase("key", "1701"))).not.toBe(a);
  });
});
