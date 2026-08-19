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

  it("keeps the machine key and re-mints only the broken secret", () => {
    const existingMachineKey = "a".repeat(32);
    fs.writeFileSync(filePath, `${JSON.stringify({
      machineKey: existingMachineKey,
      secret: "too-short",
      relayUrl: "https://relay.example.com",
    })}\n`);
    const events: Array<[string, Record<string, unknown> | undefined]> = [];

    const repaired = createSyncCloudRelayStore({
      filePath,
      logger: { info: (event, data) => events.push([event, data]) },
    }).getConfig();

    // The machine key IS the account's primary key for this computer; losing it
    // turns a live machine into a phantom row the owner is invited to delete.
    expect(repaired.machineKey).toBe(existingMachineKey);
    expect(repaired.secret).toMatch(/^[a-f0-9]{48}$/);
    expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toEqual(repaired);
    expect(events).toContainEqual([
      "sync_cloud_relay.identity_rotated",
      {
        previousMachineKey: existingMachineKey,
        machineKey: existingMachineKey,
        reason: "secret_remint",
      },
    ]);
  });

  it("never mints a new identity out of an unparsable file", () => {
    const seeded = createSyncCloudRelayStore({ filePath });
    const first = seeded.getMachineIdentity();
    // Exactly what a truncated write leaves behind — and what used to be read
    // as "this machine has no identity", minting a brand new one.
    fs.writeFileSync(filePath, '{"machineKey": "');

    const recovered = createSyncCloudRelayStore({ filePath }).getMachineIdentity();

    expect(recovered).toEqual(first);
    expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toMatchObject(first);
  });

  it("falls back to the .bak sibling when the primary file is destroyed", () => {
    const seeded = createSyncCloudRelayStore({ filePath });
    const first = seeded.getMachineIdentity();
    expect(fs.existsSync(`${filePath}.bak`)).toBe(true);
    fs.writeFileSync(filePath, "not json at all");
    const events: Array<[string, Record<string, unknown> | undefined]> = [];

    const recovered = createSyncCloudRelayStore({
      filePath,
      logger: { info: (event, data) => events.push([event, data]) },
    }).getMachineIdentity();

    expect(recovered).toEqual(first);
    expect(events).toContainEqual([
      "sync_cloud_relay.identity_rotated",
      {
        previousMachineKey: null,
        machineKey: first.machineKey,
        reason: "recovered_from_backup",
      },
    ]);
  });

  it("mints a fresh identity only when neither file yields one", () => {
    const seeded = createSyncCloudRelayStore({ filePath });
    const first = seeded.getMachineIdentity();
    fs.writeFileSync(filePath, "{}");
    fs.writeFileSync(`${filePath}.bak`, "{}");
    const events: Array<[string, Record<string, unknown> | undefined]> = [];

    const minted = createSyncCloudRelayStore({
      filePath,
      logger: { info: (event, data) => events.push([event, data]) },
    }).getMachineIdentity();

    expect(minted.machineKey).not.toBe(first.machineKey);
    expect(events).toContainEqual([
      "sync_cloud_relay.identity_rotated",
      {
        previousMachineKey: null,
        machineKey: minted.machineKey,
        reason: "corrupt_file_remint",
      },
    ]);
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

    const rotation = store.rotateMachineIdentity(first.machineKey);
    expect(rotation.rotated).toBe(true);
    expect(rotation.config).toMatchObject({
      machineKey: expect.stringMatching(/^[a-f0-9]{32}$/),
      secret: expect.stringMatching(/^[a-f0-9]{48}$/),
      relayUrl: "https://relay.example.com",
    });
    expect(rotation.config.machineKey).not.toBe(first.machineKey);
    expect(rotation.config.secret).not.toBe(first.secret);
    const stale = store.rotateMachineIdentity(first.machineKey);
    expect(stale.rotated).toBe(false);
    expect(stale.config).toEqual(rotation.config);
    expect(createSyncCloudRelayStore({ filePath }).getConfig()).toEqual(rotation.config);
  });

  it("keeps the 409 rotation budget across a simulated brain restart", () => {
    // A brand-new store instance over the same directory IS a brain restart as
    // far as this budget is concerned — the closure counter it replaced reset
    // here, so a crash loop could mint one phantom machine per boot.
    const rotateOnce = (): ReturnType<
      ReturnType<typeof createSyncCloudRelayStore>["rotateMachineIdentity"]
    > => {
      const store = createSyncCloudRelayStore({ filePath });
      return store.rotateMachineIdentity(store.getMachineIdentity().machineKey);
    };

    expect(rotateOnce().rotated).toBe(true);
    expect(rotateOnce().rotated).toBe(true);

    const third = rotateOnce();
    expect(third.rotated).toBe(false);
    expect(third.budgetExhausted).toBe(true);
    expect(third.rotationsInWindow).toBe(2);
    // And a fourth restart still reads the spent window off disk rather than
    // handing the fresh process a fresh allowance.
    const fourth = rotateOnce();
    expect(fourth.rotated).toBe(false);
    expect(fourth.budgetExhausted).toBe(true);
    expect(fourth.rotationsInWindow).toBe(2);
  });

  it("reopens the rotation budget once the 24-hour window has passed", () => {
    let clock = Date.parse("2026-08-18T00:00:00.000Z");
    const build = () => createSyncCloudRelayStore({ filePath, now: () => clock });
    for (let i = 0; i < 2; i += 1) {
      const store = build();
      expect(store.rotateMachineIdentity(store.getMachineIdentity().machineKey).rotated).toBe(true);
    }
    expect(build().rotateMachineIdentity(build().getMachineIdentity().machineKey).rotated).toBe(false);

    clock += 24 * 60 * 60 * 1_000 + 1;
    const store = build();
    expect(store.rotateMachineIdentity(store.getMachineIdentity().machineKey).rotated).toBe(true);
  });

  it("bounds automatic pairing repairs to three per persisted six-hour window", () => {
    createSyncCloudRelayStore({ filePath }).getConfig();
    const spend = () => createSyncCloudRelayStore({ filePath }).tryConsumePairingAutoRepair();

    expect(spend()).toMatchObject({ allowed: true, countInWindow: 1 });
    expect(spend()).toMatchObject({ allowed: true, countInWindow: 2 });
    expect(spend()).toMatchObject({ allowed: true, countInWindow: 3 });
    // Still refused after another simulated restart: the window lives in the
    // file, so a brain that reboots every minute cannot buy more repairs.
    expect(spend()).toMatchObject({ allowed: false, countInWindow: 3, limit: 3 });
  });

  it("confirms only the superseded machine keys this machine actually retired", () => {
    const store = createSyncCloudRelayStore({ filePath });
    const first = store.getMachineIdentity();
    const rotated = store.rotateMachineIdentity(first.machineKey);
    expect(rotated.rotated).toBe(true);

    // A key this machine never held describes somebody else's device.
    expect(store.confirmSupersededMachineKeys(["f".repeat(32)])).toEqual([]);
    expect(store.confirmSupersededMachineKeys([first.machineKey, "f".repeat(32)]))
      .toEqual([first.machineKey]);
    // Confirmed once, then forgotten — and an old directory that sends nothing
    // is simply an empty answer.
    expect(store.confirmSupersededMachineKeys([first.machineKey])).toEqual([]);
    expect(store.confirmSupersededMachineKeys([])).toEqual([]);
  });

  it("does not race an identity rotation while another process owns the lock", () => {
    const store = createSyncCloudRelayStore({ filePath });
    const first = store.getMachineIdentity();
    const lockPath = `${filePath}.rotate.lock`;
    fs.writeFileSync(lockPath, "", { flag: "wx", mode: 0o600 });

    expect(store.rotateMachineIdentity(first.machineKey).config).toMatchObject(first);
    fs.unlinkSync(lockPath);
    expect(store.rotateMachineIdentity(first.machineKey).config.machineKey)
      .not.toBe(first.machineKey);
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

    expect(store.rotateMachineIdentity(first.machineKey).config).toEqual(first);
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
