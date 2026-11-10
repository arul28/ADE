import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createHeadlessAccountVaultBridge } from "../../../../../ade-cli/src/services/account/accountRuntimeLifecycle";
import { createAccountVaultStore, type AccountVaultRelay } from "../../../../../ade-cli/src/services/account/accountVaultStore";
import { providerLoginGate } from "./providerLoginHooks";
import { createProviderLoginSync } from "./providerLoginSync";

/**
 * The capture side must never put a login into the account that the CLI had
 * not finished writing: a half file, a file that moved under the read, or one
 * file of a pair without its partner. Any of those, applied on a cloud
 * computer, is a broken sign-in there. No screen shows this race, so the test
 * is the only check (P5 step 1, T2).
 *
 * Real files, the real vault store; only the relay (network) is faked.
 */

const USER = "user_capture";

describe("provider login capture: stable reads", () => {
  let root: string;
  let home: string;
  let adeDir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-login-capture-"));
    home = path.join(root, "home");
    adeDir = path.join(root, "ade");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(adeDir, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function writeFile(rel: string, data: string | Buffer, ageMs: number): string {
    const abs = path.join(home, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, data);
    const seconds = (Date.now() - ageMs) / 1000;
    fs.utimesSync(abs, seconds, seconds);
    return abs;
  }

  async function makeSync() {
    const relay = {
      getAccountVault: vi.fn(async () => ({ items: [], cursor: null, truncated: false })),
      putAccountVault: vi.fn(async (items: unknown[]) => ({ updatedAt: new Date().toISOString(), results: items.map(() => ({ status: "written" })) })),
      deleteAccountVaultItem: vi.fn(async () => true),
    };
    const vault = createAccountVaultStore({
      adeDir,
      relay: relay as unknown as AccountVaultRelay,
      getAccountUserId: () => USER,
      getDeviceId: () => "device-a",
    });
    await vault.sync();
    const env: NodeJS.ProcessEnv = { HOME: home };
    const sync = createProviderLoginSync({
      adeDir,
      staticOff: null,
      vault: () => vault,
      settings: () => ({ get: () => undefined }),
      accountUserId: () => USER,
      machine: () => ({ machineKey: "machine-a", deviceId: "device-a", label: "test", platform: "linux" }),
      cloudAccess: async () => "ready",
      cloudComputer: false,
      logger: { info: () => {}, warn: () => {} },
      env,
      homeDir: home,
      platform: "linux",
    });
    /** The files of the one sign-in of `provider` in the account, decoded; null when there is none. */
    const carried = (provider: string): Record<string, string> | null => {
      const row = vault.list("all").find((entry) => entry.kind === "provider_login" && entry.key.startsWith(`${provider}/`) && !entry.deleted);
      if (!row) return null;
      const payload = JSON.parse(vault.get("all", "provider_login", row.key)!) as { files: Array<{ rel: string; enc: string; data: string }> };
      return Object.fromEntries(payload.files.map((file) => [file.rel, file.enc === "base64" ? Buffer.from(file.data, "base64").toString("hex") : file.data]));
    };
    return { sync, carried };
  }

  const grokLogin = (key: string) => JSON.stringify({ "https://auth.x.ai": { key, expires_at: "2099-01-01T00:00:00.000Z", email: "a@example.test" } });

  it("carries a login only once the CLI has finished writing it", async () => {
    const { sync, carried } = await makeSync();
    const finished = grokLogin("key-final");

    // Mid-write: half the file, written just now.
    writeFile(".grok/auth.json", finished.slice(0, 20), 0);
    await sync.pass();
    expect(carried("grok")).toBeNull();

    // A writer that stalled for seconds on a half file: old enough, but not a login.
    writeFile(".grok/auth.json", finished.slice(0, 20), 10_000);
    await sync.pass();
    expect(carried("grok")).toBeNull();

    // The file moves under the read: the pass must not carry what it read.
    const abs = writeFile(".grok/auth.json", grokLogin("key-before"), 10_000);
    const readFile = fs.promises.readFile.bind(fs.promises);
    const spy = vi.spyOn(fs.promises, "readFile").mockImplementation((async (target: fs.PathLike, ...rest: unknown[]) => {
      const bytes = await readFile(target as string, ...(rest as []));
      if (String(target) === abs) fs.writeFileSync(abs, finished);
      return bytes;
    }) as typeof fs.promises.readFile);
    await sync.pass();
    spy.mockRestore();
    expect(carried("grok")).toBeNull();

    // Finished and settled: the account holds exactly the finished file.
    const seconds = (Date.now() - 10_000) / 1000;
    fs.utimesSync(abs, seconds, seconds);
    await sync.pass();
    expect(carried("grok")).toEqual({ "auth.json": finished });
  });

  it("carries a two-file login as a matching pair, never one new file with one old", async () => {
    const { sync, carried } = await makeSync();
    const sealedA = crypto.randomBytes(64);
    writeFile(".factory/auth.v2.file", sealedA, 10_000);
    writeFile(".factory/auth.v2.key", "key-a", 10_000);
    await sync.pass();
    expect(carried("droid")).toEqual({ "auth.v2.file": sealedA.toString("hex"), "auth.v2.key": "key-a" });

    // A new sign-in rewrites both files; the key lands first, the sealed file is still being written.
    const sealedB = crypto.randomBytes(64);
    writeFile(".factory/auth.v2.key", "key-b", 10_000);
    writeFile(".factory/auth.v2.file", sealedB, 0);
    await sync.pass();
    expect(carried("droid")).toEqual({ "auth.v2.file": sealedA.toString("hex"), "auth.v2.key": "key-a" });

    const seconds = (Date.now() - 10_000) / 1000;
    fs.utimesSync(path.join(home, ".factory/auth.v2.file"), seconds, seconds);
    await sync.pass();
    expect(carried("droid")).toEqual({ "auth.v2.file": sealedB.toString("hex"), "auth.v2.key": "key-b" });
  });
});

/**
 * T1, the renewal race (P5 step 3a): one account vault, several computers.
 * The owner of a renewing sign-in renews it ahead and pushes it as its owner;
 * a computer that is not the owner never puts its copy over the owner's, even
 * a copy that looks newer and was queued before the owner's renewal; a cloud
 * computer never renews and never names itself owner; and two passes at once
 * on the owner give one renewal. Only a test can line these up in time.
 *
 * Real stores and real files on each computer; one relay fake that keeps the
 * relay's stale-write rule (a write older than the stored row by more than
 * 5 s loses, unless the same device wrote the row). The renewal is a fake
 * CLI that rewrites the login file with a later expiry.
 *
 * Step 3b adds the takeover and the write-back: a cloud computer claims the
 * renewal only past expiry + 60 s while a turn waits, and never holds the
 * turn past 45 s; of two claimants only the claim that stands after the 30 s
 * settle renews; the origin writes the newer copy of its own sign-in back and
 * claims the renewal back after the grace; and a sign-out on the origin
 * during a takeover never comes back. These run on fake timers (the settle
 * and the limits are tens of seconds), with real I/O between the steps.
 */
describe("provider login renewal: the owner renews, nobody else overwrites", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-login-renew-"));
  });

  const started: Array<{ sync: { stop(): void } }> = [];

  afterEach(() => {
    for (const computer of started.splice(0)) computer.sync.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  type Row = { scope: string; kind: string; key: string; value: string | null; updatedAt: string; writerDeviceId: string | null; refreshOwner: string | null; deleted?: boolean };

  function makeRelay() {
    const rows = new Map<string, Row>();
    const down = new Set<string>();
    /** A device whose reads lag: it sees the rows as they were when frozen, and its own writes. */
    const frozen = new Map<string, Map<string, Row>>();
    const unavailable = () => Object.assign(new Error("relay unavailable"), { status: 503 });
    const relayFor = (device: string): AccountVaultRelay => ({
      getAccountVault: async () => {
        if (down.has(device)) throw unavailable();
        return { items: [...(frozen.get(device) ?? rows).values()], cursor: null, truncated: false };
      },
      putAccountVault: async (items: Array<{ scope: string; kind: string; key: string; value: string; refreshOwner?: string | null; writtenAt?: string }>, deviceId: string | null) => {
        if (down.has(device)) throw unavailable();
        const at = new Date().toISOString();
        const results = items.map((item) => {
          const id = `${item.scope}|${item.kind}|${item.key}`;
          const stored = rows.get(id);
          const threshold = item.writtenAt ? Date.parse(item.writtenAt) + 5_000 : Number.POSITIVE_INFINITY;
          // The relay's rule (push-relay accountVault.ts): written when the stored row is not newer than the write, or this device wrote it last.
          if (stored && Date.parse(stored.updatedAt) > threshold && stored.writerDeviceId !== deviceId) {
            return { status: "stale" as const, current: stored as never };
          }
          const next = { scope: item.scope, kind: item.kind, key: item.key, value: item.value, updatedAt: at, writerDeviceId: deviceId, refreshOwner: item.refreshOwner ?? null };
          rows.set(id, next);
          frozen.get(device)?.set(id, { ...next });
          return { status: "written" as const };
        });
        return { updatedAt: at, results };
      },
      deleteAccountVaultItem: async (scope: string, kind: string, key: string, options?: { deviceId?: string | null }) => {
        if (down.has(device)) throw unavailable();
        rows.set(`${scope}|${kind}|${key}`, { scope, kind, key, value: null, updatedAt: new Date().toISOString(), writerDeviceId: options?.deviceId ?? null, refreshOwner: null, deleted: true });
        return true;
      },
    } as unknown as AccountVaultRelay);
    const freeze = (device: string) => frozen.set(device, new Map([...rows].map(([id, row]) => [id, { ...row }])));
    return { rows, down, relayFor, freeze, thaw: (device: string) => frozen.delete(device) };
  }

  const jwt = (claims: Record<string, unknown>) =>
    `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
  const codexLogin = (access: string, expiresAt: number, refresh: string) => JSON.stringify({
    tokens: { access_token: jwt({ exp: Math.floor(expiresAt / 1000), n: access }), id_token: jwt({ email: "a@example.test" }), refresh_token: refresh, account_id: "acct" },
  });
  const HOUR = 3_600_000;

  async function makeComputer(name: string, opts: {
    relay: ReturnType<typeof makeRelay>;
    device: string;
    machineKey: string;
    cloud: boolean;
    storeNow?: () => number;
    renew?: (provider: string) => Promise<boolean | null>;
  }) {
    const home = path.join(root, name, "home");
    const adeDir = path.join(root, name, "ade");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(adeDir, { recursive: true });
    const vault = createAccountVaultStore({
      adeDir,
      relay: opts.relay.relayFor(opts.device),
      getAccountUserId: () => USER,
      getDeviceId: () => opts.device,
      ...(opts.storeNow ? { now: opts.storeNow } : {}),
    });
    await vault.sync();
    const renewCalls: string[] = [];
    const sync = createProviderLoginSync({
      adeDir,
      staticOff: null,
      vault: () => vault,
      settings: () => ({ get: () => undefined }),
      accountUserId: () => USER,
      machine: () => ({ machineKey: opts.machineKey, deviceId: opts.device, label: name, platform: "linux" }),
      cloudAccess: async () => "ready",
      cloudComputer: opts.cloud,
      logger: { info: () => {}, warn: () => {} },
      env: { HOME: home },
      homeDir: home,
      platform: "linux",
      renewer: {
        aheadMs: { codex: 24 * HOUR },
        renew: async (provider) => {
          renewCalls.push(provider);
          return await (opts.renew ?? (async () => true))(provider);
        },
      },
      cloudComputerExists: async () => true,
      rotatingVault: () => createHeadlessAccountVaultBridge(() => vault),
    });
    const codexPath = path.join(home, ".codex", "auth.json");
    const writeCodex = (data: string) => {
      fs.mkdirSync(path.dirname(codexPath), { recursive: true });
      fs.writeFileSync(codexPath, data);
      // Settled: older than the 2 s a file needs before capture reads it.
      const seconds = (Date.now() - 10_000) / 1000;
      fs.utimesSync(codexPath, seconds, seconds);
    };
    return { name, home, vault, sync, renewCalls, codexPath, writeCodex };
  }

  const keyOf = (rows: Map<string, Row>) => [...rows.values()].find((row) => row.key.startsWith("codex/"))!;
  const expiryOf = (row: Row) => (JSON.parse(row.value!) as { expiresAt: number }).expiresAt;

  it("lets only the owner renew and push, and keeps a non-owner's newer-looking copy off the owner's", async () => {
    const relay = makeRelay();
    let renewed!: () => void;
    const renewDone = new Promise<void>((resolve) => { renewed = resolve; });
    const ownerExpiry = Date.now() + 23 * HOUR;
    // A second install with the same machine key and another device id: it synced once
    // (an empty account), then went offline. Its clock runs a minute behind while it is away.
    let otherClockBehindMs = 60_000;
    const other = await makeComputer("other", { relay, device: "device-other", machineKey: "machine-owner", cloud: false, storeNow: () => Date.now() - otherClockBehindMs });
    relay.down.add("device-other");

    // The owner: its Codex login expires inside the 24 h Codex renews ahead.
    const owner = await makeComputer("owner", {
      relay,
      device: "device-owner",
      machineKey: "machine-owner",
      cloud: false,
      renew: async () => {
        owner.writeCodex(codexLogin("renewed", Date.now() + 240 * HOUR, "refresh-1"));
        renewed();
        return true;
      },
    });
    owner.writeCodex(codexLogin("first", ownerExpiry, "refresh-1"));
    await owner.sync.pass();
    await owner.vault.sync();
    expect(keyOf(relay.rows).refreshOwner).toBe("device-owner");

    // A cloud computer takes the copy, due for renewal, access-only.
    const cloud = await makeComputer("cloud", { relay, device: "device-cloud", machineKey: "machine-cloud", cloud: true });
    await cloud.sync.pass();
    const accessOnly = () => (JSON.parse(fs.readFileSync(cloud.codexPath, "utf8")) as { tokens: { refresh_token: string } }).tokens.refresh_token;
    expect(accessOnly()).toBe("");

    // Offline, the other install captures its own copy of the same family, which looks newer
    // (a later expiry, a newer file). The write waits in its queue.
    other.writeCodex(codexLogin("other", ownerExpiry + 30 * 60_000, "refresh-1"));
    await other.sync.pass();

    // The owner plans its renewal (its write is taken), renews ahead, and pushes the renewed copy.
    await owner.sync.pass();
    await renewDone;
    await owner.sync.pass();
    await owner.vault.sync();
    const afterRenewal = keyOf(relay.rows);
    expect(owner.renewCalls).toEqual(["codex"]);
    expect(afterRenewal.writerDeviceId).toBe("device-owner");
    expect(afterRenewal.refreshOwner).toBe("device-owner");
    expect(expiryOf(afterRenewal)).toBeGreaterThan(ownerExpiry + 200 * HOUR);
    // Neither the queued install nor the cloud computer renewed the copy that was due.
    expect(other.renewCalls).toEqual([]);
    expect(cloud.renewCalls).toEqual([]);

    // The other install comes back: its queued write is older and loses. Its clock is right again,
    // and its CLI renews by itself to a later expiry than the owner's; that copy still never goes
    // over the owner's.
    relay.down.delete("device-other");
    await other.vault.sync();
    expect(keyOf(relay.rows)).toEqual(afterRenewal);
    otherClockBehindMs = 0;
    other.writeCodex(codexLogin("other-later", Date.now() + 300 * HOUR, "refresh-1"));
    await other.sync.pass();
    await other.vault.sync();
    expect(keyOf(relay.rows)).toEqual(afterRenewal);
    expect(other.renewCalls).toEqual([]);

    // The cloud computer takes the renewed copy, still access-only, and never names itself owner.
    await cloud.vault.sync();
    await cloud.sync.pass();
    await cloud.vault.sync();
    expect(accessOnly()).toBe("");
    expect(cloud.renewCalls).toEqual([]);
    expect([...relay.rows.values()].filter((row) => row.writerDeviceId === "device-cloud" || row.refreshOwner === "device-cloud")).toEqual([]);
    expect(keyOf(relay.rows)).toEqual(afterRenewal);
  });

  it("gives one renewal for passes that run at the same moment on the owner", async () => {
    const relay = makeRelay();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const renewStarted = new Promise<void>((resolve) => { started = resolve; });
    const owner = await makeComputer("owner", {
      relay,
      device: "device-owner",
      machineKey: "machine-owner",
      cloud: false,
      renew: async () => {
        started();
        await held;
        owner.writeCodex(codexLogin("renewed", Date.now() + 240 * HOUR, "refresh-1"));
        return true;
      },
    });
    owner.writeCodex(codexLogin("first", Date.now() + 23 * HOUR, "refresh-1"));
    await owner.sync.pass();
    await owner.vault.sync();
    await Promise.all([owner.sync.pass(), owner.sync.pass(), owner.sync.captureNow()]);
    await renewStarted;
    // More passes while the renewal runs plan the same sign-in again.
    await Promise.all([owner.sync.pass(), owner.sync.pass()]);
    release();
    await owner.sync.pass();
    await Promise.all([owner.sync.pass(), owner.sync.pass()]);
    expect(owner.renewCalls).toEqual(["codex"]);
  });

  // ── step 3b: the takeover and the write-back ──────────────────────────

  type Computer = Awaited<ReturnType<typeof makeComputer>>;
  const FAKE = { toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] as const };

  /** One step of fake time, after the real I/O in flight (a file read, a stat) has had its turn. */
  async function step(ms: number): Promise<void> {
    for (let turn = 0; turn < 2; turn += 1) {
      await fs.promises.access(root);
      await new Promise((resolve) => setImmediate(resolve));
    }
    await vi.advanceTimersByTimeAsync(ms);
  }

  async function elapse(ms: number): Promise<void> {
    const until = Date.now() + ms;
    while (Date.now() < until) await step(Math.min(100, until - Date.now()));
  }

  /** Run fake time until `done()` holds (an event the test watches for, not a sleep). */
  async function until(done: () => boolean): Promise<void> {
    const limit = Date.now() + 10 * 60_000;
    while (!done()) {
      if (Date.now() > limit) throw new Error("did not happen in 10 fake minutes");
      await step(100);
    }
  }

  /** Run fake time until the promise settles; `at` is the fake time it settled. */
  async function drive<T>(promise: Promise<T>): Promise<{ value: T; at: number }> {
    const box: { done?: { value: T; at: number }; failure?: unknown } = {};
    promise.then((value) => { box.done = { value, at: Date.now() }; }, (error) => { box.failure = error ?? new Error("rejected"); });
    const limit = Date.now() + 10 * 60_000;
    while (!box.done && !box.failure) {
      if (Date.now() > limit) throw new Error("did not settle in 10 fake minutes");
      await step(100);
    }
    if (box.failure) throw box.failure;
    return box.done!;
  }

  /** The origin made a Codex sign-in that expires in 10 minutes, and goes off. Fake time, a day ahead of the real clock. */
  async function originGoesOff() {
    vi.useFakeTimers({ toFake: [...FAKE.toFake] });
    vi.setSystemTime(Date.now() + 24 * HOUR);
    const relay = makeRelay();
    const origin = await makeComputer("origin", { relay, device: "device-origin", machineKey: "machine-origin", cloud: false });
    const expiresAt = Date.now() + 10 * 60_000;
    origin.writeCodex(codexLogin("first", expiresAt, "refresh-0"));
    await origin.sync.pass();
    await origin.vault.sync();
    relay.down.add("device-origin");
    return { relay, origin, expiresAt };
  }

  async function cloudComputer(name: string, relay: ReturnType<typeof makeRelay>, renew?: (self: Computer) => Promise<boolean | null>): Promise<Computer> {
    let self!: Computer;
    self = await makeComputer(name, {
      relay,
      device: `device-${name}`,
      machineKey: `machine-${name}`,
      cloud: true,
      renew: async () => await (renew ?? (async (me: Computer) => {
        me.writeCodex(codexLogin(`renewed-${name}`, Date.now() + 240 * HOUR, `refresh-${name}`));
        return true;
      }))(self),
    });
    return self;
  }

  function startComputer(computer: Computer): void {
    computer.sync.start();
    started.push(computer);
  }

  const refreshIn = (file: string) => (JSON.parse(fs.readFileSync(file, "utf8")) as { tokens: { refresh_token: string } }).tokens.refresh_token;

  /** A cloud computer that took the Codex renewal over two minutes after expiry, renewed it and pushed it. */
  async function takenOver() {
    const world = await originGoesOff();
    const cloud = await cloudComputer("cloud", world.relay);
    startComputer(cloud);
    await elapse(world.expiresAt + 2 * 60_000 - Date.now());
    const turn = await drive(providerLoginGate("codex")!);
    expect(turn.value).toEqual({ result: "ok", renewedHere: true });
    await cloud.vault.sync();
    expect(keyOf(world.relay.rows).refreshOwner).toBe("device-cloud");
    return { ...world, cloud };
  }

  it("takes the renewal over on a cloud computer only past expiry + 60 s, and never holds a turn past 45 s", async () => {
    const { relay, expiresAt } = await originGoesOff();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const cloud = await cloudComputer("cloud", relay, async (me) => {
      await held;
      me.writeCodex(codexLogin("renewed", Date.now() + 240 * HOUR, "refresh-cloud"));
      return true;
    });
    startComputer(cloud);
    await elapse(expiresAt + 20_000 - Date.now());

    // 20 s past expiry the owner may still renew: the turn waits, then goes, and nobody claims.
    const lines: string[] = [];
    const early = await drive(providerLoginGate("codex", { onWait: (line) => lines.push(line) })!);
    expect(early.value).toMatchObject({ result: "owner_off", ownerLabel: "origin" });
    expect(lines).toEqual(["Getting a fresh Codex sign-in from origin…"]);
    await cloud.vault.sync();
    expect(keyOf(relay.rows).refreshOwner).toBe("device-origin");
    expect(cloud.renewCalls).toEqual([]);

    // Two minutes past expiry the next turn claims, waits the settle, takes the full copy and renews.
    // The renewal hangs: the turn still goes at 45 s.
    await elapse(expiresAt + 2 * 60_000 - Date.now());
    const turnStarted = Date.now();
    const late = await drive(providerLoginGate("codex")!);
    expect(late.value).toMatchObject({ result: "owner_off" });
    expect(late.at - turnStarted).toBeLessThanOrEqual(45_000);
    expect(cloud.renewCalls).toEqual(["codex"]);
    expect(keyOf(relay.rows).refreshOwner).toBe("device-cloud");
    expect(refreshIn(cloud.codexPath)).not.toBe("");

    // The renewal ends after the turn: capture pushes it into the origin's key, this computer the owner.
    release();
    await elapse(5_000);
    await cloud.vault.sync();
    const row = keyOf(relay.rows);
    const payload = JSON.parse(row.value!) as { origin: { deviceId: string }; renewedBy: { label: string; cloud?: boolean }; expiresAt: number };
    expect(row.writerDeviceId).toBe("device-cloud");
    expect(payload.origin.deviceId).toBe("device-origin");
    expect(payload.renewedBy).toMatchObject({ label: "cloud", cloud: true });
    expect(payload.expiresAt).toBeGreaterThan(Date.now() + 200 * HOUR);
    expect(cloud.renewCalls).toEqual(["codex"]);
  });

  it("lets only the claim that stands renew when two cloud computers claim at once", async () => {
    const { relay, expiresAt } = await originGoesOff();
    const cloudA = await cloudComputer("cloudA", relay);
    const cloudB = await cloudComputer("cloudB", relay);
    await elapse(expiresAt + 2 * 60_000 - Date.now());
    // B's reads lag until it claims: it does not see A's claim and claims too. The later write stands.
    relay.freeze("device-cloudB");
    startComputer(cloudA);
    await step(100);
    const turnA = providerLoginGate("codex")!;
    await until(() => keyOf(relay.rows).refreshOwner === "device-cloudA");
    startComputer(cloudB);
    await step(100);
    const turnB = providerLoginGate("codex")!;
    await until(() => keyOf(relay.rows).refreshOwner === "device-cloudB");
    relay.thaw("device-cloudB");
    const both = await drive(Promise.all([turnA, turnB]));
    expect(both.value).toEqual([{ result: "ok" }, { result: "ok", renewedHere: true }]);
    expect([...cloudA.renewCalls, ...cloudB.renewCalls]).toEqual(["codex"]);
    expect(cloudB.renewCalls).toEqual(["codex"]);
    await cloudB.vault.sync();
    expect(keyOf(relay.rows).refreshOwner).toBe("device-cloudB");
    // The claimant that lost keeps an access-only copy (the winner's renewed one).
    expect(refreshIn(cloudA.codexPath)).toBe("");
  });

  it("writes the newer copy back on the origin once, never echoes it, and claims the renewal back after the grace", async () => {
    const { relay, origin, cloud } = await takenOver();
    const modeBefore = fs.statSync(origin.codexPath).mode & 0o777;
    // A second install with the origin's machine key (another device id) never writes it.
    const twin = await makeComputer("twin", { relay, device: "device-twin", machineKey: "machine-origin", cloud: false });
    twin.writeCodex(fs.readFileSync(origin.codexPath, "utf8"));
    const twinBefore = fs.readFileSync(twin.codexPath, "utf8");
    await twin.vault.sync();
    await twin.sync.pass();
    expect(fs.readFileSync(twin.codexPath, "utf8")).toBe(twinBefore);

    // The origin wakes: the account holds a newer copy of its own sign-in; the file here is unchanged since capture.
    relay.down.delete("device-origin");
    await origin.vault.sync();
    await origin.sync.pass();
    const accountCopy = (JSON.parse(keyOf(relay.rows).value!) as { files: Array<{ data: string }> }).files[0]!.data;
    expect(fs.readFileSync(origin.codexPath, "utf8")).toBe(accountCopy);
    expect(fs.statSync(origin.codexPath).mode & 0o777).toBe(modeBefore);
    const local = (await origin.sync.status("codex")).providers.find((entry) => entry.provider === "codex")!.local;
    expect(local).toMatchObject({ state: "written_back", writtenBack: { renewedBy: "cloud" } });

    // No echo: later passes read the written copy back and push nothing.
    await elapse(3_000);
    await origin.sync.pass();
    await origin.sync.pass();
    await origin.vault.sync();
    expect(keyOf(relay.rows).writerDeviceId).toBe("device-cloud");

    // The cloud computer goes quiet. Ten minutes past the copy's expiry, the origin claims the renewal back.
    cloud.sync.stop();
    relay.down.add("device-cloud");
    const expiry = (JSON.parse(keyOf(relay.rows).value!) as { expiresAt: number }).expiresAt;
    vi.setSystemTime(expiry + 11 * 60_000);
    await origin.sync.pass();
    await elapse(1_000);
    await origin.vault.sync();
    expect(keyOf(relay.rows).refreshOwner).toBe("device-origin");

    // The cloud computer hears it: its copy is access-only again.
    relay.down.delete("device-cloud");
    await cloud.vault.sync();
    await cloud.sync.pass();
    expect(refreshIn(cloud.codexPath)).toBe("");
  });

  it("never brings back a sign-in the person signed out of on the origin during a takeover", async () => {
    const { relay, origin, cloud } = await takenOver();
    // The person signs out on the origin: the file goes. Two passes 60 s apart remove the sign-in from the account.
    fs.rmSync(origin.codexPath);
    relay.down.delete("device-origin");
    await origin.vault.sync();
    await origin.sync.pass();
    await elapse(61_000);
    await origin.sync.pass();
    await origin.vault.sync();
    expect(keyOf(relay.rows).deleted).toBe(true);

    // The cloud computer's CLI renews its full copy again: it is never pushed back, and the copy leaves.
    cloud.writeCodex(codexLogin("renewed-again", Date.now() + 300 * HOUR, "refresh-again"));
    await cloud.vault.sync();
    await cloud.sync.pass();
    await cloud.vault.sync();
    expect(keyOf(relay.rows).deleted).toBe(true);
    expect(fs.existsSync(cloud.codexPath)).toBe(false);

    // A cloud write that crossed the removal lands after it: the origin removes it again, and writes nothing.
    await elapse(2_000);
    const row = keyOf(relay.rows);
    relay.rows.set(`${row.scope}|${row.kind}|${row.key}`, { ...row, value: JSON.stringify({ v: 1, provider: "codex", slot: "base", class: "renewing", origin: { machineKey: "machine-origin", deviceId: "device-origin", label: "origin", platform: "linux" }, account: null, capturedAt: 1, renewedAt: 2, renewedBy: { machineKey: "machine-cloud", label: "cloud", cloud: true }, expiresAt: Date.now() + 300 * HOUR, familyHash: "0123456789abcdef", contentHash: "fedcba9876543210", files: [] }), deleted: false, updatedAt: new Date().toISOString(), writerDeviceId: "device-cloud", refreshOwner: "device-cloud" });
    await origin.vault.sync();
    await origin.sync.pass();
    await origin.vault.sync();
    expect(keyOf(relay.rows).deleted).toBe(true);
    expect(fs.existsSync(origin.codexPath)).toBe(false);
  });
});
