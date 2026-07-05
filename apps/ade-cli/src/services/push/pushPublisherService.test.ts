import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentChatEventEnvelope } from "../../../../desktop/src/shared/types/chat";
import { createPushRegistrationStore, type PushRegistrationStore } from "./pushRegistrationStore";
import { createPushRelayClient } from "./pushRelayClient";
import {
  buildAgentRunsContentState,
  createPushPublisherService,
  isWithinQuietHours,
  parseHhMm,
  shouldDeliverAlertForPrefs,
  type AgentRunState,
} from "./pushPublisherService";

function run(overrides: Partial<AgentRunState>): AgentRunState {
  return {
    sessionId: "s",
    scopeKey: "scope",
    title: "Run",
    lane: "lane",
    model: "gpt-5",
    agent: "Codex",
    phase: "running",
    detail: null,
    startedAt: 0,
    lastActiveAt: 0,
    metaResolved: true,
    ...overrides,
  };
}

describe("quiet hours", () => {
  it("parses HH:MM and rejects malformed input", () => {
    expect(parseHhMm("22:00")).toBe(22 * 60);
    expect(parseHhMm("7:05")).toBe(7 * 60 + 5);
    expect(parseHhMm("24:00")).toBeNull();
    expect(parseHhMm("22:60")).toBeNull();
    expect(parseHhMm("nope")).toBeNull();
  });

  it("evaluates a midnight-spanning window in its own timezone", () => {
    // 02:30 UTC = 22:30 America/New_York (EDT) = 11:30 Asia/Tokyo.
    const nowMs = Date.parse("2026-07-05T02:30:00.000Z");
    const spanning = { start: "22:00", end: "07:00", timezone: "America/New_York" };
    expect(isWithinQuietHours(spanning, nowMs)).toBe(true);
    // Same instant, UTC-evaluated (02:30 is inside 22:00→07:00).
    expect(isWithinQuietHours({ ...spanning, timezone: "UTC" }, nowMs)).toBe(true);
  });

  it("discriminates a non-spanning window by timezone", () => {
    const nowMs = Date.parse("2026-07-05T02:30:00.000Z");
    const window = { start: "22:00", end: "23:00" };
    // 22:30 in New York → inside.
    expect(isWithinQuietHours({ ...window, timezone: "America/New_York" }, nowMs)).toBe(true);
    // 11:30 in Tokyo → outside.
    expect(isWithinQuietHours({ ...window, timezone: "Asia/Tokyo" }, nowMs)).toBe(false);
  });

  it("does not suppress on an unknown timezone or zero-length window", () => {
    const nowMs = Date.parse("2026-07-05T02:30:00.000Z");
    expect(isWithinQuietHours({ start: "22:00", end: "07:00", timezone: "Not/AZone" }, nowMs)).toBe(false);
    expect(isWithinQuietHours({ start: "22:00", end: "22:00", timezone: "UTC" }, nowMs)).toBe(false);
    expect(isWithinQuietHours(null, nowMs)).toBe(false);
  });
});

describe("shouldDeliverAlertForPrefs", () => {
  const nowMs = Date.parse("2026-07-05T12:00:00.000Z");

  it("blocks when the master switch is off", () => {
    expect(shouldDeliverAlertForPrefs({ enabled: false }, "s-1", nowMs)).toBe(false);
  });

  it("blocks a muted session but allows others", () => {
    const prefs = { enabled: true, mutedSessionIds: ["s-1"] };
    expect(shouldDeliverAlertForPrefs(prefs, "s-1", nowMs)).toBe(false);
    expect(shouldDeliverAlertForPrefs(prefs, "s-2", nowMs)).toBe(true);
    expect(shouldDeliverAlertForPrefs(prefs, null, nowMs)).toBe(true);
  });

  it("blocks inside quiet hours", () => {
    const prefs = { enabled: true, quietHours: { start: "00:00", end: "23:59", timezone: "UTC" } };
    expect(shouldDeliverAlertForPrefs(prefs, "s-1", nowMs)).toBe(false);
  });
});

describe("buildAgentRunsContentState", () => {
  it("caps runs at 3, orders by recency, and counts active runs", () => {
    const runs = [
      run({ sessionId: "a", lastActiveAt: 10, phase: "running" }),
      run({ sessionId: "b", lastActiveAt: 40, phase: "waiting_for_approval" }),
      run({ sessionId: "c", lastActiveAt: 30, phase: "completed" }),
      run({ sessionId: "d", lastActiveAt: 20, phase: "running" }),
    ];
    const state = buildAgentRunsContentState(runs, 1_000);
    expect(state.updatedAt).toBe(1);
    // 3 active (a, b, d); c is terminal.
    expect(state.activeCount).toBe(3);
    expect(state.runs.map((r) => r.id)).toEqual(["b", "c", "d"]);
  });

  it("redacts failed detail and caps detail length", () => {
    const long = "x".repeat(300);
    const state = buildAgentRunsContentState(
      [
        run({ sessionId: "f", phase: "failed", detail: "stack trace with secrets", lastActiveAt: 2 }),
        run({ sessionId: "g", phase: "running", detail: long, lastActiveAt: 1 }),
      ],
      0,
    );
    const failed = state.runs.find((r) => r.id === "f");
    const running = state.runs.find((r) => r.id === "g");
    expect(failed?.detail).toBe("Run failed");
    expect(running?.detail).toHaveLength(160);
  });
});

describe("createPushPublisherService flush", () => {
  const device = {
    deviceId: "dev-1",
    apnsToken: "a".repeat(64),
    pushToStartToken: "b".repeat(64),
    bundleId: "com.ade.ios",
    apsEnvironment: "sandbox" as const,
    prefs: { enabled: true, liveActivitiesEnabled: true, mutedSessionIds: [] as string[], quietHours: null },
    updatedAt: "",
  };

  function makeHarness(deviceOverride = device) {
    const publish = vi.fn().mockResolvedValue({ ok: true });
    const store = {
      hasRegisteredDevices: () => true,
      getStatusSnapshot: () => ({ enabled: true, claimed: true, registeredDeviceCount: 1, lastPublishAt: null, lastPublishError: null, lastRelayContactAt: null }),
      listDevices: () => [deviceOverride],
      getDevice: () => deviceOverride,
      recordPublishResult: vi.fn(),
      recordRelayContact: vi.fn(),
    };
    const relayClient = { publish, health: vi.fn().mockResolvedValue({ ok: true, apnsConfigured: true }), baseUrl: "https://relay.test" };
    let chatCb: ((env: AgentChatEventEnvelope) => void) | null = null;
    const agentChatService = {
      subscribeToEvents: (cb: (env: AgentChatEventEnvelope) => void) => {
        chatCb = cb;
        return () => {};
      },
      getSessionSummary: vi.fn().mockResolvedValue({
        sessionId: "s-1",
        laneId: "auth-lane",
        title: "Fix login",
        model: "gpt-5",
        provider: "codex",
        status: "active",
        startedAt: "",
        endedAt: null,
        lastActivityAt: "",
        lastOutputPreview: null,
        summary: null,
      }),
    };
    const publisher = createPushPublisherService({
      logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() } as never,
      store: store as never,
      relayClient: relayClient as never,
      machineName: "MacBook",
      flushDebounceMs: 2_000,
      promptFlushMs: 150,
    });
    publisher.attachSources("scope-1", { agentChatService: agentChatService as never });
    return { publisher, publish, emit: (env: AgentChatEventEnvelope) => chatCb?.(env), store };
  }

  const approval: AgentChatEventEnvelope = {
    sessionId: "s-1",
    timestamp: "",
    event: { type: "approval_request", itemId: "i-1", kind: "command", description: "Run tests" },
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-05T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("publishes an approval alert + a started Live Activity, then dedupes a repeat", async () => {
    const { publisher, publish, emit } = makeHarness();
    await publisher.start();

    emit(approval);
    await vi.advanceTimersByTimeAsync(200);

    expect(publish).toHaveBeenCalledTimes(1);
    const payload = publish.mock.calls[0][0];
    expect(payload.notifications).toHaveLength(1);
    expect(payload.notifications[0].title).toBe("Codex needs your approval");
    expect(payload.notifications[0].body).toBe("auth-lane · Fix login");
    expect(payload.notifications[0].deviceIds).toEqual(["dev-1"]);
    expect(payload.notifications[0].dedupeKey).toBe("alert:s-1:approval");
    expect(payload.liveActivity).toHaveLength(1);
    expect(payload.liveActivity[0].event).toBe("start");
    expect(payload.liveActivity[0].activityId).toBe("agent-runs");
    expect(payload.liveActivity[0].attributes).toEqual({ machineName: "MacBook" });
    expect(payload.liveActivity[0].contentState.activeCount).toBe(1);
    expect(payload.liveActivity[0].contentState.runs[0].id).toBe("s-1");

    // Identical repeat: alert dedupes and the LA contentState is unchanged.
    emit(approval);
    await vi.advanceTimersByTimeAsync(2_500);
    expect(publish).toHaveBeenCalledTimes(1);

    publisher.dispose();
  });

  it("suppresses a muted alert but still updates the Live Activity", async () => {
    const muted = { ...device, prefs: { ...device.prefs, mutedSessionIds: ["s-1"] } };
    const { publisher, publish, emit } = makeHarness(muted);
    await publisher.start();

    emit(approval);
    await vi.advanceTimersByTimeAsync(200);

    expect(publish).toHaveBeenCalledTimes(1);
    const payload = publish.mock.calls[0][0];
    expect(payload.notifications).toBeUndefined();
    expect(payload.liveActivity[0].event).toBe("start");

    publisher.dispose();
  });

  it("does not publish when there are no registered devices", async () => {
    const { publisher, publish, emit, store } = makeHarness();
    (store as { hasRegisteredDevices: () => boolean }).hasRegisteredDevices = () => false;
    await publisher.start();
    emit(approval);
    await vi.advanceTimersByTimeAsync(500);
    expect(publish).not.toHaveBeenCalled();
    publisher.dispose();
  });

  it("merges runs from two attached project scopes into one aggregate Live Activity", async () => {
    const publish = vi.fn().mockResolvedValue({ ok: true });
    const store = {
      hasRegisteredDevices: () => true,
      getStatusSnapshot: () => ({ enabled: true, claimed: true, registeredDeviceCount: 1, lastPublishAt: null, lastPublishError: null, lastRelayContactAt: null }),
      listDevices: () => [device],
      getDevice: () => device,
      recordPublishResult: vi.fn(),
      recordRelayContact: vi.fn(),
    };
    const relayClient = { publish, health: vi.fn().mockResolvedValue({ ok: true, apnsConfigured: true }), baseUrl: "https://relay.test" };
    const makeChat = (sessionId: string) => {
      let cb: ((env: AgentChatEventEnvelope) => void) | null = null;
      return {
        service: {
          subscribeToEvents: (fn: (env: AgentChatEventEnvelope) => void) => { cb = fn; return () => {}; },
          getSessionSummary: vi.fn().mockResolvedValue({
            sessionId, laneId: "lane", title: "T", model: "gpt-5", provider: "codex",
            status: "active", startedAt: "", endedAt: null, lastActivityAt: "", lastOutputPreview: null, summary: null,
          }),
        },
        emit: (env: AgentChatEventEnvelope) => cb?.(env),
      };
    };
    const projectA = makeChat("s-a");
    const projectB = makeChat("s-b");
    const publisher = createPushPublisherService({
      logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() } as never,
      store: store as never,
      relayClient: relayClient as never,
      machineName: "MacBook",
      flushDebounceMs: 2_000,
      promptFlushMs: 150,
    });
    publisher.attachSources("project-a", { agentChatService: projectA.service as never });
    publisher.attachSources("project-b", { agentChatService: projectB.service as never });
    await publisher.start();

    projectA.emit({ sessionId: "s-a", timestamp: "", event: { type: "approval_request", itemId: "i", kind: "command", description: "x" } });
    projectB.emit({ sessionId: "s-b", timestamp: "", event: { type: "approval_request", itemId: "i", kind: "command", description: "y" } });
    await vi.advanceTimersByTimeAsync(2_500);

    const laPayloads = publish.mock.calls.map((c) => c[0]).filter((p) => p.liveActivity);
    const lastLa = laPayloads[laPayloads.length - 1].liveActivity[0];
    expect(lastLa.contentState.activeCount).toBe(2);
    expect(lastLa.contentState.runs.map((r: { id: string }) => r.id).sort()).toEqual(["s-a", "s-b"]);

    publisher.dispose();
  });
});

describe("createPushRegistrationStore", () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "push-store-"));
    filePath = path.join(dir, "secrets", "push-relay.json");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("mints a stable 32-hex machineKey + 48-char secret on first access", () => {
    const store = createPushRegistrationStore({ filePath });
    const identity = store.getOrCreateIdentity();
    expect(identity.machineKey).toMatch(/^[0-9a-f]{32}$/);
    expect(identity.machineSecret).toHaveLength(48);
    // Stable across calls and reloads.
    expect(store.getOrCreateIdentity()).toEqual(identity);
    const reopened = createPushRegistrationStore({ filePath });
    expect(reopened.getOrCreateIdentity()).toEqual(identity);
  });

  it("does not count a device as registered until it has a deliverable token", () => {
    const store = createPushRegistrationStore({ filePath });
    store.upsertDevice({ deviceId: "dev-1", bundleId: "com.ade.ios", apsEnvironment: "sandbox" });
    expect(store.hasRegisteredDevices()).toBe(false);
    store.upsertDevice({ deviceId: "dev-1", bundleId: "com.ade.ios", apsEnvironment: "sandbox", apnsToken: "a".repeat(64) });
    expect(store.hasRegisteredDevices()).toBe(true);
  });

  it("preserves a previously reported token when only the other token re-registers", () => {
    const store = createPushRegistrationStore({ filePath });
    store.upsertDevice({
      deviceId: "dev-1",
      bundleId: "com.ade.ios",
      apsEnvironment: "sandbox",
      apnsToken: "a".repeat(64),
    });
    store.upsertDevice({
      deviceId: "dev-1",
      bundleId: "com.ade.ios",
      apsEnvironment: "sandbox",
      pushToStartToken: "b".repeat(64),
    });
    const device = store.getDevice("dev-1");
    expect(device?.apnsToken).toBe("a".repeat(64));
    expect(device?.pushToStartToken).toBe("b".repeat(64));
  });

  it("stores prefs and applies defaults", () => {
    const store = createPushRegistrationStore({ filePath });
    store.upsertDevice({ deviceId: "dev-1", bundleId: "com.ade.ios", apsEnvironment: "sandbox", apnsToken: "a".repeat(64) });
    expect(store.getDevice("dev-1")?.prefs).toEqual({
      enabled: true,
      liveActivitiesEnabled: true,
      mutedSessionIds: [],
      quietHours: null,
    });
    const updated = store.setPrefs("dev-1", {
      enabled: false,
      liveActivitiesEnabled: false,
      mutedSessionIds: ["s-1"],
      quietHours: { start: "22:00", end: "07:00", timezone: "America/New_York" },
    });
    expect(updated?.prefs.enabled).toBe(false);
    expect(updated?.prefs.mutedSessionIds).toEqual(["s-1"]);
    expect(store.setPrefs("missing", { enabled: true })).toBeNull();
  });

  it("removes devices and records publish results in the status snapshot", () => {
    const store = createPushRegistrationStore({ filePath });
    store.upsertDevice({ deviceId: "dev-1", bundleId: "com.ade.ios", apsEnvironment: "sandbox", apnsToken: "a".repeat(64) });
    store.setEnabled(false);
    store.recordPublishResult({ at: "2026-07-05T00:00:00.000Z", error: "boom" });
    let snapshot = store.getStatusSnapshot();
    expect(snapshot.enabled).toBe(false);
    expect(snapshot.registeredDeviceCount).toBe(1);
    expect(snapshot.lastPublishError).toBe("boom");
    expect(snapshot.lastRelayContactAt).toBe("2026-07-05T00:00:00.000Z");

    store.recordPublishResult({ at: "2026-07-05T01:00:00.000Z" });
    snapshot = store.getStatusSnapshot();
    expect(snapshot.lastPublishError).toBeNull();

    store.removeDevice("dev-1");
    expect(store.getStatusSnapshot().registeredDeviceCount).toBe(0);
    expect(store.hasRegisteredDevices()).toBe(false);
  });

  it("tracks claim state idempotently", () => {
    const store = createPushRegistrationStore({ filePath });
    expect(store.isClaimed()).toBe(false);
    store.markClaimed();
    expect(store.isClaimed()).toBe(true);
    expect(createPushRegistrationStore({ filePath }).isClaimed()).toBe(true);
  });
});

const MACHINE_KEY = "0123456789abcdef0123456789abcdef"; // gitleaks:allow — test fixture
const MACHINE_SECRET = "test-secret-abcdefghijklmnopqrstuvwxyz012345"; // gitleaks:allow — test fixture

/**
 * Independent re-implementation of the worker's canonical signing string
 * (apps/push-relay/src/relay.ts `buildSignatureBase` / `signPushRelayRequest`)
 * — the client's header must equal this for the relay to accept the call.
 */
function expectedSignature(secret: string, timestamp: string, method: string, pathname: string, body: string): string {
  const bodyHash = createHash("sha256").update(body, "utf8").digest("hex");
  const base = `${timestamp}.${method.toUpperCase()}.${pathname}.${bodyHash}`;
  return `sha256=${createHmac("sha256", secret).update(base, "utf8").digest("hex")}`;
}

function makeStore(overrides: Partial<PushRegistrationStore> = {}): PushRegistrationStore {
  let claimed = false;
  return {
    getOrCreateIdentity: () => ({ machineKey: MACHINE_KEY, machineSecret: MACHINE_SECRET }),
    isClaimed: () => claimed,
    markClaimed: () => {
      claimed = true;
    },
    ...overrides,
  } as unknown as PushRegistrationStore;
}

const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() } as never;

describe("createPushRelayClient", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-05T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("signs publish with the exact canonical string the relay verifies", async () => {
    const client = createPushRelayClient({ store: makeStore(), logger, baseUrl: "https://relay.test" });
    await client.publish({ notifications: [{ title: "hi", phase: "waiting" }] });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://relay.test/machines/${MACHINE_KEY}/publish`);
    expect(init.method).toBe("POST");
    const timestamp = init.headers["x-ade-push-timestamp"];
    expect(timestamp).toBe(String(Math.floor(Date.parse("2026-07-05T00:00:00.000Z") / 1000)));
    const pathname = new URL(url).pathname;
    expect(init.headers["x-ade-push-signature"]).toBe(
      expectedSignature(MACHINE_SECRET, timestamp, "POST", pathname, init.body),
    );
  });

  it("signs the percent-encoded device path so it matches the wire pathname", async () => {
    const client = createPushRelayClient({ store: makeStore(), logger, baseUrl: "https://relay.test" });
    await client.registerDevice({ deviceId: "dev:99", bundleId: "com.ade.ios", apsEnvironment: "sandbox", apnsToken: "a".repeat(64) });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/devices/dev%3A99");
    const pathname = new URL(url).pathname;
    expect(init.headers["x-ade-push-signature"]).toBe(
      expectedSignature(MACHINE_SECRET, init.headers["x-ade-push-timestamp"], "PUT", pathname, init.body),
    );
  });

  it("claims idempotently and never signs the claim call", async () => {
    const store = makeStore();
    const client = createPushRelayClient({ store, logger, baseUrl: "https://relay.test" });
    await client.claim();
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers["x-ade-push-signature"]).toBeUndefined();
    expect(store.isClaimed()).toBe(true);

    // Second claim is a no-op once the store records it as claimed.
    await client.claim();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws with the relay error message on a non-2xx publish", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => ({ ok: false, error: "APNs signing key is not configured on the relay" }),
    });
    const client = createPushRelayClient({ store: makeStore(), logger, baseUrl: "https://relay.test" });
    await expect(client.publish({ notifications: [{ title: "x", phase: "waiting" }] })).rejects.toThrow(
      /APNs signing key is not configured/,
    );
  });

  it("reports relay health without signing", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, apnsConfigured: true }) });
    const client = createPushRelayClient({ store: makeStore(), logger, baseUrl: "https://relay.test" });
    const health = await client.health();
    expect(health).toEqual({ ok: true, apnsConfigured: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://relay.test/health");
    expect(init.headers["x-ade-push-signature"]).toBeUndefined();
  });

  it("matches the cross-app golden signature vector (must equal apps/push-relay's)", () => {
    // Pinned in BOTH apps (see apps/push-relay/test/relay.test.ts). If either
    // side's canonical string drifts, exactly one of the two tests breaks.
    const signature = expectedSignature(
      "ade-parity-secret-0123456789abcdef0123456789", // gitleaks:allow — golden test vector
      "1751712000",
      "POST",
      "/machines/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/publish",
      '{"notifications":[{"title":"parity","phase":"waiting"}]}',
    );
    expect(signature).toBe("sha256=5c5c3a3081a0c6bec96c4191a88ab17b59382b902c6071672ea6d8daa30764f3"); // gitleaks:allow
  });
});
