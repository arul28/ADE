import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  computeBackoffMs,
  createSyncTunnelClientService,
  parseControlMessage,
} from "./syncTunnelClientService";
import {
  buildHostSignatureBase,
  buildPipeSignatureBase,
  createSyncCloudRelayStore,
  defaultRelayUrl,
  deriveRelayWssConnectUrl,
  httpToWsUrl,
  signRelayHmacHex,
  type SyncCloudRelayStore,
} from "./syncCloudRelayStore";

function fakeStore(enabled: boolean): SyncCloudRelayStore {
  const identity = { machineKey: "a".repeat(32), secret: "b".repeat(48) };
  return {
    getConfig: () => ({ enabled, ...identity }),
    isEnabled: () => enabled,
    setEnabled: () => ({ enabled, ...identity }),
    getMachineIdentity: () => identity,
    getRelayUrl: () => "https://relay.example.com",
    setRelayUrl: () => ({ enabled, ...identity }),
    getRelayWssUrl: () => `wss://relay.example.com/connect/${identity.machineKey}`,
  } as unknown as SyncCloudRelayStore;
}

describe("computeBackoffMs", () => {
  it("grows exponentially and caps at 60s", () => {
    const max = (attempt: number) => computeBackoffMs(attempt, () => 0.999999);
    expect(max(0)).toBeLessThanOrEqual(1_000);
    expect(max(1)).toBeLessThanOrEqual(2_000);
    expect(max(2)).toBeLessThanOrEqual(4_000);
    expect(max(3)).toBeLessThanOrEqual(8_000);
    expect(max(20)).toBeLessThanOrEqual(60_000);
    expect(max(20)).toBeGreaterThan(50_000);
  });

  it("applies full jitter within the ceiling", () => {
    expect(computeBackoffMs(5, () => 0)).toBe(0);
    expect(computeBackoffMs(5, () => 0.5)).toBe(16_000);
  });
});

describe("parseControlMessage", () => {
  it("parses an open envelope with a valid id", () => {
    expect(parseControlMessage(JSON.stringify({ t: "open", id: "abcdef01" }))).toEqual({ t: "open", id: "abcdef01" });
  });

  it("rejects an open envelope with a malformed id", () => {
    expect(parseControlMessage(JSON.stringify({ t: "open", id: "not hex!" }))).toBeNull();
    expect(parseControlMessage(JSON.stringify({ t: "open" }))).toBeNull();
  });

  it("passes ping/pong and rejects junk", () => {
    expect(parseControlMessage(JSON.stringify({ t: "ping" }))).toEqual({ t: "ping" });
    expect(parseControlMessage(JSON.stringify({ t: "pong" }))).toEqual({ t: "pong" });
    expect(parseControlMessage("not json")).toBeNull();
    expect(parseControlMessage(JSON.stringify({ t: "other" }))).toBeNull();
  });
});

describe("createSyncTunnelClientService", () => {
  it("is a no-op and reports disabled when the store is disabled", async () => {
    const service = createSyncTunnelClientService({
      getSyncPort: () => 12345,
      configStore: fakeStore(false),
    });
    await service.start();
    const status = service.getStatus();
    expect(status.enabled).toBe(false);
    expect(status.connected).toBe(false);
    expect(status.activeTunnels).toBe(0);
    expect(status.machineKey).toBe("a".repeat(32));
    expect(status.relayUrl).toBe("https://relay.example.com");
    await service.dispose();
  });
});


const tempFiles: string[] = [];

function tempStorePath(): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ade-tunnel-")), "cloud-relay.json");
  tempFiles.push(path.dirname(file));
  return file;
}

afterEach(() => {
  while (tempFiles.length) {
    fs.rmSync(tempFiles.pop() as string, { recursive: true, force: true });
  }
  delete process.env.ADE_TUNNEL_RELAY_URL;
});

describe("url derivation", () => {
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

describe("createSyncCloudRelayStore", () => {
  it("mints a stable identity, defaults to disabled, and persists chmod 600", () => {
    const filePath = tempStorePath();
    const store = createSyncCloudRelayStore({ filePath });
    const first = store.getMachineIdentity();
    expect(/^[a-f0-9]{32}$/.test(first.machineKey)).toBe(true);
    expect(first.secret.length).toBe(48);
    expect(store.isEnabled()).toBe(false);

    // Re-opening the store keeps the same identity.
    const reopened = createSyncCloudRelayStore({ filePath });
    expect(reopened.getMachineIdentity()).toEqual(first);
    if (process.platform !== "win32") {
      expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    }
  });

  it("toggles enabled and exposes the connect url", () => {
    const store = createSyncCloudRelayStore({ filePath: tempStorePath() });
    expect(store.setEnabled(true).enabled).toBe(true);
    expect(store.isEnabled()).toBe(true);
    const { machineKey } = store.getMachineIdentity();
    expect(store.getRelayWssUrl()).toBe(
      `wss://ade-tunnel-relay.arulsharma1028.workers.dev/connect/${machineKey}`,
    );
  });

  it("honors a relay url override for the connect url", () => {
    const store = createSyncCloudRelayStore({ filePath: tempStorePath() });
    store.setRelayUrl("http://127.0.0.1:8787");
    const { machineKey } = store.getMachineIdentity();
    expect(store.getRelayWssUrl()).toBe(`ws://127.0.0.1:8787/connect/${machineKey}`);
  });
});
