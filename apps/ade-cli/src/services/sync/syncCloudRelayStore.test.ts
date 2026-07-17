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

describe("syncCloudRelayStore", () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cloud-relay-"));
    filePath = path.join(dir, "sync-cloud-relay.json");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("mints an identity on first run", () => {
    const store = createSyncCloudRelayStore({ filePath });
    expect(store.getMachineIdentity()).toMatchObject({
      machineKey: expect.stringMatching(/^[a-f0-9]{32}$/),
      secret: expect.stringMatching(/^[a-f0-9]{48}$/),
    });
  });

  it("preserves a legacy identity without kill-switch fields", () => {
    const seeded = createSyncCloudRelayStore({ filePath });
    const { machineKey, secret } = seeded.getMachineIdentity();
    fs.writeFileSync(filePath, `${JSON.stringify({ machineKey, secret })}\n`);
    const store = createSyncCloudRelayStore({ filePath });
    expect(store.getMachineIdentity().machineKey).toBe(machineKey);
  });

  it("ignores and drops legacy kill-switch fields", () => {
    const seeded = createSyncCloudRelayStore({ filePath });
    const { machineKey, secret } = seeded.getMachineIdentity();
    fs.writeFileSync(filePath, `${JSON.stringify({
      enabled: false,
      enabledSetByUser: true,
      machineKey,
      secret,
      relayUrl: "https://relay.example.com",
    })}\n`);

    const config = createSyncCloudRelayStore({ filePath }).getConfig();
    expect(config).toEqual({
      machineKey,
      secret,
      relayUrl: "https://relay.example.com",
    });
    expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toEqual(config);
  });

  it("regenerates both halves when either persisted credential is invalid", () => {
    const oldMachineKey = "a".repeat(32);
    fs.writeFileSync(filePath, `${JSON.stringify({
      machineKey: oldMachineKey,
      secret: "too-short",
      relayUrl: "https://relay.example.com",
    })}\n`);

    const repaired = createSyncCloudRelayStore({ filePath }).getConfig();

    expect(repaired.machineKey).toMatch(/^[a-f0-9]{32}$/);
    expect(repaired.machineKey).not.toBe(oldMachineKey);
    expect(repaired.secret).toMatch(/^[a-f0-9]{48}$/);
    expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toEqual(repaired);
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

  it("exposes the connect url", () => {
    const store = createSyncCloudRelayStore({ filePath });
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

  it("rotates the full identity only when the expected key still matches", () => {
    const store = createSyncCloudRelayStore({ filePath });
    store.setRelayUrl("https://relay.example.com");
    const first = store.getMachineIdentity();

    const rotated = store.rotateMachineIdentity(first.machineKey);
    expect(rotated).toMatchObject({
      machineKey: expect.stringMatching(/^[a-f0-9]{32}$/),
      secret: expect.stringMatching(/^[a-f0-9]{48}$/),
      relayUrl: "https://relay.example.com",
    });
    expect(rotated.machineKey).not.toBe(first.machineKey);
    expect(rotated.secret).not.toBe(first.secret);
    expect(store.rotateMachineIdentity(first.machineKey)).toEqual(rotated);
    expect(createSyncCloudRelayStore({ filePath }).getConfig()).toEqual(rotated);
  });

  it("does not race an identity rotation while another process owns the lock", () => {
    const store = createSyncCloudRelayStore({ filePath });
    const first = store.getMachineIdentity();
    const lockPath = `${filePath}.rotate.lock`;
    fs.writeFileSync(lockPath, "", { flag: "wx", mode: 0o600 });

    expect(store.rotateMachineIdentity(first.machineKey)).toMatchObject(first);
    fs.unlinkSync(lockPath);
    expect(store.rotateMachineIdentity(first.machineKey).machineKey).not.toBe(first.machineKey);
  });

  it("does not steal an old lock from a live owner", () => {
    const store = createSyncCloudRelayStore({ filePath });
    const first = store.getConfig();
    const lockPath = `${filePath}.rotate.lock`;
    const liveOwner = {
      version: 1,
      pid: process.pid,
      token: "live-owner-token".padEnd(32, "0"),
      createdAt: "2020-01-01T00:00:00.000Z",
    };
    fs.writeFileSync(lockPath, `${JSON.stringify(liveOwner)}\n`, { flag: "wx", mode: 0o600 });
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, old, old);

    expect(store.rotateMachineIdentity(first.machineKey)).toEqual(first);
    expect(JSON.parse(fs.readFileSync(lockPath, "utf8"))).toEqual(liveOwner);
    expect(createSyncCloudRelayStore({ filePath }).getConfig()).toEqual(first);
  });

  it("serializes relay URL writes behind the identity rotation lock", () => {
    const store = createSyncCloudRelayStore({ filePath, lockWaitMs: 0 });
    const first = store.getConfig();
    const lockPath = `${filePath}.rotate.lock`;
    fs.writeFileSync(lockPath, `${JSON.stringify({
      version: 1,
      pid: process.pid,
      token: "live-config-owner".padEnd(32, "0"),
      createdAt: new Date().toISOString(),
    })}\n`, { flag: "wx", mode: 0o600 });

    expect(() => store.setRelayUrl("https://new-relay.example.com")).toThrow(
      "configuration is being updated by another live ADE process",
    );
    expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toEqual(first);

    fs.unlinkSync(lockPath);
    expect(store.setRelayUrl("https://new-relay.example.com")).toMatchObject({
      ...first,
      relayUrl: "https://new-relay.example.com",
    });
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
