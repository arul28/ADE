import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_MACHINE_HEARTBEAT_MS,
  ACCOUNT_MACHINE_RELAY_STATE_POLL_MS,
  ACCOUNT_MACHINE_RETRY_BACKOFF_MS,
  type AccountMachineRegistrationSnapshot,
  buildAccountMachineRegistration,
  createBrainAccountMachinePublisherService,
  createAccountMachinePublisherService,
  PAIRING_REAUTHENTICATION_REQUIRED_MESSAGE,
} from "./accountMachinePublisherService";
import {
  DEFAULT_ADE_ACCOUNT_DIRECTORY_URL,
  DEVELOPMENT_ADE_ACCOUNT_DIRECTORY_URL,
} from "../../../../desktop/src/shared/accountDirectory";
import { buildProjectlessSyncSnapshot } from "../sync/projectlessSyncSnapshot";
import { createSyncAccountDirectoryHealth } from "../../../../desktop/src/shared/types";
import type { ProductAnalyticsCapture } from "../../../../desktop/src/shared/types/productAnalytics";
import { removeTestTree } from "../../test/filesystem";
import {
  createEpisodeAnalytics,
  EPISODE_ANALYTICS_MINIMUM_INTERVAL_MS,
} from "./episodeAnalytics";

const sharedAccountAuthService = vi.hoisted(() => ({
  getStatus: vi.fn(() => ({
    signedIn: true,
    userId: "account-user",
    source: "loopback" as const,
  })),
  getAccessToken: vi.fn(async () => "account-token"),
  getSessionReadState: vi.fn(() => "available" as const),
  getSessionReadFailureReason: vi.fn(() => null),
  onSignedIn: vi.fn(() => () => {}),
}));

vi.mock("./sharedAccountAuthService", async () => {
  const actual = await vi.importActual<typeof import("./sharedAccountAuthService")>(
    "./sharedAccountAuthService",
  );
  return {
    ...actual,
    getSharedAccountAuthService: () => sharedAccountAuthService,
  };
});

function snapshot(
  overrides: Partial<AccountMachineRegistrationSnapshot> = {},
): AccountMachineRegistrationSnapshot {
  return {
    role: "brain",
    runtimeRole: "host",
    runtimeName: "Studio",
    pairingConnectInfo: {
      hostIdentity: {
        deviceId: "device-studio",
        siteId: "site-studio",
        name: "Studio",
        platform: "macOS",
        deviceType: "desktop",
      },
      port: 8787,
      addressCandidates: [{ kind: "lan", host: "192.168.1.20" }],
    },
    routeHealth: {
      listener: {
        listenerBound: true,
        loopbackAdeValidated: true,
        port: 8787,
        lastFailureAt: null,
        reason: null,
        lastSuccessAt: "2026-07-16T00:00:00.000Z",
      },
      tailscale: {
        enabled: false,
        tailscalePublished: false,
        tailscaleReachable: false,
        lastFailureAt: null,
        reason: null,
        lastSuccessAt: null,
      },
      relay: {
        enabled: false,
        relayControlConnected: false,
        relayBridgeValidated: false,
        relayEndToEndVerifiedAt: null,
        relayEndToEndFailure: null,
        relayEndToEndRoundTripMs: null,
        lastFailureAt: null,
        skipReason: null,
        lastControlError: null,
        lastControlOpenAt: null,
        lastBridgeValidationAt: null,
      },
    },
    ...overrides,
  };
}

function routeSnapshot(
  overrides: Partial<AccountMachineRegistrationSnapshot> = {},
): AccountMachineRegistrationSnapshot {
  const value = snapshot({
    runtimeName: "Arul's Mac Studio",
    ...overrides,
  });
  if (value.pairingConnectInfo) {
    value.pairingConnectInfo.addressCandidates = [
      { kind: "lan", host: "192.168.1.20" },
      { kind: "tailscale", host: "studio.tailnet.ts.net" },
      { kind: "loopback", host: "127.0.0.1" },
      { kind: "relay", host: "wss://relay.example/connect/machine-studio" },
    ];
  }
  value.routeHealth.tailscale = {
    enabled: true,
    tailscalePublished: true,
    tailscaleReachable: true,
    lastFailureAt: null,
    reason: null,
    lastSuccessAt: "2026-07-16T00:00:00.000Z",
  };
  value.routeHealth.relay = {
    enabled: true,
    relayControlConnected: true,
    relayBridgeValidated: true,
    relayEndToEndVerifiedAt: "2026-07-16T00:00:01.000Z",
    relayEndToEndFailure: null,
    relayEndToEndRoundTripMs: 42,
    lastFailureAt: null,
    skipReason: null,
    lastControlError: null,
    lastControlOpenAt: "2026-07-16T00:00:00.000Z",
    lastBridgeValidationAt: "2026-07-16T00:00:00.000Z",
  };
  return value;
}

const projectlessSecretsDirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const dir of projectlessSecretsDirs.splice(0)) {
    await removeTestTree(dir);
  }
});

describe("account machine publisher health", () => {
  it("defaults the account-directory heartbeat to 30 seconds", () => {
    expect(ACCOUNT_MACHINE_HEARTBEAT_MS).toBe(30_000);
  });

  it("records a successful publication with its endpoint count and timestamps", async () => {
    let clock = 100;
    const service = createAccountMachinePublisherService({
      getAccessToken: async () => "account-token",
      getAccountStatus: () => ({ signedIn: true, sessionReadState: "available" as const }),
      getSnapshot: async () => snapshot(),
      getMachineKey: () => "machine-studio",
      directoryBaseUrl: () => "https://directory.example/path/",
      fetchImpl: vi.fn(async () => {
        clock = 125;
        return new Response(null, { status: 204 });
      }),
      now: () => clock,
    });

    await service.publishNow();

    expect(service.getPublisherHealth()).toEqual({
      state: "published",
      skipReason: null,
      directoryOrigin: "https://directory.example",
      lastAttemptAt: 100,
      lastSuccessAt: 125,
      lastHttpStatus: 204,
      lastHttpReason: null,
      reachableEndpointCount: 1,
      lastLegDurations: {
        snapshot: 0,
        token: 0,
        http: 25,
      },
      failingSinceMs: null,
    });
  });

  it("samples successful leg durations and escalates slow legs to warn", async () => {
    let clock = 0;
    let tokenDelayMs = 2;
    const debug = vi.fn();
    const info = vi.fn();
    const warn = vi.fn();
    const service = createAccountMachinePublisherService({
      getAccessToken: async () => {
        clock += tokenDelayMs;
        return "account-token";
      },
      getAccountStatus: () => ({ signedIn: true, sessionReadState: "available" as const }),
      getSnapshot: async () => {
        clock += 1;
        return snapshot();
      },
      getMachineKey: () => "machine-studio",
      directoryBaseUrl: () => "https://directory.example",
      fetchImpl: vi.fn(async () => {
        clock += 3;
        return new Response(null, { status: 204 });
      }),
      now: () => clock,
      logger: { debug, info, warn },
    });

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await service.publishNow();
    }

    expect(debug).toHaveBeenCalledTimes(9);
    expect(info).toHaveBeenCalledWith("account.machine_publish_ok", {
      legDurationsMs: { snapshot: 1, token: 2, http: 3 },
    });
    tokenDelayMs = 2_001;
    await service.publishNow();
    expect(warn).toHaveBeenCalledWith("account.machine_publish_ok", {
      legDurationsMs: { snapshot: 1, token: 2_001, http: 3 },
    });
  });

  it("includes the machine Ed25519 signing key in the registration payload", async () => {
    let body: unknown = null;
    const publicKeyRawBase64 = Buffer.alloc(32, 9).toString("base64");
    const service = createAccountMachinePublisherService({
      getAccessToken: async () => "account-token",
      getAccountStatus: () => ({
        signedIn: true,
        sessionReadState: "available" as const,
      }),
      getSnapshot: async () => snapshot(),
      getMachineKey: () => "machine-studio",
      getMachineIdentitySigningPublicKey: () => publicKeyRawBase64,
      directoryBaseUrl: () => "https://directory.example",
      fetchImpl: vi.fn(async (_input, init) => {
        body = JSON.parse(String(init?.body));
        return new Response(null, { status: 204 });
      }),
    });

    await service.publishNow();

    expect(body).toMatchObject({
      machineKey: "machine-studio",
      pubkey: `ed25519:${publicKeyRawBase64}`,
    });
  });

  it.each([
    {
      name: "sync disabled",
      expected: "sync_disabled",
      options: { isSyncEnabled: () => false },
    },
    {
      name: "no active scope",
      expected: "no_active_sync_scope",
      options: { getSnapshot: async () => null },
    },
    {
      name: "snapshot failure",
      expected: "snapshot_failed",
      options: { getSnapshot: async () => { throw new Error("snapshot"); } },
    },
    {
      name: "missing machine key",
      expected: "machine_key_unavailable",
      options: { getMachineKey: () => "" },
    },
    {
      name: "missing pairing info",
      expected: "missing_pairing_connect_info",
      options: { getSnapshot: async () => snapshot({ pairingConnectInfo: null }) },
    },
    {
      name: "viewer runtime",
      expected: "not_host",
      options: { getSnapshot: async () => snapshot({ runtimeRole: "viewer" }) },
    },
    {
      name: "signed out account",
      expected: "account_signed_out",
      options: { getAccountStatus: () => ({ signedIn: false, sessionReadState: "missing" as const }) },
    },
    {
      name: "unreadable session",
      expected: "token_unreadable",
      options: { getAccountStatus: () => ({ signedIn: false, sessionReadState: "unreadable" as const }) },
    },
    {
      name: "failed token refresh",
      expected: "token_unreadable",
      options: { getAccessToken: async () => null },
    },
    {
      name: "invalid directory URL",
      expected: "invalid_directory_url",
      options: { directoryBaseUrl: () => "http://directory.example" },
    },
  ])("records $name", async ({ expected, options }) => {
    const service = createAccountMachinePublisherService({
      getAccessToken: async () => "account-token",
      getAccountStatus: () => ({ signedIn: true, sessionReadState: "available" as const }),
      getSnapshot: async () => snapshot(),
      getMachineKey: () => "machine-studio",
      directoryBaseUrl: () => "https://directory.example",
      fetchImpl: vi.fn(async () => new Response(null, { status: 200 })),
      now: () => 250,
      ...options,
    });

    await service.publishNow();

    expect(service.getPublisherHealth()).toMatchObject({
      state: expected,
      lastAttemptAt: 250,
    });
  });

  it("distinguishes HTTP timeouts from transport failures", async () => {
    const baseOptions = {
      getAccessToken: async () => "account-token",
      getAccountStatus: () => ({ signedIn: true, sessionReadState: "available" as const }),
      getSnapshot: async () => snapshot(),
      getMachineKey: () => "machine-studio",
      directoryBaseUrl: () => "https://directory.example",
    };
    const http = createAccountMachinePublisherService({
      ...baseOptions,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ error: "invalid audience" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })),
    });
    await http.publishNow();
    expect(http.getPublisherHealth()).toMatchObject({
      state: "http_error",
      skipReason: "The account directory returned HTTP 401: invalid audience",
      lastHttpStatus: 401,
      lastHttpReason: "invalid audience",
      reachableEndpointCount: 1,
    });

    const transport = createAccountMachinePublisherService({
      ...baseOptions,
      fetchImpl: vi.fn(async () => { throw new TypeError("offline"); }),
    });
    await transport.publishNow();
    expect(transport.getPublisherHealth()).toMatchObject({
      state: "transport_error",
      lastHttpStatus: null,
    });

    vi.useFakeTimers();
    const warn = vi.fn();
    const timeout = createAccountMachinePublisherService({
      ...baseOptions,
      requestTimeoutMs: 250,
      fetchImpl: vi.fn((_input, init) => new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })),
      logger: { warn },
    });
    const publishing = timeout.publishNow();
    await vi.advanceTimersByTimeAsync(250);
    await publishing;
    expect(timeout.getPublisherHealth()).toMatchObject({
      state: "http_timeout",
      lastHttpStatus: null,
      failingSinceMs: expect.any(Number),
      lastLegDurations: {
        snapshot: expect.any(Number),
        token: expect.any(Number),
        http: 250,
      },
    });
    expect(warn).toHaveBeenCalledWith("account.machine_publish_failed", expect.objectContaining({
      leg: "http",
      code: "http_timeout",
      legDurationsMs: expect.objectContaining({ http: 250 }),
    }));
  });

  it("captures one publish-failing event per failure episode after two minutes", async () => {
    let clock = 0;
    let succeeds = false;
    const captureAnalytics = vi.fn();
    const service = createAccountMachinePublisherService({
      getAccessToken: async () => "account-token",
      getAccountStatus: () => ({ signedIn: true, sessionReadState: "available" as const }),
      getSnapshot: async () => snapshot(),
      getMachineKey: () => "machine-studio",
      directoryBaseUrl: () => "https://directory.example",
      fetchImpl: vi.fn(async () => succeeds
        ? new Response(null, { status: 204 })
        : new Response(null, { status: 503 })),
      now: () => clock,
      captureAnalytics,
    });

    await service.publishNow();
    clock = 121_000;
    await service.publishNow();
    clock = 180_000;
    await service.publishNow();

    expect(captureAnalytics).toHaveBeenCalledTimes(1);
    expect(captureAnalytics).toHaveBeenCalledWith({
      event: "ade_publish_failing",
      surface: "api",
      properties: {
        failing_minutes: 2,
        leg: "http",
        code: "http_error",
      },
      dedupeKey: "publish-failing:0",
      minimumIntervalMs: 24 * 60 * 60 * 1_000,
    });

    succeeds = true;
    clock = 200_000;
    await service.publishNow();
    succeeds = false;
    clock = 300_000;
    await service.publishNow();
    clock = 421_000;
    await service.publishNow();

    expect(captureAnalytics).toHaveBeenCalledTimes(2);
  });

  it("captures one account-session-unreadable event per unreadable episode", async () => {
    let sessionReadState: "available" | "unreadable" = "unreadable";
    const captureAnalytics = vi.fn();
    const service = createAccountMachinePublisherService({
      getAccessToken: async () => "account-token",
      getAccountStatus: () => ({
        signedIn: sessionReadState === "available",
        sessionReadState,
        sessionReadFailureReason: sessionReadState === "unreadable"
          ? ("no_os_key_material" as const)
          : null,
      }),
      getSnapshot: async () => snapshot(),
      getMachineKey: () => "machine-studio",
      directoryBaseUrl: () => "https://directory.example",
      fetchImpl: vi.fn(async () => new Response(null, { status: 204 })),
      captureAnalytics,
    });

    await service.publishNow();
    await service.publishNow();

    expect(captureAnalytics).toHaveBeenCalledTimes(1);
    expect(captureAnalytics).toHaveBeenCalledWith({
      event: "ade_account_session_unreadable",
      surface: "api",
      properties: { code: "no_os_key_material" },
      dedupeKey: "account-session-unreadable:no_os_key_material",
      minimumIntervalMs: 24 * 60 * 60 * 1_000,
    });

    // A readable session ends the episode, so a genuinely new one reports again.
    sessionReadState = "available";
    await service.publishNow();
    sessionReadState = "unreadable";
    await service.publishNow();

    expect(captureAnalytics).toHaveBeenCalledTimes(2);
  });

  it("captures an account-session-unreadable event when the status read throws", async () => {
    // A throwing status read is the same failure as an "unreadable" one, and
    // `read_error` is a documented code for it. Reporting only the non-throwing
    // path left this half of the incident class invisible.
    const captureAnalytics = vi.fn();
    const service = createAccountMachinePublisherService({
      getAccessToken: async () => "account-token",
      getAccountStatus: () => {
        throw new Error("credential store unreadable");
      },
      getSnapshot: async () => snapshot(),
      getMachineKey: () => "machine-studio",
      directoryBaseUrl: () => "https://directory.example",
      fetchImpl: vi.fn(async () => new Response(null, { status: 204 })),
      captureAnalytics,
    });

    await service.publishNow();
    await service.publishNow();

    expect(service.getPublisherHealth().state).toBe("token_unreadable");
    expect(captureAnalytics).toHaveBeenCalledTimes(1);
    expect(captureAnalytics).toHaveBeenCalledWith({
      event: "ade_account_session_unreadable",
      surface: "api",
      properties: { code: "read_error" },
      dedupeKey: "account-session-unreadable:read_error",
      minimumIntervalMs: 24 * 60 * 60 * 1_000,
    });
  });

  it("starts a new publish-failure analytics episode after a benign skip", async () => {
    let clock = 0;
    let syncEnabled = true;
    const captureAnalytics = vi.fn();
    const service = createAccountMachinePublisherService({
      getAccessToken: async () => "account-token",
      getAccountStatus: () => ({ signedIn: true, sessionReadState: "available" as const }),
      getSnapshot: async () => snapshot(),
      getMachineKey: () => "machine-studio",
      directoryBaseUrl: () => "https://directory.example",
      isSyncEnabled: () => syncEnabled,
      fetchImpl: vi.fn(async () => new Response(null, { status: 503 })),
      now: () => clock,
      captureAnalytics,
    });

    await service.publishNow();
    clock = 121_000;
    await service.publishNow();
    syncEnabled = false;
    clock = 130_000;
    await service.publishNow();
    expect(service.getPublisherHealth()).toMatchObject({
      state: "sync_disabled",
      failingSinceMs: null,
    });

    syncEnabled = true;
    clock = 200_000;
    await service.publishNow();
    clock = 321_000;
    await service.publishNow();

    expect(captureAnalytics).toHaveBeenCalledTimes(2);
  });

  it("bounds a stalled token leg and reports token_timeout without starting HTTP", async () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    const fetchImpl = vi.fn();
    const getAccessToken = vi.fn((options?: { signal?: AbortSignal }) =>
      new Promise<string>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => {
          reject(options.signal?.reason);
        });
      }));
    const service = createAccountMachinePublisherService({
      getAccessToken,
      getAccountStatus: () => ({ signedIn: true, sessionReadState: "available" as const }),
      getSnapshot: async () => snapshot(),
      getMachineKey: () => "machine-studio",
      directoryBaseUrl: () => "https://directory.example",
      fetchImpl,
      tokenTimeoutMs: 250,
      logger: { warn },
    });

    const publishing = service.publishNow();
    await vi.advanceTimersByTimeAsync(250);
    await publishing;

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(service.getPublisherHealth()).toMatchObject({
      state: "token_timeout",
      lastHttpStatus: null,
      failingSinceMs: expect.any(Number),
      lastLegDurations: {
        snapshot: expect.any(Number),
        token: 250,
        http: null,
      },
    });
    expect(warn).toHaveBeenCalledWith("account.machine_publish_failed", expect.objectContaining({
      leg: "token",
      code: "token_timeout",
      legDurationsMs: expect.objectContaining({ token: 250, http: null }),
    }));
  });

  it("force-refreshes once after the directory rejects the first bearer", async () => {
    const getAccessToken = vi.fn(async (options?: { forceRefresh?: boolean }) =>
      options?.forceRefresh ? "fresh-token" : "stale-token");
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const token = new Headers(init?.headers).get("authorization");
      return token === "Bearer fresh-token"
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify({ error: "expired bearer" }), {
            status: 401,
            headers: { "content-type": "application/json" },
          });
    });
    const service = createAccountMachinePublisherService({
      getAccessToken,
      getAccountStatus: () => ({ signedIn: true, sessionReadState: "available" as const }),
      getSnapshot: async () => snapshot(),
      getMachineKey: () => "machine-studio",
      directoryBaseUrl: () => "https://directory.example",
      fetchImpl,
    });

    await service.publishNow();

    expect(getAccessToken).toHaveBeenNthCalledWith(1, expect.objectContaining({
      signal: expect.any(AbortSignal),
      timeoutMs: 10_000,
    }));
    expect(getAccessToken).toHaveBeenNthCalledWith(2, expect.objectContaining({
      forceRefresh: true,
      signal: expect.any(AbortSignal),
      timeoutMs: 10_000,
    }));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(service.getPublisherHealth()).toMatchObject({
      state: "published",
      lastHttpStatus: 204,
    });
  });

  it("classifies a stalled 401 refresh as token_timeout, outside the HTTP budget", async () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    const getAccessToken = vi.fn((options?: {
      forceRefresh?: boolean;
      signal?: AbortSignal;
    }): Promise<string> => {
      if (!options?.forceRefresh) return Promise.resolve("stale-token");
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => {
          reject(options.signal?.reason);
        });
      });
    });
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ error: "expired bearer" }),
      {
        status: 401,
        headers: { "content-type": "application/json" },
      },
    ));
    const service = createAccountMachinePublisherService({
      getAccessToken,
      getAccountStatus: () => ({ signedIn: true, sessionReadState: "available" as const }),
      getSnapshot: async () => snapshot(),
      getMachineKey: () => "machine-studio",
      directoryBaseUrl: () => "https://directory.example",
      fetchImpl,
      tokenTimeoutMs: 250,
      requestTimeoutMs: 250,
      logger: { warn },
    });

    const publishing = service.publishNow();
    await vi.advanceTimersByTimeAsync(250);
    await publishing;

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(service.getPublisherHealth()).toMatchObject({
      state: "token_timeout",
      lastHttpStatus: 401,
      lastHttpReason: "expired bearer",
      lastLegDurations: {
        snapshot: expect.any(Number),
        token: 250,
        http: expect.any(Number),
      },
    });
    expect(warn).toHaveBeenCalledWith("account.machine_publish_failed", expect.objectContaining({
      leg: "token_refresh_401",
      code: "token_timeout",
    }));
  });

  it("accelerates transient retries with bounded backoff and resets after success", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValue(new Response(null, { status: 204 }));
    const service = createAccountMachinePublisherService({
      getAccessToken: async () => "account-token",
      getAccountStatus: () => ({ signedIn: true, sessionReadState: "available" as const }),
      getSnapshot: async () => snapshot(),
      getMachineKey: () => "machine-studio",
      directoryBaseUrl: () => "https://directory.example",
      fetchImpl,
    });

    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(ACCOUNT_MACHINE_RETRY_BACKOFF_MS[0] - 1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(ACCOUNT_MACHINE_RETRY_BACKOFF_MS[1] - 1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(service.getPublisherHealth().state).toBe("published");

    await vi.advanceTimersByTimeAsync(ACCOUNT_MACHINE_HEARTBEAT_MS - 1);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    service.dispose();
  });

  it("publishes immediately on sign-in and still discovers a late token on heartbeat", async () => {
    vi.useFakeTimers();
    let signedIn = false;
    let token: string | null = null;
    let signInListener: (() => void) | null = null;
    const emitSignIn = () => signInListener?.();
    const fetchImpl = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => new Response(null, { status: 200 }));
    const service = createAccountMachinePublisherService({
      getAccessToken: async () => token,
      getAccountStatus: () => ({
        signedIn,
        sessionReadState: signedIn ? "available" : "missing",
      }),
      getSnapshot: async () => snapshot(),
      getMachineKey: () => "machine-studio",
      directoryBaseUrl: () => "https://directory.example",
      fetchImpl,
      subscribeToSignIn: (listener) => {
        signInListener = listener;
        return () => { signInListener = null; };
      },
    });

    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(service.getPublisherHealth().state).toBe("account_signed_out");

    signedIn = true;
    token = "late-token";
    emitSignIn();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(service.getPublisherHealth().state).toBe("published");

    token = "heartbeat-token";
    await vi.advanceTimersByTimeAsync(ACCOUNT_MACHINE_HEARTBEAT_MS);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    service.dispose();
  });

  it("coalesces relay readiness changes into a publish and resets the heartbeat", async () => {
    vi.useFakeTimers();
    const current = routeSnapshot();
    const fetchImpl = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => new Response(null, { status: 200 }));
    const service = createAccountMachinePublisherService({
      getAccessToken: async () => "account-token",
      getAccountStatus: () => ({
        signedIn: true,
        userId: "owner-a",
        sessionReadState: "available" as const,
      }),
      getSnapshot: async () => current,
      getMachineKey: () => "machine-studio",
      directoryBaseUrl: () => "https://directory.example",
      fetchImpl,
    });

    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    current.routeHealth.relay.relayControlConnected = false;
    current.routeHealth.relay.relayBridgeValidated = false;
    await vi.advanceTimersByTimeAsync(ACCOUNT_MACHINE_RELAY_STATE_POLL_MS);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toEqual(
      expect.objectContaining({
        retainRelayEndpoints: true,
        reachableEndpoints: [
          { kind: "lan", host: "192.168.1.20", port: 8787 },
          { kind: "tailnet", host: "studio.tailnet.ts.net", port: 8787 },
          { kind: "relay", url: "wss://relay.example/connect/machine-studio" },
        ],
      }),
    );
    expect(service.getPublisherHealth().reachableEndpointCount).toBe(3);

    await vi.advanceTimersByTimeAsync(ACCOUNT_MACHINE_HEARTBEAT_MS - 1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    service.dispose();
  });

  it("retains the verified Relay endpoint across a pipe blocker and republishes it on recovery", async () => {
    vi.useFakeTimers();
    const current = routeSnapshot();
    const fetchImpl = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => new Response(null, { status: 200 }));
    const service = createAccountMachinePublisherService({
      getAccessToken: async () => "account-token",
      getAccountStatus: () => ({
        signedIn: true,
        userId: "owner-a",
        sessionReadState: "available" as const,
      }),
      getSnapshot: async () => current,
      getMachineKey: () => "machine-studio",
      directoryBaseUrl: () => "https://directory.example",
      fetchImpl,
    });

    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    current.routeHealth.relay.skipReason = "injected relay pipe open failure";
    await vi.advanceTimersByTimeAsync(ACCOUNT_MACHINE_RELAY_STATE_POLL_MS);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toEqual(
      expect.objectContaining({
        retainRelayEndpoints: true,
        reachableEndpoints: expect.arrayContaining([
          { kind: "relay", url: "wss://relay.example/connect/machine-studio" },
        ]),
      }),
    );

    current.routeHealth.relay.skipReason = null;
    await vi.advanceTimersByTimeAsync(ACCOUNT_MACHINE_RELAY_STATE_POLL_MS);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const recovered = JSON.parse(String(fetchImpl.mock.calls[2]?.[1]?.body));
    expect(recovered.retainRelayEndpoints).toBeUndefined();
    expect(recovered.reachableEndpoints).toContainEqual({
      kind: "relay",
      url: "wss://relay.example/connect/machine-studio",
    });
    service.dispose();
  });

  it("retains the directory Relay endpoint while end-to-end verification is pending at startup", async () => {
    const current = routeSnapshot();
    current.routeHealth.relay.relayEndToEndVerifiedAt = null;
    const fetchImpl = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => new Response(null, { status: 204 }));
    const service = createAccountMachinePublisherService({
      getAccessToken: async () => "account-token",
      getAccountStatus: () => ({
        signedIn: true,
        userId: "owner-a",
        sessionReadState: "available" as const,
      }),
      getSnapshot: async () => current,
      getMachineKey: () => "machine-studio",
      directoryBaseUrl: () => "https://directory.example",
      fetchImpl,
    });

    await service.publishNow();

    const registration = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(registration.retainRelayEndpoints).toBe(true);
    expect(registration.reachableEndpoints).not.toContainEqual(
      expect.objectContaining({ kind: "relay" }),
    );
    service.dispose();
  });

  it("drops a stale Relay endpoint and retention hint after end-to-end verification fails", async () => {
    const current = routeSnapshot();
    const fetchImpl = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => new Response(null, { status: 204 }));
    const service = createAccountMachinePublisherService({
      getAccessToken: async () => "account-token",
      getAccountStatus: () => ({
        signedIn: true,
        userId: "owner-a",
        sessionReadState: "available" as const,
      }),
      getSnapshot: async () => current,
      getMachineKey: () => "machine-studio",
      directoryBaseUrl: () => "https://directory.example",
      fetchImpl,
    });

    await service.publishNow();
    current.routeHealth.relay.relayEndToEndVerifiedAt = null;
    current.routeHealth.relay.relayEndToEndFailure = "Relay self-probe closed before ready (4501): host offline.";
    await service.publishNow();

    const registration = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body));
    expect(registration.retainRelayEndpoints).toBeUndefined();
    expect(registration.reachableEndpoints).not.toContainEqual(
      expect.objectContaining({ kind: "relay" }),
    );
    service.dispose();
  });

  it("does not retain a verified Relay route across account-owner changes", async () => {
    let accountOwnerId = "owner-a";
    const current = routeSnapshot();
    const fetchImpl = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => new Response(null, { status: 204 }));
    const service = createAccountMachinePublisherService({
      getAccessToken: async () => "account-token",
      getAccountStatus: () => ({
        signedIn: true,
        userId: accountOwnerId,
        sessionReadState: "available" as const,
      }),
      getSnapshot: async () => current,
      getMachineKey: () => "machine-studio",
      directoryBaseUrl: () => "https://directory.example",
      fetchImpl,
    });

    await service.publishNow();
    current.routeHealth.relay.relayControlConnected = false;
    current.routeHealth.relay.relayBridgeValidated = false;
    accountOwnerId = "owner-b";
    await service.publishNow();

    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toEqual(
      expect.objectContaining({
        retainRelayEndpoints: true,
        reachableEndpoints: [
          { kind: "lan", host: "192.168.1.20", port: 8787 },
          { kind: "tailnet", host: "studio.tailnet.ts.net", port: 8787 },
        ],
      }),
    );
    service.dispose();
  });

  it("clears retained Relay ownership on explicit sign-out", async () => {
    let signedIn = true;
    const current = routeSnapshot();
    const fetchImpl = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => new Response(null, { status: 204 }));
    const service = createAccountMachinePublisherService({
      getAccessToken: async () => "account-token",
      getAccountStatus: () => ({
        signedIn,
        userId: signedIn ? "owner-a" : null,
        sessionReadState: signedIn ? "available" as const : "missing" as const,
      }),
      getSnapshot: async () => current,
      getMachineKey: () => "machine-studio",
      directoryBaseUrl: () => "https://directory.example",
      fetchImpl,
    });

    await service.publishNow();
    signedIn = false;
    await service.publishNow();
    current.routeHealth.relay.relayControlConnected = false;
    current.routeHealth.relay.relayBridgeValidated = false;
    signedIn = true;
    await service.publishNow();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toEqual(
      expect.objectContaining({
        retainRelayEndpoints: true,
        reachableEndpoints: [
          { kind: "lan", host: "192.168.1.20", port: 8787 },
          { kind: "tailnet", host: "studio.tailnet.ts.net", port: 8787 },
        ],
      }),
    );
    service.dispose();
  });

  it("clears retained Relay ownership after an authoritative authentication rejection", async () => {
    const current = routeSnapshot();
    let rejectAuthentication = false;
    const fetchImpl = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => rejectAuthentication
      ? new Response(JSON.stringify({ error: "invalid token" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        })
      : new Response(null, { status: 204 }));
    const service = createAccountMachinePublisherService({
      getAccessToken: async () => "account-token",
      getAccountStatus: () => ({
        signedIn: true,
        userId: "owner-a",
        sessionReadState: "available" as const,
      }),
      getSnapshot: async () => current,
      getMachineKey: () => "machine-studio",
      directoryBaseUrl: () => "https://directory.example",
      fetchImpl,
    });

    await service.publishNow();
    current.routeHealth.relay.relayControlConnected = false;
    current.routeHealth.relay.relayBridgeValidated = false;
    rejectAuthentication = true;
    await service.publishNow();
    expect(service.getPublisherHealth()).toMatchObject({
      state: "http_error",
      lastHttpStatus: 401,
    });

    rejectAuthentication = false;
    await service.publishNow();
    expect(JSON.parse(String(fetchImpl.mock.calls[3]?.[1]?.body))).toEqual(
      expect.objectContaining({
        retainRelayEndpoints: true,
        reachableEndpoints: [
          { kind: "lan", host: "192.168.1.20", port: 8787 },
          { kind: "tailnet", host: "studio.tailnet.ts.net", port: 8787 },
        ],
      }),
    );
    service.dispose();
  });

  it("publishes at the first relay poll when the startup snapshot was unavailable", async () => {
    vi.useFakeTimers();
    let ready = false;
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const service = createAccountMachinePublisherService({
      getAccessToken: async () => "account-token",
      getAccountStatus: () => ({ signedIn: true, sessionReadState: "available" as const }),
      getSnapshot: async () => ready ? routeSnapshot() : null,
      getMachineKey: () => "machine-studio",
      directoryBaseUrl: () => "https://directory.example",
      fetchImpl,
    });

    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(service.getPublisherHealth().state).toBe("no_active_sync_scope");
    expect(fetchImpl).not.toHaveBeenCalled();

    ready = true;
    await vi.advanceTimersByTimeAsync(ACCOUNT_MACHINE_RELAY_STATE_POLL_MS);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(service.getPublisherHealth().state).toBe("published");
    service.dispose();
  });

  it("publishes a machine that hosts sync with no project registered", async () => {
    // The bug this pins: a signed-in machine with an empty projects.json never
    // reached the network at all. The publisher bailed at `no_active_sync_scope`
    // because the only snapshot source was the active project scope, even though
    // the brain was hosting phone sync on a real, bound, loopback-validated port.
    const secretsDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-projectless-publish-"));
    projectlessSecretsDirs.push(secretsDir);
    fs.writeFileSync(path.join(secretsDir, "sync-device-id"), "device-headless\n");
    fs.writeFileSync(path.join(secretsDir, "sync-site-id"), "site-headless\n");
    const projectless = buildProjectlessSyncSnapshot({
      secretsDir,
      listener: {
        getPort: () => 8791,
        getLoopbackValidationStatus: () => ({
          port: 8791,
          loopbackAdeValidated: true,
          lastFailureAt: null,
          reason: null,
          lastSuccessAt: "2026-07-16T00:00:00.000Z",
        }),
      },
      holdsSyncHostLease: true,
      relay: { accountSignedIn: true, wssUrl: null, status: null },
      accountDirectory: createSyncAccountDirectoryHealth("sync_disabled", null),
    });
    const fetchImpl = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => new Response(null, { status: 204 }));
    const service = createAccountMachinePublisherService({
      getAccessToken: async () => "account-token",
      getAccountStatus: () => ({ signedIn: true, sessionReadState: "available" as const }),
      getSnapshot: async () => projectless,
      getMachineKey: () => "machine-headless",
      directoryBaseUrl: () => "https://directory.example",
      fetchImpl,
    });

    await service.publishNow();

    expect(service.getPublisherHealth().state).toBe("published");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body)) as {
      machineKey: string;
      deviceId: string;
      name: string;
    };
    expect(body.machineKey).toBe("machine-headless");
    expect(body.deviceId).toBe("device-headless");
    expect(body.name.trim().length).toBeGreaterThan(0);
    service.dispose();
  });

  it("publishes when the reachable endpoint set changes", async () => {
    vi.useFakeTimers();
    const current = snapshot();
    const fetchImpl = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => new Response(null, { status: 200 }));
    const service = createAccountMachinePublisherService({
      getAccessToken: async () => "account-token",
      getAccountStatus: () => ({ signedIn: true, sessionReadState: "available" as const }),
      getSnapshot: async () => current,
      getMachineKey: () => "machine-studio",
      directoryBaseUrl: () => "https://directory.example",
      fetchImpl,
    });

    service.start();
    await vi.advanceTimersByTimeAsync(0);
    current.pairingConnectInfo!.addressCandidates.push({
      kind: "lan",
      host: "192.168.1.21",
    });
    await vi.advanceTimersByTimeAsync(ACCOUNT_MACHINE_RELAY_STATE_POLL_MS);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const registration = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body));
    expect(registration.reachableEndpoints).toEqual([
      { kind: "lan", host: "192.168.1.20", port: 8787 },
      { kind: "lan", host: "192.168.1.21", port: 8787 },
    ]);
    expect(service.getPublisherHealth().reachableEndpointCount).toBe(2);
    service.dispose();
  });

  it("does not publish relay transitions while signed out", async () => {
    vi.useFakeTimers();
    const current = routeSnapshot();
    const getAccessToken = vi.fn(async () => "account-token");
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const service = createAccountMachinePublisherService({
      getAccessToken,
      getAccountStatus: () => ({ signedIn: false, sessionReadState: "missing" as const }),
      getSnapshot: async () => current,
      getMachineKey: () => "machine-studio",
      directoryBaseUrl: () => "https://directory.example",
      fetchImpl,
    });

    service.start();
    await vi.advanceTimersByTimeAsync(0);
    current.routeHealth.relay.relayBridgeValidated = false;
    await vi.advanceTimersByTimeAsync(ACCOUNT_MACHINE_RELAY_STATE_POLL_MS * 2);

    expect(getAccessToken).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(service.getPublisherHealth().state).toBe("account_signed_out");
    service.dispose();
  });
});

describe("brain account machine publisher directory policy", () => {
  it("posts the account bearer to production when a packaged override targets development", async () => {
    vi.stubEnv("ADE_RUNTIME_PACKAGED", "1");
    vi.stubEnv("ADE_ALLOW_DEVELOPMENT_CLERK", "");
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      requests.push({ input: String(input), init });
      return new Response(null, { status: 204 });
    }));
    const service = createBrainAccountMachinePublisherService({
      secretsDir: "/tmp/ade-account-publisher-policy",
      projectRoots: () => [],
      isSyncEnabled: () => true,
      getSnapshot: async () => snapshot(),
      getMachineKey: () => "machine-studio",
      directoryBaseUrl: () => DEVELOPMENT_ADE_ACCOUNT_DIRECTORY_URL,
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    await service.publishNow();
    service.dispose();

    expect(requests.map((request) => request.input)).toEqual([
      `${DEFAULT_ADE_ACCOUNT_DIRECTORY_URL}/account/machines/register`,
    ]);
    expect(new Headers(requests[0]?.init?.headers).get("authorization"))
      .toBe("Bearer account-token");
    expect(service.getPublisherHealth()).toMatchObject({
      state: "published",
      directoryOrigin: DEFAULT_ADE_ACCOUNT_DIRECTORY_URL,
    });
  });
});

describe("account machine registration publisher", () => {
  it("suffixes Beta and Alpha machine names but never stable names", () => {
    const registrationName = (packageChannel: string | null) =>
      buildAccountMachineRegistration({
        machineKey: "machine-studio",
        snapshot: routeSnapshot(),
        packageChannel,
      })?.name;

    expect(registrationName("beta")).toBe("Arul's Mac Studio · Beta");
    expect(registrationName(" ALPHA ")).toBe("Arul's Mac Studio · Alpha");
    expect(registrationName("stable")).toBe("Arul's Mac Studio");
    expect(registrationName(null)).toBe("Arul's Mac Studio");
  });

  it("publishes health-validated routes without honoring the legacy relay toggle bit", () => {
    const value = routeSnapshot();
    value.routeHealth.relay.enabled = false;
    expect(buildAccountMachineRegistration({
      machineKey: "machine-studio",
      snapshot: value,
    })).toEqual({
      machineKey: "machine-studio",
      deviceId: "device-studio",
      name: "Arul's Mac Studio",
      platform: "macOS",
      deviceType: "desktop",
      pubkey: null,
      reachableEndpoints: [
        { kind: "lan", host: "192.168.1.20", port: 8787 },
        { kind: "tailnet", host: "studio.tailnet.ts.net", port: 8787 },
        { kind: "relay", url: "wss://relay.example/connect/machine-studio" },
      ],
    });
  });

  it("publishes Relay only after end-to-end verification", () => {
    const pending = routeSnapshot();
    pending.routeHealth.relay.relayEndToEndVerifiedAt = null;
    expect(buildAccountMachineRegistration({
      machineKey: "machine-studio",
      snapshot: pending,
    })?.reachableEndpoints).not.toContainEqual(
      expect.objectContaining({ kind: "relay" }),
    );

    const verified = routeSnapshot();
    expect(buildAccountMachineRegistration({
      machineKey: "machine-studio",
      snapshot: verified,
    })?.reachableEndpoints).toContainEqual({
      kind: "relay",
      url: "wss://relay.example/connect/machine-studio",
    });
  });

  it("fails closed for viewers and omits unhealthy or spoofed routes", () => {
    expect(buildAccountMachineRegistration({
      machineKey: "machine-studio",
      snapshot: routeSnapshot({ runtimeRole: "viewer" }),
    })).toBeNull();

    const host = routeSnapshot();
    host.routeHealth.listener.loopbackAdeValidated = false;
    host.routeHealth.tailscale.tailscaleReachable = false;
    host.routeHealth.relay.skipReason = "Relay route is unusable because loopback validation failed.";
    host.pairingConnectInfo!.addressCandidates = [
      { kind: "lan", host: "192.168.1.20" },
      { kind: "tailscale", host: "studio.tailnet.ts.net" },
      { kind: "relay", host: "wss://relay.example/connect/different-machine" },
    ];
    expect(buildAccountMachineRegistration({
      machineKey: "machine-studio",
      snapshot: host,
    })?.reachableEndpoints).toEqual([]);
  });

  it("sends the account bearer only to a trusted directory with a bounded registration body", async () => {
    const fetchImpl = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => new Response("{}", { status: 200 }));
    const service = createAccountMachinePublisherService({
      getAccessToken: async () => "account-secret-token",
      getSnapshot: async () => routeSnapshot(),
      getMachineKey: () => "machine-studio",
      directoryBaseUrl: () => "https://directory.example",
      fetchImpl,
    });

    await service.publishNow();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://directory.example/account/machines/register");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer account-secret-token");
    expect(new Headers(init?.headers).get("x-ade-correlation-id"))
      .toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(init).toMatchObject({
      method: "POST",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      redirect: "error",
    });
    expect(JSON.parse(String(init?.body))).toEqual(expect.objectContaining({
      machineKey: "machine-studio",
      deviceId: "device-studio",
    }));
  });

  it("never marks a heartbeat as a pairing, and marks a deliberate link exactly once", async () => {
    const fetchImpl = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => new Response("{}", { status: 200 }));
    const service = createAccountMachinePublisherService({
      getAccessToken: async () => "account-secret-token",
      getSnapshot: async () => routeSnapshot(),
      getMachineKey: () => "machine-studio",
      directoryBaseUrl: () => "https://directory.example",
      fetchImpl,
    });

    // Heartbeats never carry `pairing` — re-registering on a timer is exactly
    // what used to resurrect a machine the account owner had removed.
    await service.publishNow();
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)).pairing).toBeUndefined();

    await service.publishPairing();
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body)).pairing).toBe(true);

    // One-shot: the pairing intent must not leak into the next heartbeat.
    await service.publishNow();
    expect(JSON.parse(String(fetchImpl.mock.calls[2]?.[1]?.body)).pairing).toBeUndefined();
    service.dispose();
  });

  it("does not let an in-flight heartbeat swallow the pairing one-shot", async () => {
    let releaseSnapshot!: () => void;
    let markSnapshotEntered!: () => void;
    const snapshotEntered = new Promise<void>((resolve) => {
      markSnapshotEntered = resolve;
    });
    const snapshotGate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    let snapshotCalls = 0;
    const fetchImpl = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => {
      // The heartbeat that was already running fails on the network. A pairing
      // flag it had swallowed would be gone for good, and the re-pair would
      // then send an unpaired request, get told the machine is revoked, and
      // report failure for a user action that was actually valid.
      if (fetchImpl.mock.calls.length === 1) throw new Error("network down");
      return new Response("{}", { status: 200 });
    });
    const service = createAccountMachinePublisherService({
      getAccessToken: async () => "account-secret-token",
      getSnapshot: async () => {
        snapshotCalls += 1;
        if (snapshotCalls === 1) {
          markSnapshotEntered();
          await snapshotGate;
        }
        return routeSnapshot();
      },
      getMachineKey: () => "machine-studio",
      directoryBaseUrl: () => "https://directory.example",
      fetchImpl,
    });

    // Park a heartbeat PAST its early returns but before it reads the one-shot.
    const heartbeat = service.publishNow();
    await snapshotEntered;
    const pairing = service.publishPairing();
    releaseSnapshot();
    await heartbeat;
    await pairing;

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)).pairing).toBeUndefined();
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body)).pairing).toBe(true);
    service.dispose();
  });

  it("drops the pairing one-shot when the re-pair never reaches the send", async () => {
    // `publish` reads the one-shot only AFTER a long run of early returns, so a
    // re-pair abandoned before that point (here: no active sync scope) left the
    // intent armed. The very next 30-second heartbeat would then send
    // `pairing: true` plus the single-use grant on a request the user never
    // made — spending the grant and potentially clearing a revocation the
    // account owner had applied in the meantime.
    let hasSyncScope = false;
    const fetchImpl = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => new Response("{}", { status: 200 }));
    const consumePairingGrant = vi.fn<[], string | null>(() => "grant-from-directory");
    const service = createAccountMachinePublisherService({
      getAccessToken: async () => "account-secret-token",
      getSnapshot: async () => (hasSyncScope ? routeSnapshot() : null),
      getMachineKey: () => "machine-studio",
      consumePairingGrant,
      directoryBaseUrl: () => "https://directory.example",
      fetchImpl,
    });

    const result = await service.publishPairing();
    expect(result.published).toBe(false);
    expect(service.getPublisherHealth().state).toBe("no_active_sync_scope");
    expect(fetchImpl).not.toHaveBeenCalled();
    // Nothing was sent, so nothing may have been spent.
    expect(consumePairingGrant).not.toHaveBeenCalled();

    // The scope comes back and the ordinary heartbeat resumes. It must be a
    // plain heartbeat, not the pairing the failed call armed.
    hasSyncScope = true;
    await service.publishNow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body.pairing).toBeUndefined();
    expect(body.pairingGrant).toBeUndefined();
    expect(consumePairingGrant).not.toHaveBeenCalled();
    service.dispose();
  });

  it("spends a pairing grant only on the deliberate re-pair, and only once", async () => {
    const fetchImpl = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => new Response("{}", { status: 200 }));
    const consumePairingGrant = vi.fn<[], string | null>(() => "grant-from-directory");
    const service = createAccountMachinePublisherService({
      getAccessToken: async () => "account-secret-token",
      getSnapshot: async () => routeSnapshot(),
      getMachineKey: () => "machine-studio",
      consumePairingGrant,
      directoryBaseUrl: () => "https://directory.example",
      fetchImpl,
    });

    await service.publishNow();
    // A heartbeat has no use for a single-use proof, so it must never take one.
    expect(consumePairingGrant).not.toHaveBeenCalled();
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)).pairingGrant).toBeUndefined();

    consumePairingGrant.mockReturnValueOnce("grant-from-directory").mockReturnValue(null);
    await service.publishPairing();
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toMatchObject({
      pairing: true,
      pairingGrant: "grant-from-directory",
    });

    // The grant is gone after one spend: a second re-pair sends `pairing` alone
    // and falls back to whatever freshness the token itself can prove.
    await service.publishPairing();
    const second = JSON.parse(String(fetchImpl.mock.calls[2]?.[1]?.body));
    expect(second.pairing).toBe(true);
    expect(second.pairingGrant).toBeUndefined();
    service.dispose();
  });

  it("re-pairs without a grant when none was minted, and survives a throwing reader", async () => {
    const fetchImpl = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => new Response("{}", { status: 200 }));
    const service = createAccountMachinePublisherService({
      getAccessToken: async () => "account-secret-token",
      getSnapshot: async () => routeSnapshot(),
      getMachineKey: () => "machine-studio",
      consumePairingGrant: () => {
        throw new Error("credential store is unreadable");
      },
      directoryBaseUrl: () => "https://directory.example",
      fetchImpl,
    });

    await service.publishPairing();

    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body.pairing).toBe(true);
    expect(body.pairingGrant).toBeUndefined();
    service.dispose();
  });

  it("answers a refused re-pair with the action that fixes it", async () => {
    const fetchImpl = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => new Response(
      JSON.stringify({
        error: "Sign in again on this computer to reconnect it to your ADE account",
        code: "pairing_authentication_required",
        revokedAt: Date.parse("2026-07-05T11:00:00.000Z"),
      }),
      { status: 403, headers: { "content-type": "application/json" } },
    ));
    const service = createAccountMachinePublisherService({
      getAccessToken: async () => "account-secret-token",
      getSnapshot: async () => routeSnapshot(),
      getMachineKey: () => "machine-studio",
      directoryBaseUrl: () => "https://directory.example",
      fetchImpl,
    });

    const result = await service.publishPairing();

    expect(result).toMatchObject({
      published: false,
      revoked: true,
      reason: PAIRING_REAUTHENTICATION_REQUIRED_MESSAGE,
      // The discriminator callers branch on. `state` cannot separate the two
      // refusals — both are `http_error` — and `reason` is user-facing copy,
      // so rewording it must never be able to disable the recovery path.
      reasonCode: "pairing_authentication_required",
    });
    expect(result.state).toBe("http_error");
    // A 403 the machine cannot argue with is terminal for the heartbeat too:
    // retrying on a timer is what made removal non-durable in the first place.
    expect(service.getMachineRevocation()).toEqual({
      revoked: true,
      revokedAt: "2026-07-05T11:00:00.000Z",
    });
    await service.publishNow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    service.dispose();
  });

  it("stops publishing after a revoked machine response instead of retrying", async () => {
    const fetchImpl = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => new Response(
      JSON.stringify({ code: "machine_revoked", revokedAt: "2026-07-05T11:00:00.000Z" }),
      { status: 403, headers: { "content-type": "application/json" } },
    ));
    const warn = vi.fn();
    const service = createAccountMachinePublisherService({
      getAccessToken: async () => "account-secret-token",
      getSnapshot: async () => routeSnapshot(),
      getMachineKey: () => "machine-studio",
      directoryBaseUrl: () => "https://directory.example",
      fetchImpl,
      logger: { warn },
    });

    await service.publishNow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(service.getMachineRevocation()).toEqual({
      revoked: true,
      revokedAt: "2026-07-05T11:00:00.000Z",
    });
    expect(warn).toHaveBeenCalledWith(
      "account.machine_revoked",
      { revokedAt: "2026-07-05T11:00:00.000Z" },
    );
    const health = service.getPublisherHealth();
    expect(health.lastHttpStatus).toBe(403);
    expect(health.skipReason).toMatch(/removed from your ADE account/i);

    // Terminal: further heartbeats are no-ops, not retries.
    await service.publishNow();
    await service.publishNow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // A deliberate re-pair is the one thing that may try again.
    fetchImpl.mockResolvedValue(new Response("{}", { status: 200 }));
    const repair = await service.publishPairing();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body)).pairing).toBe(true);
    expect(service.getMachineRevocation().revoked).toBe(false);
    // An accepted re-pair carries no refusal code, so the code from the earlier
    // removal cannot leak forward and describe a success as a refusal.
    expect(repair.published).toBe(true);
    expect(repair.reasonCode).toBeUndefined();
    service.dispose();
  });

  it("names the refusal by code, distinctly for each of the two answers", async () => {
    const body = { code: "machine_revoked", revokedAt: "2026-07-05T11:00:00.000Z" };
    const fetchImpl = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => new Response(
      JSON.stringify(body),
      { status: 403, headers: { "content-type": "application/json" } },
    ));
    const service = createAccountMachinePublisherService({
      getAccessToken: async () => "account-secret-token",
      getSnapshot: async () => routeSnapshot(),
      getMachineKey: () => "machine-studio",
      directoryBaseUrl: () => "https://directory.example",
      fetchImpl,
    });

    const removed = await service.publishPairing();
    expect(removed).toMatchObject({
      published: false,
      state: "http_error",
      reasonCode: "machine_revoked",
    });
    // Same state, different code — which is the whole point of the field.
    expect(removed.reason).not.toBe(PAIRING_REAUTHENTICATION_REQUIRED_MESSAGE);
    service.dispose();
  });

  it("leaves the refusal code absent when the directory named no code it knows", async () => {
    // Anything that is not one of ADE's two refusals — a WAF 403, a 500, an
    // unrecognised future code — must read as "unknown", so a reader that has
    // not been taught the new vocabulary fails closed instead of guessing.
    const responses = [
      new Response(
        JSON.stringify({ error: "forbidden" }),
        { status: 403, headers: { "content-type": "application/json" } },
      ),
      new Response(
        JSON.stringify({ code: "pairing_grant_expired" }),
        { status: 403, headers: { "content-type": "application/json" } },
      ),
      new Response("nope", { status: 500 }),
    ];
    for (const response of responses) {
      const fetchImpl = vi.fn(async (
        _input: string | URL | Request,
        _init?: RequestInit,
      ) => response.clone());
      const service = createAccountMachinePublisherService({
        getAccessToken: async () => "account-secret-token",
        getSnapshot: async () => routeSnapshot(),
        getMachineKey: () => "machine-studio",
        directoryBaseUrl: () => "https://directory.example",
        fetchImpl,
      });
      const result = await service.publishPairing();
      expect(result.published).toBe(false);
      expect(result.reasonCode).toBeUndefined();
      expect("reasonCode" in result).toBe(false);
      service.dispose();
    }
  });

  it("treats a bare 403 as an ordinary failure, not a revocation", async () => {
    const fetchImpl = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => new Response(
      JSON.stringify({ error: "forbidden" }),
      { status: 403, headers: { "content-type": "application/json" } },
    ));
    const service = createAccountMachinePublisherService({
      getAccessToken: async () => "account-secret-token",
      getSnapshot: async () => routeSnapshot(),
      getMachineKey: () => "machine-studio",
      directoryBaseUrl: () => "https://directory.example",
      fetchImpl,
    });

    await service.publishNow();
    expect(service.getMachineRevocation().revoked).toBe(false);
    await service.publishNow();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    service.dispose();
  });

  it("ignores a development directory at the core publisher boundary when packaged", async () => {
    vi.stubEnv("ADE_RUNTIME_PACKAGED", "1");
    vi.stubEnv("ADE_ALLOW_DEVELOPMENT_CLERK", "");
    const fetchImpl = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => new Response(null, { status: 204 }));
    const service = createAccountMachinePublisherService({
      getAccessToken: async () => "account-secret-token",
      getSnapshot: async () => routeSnapshot(),
      getMachineKey: () => "machine-studio",
      directoryBaseUrl: () => `${DEVELOPMENT_ADE_ACCOUNT_DIRECTORY_URL}/tenant`,
      fetchImpl,
    });

    await service.publishNow();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      `${DEFAULT_ADE_ACCOUNT_DIRECTORY_URL}/account/machines/register`,
    );
  });

  it("never sends the bearer to an untrusted URL or logs it on failure", async () => {
    const fetchImpl = vi.fn(async () => new Response("no", { status: 503 }));
    const warn = vi.fn();
    const invalid = createAccountMachinePublisherService({
      getAccessToken: async () => "account-secret-token",
      getSnapshot: async () => routeSnapshot(),
      getMachineKey: () => "machine-studio",
      directoryBaseUrl: () => "http://directory.example",
      fetchImpl,
      logger: { warn },
    });
    await invalid.publishNow();
    expect(fetchImpl).not.toHaveBeenCalled();

    const failing = createAccountMachinePublisherService({
      getAccessToken: async () => "account-secret-token",
      getSnapshot: async () => routeSnapshot(),
      getMachineKey: () => "machine-studio",
      directoryBaseUrl: () => "https://directory.example",
      fetchImpl,
      logger: { warn },
    });
    await failing.publishNow();
    expect(JSON.stringify(warn.mock.calls)).not.toContain("account-secret-token");
  });

  it("contains synchronous machine-state failures and exposes the typed outcome", async () => {
    const warn = vi.fn();
    const service = createAccountMachinePublisherService({
      getAccessToken: async () => "account-secret-token",
      getSnapshot: async () => routeSnapshot(),
      getMachineKey: () => { throw new Error("machine identity unavailable"); },
      fetchImpl: vi.fn(),
      logger: { warn },
    });

    await expect(service.publishNow()).resolves.toBeUndefined();
    expect(service.getPublisherHealth()).toMatchObject({
      state: "machine_key_unavailable",
      skipReason: "The machine directory key is unavailable.",
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not send a heartbeat when disposal wins an async state lookup", async () => {
    let resolveSnapshot: ((value: AccountMachineRegistrationSnapshot) => void) | null = null;
    let markSnapshotRequested: (() => void) | null = null;
    const snapshotRequested = new Promise<void>((resolve) => {
      markSnapshotRequested = resolve;
    });
    const fetchImpl = vi.fn();
    const service = createAccountMachinePublisherService({
      getAccessToken: async () => "account-secret-token",
      getSnapshot: () => new Promise((resolve) => {
        resolveSnapshot = resolve;
        markSnapshotRequested?.();
      }),
      getMachineKey: () => "machine-studio",
      fetchImpl,
    });

    const publishing = service.publishNow();
    await snapshotRequested;
    service.dispose();
    resolveSnapshot!(routeSnapshot());
    await publishing;

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("coalesces overlapping heartbeats and keeps publishing on the bounded interval", async () => {
    vi.useFakeTimers();
    let resolveFetch: ((response: Response) => void) | null = null;
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    }));
    const service = createAccountMachinePublisherService({
      getAccessToken: async () => "token",
      getSnapshot: async () => routeSnapshot(),
      getMachineKey: () => "machine-studio",
      fetchImpl,
    });

    const first = service.publishNow();
    const overlapping = service.publishNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    resolveFetch!(new Response("{}", { status: 200 }));
    await Promise.all([first, overlapping]);

    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    resolveFetch!(new Response("{}", { status: 200 }));
    await vi.advanceTimersByTimeAsync(ACCOUNT_MACHINE_HEARTBEAT_MS);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    resolveFetch!(new Response("{}", { status: 200 }));
    service.dispose();
  });

  it("queues an identity-recovery publish after the current attempt", async () => {
    let resolveFetch: ((response: Response) => void) | null = null;
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    }));
    const service = createAccountMachinePublisherService({
      getAccessToken: async () => "token",
      getSnapshot: async () => routeSnapshot(),
      getMachineKey: () => "machine-studio",
      fetchImpl,
    });

    const first = service.publishNow();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    service.requestPublishAfterCurrentAttempt();
    resolveFetch!(new Response("{}", { status: 200 }));
    await first;
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    const second = service.publishNow();
    resolveFetch!(new Response("{}", { status: 200 }));
    await second;
    service.dispose();
  });
});

const analyticsFor = (capture: () => ((input: ProductAnalyticsCapture) => void) | undefined) =>
  createEpisodeAnalytics({
    event: "ade_publish_failing",
    dedupePrefix: "publish-failing",
    capture,
  });

describe("createEpisodeAnalytics", () => {
  it("reports once per episode no matter how often the condition is observed", () => {
    const capture = vi.fn();
    const episode = analyticsFor(() => capture);

    episode.report({ dedupeValue: 1, properties: { code: "http_error" } });
    episode.report({ dedupeValue: 1, properties: { code: "http_error" } });
    episode.report({ dedupeValue: 2, properties: { code: "token_timeout" } });

    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith({
      event: "ade_publish_failing",
      surface: "api",
      properties: { code: "http_error" },
      dedupeKey: "publish-failing:1",
      minimumIntervalMs: EPISODE_ANALYTICS_MINIMUM_INTERVAL_MS,
    });
  });

  it("re-arms only after the condition clears", () => {
    const capture = vi.fn();
    const episode = analyticsFor(() => capture);

    episode.report({ dedupeValue: "first", properties: {} });
    episode.end();
    episode.report({ dedupeValue: "second", properties: {} });
    // A repeated clear must not open a second report inside the same episode.
    episode.end();
    episode.end();
    episode.report({ dedupeValue: "third", properties: {} });
    episode.report({ dedupeValue: "fourth", properties: {} });

    expect(capture.mock.calls.map(([input]) => input.dedupeKey)).toEqual([
      "publish-failing:first",
      "publish-failing:second",
      "publish-failing:third",
    ]);
  });

  it("reads the capture handler at report time, not at construction", () => {
    // The publisher builds its episodes before its options are necessarily
    // wired up; a handler snapshotted at construction would drop every event.
    let capture: ((input: ProductAnalyticsCapture) => void) | undefined;
    const episode = analyticsFor(() => capture);

    episode.report({ dedupeValue: "missed", properties: {} });
    const late = vi.fn();
    capture = late;
    episode.end();
    episode.report({ dedupeValue: "seen", properties: {} });

    expect(late).toHaveBeenCalledTimes(1);
    expect(late.mock.calls[0]?.[0].dedupeKey).toBe("publish-failing:seen");
  });

  it("still consumes the episode when no capture handler is configured", () => {
    // An absent handler must not leave the episode armed: once the handler
    // appears mid-episode it would emit for a failure already in progress.
    let capture: ((input: ProductAnalyticsCapture) => void) | undefined;
    const episode = analyticsFor(() => capture);

    episode.report({ dedupeValue: "in-progress", properties: {} });
    const late = vi.fn();
    capture = late;
    episode.report({ dedupeValue: "in-progress", properties: {} });

    expect(late).not.toHaveBeenCalled();
  });

  it("swallows a throwing capture and still consumes the episode", () => {
    // A synchronous capture failure escaping here would surface as the
    // publisher's transport_error instead of the real token_unreadable
    // outcome, hiding the repair path from the user.
    const capture = vi.fn(() => { throw new Error("posthog exploded"); });
    const episode = analyticsFor(() => capture);

    expect(() => episode.report({ dedupeValue: "boom", properties: {} })).not.toThrow();
    episode.report({ dedupeValue: "boom", properties: {} });

    expect(capture).toHaveBeenCalledTimes(1);
  });
});
