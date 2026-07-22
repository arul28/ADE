import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SYNC_COMPACT_INVALIDATION_V1_CAPABILITY,
  SYNC_INVALIDATION_TABLE_MAX_BYTES,
  SYNC_INVALIDATION_ONLY_V1_CAPABILITY,
  type SyncBrainStatusPayload,
  type SyncEnvelope,
  type SyncFeatureFlags,
  type SyncHelloOkPayload,
  type SyncPairingQrPayload,
  type SyncPeerMetadata,
} from "../../../../shared/types/sync";
import type { AdeAccountMachine } from "../../../../shared/types/account";
import { AdeSyncClient } from "../client";
import {
  BACKOFF_STABLE_CONNECTED_MS,
  INVALIDATION_ONLY_V1_HOST_UPDATE_MESSAGE,
  RELAY_READY_NEGOTIATION_WINDOW_MS,
  SyncConnection,
  type WebSocketLike,
} from "../connection";
import { deriveBrowserSyncEndpoints } from "../endpoints";
import {
  IndexedDbOpenError,
  IndexedDbStorage,
  MemoryStorage,
  WEB_TRUST_RESET_VERSION,
  WebClientEnvStore,
  type WebClientEnvironmentRecord,
  type WebClientStorageArea,
  type WebClientStorageTransaction,
} from "../envStore";
import { WebRelayAuthRequiredError, type WebRelayAccess } from "../relayPolicy";
import {
  generateDpopKeyPair,
  exportPublicKeyX963Base64,
  rawEcdsaSignatureToDer,
  signDpopProof,
  signRelayReauthorizationProof,
} from "../dpop";
import { randomHex } from "../ids";
import {
  assembleProjectCatalogChunks,
  decodeEnvelopeText,
  encodeEnvelopeText,
  MAX_UNCOMPRESSED_SYNC_ENVELOPE_BYTES,
} from "../wireProtocol";
import {
  createSyncDpopNonceCache,
  verifySyncDpopProof,
} from "../../../../../../ade-cli/src/services/sync/syncDpop";
import {
  encodeSyncEnvelope,
  parseSyncEnvelope,
} from "../../../../../../ade-cli/src/services/sync/syncProtocol";
import { verifyRelayReauthorizationProof } from "../../../../../../ade-cli/src/services/sync/relayAuthorization";
import {
  accountLeaseOwnerForActiveConnection,
  reconcileActiveAccountLease,
} from "../../account/leaseMonitor";

const hostPeer: SyncPeerMetadata = {
  deviceId: "host-device",
  deviceName: "Studio Mac",
  platform: "macOS",
  deviceType: "desktop",
  siteId: "host-site",
  dbVersion: 12,
  capabilities: [],
};

const features: SyncFeatureFlags = {
  fileAccess: true,
  terminalStreaming: true,
  chatStreaming: { enabled: true },
  invalidationOnlyV1: { enabled: true },
  compactInvalidationV1: { enabled: true },
  projectCatalog: { enabled: true },
  projectActions: { enabled: true },
  changesetAck: { enabled: true },
  bootstrapAuth: true,
  pairingAuth: { enabled: true, pinDigits: 6 },
  commandRouting: {
    mode: "allowlisted",
    supportedActions: ["chat.send"],
    actions: [
      {
        action: "chat.send",
        scope: "project",
        policy: { viewerAllowed: true },
      },
    ],
  },
};

const pairingPayload: SyncPairingQrPayload = {
  version: 3,
  hostIdentity: {
    deviceId: hostPeer.deviceId,
    siteId: hostPeer.siteId,
    name: hostPeer.deviceName,
    platform: "macOS",
    deviceType: "desktop",
  },
  port: 8787,
  relayUrl: "wss://relay.example/connect/machine-key",
  addressCandidates: [
    { host: "192.168.1.10", kind: "lan" },
    { host: "100.64.0.2", kind: "tailscale" },
  ],
};

const signedInRelayAccess: WebRelayAccess = {
  kind: "signed_in",
  userId: "account-user-1",
  hostDeviceIds: [hostPeer.deviceId],
  getAccessToken: async () => "relay-account-token",
};

const currentAccountSessionLease = {
  userId: "account-user-1",
  generation: 1,
};

function helloOk(projectId = "project-1"): SyncHelloOkPayload {
  return {
    peer: hostPeer,
    brain: hostPeer,
    serverDbVersion: 12,
    serverDbSiteId: "server-site",
    heartbeatIntervalMs: 30_000,
    pollIntervalMs: 400,
    projects: [
      {
        id: projectId,
        displayName: "ADE",
        rootPath: "/repo",
        defaultBaseRef: "main",
        lastOpenedAt: null,
        laneCount: 1,
        isAvailable: true,
        isCached: true,
        isOpen: true,
      },
    ],
    features,
  };
}

function legacyHelloOk(projectId = "project-1"): SyncHelloOkPayload {
  const payload = helloOk(projectId);
  const { invalidationOnlyV1: _ignored, ...featuresWithoutAcceptance } = payload.features;
  return {
    ...payload,
    features: featuresWithoutAcceptance,
  };
}

function changesetHintHelloOk(projectId = "project-1"): SyncHelloOkPayload {
  const payload = helloOk(projectId);
  const { compactInvalidationV1: _ignored, ...featuresWithoutCompactInvalidation } = payload.features;
  return {
    ...payload,
    features: featuresWithoutCompactInvalidation,
  };
}

function relayHelloOk(nowMs: number, options: {
  refreshAfterMs?: number;
  expiresAfterMs?: number;
  challenge?: string;
} = {}): SyncHelloOkPayload {
  return {
    ...helloOk(),
    relayAuthorization: {
      expiresAt: nowMs + (options.expiresAfterMs ?? 60_000),
      refreshAfter: nowMs + (options.refreshAfterMs ?? 1_000),
      challenge: options.challenge ?? "relay-challenge-1",
      graceMs: 10_000,
    },
  };
}

const relayReauthorizationSigner = vi.fn(async () => ({
  timestamp: Math.floor(Date.now() / 1_000),
  nonce: "relay-reauth-test-nonce",
  signature: "relay-reauth-test-signature",
}));

function helloOkWithoutProjects(): SyncHelloOkPayload {
  const payload = helloOk();
  delete payload.projects;
  return payload;
}

function helloOkWithTerminalInputAck(
  projectId = "project-1",
  retryWindowMs?: number,
): SyncHelloOkPayload {
  const payload = helloOk(projectId);
  return {
    ...payload,
    features: {
      ...payload.features,
      terminalInputAck: {
        enabled: true,
        ...(retryWindowMs ? { retryWindowMs } : {}),
      },
    },
  } as SyncHelloOkPayload;
}

class ScriptedSocket implements WebSocketLike {
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly sent: SyncEnvelope[] = [];
  readonly closeHistory: Array<{ code: number; reason: string }> = [];
  closedWith: { code: number; reason: string } | null = null;

  constructor(
    readonly url: string,
    private readonly onClientEnvelope: (socket: ScriptedSocket, envelope: SyncEnvelope) => void | Promise<void>,
    openDelayMs = 0,
  ) {
    setTimeout(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.onopen?.(new Event("open"));
    }, openDelayMs);
  }

  send(data: string): void {
    void decodeEnvelopeText(data).then(async (envelope) => {
      this.sent.push(envelope);
      await this.onClientEnvelope(this, envelope);
    });
  }

  close(code = 1000, reason = ""): void {
    this.closedWith = { code, reason };
    this.closeHistory.push(this.closedWith);
    this.readyState = 3;
    this.onclose?.({ code, reason } as CloseEvent);
  }

  serverSend(input: Parameters<typeof encodeEnvelopeText>[0]): void {
    this.onmessage?.({ data: encodeEnvelopeText(input) } as MessageEvent<string>);
  }

  serverTransportSend(input: unknown): void {
    this.onmessage?.({ data: JSON.stringify(input) } as MessageEvent<string>);
  }
}

function createSocketFactory(
  handler: (socket: ScriptedSocket, envelope: SyncEnvelope) => void | Promise<void>,
  options: { openDelayMs?: number | ((socketIndex: number) => number) } = {},
) {
  const sockets: ScriptedSocket[] = [];
  return {
    sockets,
    factory(url: string): WebSocketLike {
      const socketIndex = sockets.length;
      const openDelayMs = typeof options.openDelayMs === "function"
        ? options.openDelayMs(socketIndex)
        : options.openDelayMs;
      const socket = new ScriptedSocket(url, handler, openDelayMs);
      sockets.push(socket);
      return socket;
    },
  };
}

class VisibilityDocument {
  visibilityState: DocumentVisibilityState = "visible";
  private readonly listeners = new Set<() => void>();

  readonly document = {
    get visibilityState() {
      return (this as { owner: VisibilityDocument }).owner.visibilityState;
    },
    owner: this,
    addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
      if (typeof listener === "function") this.listeners.add(listener as () => void);
    },
    removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
      if (typeof listener === "function") this.listeners.delete(listener as () => void);
    },
  } as unknown as Document;

  setVisibility(state: DocumentVisibilityState): void {
    this.visibilityState = state;
    for (const listener of this.listeners) listener();
  }
}

class DelayedPutStorage extends MemoryStorage {
  delayNextEnvironmentPut = false;
  private pausedPut: Promise<void> | null = null;
  private resolvePausedPut: (() => void) | null = null;
  private resumePut: (() => void) | null = null;

  override async put<T>(area: "environments" | "meta", key: string, value: T): Promise<void> {
    if (area === "environments" && this.delayNextEnvironmentPut) {
      this.delayNextEnvironmentPut = false;
      this.pausedPut = new Promise((resolve) => {
        this.resolvePausedPut = resolve;
      });
      await new Promise<void>((resolve) => {
        this.resumePut = resolve;
        this.resolvePausedPut?.();
      });
    }
    await super.put(area, key, value);
  }

  async waitForPausedPut(): Promise<void> {
    while (!this.pausedPut) await flush();
    await this.pausedPut;
  }

  resumePausedPut(): void {
    this.resumePut?.();
  }
}

class TransactionCountingStorage extends MemoryStorage {
  readonly transactions: Array<{ areas: WebClientStorageArea[]; mode: IDBTransactionMode }> = [];

  override async transaction<T>(
    areas: WebClientStorageArea[],
    mode: IDBTransactionMode,
    operation: (transaction: WebClientStorageTransaction) => Promise<T>,
  ): Promise<T> {
    this.transactions.push({ areas: [...areas], mode });
    return await super.transaction(areas, mode, operation);
  }

  resetTransactions(): void {
    this.transactions.length = 0;
  }
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

function completeRelayReadyV2(socket: ScriptedSocket | undefined): void {
  socket?.serverTransportSend({ t: "accepted", v: 2 });
  socket?.serverTransportSend({ t: "ready", v: 2 });
}

async function completeRelayReadyV2AfterOpen(
  sockets: ScriptedSocket[],
  socketIndex: number,
): Promise<ScriptedSocket> {
  for (let attempt = 0; attempt < 20 && sockets[socketIndex]?.readyState !== 1; attempt += 1) {
    await flush();
  }
  const socket = sockets[socketIndex];
  if (!socket || socket.readyState !== 1) throw new Error(`Relay test socket ${socketIndex} did not open.`);
  completeRelayReadyV2(socket);
  return socket;
}

async function makeEnvironment(storage: MemoryStorage, overrides: Partial<WebClientEnvironmentRecord> = {}): Promise<WebClientEnvironmentRecord> {
  const keys = await generateDpopKeyPair();
  const environment: WebClientEnvironmentRecord = {
    envId: overrides.envId ?? "env-1",
    machineName: "Studio Mac",
    hostDeviceId: hostPeer.deviceId,
    relayUrl: "wss://relay.example/connect/machine-key",
    addressCandidates: pairingPayload.addressCandidates,
    port: 8787,
    pairedDeviceId: "browser-device",
    secret: "paired-secret",
    dpopKeys: keys,
    dpopPublicKeyX963: await exportPublicKeyX963Base64(keys.publicKey),
    siteId: randomHex(16),
    localDeviceId: "browser-device",
    localDeviceName: "Browser",
    createdAt: new Date().toISOString(),
    lastGoodEndpoint: "wss://relay.example/connect/machine-key",
    activeProjectId: "project-1",
    ...overrides,
  };
  await new WebClientEnvStore(storage).saveEnvironment(environment);
  return environment;
}

describe("browser sync DPoP", () => {
  it("produces proofs accepted by the real host verifier", async () => {
    const keys = await generateDpopKeyPair({ extractable: true });
    const publicKey = await exportPublicKeyX963Base64(keys.publicKey);
    const proof = await signDpopProof({
      privateKey: keys.privateKey,
      publicKeyX963Base64: publicKey,
      deviceId: "browser-device",
      secret: "paired-secret",
      nowSeconds: 1_700_000_000,
      nonce: "nonce-1",
    });
    const nonceCache = createSyncDpopNonceCache();

    expect(verifySyncDpopProof({
      publicKeyX963Base64: publicKey,
      deviceId: "browser-device",
      secret: "paired-secret",
      proof,
      nowSeconds: 1_700_000_001,
      checkAndRecordNonce: (nonce) => nonceCache.checkAndRecord("browser-device", nonce),
    })).toEqual({ ok: true });
    expect(verifySyncDpopProof({
      publicKeyX963Base64: publicKey,
      deviceId: "browser-device",
      secret: "paired-secret",
      proof,
      nowSeconds: 1_700_000_001,
      checkAndRecordNonce: (nonce) => nonceCache.checkAndRecord("browser-device", nonce),
    })).toEqual({ ok: false, reason: "replayed_nonce" });
    expect(verifySyncDpopProof({
      publicKeyX963Base64: publicKey,
      deviceId: "browser-device",
      secret: "wrong-secret",
      proof,
      nowSeconds: 1_700_000_001,
    })).toEqual({ ok: false, reason: "invalid_signature" });
    expect(verifySyncDpopProof({
      publicKeyX963Base64: publicKey,
      deviceId: "browser-device",
      secret: "paired-secret",
      proof,
      nowSeconds: 1_700_001_000,
    })).toEqual({ ok: false, reason: "stale_timestamp" });
  });

  it("binds Relay refresh proofs to the exact token bytes and host challenge", async () => {
    const keys = await generateDpopKeyPair({ extractable: true });
    const publicKey = await exportPublicKeyX963Base64(keys.publicKey);
    const relayAccountToken = " token-with-exact-bytes ";
    const proof = await signRelayReauthorizationProof({
      privateKey: keys.privateKey,
      deviceId: "browser-device",
      relayAccountToken,
      challenge: "host-connection-challenge",
      nowSeconds: 1_700_000_000,
      nonce: "relay-nonce-1",
    });

    expect(verifyRelayReauthorizationProof({
      publicKeyX963Base64: publicKey,
      deviceId: "browser-device",
      relayAccountToken,
      challenge: "host-connection-challenge",
      proof,
      nowSeconds: 1_700_000_001,
    })).toEqual({ ok: true });
    expect(verifyRelayReauthorizationProof({
      publicKeyX963Base64: publicKey,
      deviceId: "browser-device",
      relayAccountToken: relayAccountToken.trim(),
      challenge: "host-connection-challenge",
      proof,
      nowSeconds: 1_700_000_001,
    })).toEqual({ ok: false, reason: "invalid_signature" });
    expect(verifyRelayReauthorizationProof({
      publicKeyX963Base64: publicKey,
      deviceId: "browser-device",
      relayAccountToken,
      challenge: "different-connection-challenge",
      proof,
      nowSeconds: 1_700_000_001,
    })).toEqual({ ok: false, reason: "invalid_signature" });
  });

  it("DER-encodes high-bit and leading-zero P-256 signature integers", () => {
    const raw = new Uint8Array(64);
    raw[0] = 0x80;
    raw[31] = 0x01;
    raw[32] = 0x00;
    raw[33] = 0x00;
    raw[63] = 0x7f;

    const der = rawEcdsaSignatureToDer(raw);

    expect(Array.from(der.slice(0, 4))).toEqual([0x30, 0x26, 0x02, 0x21]);
    expect(der[4]).toBe(0x00);
    expect(der[37]).toBe(0x02);
    expect(der[38]).toBe(0x01);
    expect(der[39]).toBe(0x7f);
  });
});

describe("browser sync envelope codec", () => {
  it("round-trips browser-encoded envelopes through the real host parser", () => {
    const text = encodeEnvelopeText({
      type: "command",
      requestId: "cmd-1",
      projectId: "project-1",
      payload: {
        commandId: "cmd-1",
        action: "chat.send",
        args: { text: "hello" },
      },
    });

    const parsed = parseSyncEnvelope(text);

    expect(parsed.version).toBe(1);
    expect(parsed.type).toBe("command");
    expect(parsed.projectId).toBe("project-1");
    expect(parsed.requestId).toBe("cmd-1");
    expect(parsed.payload).toEqual({
      commandId: "cmd-1",
      action: "chat.send",
      args: { text: "hello" },
    });
  });

  it("inflates host gzip envelopes and rejects oversize declarations", async () => {
    const text = encodeSyncEnvelope({
      type: "project_catalog",
      payload: {
        projects: [
          {
            id: "project-1",
            displayName: "A".repeat(5_000),
            rootPath: "/repo",
            defaultBaseRef: null,
            lastOpenedAt: null,
            laneCount: 0,
            isAvailable: true,
            isCached: true,
            isOpen: true,
          },
        ],
      },
    });

    const decoded = await decodeEnvelopeText(text);

    expect(decoded.type).toBe("project_catalog");
    expect(decoded.compression).toBe("none");
    expect(decoded.payloadEncoding).toBe("json");
    expect((decoded.payload as { projects: Array<{ displayName: string }> }).projects[0].displayName).toHaveLength(5_000);

    const oversized = JSON.stringify({
      version: 1,
      type: "project_catalog",
      requestId: null,
      compression: "gzip",
      payloadEncoding: "base64",
      payload: gzipSync(Buffer.from("{}", "utf8")).toString("base64"),
      uncompressedBytes: MAX_UNCOMPRESSED_SYNC_ENVELOPE_BYTES + 1,
    });
    await expect(decodeEnvelopeText(oversized)).rejects.toThrow("exceeds");
  });

  it("assembles project catalog chunks in index order", () => {
    const assembled = assembleProjectCatalogChunks([
      {
        catalogId: "catalog",
        index: 1,
        total: 2,
        done: true,
        projects: [{ ...helloOk().projects![0], id: "project-2" }],
      },
      {
        catalogId: "catalog",
        index: 0,
        total: 2,
        done: false,
        projects: [{ ...helloOk().projects![0], id: "project-1" }],
      },
    ]);

    expect(assembled?.projects.map((project) => project.id)).toEqual(["project-1", "project-2"]);
  });
});

describe("browser sync endpoints and storage", () => {
  it("orders relay and browser-safe endpoints while marking HTTPS plain ws routes undialable", () => {
    const endpoints = deriveBrowserSyncEndpoints({
      payload: pairingPayload,
      location: { protocol: "https:", hostname: "app.ade-app.dev" },
    });

    expect(endpoints.filter((candidate) => candidate.dialable).map((candidate) => candidate.url)).toEqual([
      "wss://relay.example/connect/machine-key",
    ]);
    expect(endpoints.find((candidate) => candidate.url === "ws://127.0.0.1:8787")?.reason).toBe("loopback_blocked_from_https");
    expect(endpoints.find((candidate) => candidate.url === "ws://192.168.1.10:8787")?.reason).toBe("plain_ws_blocked_from_https");
  });

  it("allows loopback candidates from local browser pages", () => {
    const endpoints = deriveBrowserSyncEndpoints({
      payload: pairingPayload,
      location: { protocol: "http:", hostname: "localhost" },
    });

    expect(endpoints.find((candidate) => candidate.url === "ws://127.0.0.1:8787")?.dialable).toBe(true);
    expect(endpoints.find((candidate) => candidate.url === "ws://localhost:8787")?.dialable).toBe(true);
  });

  it("round-trips environments and selected env metadata in memory storage", async () => {
    const storage = new MemoryStorage();
    const store = new WebClientEnvStore(storage);
    const environment = await makeEnvironment(storage);

    await store.setSelectedEnvId(environment.envId);

    expect(await store.getSelectedEnvId()).toBe(environment.envId);
    expect(await store.findByHostDeviceId(hostPeer.deviceId)).toMatchObject({
      envId: environment.envId,
      secret: "paired-secret",
    });
    expect(await store.listEnvironments()).toHaveLength(1);
  });

  it("rejects blocked IndexedDB opens with a typed error and permits retry", async () => {
    const open = vi.fn(() => {
      const request = {} as IDBOpenDBRequest;
      setTimeout(() => request.onblocked?.(new Event("blocked") as IDBVersionChangeEvent), 0);
      return request;
    });
    vi.stubGlobal("indexedDB", { open });
    try {
      const storage = new IndexedDbStorage({
        openTimeoutMs: 100,
        upgradeBlockedTimeoutMs: 10,
      });

      await expect(storage.list("environments")).rejects.toEqual(expect.objectContaining({
        name: "IndexedDbOpenError",
        code: "blocked",
      }));
      await expect(storage.list("environments")).rejects.toBeInstanceOf(IndexedDbOpenError);
      expect(open).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reopens IndexedDB and reruns the trust reset after versionchange", async () => {
    const firstEnvironment = await makeEnvironment(new MemoryStorage(), { envId: "first" });
    const secondEnvironment = await makeEnvironment(new MemoryStorage(), { envId: "second" });
    const transactions: IDBTransactionMode[][] = [[], []];

    const successfulRequest = <T,>(value: T): IDBRequest<T> => {
      const request = { result: value } as IDBRequest<T>;
      queueMicrotask(() => request.onsuccess?.(new Event("success")));
      return request;
    };
    const databases = [[firstEnvironment], [secondEnvironment]].map((environments, index) => ({
      close: vi.fn(),
      objectStoreNames: { contains: () => true },
      onversionchange: null,
      transaction: (_areas: string[], mode: IDBTransactionMode) => {
        transactions[index].push(mode);
        const transaction = {
          abort: vi.fn(),
          error: null,
          objectStore: (area: WebClientStorageArea) => ({
            delete: vi.fn(),
            get: () => successfulRequest(
              area === "meta" ? WEB_TRUST_RESET_VERSION : undefined,
            ),
            getAll: () => successfulRequest(environments),
            put: vi.fn(),
          }),
          onabort: null,
          oncomplete: null,
          onerror: null,
        } as unknown as IDBTransaction;
        setTimeout(() => transaction.oncomplete?.(new Event("complete")), 0);
        return transaction;
      },
    })) as unknown as IDBDatabase[];
    let nextDatabase = 0;
    const open = vi.fn(() => {
      const request = { result: databases[nextDatabase++] } as IDBOpenDBRequest;
      setTimeout(() => request.onsuccess?.(new Event("success")), 0);
      return request;
    });
    vi.stubGlobal("indexedDB", { open });

    try {
      const storage = new IndexedDbStorage({ openTimeoutMs: 100 });
      const store = new WebClientEnvStore(storage);

      await expect(store.listEnvironments()).resolves.toEqual([firstEnvironment]);
      databases[0].onversionchange?.(new Event("versionchange") as IDBVersionChangeEvent);
      await expect(store.listEnvironments()).resolves.toEqual([secondEnvironment]);

      expect(open).toHaveBeenCalledTimes(2);
      expect(databases[0].close).toHaveBeenCalledOnce();
      expect(transactions).toEqual([
        ["readwrite", "readonly"],
        ["readwrite", "readonly"],
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("times out an IndexedDB open that never settles", async () => {
    vi.stubGlobal("indexedDB", {
      open: vi.fn(() => ({} as IDBOpenDBRequest)),
    });
    try {
      const storage = new IndexedDbStorage({ openTimeoutMs: 5 });

      await expect(storage.list("environments")).rejects.toEqual(expect.objectContaining({
        name: "IndexedDbOpenError",
        code: "timeout",
      }));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("batches the one-time trust reset into one readwrite transaction", async () => {
    const storage = new TransactionCountingStorage();
    await storage.put("environments", "legacy", await makeEnvironment(new MemoryStorage(), {
      envId: "legacy",
    }));
    await storage.put("meta", "selectedEnvId", "legacy");
    await storage.delete("meta", "machineTrustResetVersion");
    storage.resetTransactions();

    const store = new WebClientEnvStore(storage);
    await expect(store.listEnvironments()).resolves.toEqual([]);

    expect(storage.transactions.filter((transaction) => transaction.mode === "readwrite")).toEqual([{
      areas: ["environments", "meta"],
      mode: "readwrite",
    }]);
    await expect(storage.get("meta", "machineTrustResetVersion")).resolves.toBe(WEB_TRUST_RESET_VERSION);
  });

  it("prunes account records and returns survivors from one readwrite transaction", async () => {
    const storage = new TransactionCountingStorage();
    const store = new WebClientEnvStore(storage);
    await store.saveEnvironment(await makeEnvironment(new MemoryStorage(), {
      envId: "local",
      accountOwnerUserId: null,
    }));
    await store.saveEnvironment(await makeEnvironment(new MemoryStorage(), {
      envId: "current",
      accountOwnerUserId: "account-current",
    }));
    await store.saveEnvironment(await makeEnvironment(new MemoryStorage(), {
      envId: "foreign",
      accountOwnerUserId: "account-previous",
    }));
    await store.setSelectedEnvId("foreign");
    storage.resetTransactions();

    const result = await store.pruneAccountOwnedEnvironments("account-current");

    expect(result.removedIds).toEqual(["foreign"]);
    expect(result.environments.map((environment) => environment.envId).sort()).toEqual([
      "current",
      "local",
    ]);
    expect(storage.transactions).toEqual([{
      areas: ["environments", "meta"],
      mode: "readwrite",
    }]);
    await expect(store.getSelectedEnvId()).resolves.toBeNull();
  });
});

describe("browser sync connection and client", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("rejects a saved browser pairing when the host only supports legacy changeset hints", async () => {
    const environment = await makeEnvironment(new MemoryStorage(), { dpopPublicKeyX963: null });
    vi.useFakeTimers();
    const script = createSocketFactory((socket, envelope) => {
      if (envelope.type === "hello") {
        socket.serverSend({ type: "hello_ok", requestId: envelope.requestId, payload: changesetHintHelloOk() });
      }
    });
    const connection = new SyncConnection({ socketFactory: script.factory, document: null });

    const outcome = connection.connect(environment, [
      { url: "ws://127.0.0.1:8787", kind: "loopback", dialable: true },
      { url: "ws://127.0.0.1:8788", kind: "loopback", dialable: true },
    ]).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    await expect(outcome).resolves.toMatchObject({
      code: "invalidation_only_v1_unsupported",
      message: INVALIDATION_ONLY_V1_HOST_UPDATE_MESSAGE,
    });

    expect(script.sockets).toHaveLength(1);
    expect(script.sockets[0]?.closeHistory).toContainEqual({ code: 4000, reason: "Incompatible ADE host" });
    expect(connection.getStatus()).toMatchObject({
      state: "error",
      error: INVALIDATION_ONLY_V1_HOST_UPDATE_MESSAGE,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(script.sockets).toHaveLength(1);
    connection.dispose();
  });

  it("rejects account adoption before creating trust when the host is too old", async () => {
    const environment = await makeEnvironment(new MemoryStorage(), { dpopPublicKeyX963: null });
    vi.useFakeTimers();
    const buildEnvironment = vi.fn(() => environment);
    const script = createSocketFactory((socket, envelope) => {
      if (envelope.type === "hello") {
        const peer = (envelope.payload as { peer: SyncPeerMetadata }).peer;
        socket.serverSend({
          type: "hello_ok",
          requestId: envelope.requestId,
          payload: {
            ...legacyHelloOk(),
            accountPairing: { deviceId: peer.deviceId, secret: "new-pairing-secret" },
          },
        });
      }
    });
    const connection = new SyncConnection({ socketFactory: script.factory, document: null });

    const outcome = connection.pairWithAccount({
      endpoints: [
        { url: "ws://127.0.0.1:8787", kind: "loopback", dialable: true },
        { url: "ws://127.0.0.1:8788", kind: "loopback", dialable: true },
      ],
      peer: { ...hostPeer, deviceId: "new-browser-device", deviceType: "browser" },
      accountToken: "account-token",
      createDpop: async () => ({ timestamp: 1, nonce: "nonce", signature: "signature" }),
      expectedHostDeviceId: hostPeer.deviceId,
      existingPairing: null,
      buildEnvironment,
    }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    await expect(outcome).resolves.toMatchObject({
      code: "invalidation_only_v1_unsupported",
      message: INVALIDATION_ONLY_V1_HOST_UPDATE_MESSAGE,
    });

    expect(buildEnvironment).not.toHaveBeenCalled();
    expect(script.sockets).toHaveLength(1);
    expect(script.sockets[0]?.closeHistory).toContainEqual({ code: 4000, reason: "Incompatible ADE host" });
    expect(connection.getStatus()).toMatchObject({
      state: "error",
      error: INVALIDATION_ONLY_V1_HOST_UPDATE_MESSAGE,
    });
    connection.dispose();
  });

  it("retries an old Worker on a fresh legacy socket without sending hello on ready-v2", async () => {
    const environment = await makeEnvironment(new MemoryStorage(), { dpopPublicKeyX963: null });
    vi.useFakeTimers();
    const script = createSocketFactory((socket, envelope) => {
      if (envelope.type === "hello") {
        socket.serverSend({ type: "hello_ok", requestId: envelope.requestId, payload: helloOk() });
      }
    });
    const connection = new SyncConnection({ socketFactory: script.factory, document: null });

    const connecting = connection.connect(
      environment,
      [{ url: pairingPayload.relayUrl!, kind: "relay", dialable: true }],
      async () => "relay-account-token",
    );
    await vi.advanceTimersByTimeAsync(RELAY_READY_NEGOTIATION_WINDOW_MS - 1);
    expect(script.sockets[0]?.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();

    await connecting;
    expect(script.sockets).toHaveLength(2);
    expect(script.sockets[0]?.sent).toEqual([]);
    expect(script.sockets[0]?.url).toContain("ready=2");
    expect(script.sockets[0]?.closedWith?.reason).toBe("Relay readiness negotiation timeout");
    expect(script.sockets[1]?.url).toBe(pairingPayload.relayUrl);
    expect(script.sockets[1]?.sent.map((envelope) => envelope.type)).toEqual(["hello"]);
    connection.dispose();
  });

  it("ignores a late accepted frame on the abandoned ready-v2 socket and uses only the fresh legacy socket", async () => {
    const environment = await makeEnvironment(new MemoryStorage(), { dpopPublicKeyX963: null });
    vi.useFakeTimers();
    const script = createSocketFactory((socket, envelope) => {
      if (envelope.type === "hello") {
        socket.serverSend({ type: "hello_ok", requestId: envelope.requestId, payload: helloOk() });
      }
    });
    const connection = new SyncConnection({ socketFactory: script.factory, document: null });

    const connecting = connection.connect(
      environment,
      [{ url: pairingPayload.relayUrl!, kind: "relay", dialable: true }],
      async () => "relay-account-token",
    );
    await vi.advanceTimersByTimeAsync(RELAY_READY_NEGOTIATION_WINDOW_MS);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(script.sockets).toHaveLength(2);

    script.sockets[0]?.serverTransportSend({ t: "accepted", v: 2 });
    script.sockets[0]?.serverTransportSend({ t: "ready", v: 2 });
    await connecting;

    expect(script.sockets[0]?.sent).toEqual([]);
    expect(script.sockets[1]?.sent.map((envelope) => envelope.type)).toEqual(["hello"]);
    connection.dispose();
  });

  it("uses the same fresh-socket legacy fallback for Relay account pairing", async () => {
    const environment = await makeEnvironment(new MemoryStorage(), { dpopPublicKeyX963: null });
    vi.useFakeTimers();
    const script = createSocketFactory((socket, envelope) => {
      if (envelope.type !== "hello") return;
      const peer = (envelope.payload as { peer: SyncPeerMetadata }).peer;
      socket.serverSend({
        type: "hello_ok",
        requestId: envelope.requestId,
        payload: {
          ...helloOk(),
          accountPairing: { deviceId: peer.deviceId, secret: "paired-secret" },
        },
      });
    });
    const connection = new SyncConnection({ socketFactory: script.factory, document: null });

    const pairing = connection.pairWithAccount({
      endpoints: [{ url: pairingPayload.relayUrl!, kind: "relay", dialable: true }],
      peer: { ...hostPeer, deviceId: "fallback-browser", deviceType: "browser" },
      accountToken: "account-token",
      createDpop: async () => ({ timestamp: 1, nonce: "nonce", signature: "signature" }),
      expectedHostDeviceId: hostPeer.deviceId,
      existingPairing: null,
      buildEnvironment: () => environment,
    });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(RELAY_READY_NEGOTIATION_WINDOW_MS);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();

    script.sockets[0]?.serverTransportSend({ t: "accepted", v: 2 });
    script.sockets[0]?.serverTransportSend({ t: "ready", v: 2 });
    await expect(pairing).resolves.toMatchObject({ endpoint: pairingPayload.relayUrl });

    expect(script.sockets).toHaveLength(2);
    expect(script.sockets[0]?.url).toContain("ready=2");
    expect(script.sockets[0]?.sent).toEqual([]);
    expect(script.sockets[1]?.url).toBe(pairingPayload.relayUrl);
    expect(script.sockets[1]?.sent.map((envelope) => envelope.type)).toEqual(["hello"]);
    connection.dispose();
  });

  it("waits after accepted for a slow new-Worker pipe and consumes accepted/ready as transport frames", async () => {
    const environment = await makeEnvironment(new MemoryStorage(), { dpopPublicKeyX963: null });
    vi.useFakeTimers();
    const script = createSocketFactory((socket, envelope) => {
      if (envelope.type === "hello") {
        socket.serverSend({ type: "hello_ok", requestId: envelope.requestId, payload: helloOk() });
      }
    });
    const connection = new SyncConnection({ socketFactory: script.factory, document: null });

    const connecting = connection.connect(
      environment,
      [{ url: pairingPayload.relayUrl!, kind: "relay", dialable: true }],
      async () => "relay-account-token",
    );
    await vi.advanceTimersByTimeAsync(1);
    script.sockets[0]?.serverTransportSend({ t: "accepted", v: 2 });
    await vi.advanceTimersByTimeAsync(RELAY_READY_NEGOTIATION_WINDOW_MS * 4);
    expect(script.sockets[0]?.sent).toEqual([]);

    script.sockets[0]?.serverTransportSend({ t: "ready", v: 2 });
    await connecting;
    expect(script.sockets[0]?.sent.map((envelope) => envelope.type)).toEqual(["hello"]);
    expect(connection.getStatus().state).toBe("connected");
    connection.dispose();
  });

  it("does not downgrade when ready arrives before accepted", async () => {
    const environment = await makeEnvironment(new MemoryStorage(), { dpopPublicKeyX963: null });
    vi.useFakeTimers();
    const script = createSocketFactory((socket, envelope) => {
      if (envelope.type === "hello") {
        socket.serverSend({ type: "hello_ok", requestId: envelope.requestId, payload: helloOk() });
      }
    });
    const connection = new SyncConnection({ socketFactory: script.factory, document: null });
    const connecting = connection.connect(
      environment,
      [{ url: pairingPayload.relayUrl!, kind: "relay", dialable: true }],
      async () => "relay-account-token",
    );
    await vi.advanceTimersByTimeAsync(1);
    script.sockets[0]?.serverTransportSend({ t: "ready", v: 2 });
    await vi.advanceTimersByTimeAsync(RELAY_READY_NEGOTIATION_WINDOW_MS * 2);
    expect(script.sockets[0]?.sent).toEqual([]);
    script.sockets[0]?.serverTransportSend({ t: "accepted", v: 2 });
    expect(script.sockets[0]?.sent).toEqual([]);
    script.sockets[0]?.serverTransportSend({ t: "ready", v: 2 });
    await connecting;
    expect(script.sockets[0]?.sent.map((entry) => entry.type)).toEqual(["hello"]);
    connection.dispose();
  });

  it("fails a ready-v2 relay attempt when control closes after accepted but before ready", async () => {
    const environment = await makeEnvironment(new MemoryStorage(), { dpopPublicKeyX963: null });
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const script = createSocketFactory(() => undefined);
    const connection = new SyncConnection({ socketFactory: script.factory, document: null });

    const outcome = connection.connect(
      environment,
      [{ url: pairingPayload.relayUrl!, kind: "relay", dialable: true }],
      async () => "relay-account-token",
    ).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    script.sockets[0]?.serverTransportSend({ t: "accepted", v: 2 });
    script.sockets[0]?.close(4501, "host offline");

    await expect(outcome).resolves.toMatchObject({
      message: expect.stringContaining("Can't reach this Mac"),
    });
    expect(script.sockets[0]?.sent).toEqual([]);
    expect(connection.getStatus().state).toBe("reconnecting");
    connection.dispose();
  });

  it.each(["connect", "dispose"] as const)(
    "cancels deferred account DPoP creation when a newer %s operation wins",
    async (supersedingOperation) => {
      const environment = await makeEnvironment(new MemoryStorage(), { dpopPublicKeyX963: null });
      vi.useFakeTimers();
      let resolveDpop!: (proof: { timestamp: number; nonce: string; signature: string }) => void;
      const dpop = new Promise<{ timestamp: number; nonce: string; signature: string }>((resolve) => {
        resolveDpop = resolve;
      });
      const script = createSocketFactory((socket, envelope) => {
        if (envelope.type === "hello") {
          socket.serverSend({ type: "hello_ok", requestId: envelope.requestId, payload: helloOk() });
        }
      });
      const connection = new SyncConnection({ socketFactory: script.factory, document: null });
      const pairing = connection.pairWithAccount({
        endpoints: [{ url: pairingPayload.relayUrl!, kind: "relay", dialable: true }],
        peer: { ...hostPeer, deviceId: "deferred-dpop-browser", deviceType: "browser" },
        accountToken: "account-token",
        createDpop: async () => await dpop,
        expectedHostDeviceId: hostPeer.deviceId,
        existingPairing: null,
        buildEnvironment: () => environment,
      });
      await flushMicrotasks();
      expect(script.sockets).toHaveLength(0);

      if (supersedingOperation === "connect") {
        const connecting = connection.connect(
          environment,
          [{ url: "ws://127.0.0.1:8787", kind: "loopback", dialable: true }],
        );
        await vi.advanceTimersByTimeAsync(0);
        await connecting;
      } else {
        connection.dispose();
      }
      resolveDpop({ timestamp: 1, nonce: "nonce", signature: "signature" });

      await expect(pairing).rejects.toThrow("superseded");
      expect(script.sockets).toHaveLength(supersedingOperation === "connect" ? 1 : 0);
      if (supersedingOperation === "connect") {
        expect(connection.getStatus().state).toBe("connected");
        connection.dispose();
      }
    },
  );

  it("preserves reconnect backoff across short hello_ok flaps and resets after a stable session", async () => {
    const environment = await makeEnvironment(new MemoryStorage(), { dpopPublicKeyX963: null });
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const script = createSocketFactory((socket, envelope) => {
      if (envelope.type === "hello") {
        socket.serverSend({ type: "hello_ok", requestId: envelope.requestId, payload: helloOk() });
      }
    });
    const connection = new SyncConnection({ socketFactory: script.factory, document: null });

    const connecting = connection.connect(
      environment,
      [{ url: "ws://127.0.0.1:8787", kind: "loopback", dialable: true }],
    );
    await vi.advanceTimersByTimeAsync(0);
    await connecting;

    script.sockets[0]!.serverSend({ type: "brain_status", payload: {} });
    await flushMicrotasks();
    script.sockets[0]!.close(4505, "short flap one");
    await vi.advanceTimersByTimeAsync(999);
    expect(script.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(script.sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(connection.getStatus().state).toBe("connected");

    script.sockets[1]!.serverSend({ type: "brain_status", payload: {} });
    await flushMicrotasks();
    script.sockets[1]!.close(4505, "short flap two");
    await vi.advanceTimersByTimeAsync(1_999);
    expect(script.sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(script.sockets).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(connection.getStatus().state).toBe("connected");

    await vi.advanceTimersByTimeAsync(BACKOFF_STABLE_CONNECTED_MS);
    script.sockets[2]!.close(4505, "stable session ended");
    await vi.advanceTimersByTimeAsync(999);
    expect(script.sockets).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(script.sockets).toHaveLength(4);
    connection.dispose();
  });

  it("does not let an envelope listener reconnect make a stale ping send on the new socket", async () => {
    const environment = await makeEnvironment(new MemoryStorage(), { dpopPublicKeyX963: null });
    vi.useFakeTimers();
    const script = createSocketFactory((socket, envelope) => {
      if (envelope.type === "hello") {
        socket.serverSend({ type: "hello_ok", requestId: envelope.requestId, payload: helloOk() });
      }
    });
    const connection = new SyncConnection({ socketFactory: script.factory, document: null });
    await vi.advanceTimersByTimeAsync(0);
    const firstConnect = connection.connect(
      environment,
      [{ url: "ws://127.0.0.1:8787", kind: "loopback", dialable: true }],
    );
    await vi.advanceTimersByTimeAsync(0);
    await firstConnect;
    let replacement: Promise<void> | null = null;
    const unsubscribe = connection.on("envelope", (envelope) => {
      if (envelope.type !== "heartbeat" || replacement) return;
      replacement = connection.connect(
        environment,
        [{ url: "ws://127.0.0.1:8788", kind: "loopback", dialable: true }],
      );
    });

    script.sockets[0]!.serverSend({
      type: "heartbeat",
      requestId: "stale-ping",
      payload: { kind: "ping", sentAt: new Date().toISOString() },
    });
    await vi.advanceTimersByTimeAsync(0);
    await replacement;
    expect(script.sockets).toHaveLength(2);
    expect(script.sockets[1]!.sent.map((entry) => entry.type)).toEqual(["hello"]);
    unsubscribe();
    connection.dispose();
  });

  it("lets a statusChanged reconnect supersede finish without stale hello or catalog events", async () => {
    const environment = await makeEnvironment(new MemoryStorage(), { dpopPublicKeyX963: null });
    vi.useFakeTimers();
    const script = createSocketFactory((socket, envelope) => {
      if (envelope.type !== "hello") return;
      const projectId = script.sockets.indexOf(socket) === 0 ? "stale-project" : "replacement-project";
      socket.serverSend({ type: "hello_ok", requestId: envelope.requestId, payload: helloOk(projectId) });
    });
    const connection = new SyncConnection({ socketFactory: script.factory, document: null });
    const helloProjects: string[] = [];
    const catalogProjects: string[] = [];
    connection.on("helloOk", (payload) => helloProjects.push(payload.projects?.[0]?.id ?? "missing"));
    connection.on("projectCatalog", (payload) => catalogProjects.push(payload.projects[0]?.id ?? "missing"));
    let replacement: Promise<void> | null = null;
    const unsubscribeStatus = connection.on("statusChanged", (status) => {
      if (status.state !== "connected" || status.endpoint !== "ws://127.0.0.1:8787" || replacement) return;
      replacement = connection.connect(
        environment,
        [{ url: "ws://127.0.0.1:8788", kind: "loopback", dialable: true }],
      );
    });

    const firstOutcome = connection.connect(
      environment,
      [{ url: "ws://127.0.0.1:8787", kind: "loopback", dialable: true }],
    ).then(
      () => ({ ok: true as const, error: null }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();
    expect(replacement).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await replacement;

    await expect(firstOutcome).resolves.toMatchObject({
      ok: false,
      error: { message: "Sync connection attempt was superseded." },
    });
    expect(script.sockets).toHaveLength(2);
    expect(connection.getStatus()).toMatchObject({
      state: "connected",
      endpoint: "ws://127.0.0.1:8788",
    });
    expect(helloProjects).toEqual(["replacement-project"]);
    expect(catalogProjects).toEqual(["replacement-project"]);
    unsubscribeStatus();
    connection.dispose();
  });

  it("lets a close listener reconnect without stale status or a duplicate replacement", async () => {
    const environment = await makeEnvironment(new MemoryStorage(), { dpopPublicKeyX963: null });
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const script = createSocketFactory((socket, envelope) => {
      if (envelope.type === "hello") {
        socket.serverSend({ type: "hello_ok", requestId: envelope.requestId, payload: helloOk() });
      }
    });
    const connection = new SyncConnection({ socketFactory: script.factory, document: null });
    const initial = connection.connect(
      environment,
      [{ url: "ws://127.0.0.1:8787", kind: "loopback", dialable: true }],
    );
    await vi.advanceTimersByTimeAsync(0);
    await initial;
    let replacement: Promise<void> | null = null;
    const unsubscribeClose = connection.on("close", () => {
      if (replacement) return;
      replacement = connection.connect(
        environment,
        [{ url: "ws://127.0.0.1:8788", kind: "loopback", dialable: true }],
      );
    });

    script.sockets[0]!.close(4505, "superseded route");
    expect(script.sockets).toHaveLength(2);
    expect(connection.getStatus()).toMatchObject({
      state: "connecting",
      endpoint: "ws://127.0.0.1:8788",
    });
    await vi.advanceTimersByTimeAsync(1);
    await replacement;
    await vi.advanceTimersByTimeAsync(5_000);

    expect(script.sockets).toHaveLength(2);
    expect(connection.getStatus()).toMatchObject({
      state: "connected",
      endpoint: "ws://127.0.0.1:8788",
    });
    expect(script.sockets[1]!.closeHistory).toEqual([]);
    unsubscribeClose();
    connection.dispose();
  });

  it("closes a stale visible connection and enters the normal reconnect path", async () => {
    const storage = new MemoryStorage();
    const environment = await makeEnvironment(storage, { dpopPublicKeyX963: null });
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const script = createSocketFactory((socket, envelope) => {
      if (envelope.type === "hello") {
        socket.serverSend({ type: "hello_ok", requestId: envelope.requestId, payload: helloOk() });
      }
    });
    const connection = new SyncConnection({ socketFactory: script.factory, document: null });

    const connecting = connection.connect(
      environment,
      [{ url: pairingPayload.relayUrl!, kind: "relay", dialable: true }],
      async () => "relay-account-token",
    );
    await vi.advanceTimersByTimeAsync(0);
    completeRelayReadyV2(script.sockets[0]);
    await connecting;

    await vi.advanceTimersByTimeAsync(75_000);

    expect(script.sockets[0]?.closedWith).toEqual({
      code: 4008,
      reason: "Inbound connection stale",
    });
    expect(connection.getStatus()).toMatchObject({
      state: "reconnecting",
      error: "Connection became unresponsive. Reconnecting.",
    });
    expect(script.sockets).toHaveLength(1);
    connection.dispose();
  });

  it("does not close a stale connection while the document is hidden", async () => {
    const storage = new MemoryStorage();
    const environment = await makeEnvironment(storage, { dpopPublicKeyX963: null });
    const visibility = new VisibilityDocument();
    vi.useFakeTimers();
    const script = createSocketFactory((socket, envelope) => {
      if (envelope.type === "hello") {
        socket.serverSend({ type: "hello_ok", requestId: envelope.requestId, payload: helloOk() });
      }
    });
    const connection = new SyncConnection({
      socketFactory: script.factory,
      document: visibility.document,
    });

    const connecting = connection.connect(
      environment,
      [{ url: pairingPayload.relayUrl!, kind: "relay", dialable: true }],
      async () => "relay-account-token",
    );
    await vi.advanceTimersByTimeAsync(0);
    completeRelayReadyV2(script.sockets[0]);
    await connecting;
    visibility.setVisibility("hidden");

    await vi.advanceTimersByTimeAsync(90_000);

    expect(script.sockets[0]?.readyState).toBe(1);
    expect(script.sockets[0]?.closedWith).toBeNull();
    expect(connection.getStatus().state).toBe("connected");
    connection.dispose();
  });

  it("closes a stale hidden connection on visibility resume and bypasses backoff", async () => {
    const storage = new MemoryStorage();
    const environment = await makeEnvironment(storage, { dpopPublicKeyX963: null });
    const visibility = new VisibilityDocument();
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const script = createSocketFactory((socket, envelope) => {
      if (envelope.type === "hello") {
        socket.serverSend({ type: "hello_ok", requestId: envelope.requestId, payload: helloOk() });
      }
    });
    const connection = new SyncConnection({
      socketFactory: script.factory,
      document: visibility.document,
    });

    const connecting = connection.connect(
      environment,
      [{ url: pairingPayload.relayUrl!, kind: "relay", dialable: true }],
      async () => "relay-account-token",
    );
    await vi.advanceTimersByTimeAsync(0);
    completeRelayReadyV2(script.sockets[0]);
    await connecting;
    visibility.setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(90_000);

    visibility.setVisibility("visible");
    expect(script.sockets[0]?.closedWith?.code).toBe(4008);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1);
    script.sockets[1]?.serverTransportSend({ t: "accepted", v: 2 });
    script.sockets[1]?.serverTransportSend({ t: "ready", v: 2 });
    await flushMicrotasks();

    expect(script.sockets).toHaveLength(2);
    expect(connection.getStatus().state).toBe("connected");
    connection.dispose();
  });

  it("allows a five-second transport open and a separate hello response within twelve seconds", async () => {
    const storage = new MemoryStorage();
    const environment = await makeEnvironment(storage, { dpopPublicKeyX963: null });
    vi.useFakeTimers();
    const script = createSocketFactory((socket, envelope) => {
      if (envelope.type !== "hello") return;
      setTimeout(() => {
        socket.serverSend({ type: "hello_ok", requestId: envelope.requestId, payload: helloOk() });
      }, 11_000);
    }, { openDelayMs: 5_000 });
    const connection = new SyncConnection({ socketFactory: script.factory, document: null });

    const connecting = connection.connect(
      environment,
      [{ url: pairingPayload.relayUrl!, kind: "relay", dialable: true }],
      async () => "relay-account-token",
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect(script.sockets[0]?.readyState).toBe(1);
    completeRelayReadyV2(script.sockets[0]);
    await vi.advanceTimersByTimeAsync(11_000);
    await connecting;

    expect(connection.getStatus().state).toBe("connected");
    expect(script.sockets[0]?.closeHistory).toEqual([]);
    connection.dispose();
  });

  it("applies the same split open and hello deadlines to account adoption", async () => {
    const storage = new MemoryStorage();
    const environment = await makeEnvironment(storage, { dpopPublicKeyX963: null });
    vi.useFakeTimers();
    const script = createSocketFactory((socket, envelope) => {
      if (envelope.type !== "hello") return;
      const peer = (envelope.payload as { peer: SyncPeerMetadata }).peer;
      setTimeout(() => {
        socket.serverSend({
          type: "hello_ok",
          requestId: envelope.requestId,
          payload: {
            ...helloOk(),
            accountPairing: { deviceId: peer.deviceId, secret: "paired-secret" },
          },
        });
      }, 11_000);
    }, { openDelayMs: 5_000 });
    const connection = new SyncConnection({ socketFactory: script.factory, document: null });

    const pairing = connection.pairWithAccount({
      endpoints: [{ url: pairingPayload.relayUrl!, kind: "relay", dialable: true }],
      peer: { ...hostPeer, deviceId: "browser-device", deviceType: "browser" },
      accountToken: "account-token",
      createDpop: async () => ({ timestamp: 1, nonce: "nonce", signature: "signature" }),
      expectedHostDeviceId: hostPeer.deviceId,
      existingPairing: null,
      buildEnvironment: () => environment,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    completeRelayReadyV2(script.sockets[0]);
    await vi.advanceTimersByTimeAsync(11_000);

    await expect(pairing).resolves.toMatchObject({ endpoint: pairingPayload.relayUrl });
    expect(connection.getStatus().state).toBe("connected");
    expect(script.sockets[0]?.closeHistory).toEqual([]);
    connection.dispose();
  });

  it("fails a transport that does not open within eight seconds", async () => {
    const storage = new MemoryStorage();
    const environment = await makeEnvironment(storage, { dpopPublicKeyX963: null });
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const script = createSocketFactory(() => undefined, { openDelayMs: 8_001 });
    const connection = new SyncConnection({ socketFactory: script.factory, document: null });

    const outcome = connection.connect(
      environment,
      [{ url: pairingPayload.relayUrl!, kind: "relay", dialable: true }],
      async () => "relay-account-token",
    ).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(8_000);

    await expect(outcome).resolves.toMatchObject({
      message: expect.stringContaining("Timed out opening"),
    });
    expect(script.sockets[0]?.closeHistory).toContainEqual({
      code: 4000,
      reason: "Transport open timeout",
    });
    expect(connection.getStatus()).toMatchObject({
      state: "reconnecting",
      error: expect.stringContaining("Timed out opening"),
    });
    connection.dispose();
  });

  it("starts paired proof and Relay token preparation before the socket opens", async () => {
    const storage = new MemoryStorage();
    const environment = await makeEnvironment(storage);
    vi.useFakeTimers();
    const digest = vi.spyOn(crypto.subtle, "digest");
    const relayTokenProvider = vi.fn(async () => "relay-account-token");
    const script = createSocketFactory((socket, envelope) => {
      if (envelope.type === "hello") {
        socket.serverSend({ type: "hello_ok", requestId: envelope.requestId, payload: helloOk() });
      }
    }, { openDelayMs: 5_000 });
    const connection = new SyncConnection({ socketFactory: script.factory, document: null });

    const connecting = connection.connect(
      environment,
      [{ url: pairingPayload.relayUrl!, kind: "relay", dialable: true }],
      relayTokenProvider,
    );
    await flushMicrotasks();

    expect(script.sockets[0]?.readyState).toBe(0);
    expect(digest).toHaveBeenCalled();
    expect(relayTokenProvider).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(5_000);
    completeRelayReadyV2(script.sockets[0]);
    await connecting;
    expect(script.sockets[0]?.sent[0]?.payload).toMatchObject({
      auth: {
        dpop: expect.any(Object),
        relayAccountToken: "relay-account-token",
      },
    });
    connection.dispose();
  });

  it("advertises reauthorization support and refreshes ahead of the host lease deadline", async () => {
    const nowMs = 1_800_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(nowMs);
    const storage = new MemoryStorage();
    const environment = await makeEnvironment(storage);
    let relayTokenSequence = 0;
    const relayTokenProvider: () => Promise<string> = vi.fn(async () => `relay-token-${++relayTokenSequence}`);
    const script = createSocketFactory((socket, envelope) => {
      if (envelope.type === "hello") {
        socket.serverSend({
          type: "hello_ok",
          requestId: envelope.requestId,
          payload: relayHelloOk(nowMs, { expiresAfterMs: 120_000, refreshAfterMs: 91_000 }),
        });
      } else if (envelope.type === "relay_reauthorize") {
        socket.serverSend({
          type: "relay_reauthorize_result",
          requestId: envelope.requestId,
          payload: {
            ok: true,
            relayAuthorization: {
              expiresAt: nowMs + 120_000,
              refreshAfter: nowMs + 90_000,
              challenge: "relay-challenge-2",
              graceMs: 10_000,
            },
          },
        });
      }
    });
    const connection = new SyncConnection({
      socketFactory: script.factory,
      document: null,
      relayReauthorizationSigner,
    });

    const connecting = connection.connect(
      environment,
      [{ url: pairingPayload.relayUrl!, kind: "relay", dialable: true }],
      relayTokenProvider,
    );
    await vi.advanceTimersByTimeAsync(0);
    completeRelayReadyV2(script.sockets[0]);
    await connecting;
    const hello = script.sockets[0]?.sent.find((envelope) => envelope.type === "hello");
    expect((hello?.payload as { peer?: SyncPeerMetadata }).peer?.capabilities).toContain("relayReauthorizeV1");

    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();

    const refreshes = script.sockets[0]?.sent.filter((envelope) => envelope.type === "relay_reauthorize") ?? [];
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0]?.payload).toMatchObject({
      deviceId: environment.pairedDeviceId,
      relayAccountToken: "relay-token-2",
      proof: { nonce: expect.any(String), signature: expect.any(String) },
    });
    expect(connection.getHelloOk()?.relayAuthorization?.challenge).toBe("relay-challenge-2");
    connection.dispose();
  });

  it("paces successful Relay renewals when short token leases stay inside the safety lead", async () => {
    const nowMs = 1_800_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(nowMs);
    const storage = new MemoryStorage();
    const environment = await makeEnvironment(storage);
    let refreshCount = 0;
    const script = createSocketFactory((socket, envelope) => {
      if (envelope.type === "hello") {
        socket.serverSend({
          type: "hello_ok",
          requestId: envelope.requestId,
          payload: relayHelloOk(nowMs, { expiresAfterMs: 120_000, refreshAfterMs: 91_000 }),
        });
      } else if (envelope.type === "relay_reauthorize") {
        refreshCount += 1;
        if (refreshCount === 1) {
          socket.serverSend({
            type: "relay_reauthorize_result",
            requestId: envelope.requestId,
            payload: {
              ok: true,
              relayAuthorization: {
                expiresAt: nowMs + 120_000,
                refreshAfter: nowMs + 60_000,
                challenge: "short-token-lease",
                graceMs: 10_000,
              },
            },
          });
        }
      }
    });
    const connection = new SyncConnection({
      socketFactory: script.factory,
      document: null,
      relayReauthorizationSigner,
    });

    const connecting = connection.connect(
      environment,
      [{ url: pairingPayload.relayUrl!, kind: "relay", dialable: true }],
      async () => "relay-token",
    );
    await vi.advanceTimersByTimeAsync(0);
    completeRelayReadyV2(script.sockets[0]);
    await connecting;
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(refreshCount).toBe(1);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(refreshCount).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(refreshCount).toBe(2);
    connection.dispose();
  });

  it("caps Relay pacing before a short accepted lease expires", async () => {
    const nowMs = 1_800_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(nowMs);
    const storage = new MemoryStorage();
    const environment = await makeEnvironment(storage);
    let refreshCount = 0;
    const script = createSocketFactory((socket, envelope) => {
      if (envelope.type === "hello") {
        socket.serverSend({
          type: "hello_ok",
          requestId: envelope.requestId,
          payload: relayHelloOk(nowMs, { expiresAfterMs: 120_000, refreshAfterMs: 91_000 }),
        });
      } else if (envelope.type === "relay_reauthorize") {
        refreshCount += 1;
        if (refreshCount === 1) {
          socket.serverSend({
            type: "relay_reauthorize_result",
            requestId: envelope.requestId,
            payload: {
              ok: true,
              relayAuthorization: {
                expiresAt: nowMs + 32_000,
                refreshAfter: nowMs + 12_000,
                challenge: "short-accepted-lease",
                graceMs: 10_000,
              },
            },
          });
        }
      }
    });
    const connection = new SyncConnection({
      socketFactory: script.factory,
      document: null,
      relayReauthorizationSigner,
    });

    const connecting = connection.connect(
      environment,
      [{ url: pairingPayload.relayUrl!, kind: "relay", dialable: true }],
      async () => "relay-token",
    );
    await vi.advanceTimersByTimeAsync(0);
    completeRelayReadyV2(script.sockets[0]);
    await connecting;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(refreshCount).toBe(1);

    await vi.advanceTimersByTimeAsync(25_999);
    expect(refreshCount).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(refreshCount).toBe(2);
    connection.dispose();
  });

  it("deduplicates refresh preparation and retries an identical request after a lost ACK", async () => {
    const nowMs = 1_800_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(nowMs);
    const storage = new MemoryStorage();
    const environment = await makeEnvironment(storage);
    let relayTokenSequence = 0;
    const relayTokenProvider: () => Promise<string> = vi.fn(async () => `relay-token-${++relayTokenSequence}`);
    let refreshFrames = 0;
    const script = createSocketFactory((socket, envelope) => {
      if (envelope.type === "hello") {
        socket.serverSend({
          type: "hello_ok",
          requestId: envelope.requestId,
          payload: relayHelloOk(nowMs, { expiresAfterMs: 120_000, refreshAfterMs: 91_000 }),
        });
      } else if (envelope.type === "relay_reauthorize") {
        refreshFrames += 1;
        if (refreshFrames === 2) {
          socket.serverSend({
            type: "relay_reauthorize_result",
            requestId: envelope.requestId,
            payload: {
              ok: true,
              relayAuthorization: {
                expiresAt: nowMs + 120_000,
                refreshAfter: nowMs + 90_000,
                challenge: "relay-challenge-2",
                graceMs: 10_000,
              },
            },
          });
        }
      }
    });
    const connection = new SyncConnection({
      socketFactory: script.factory,
      document: null,
      relayReauthorizationSigner,
    });
    const connecting = connection.connect(
      environment,
      [{ url: pairingPayload.relayUrl!, kind: "relay", dialable: true }],
      relayTokenProvider,
    );
    await vi.advanceTimersByTimeAsync(0);
    completeRelayReadyV2(script.sockets[0]);
    await connecting;

    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();
    expect(refreshFrames).toBe(1);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(refreshFrames).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();

    const refreshes = script.sockets[0]?.sent.filter((envelope) => envelope.type === "relay_reauthorize") ?? [];
    expect(refreshes).toHaveLength(2);
    expect(refreshes[1]).toEqual(refreshes[0]);
    expect(relayTokenProvider).toHaveBeenCalledTimes(2);
    expect(connection.getHelloOk()?.relayAuthorization?.challenge).toBe("relay-challenge-2");
    connection.dispose();
  });

  it("keeps retrying transient Relay verification failures at capped 8s intervals until the lease deadline", async () => {
    const nowMs = 1_800_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(nowMs);
    const storage = new MemoryStorage();
    const environment = await makeEnvironment(storage);
    let relayTokenSequence = 0;
    const relayTokenProvider: () => Promise<string> = vi.fn(async () => `relay-token-${++relayTokenSequence}`);
    const refreshTimes: number[] = [];
    const script = createSocketFactory((socket, envelope) => {
      if (envelope.type === "hello") {
        socket.serverSend({
          type: "hello_ok",
          requestId: envelope.requestId,
          payload: relayHelloOk(nowMs, { expiresAfterMs: 120_000, refreshAfterMs: 91_000 }),
        });
      } else if (envelope.type === "relay_reauthorize") {
        refreshTimes.push(Date.now());
        socket.serverSend({
          type: "relay_reauthorize_result",
          requestId: envelope.requestId,
          payload: refreshTimes.length < 8
            ? {
                ok: false,
                error: {
                  code: "verification_failed",
                  message: "Relay account verification is temporarily unavailable.",
                  retryable: true,
                },
              }
            : {
                ok: true,
                relayAuthorization: {
                  expiresAt: nowMs + 180_000,
                  refreshAfter: nowMs + 150_000,
                  challenge: "relay-challenge-after-retry",
                  graceMs: 10_000,
                },
              },
        });
      }
    });
    const connection = new SyncConnection({
      socketFactory: script.factory,
      document: null,
      relayReauthorizationSigner,
    });
    const connecting = connection.connect(
      environment,
      [{ url: pairingPayload.relayUrl!, kind: "relay", dialable: true }],
      relayTokenProvider,
    );
    await vi.advanceTimersByTimeAsync(0);
    completeRelayReadyV2(script.sockets[0]);
    await connecting;

    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();
    expect(refreshTimes).toHaveLength(1);
    for (const [index, delayMs] of [1_000, 2_000, 4_000, 8_000, 8_000, 8_000, 8_000].entries()) {
      await vi.advanceTimersByTimeAsync(delayMs);
      await flushMicrotasks();
      expect(refreshTimes).toHaveLength(index + 2);
    }

    expect(refreshTimes.map((time, index) => index === 0 ? 0 : time - refreshTimes[index - 1]!))
      .toEqual([0, 1_000, 2_000, 4_000, 8_000, 8_000, 8_000, 8_000]);
    const refreshFrames = script.sockets[0]?.sent.filter((envelope) => envelope.type === "relay_reauthorize") ?? [];
    expect(refreshFrames).toHaveLength(8);
    expect(refreshFrames.every((frame) => JSON.stringify(frame) === JSON.stringify(refreshFrames[0]))).toBe(true);
    expect(relayTokenProvider).toHaveBeenCalledTimes(2);
    expect(connection.getHelloOk()?.relayAuthorization?.challenge).toBe("relay-challenge-after-retry");
    connection.dispose();
  });

  it("retains legacy reconnect behavior when an old host omits Relay lease metadata", async () => {
    vi.useFakeTimers();
    const storage = new MemoryStorage();
    const environment = await makeEnvironment(storage, { dpopPublicKeyX963: null });
    const script = createSocketFactory((socket, envelope) => {
      if (envelope.type === "hello") {
        socket.serverSend({ type: "hello_ok", requestId: envelope.requestId, payload: helloOk() });
      }
    });
    const connection = new SyncConnection({ socketFactory: script.factory, document: null });
    const connecting = connection.connect(
      environment,
      [{ url: pairingPayload.relayUrl!, kind: "relay", dialable: true }],
      async () => "relay-token",
    );
    await vi.advanceTimersByTimeAsync(0);
    completeRelayReadyV2(script.sockets[0]);
    await connecting;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(script.sockets[0]?.sent.some((envelope) => envelope.type === "relay_reauthorize")).toBe(false);

    script.sockets.at(-1)?.close(4003, "ADE Relay account proof expired");
    expect(connection.getStatus().state).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(1_500);
    await flushMicrotasks();
    expect(script.sockets).toHaveLength(2);
    connection.dispose();
  });

  it("scopes refresh timers to the active socket generation", async () => {
    const nowMs = 1_800_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(nowMs);
    const storage = new MemoryStorage();
    const environment = await makeEnvironment(storage);
    let helloCount = 0;
    const script = createSocketFactory((socket, envelope) => {
      if (envelope.type !== "hello") return;
      helloCount += 1;
      socket.serverSend({
        type: "hello_ok",
        requestId: envelope.requestId,
        payload: relayHelloOk(nowMs, {
          expiresAfterMs: 120_000,
          refreshAfterMs: helloCount === 1 ? 91_000 : 95_000,
        }),
      });
    });
    const connection = new SyncConnection({
      socketFactory: script.factory,
      document: null,
      relayReauthorizationSigner,
    });
    const firstConnect = connection.connect(
      environment,
      [{ url: pairingPayload.relayUrl!, kind: "relay", dialable: true }],
      async () => "relay-token",
    );
    await vi.advanceTimersByTimeAsync(0);
    completeRelayReadyV2(script.sockets[0]);
    await firstConnect;
    const secondConnect = connection.connect(
      environment,
      [{ url: pairingPayload.relayUrl!, kind: "relay", dialable: true }],
      async () => "relay-token",
    );
    await vi.advanceTimersByTimeAsync(0);
    completeRelayReadyV2(script.sockets[1]);
    await secondConnect;

    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();
    expect(script.sockets.flatMap((socket) => socket.sent).filter((envelope) => envelope.type === "relay_reauthorize"))
      .toHaveLength(0);
    await vi.advanceTimersByTimeAsync(4_000);
    await flushMicrotasks();
    expect(script.sockets[1]?.sent.filter((envelope) => envelope.type === "relay_reauthorize"))
      .toHaveLength(1);
    connection.dispose();
  });

  it("refreshes a hidden Relay tab before expiry and treats account change as terminal", async () => {
    const nowMs = 1_800_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(nowMs);
    const storage = new MemoryStorage();
    const environment = await makeEnvironment(storage);
    const visibility = new VisibilityDocument();
    const script = createSocketFactory((socket, envelope) => {
      if (envelope.type === "hello") {
        socket.serverSend({
          type: "hello_ok",
          requestId: envelope.requestId,
          payload: relayHelloOk(nowMs, { expiresAfterMs: 120_000, refreshAfterMs: 91_000 }),
        });
      } else if (envelope.type === "relay_reauthorize") {
        socket.serverSend({
          type: "relay_reauthorize_result",
          requestId: envelope.requestId,
          payload: {
            ok: false,
            error: {
              code: "relay_account_changed",
              message: "The ADE account session changed.",
              retryable: false,
            },
          },
        });
      }
    });
    const connection = new SyncConnection({
      socketFactory: script.factory,
      document: visibility.document,
      relayReauthorizationSigner,
    });
    const connecting = connection.connect(
      environment,
      [{ url: pairingPayload.relayUrl!, kind: "relay", dialable: true }],
      async () => "relay-token",
    );
    await vi.advanceTimersByTimeAsync(0);
    completeRelayReadyV2(script.sockets[0]);
    await connecting;
    visibility.setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(script.sockets[0]?.sent.filter((envelope) => envelope.type === "relay_reauthorize"))
      .toHaveLength(1);

    visibility.setVisibility("visible");
    await flushMicrotasks();

    expect(script.sockets[0]?.sent.filter((envelope) => envelope.type === "relay_reauthorize"))
      .toHaveLength(1);
    expect(connection.getStatus()).toMatchObject({
      state: "auth_failed",
      error: "The ADE account session changed.",
    });
    connection.dispose();
  });

  it.each([
    { code: 4501, expected: "Can't reach this Mac. Retrying…" },
    { code: 4507, expected: "Your Mac couldn't accept the connection. Retrying…" },
    { code: 4503, expected: "Too many active connections to this Mac" },
    { code: 4502, expected: "Connection lost. Reconnecting." },
    { code: 4000, expected: "Connection lost. Reconnecting." },
    { code: 4505, expected: "Connection lost. Reconnecting." },
    { code: 4506, expected: "Connection lost. Reconnecting." },
  ])("maps Relay close code $code and keeps reconnecting", async ({ code, expected }) => {
    const storage = new MemoryStorage();
    const environment = await makeEnvironment(storage);
    vi.spyOn(Math, "random").mockReturnValue(0);
    const script = createSocketFactory((socket, envelope) => {
      if (envelope.type === "hello") {
        socket.serverSend({ type: "hello_ok", requestId: envelope.requestId, payload: helloOk() });
      }
    });
    const connection = new SyncConnection({ socketFactory: script.factory, document: null });
    const closeEvents: Array<{ code: number; reason: string }> = [];
    connection.on("close", (event) => closeEvents.push(event));

    await connection.connect(
      environment,
      [{ url: pairingPayload.relayUrl!, kind: "relay", dialable: true }],
      async () => "relay-account-token",
    );
    script.sockets.at(-1)?.close(code, "relay detail");

    expect(closeEvents).toEqual([{ code, reason: "relay detail" }]);
    expect(connection.getStatus()).toMatchObject({
      state: "reconnecting",
      error: expected,
    });
    connection.dispose();
  });

  it("does not report application readiness until hello restoration completes", async () => {
    const storage = new DelayedPutStorage();
    const environment = await makeEnvironment(storage);
    storage.delayNextEnvironmentPut = true;
    const states: string[] = [];
    let catalogRequestId: string | null = null;
    const script = createSocketFactory((socket, envelope) => {
      if (envelope.type === "hello") {
        socket.serverSend({ type: "hello_ok", requestId: envelope.requestId, payload: helloOkWithoutProjects() });
      }
      if (envelope.type === "project_catalog_request") {
        catalogRequestId = envelope.requestId ?? null;
      }
    });
    const client = new AdeSyncClient({ storage, socketFactory: script.factory, document: null });
    client.subscribe((status) => states.push(status.state));

    const connecting = client.connect(environment.envId, signedInRelayAccess);
    for (let attempt = 0; attempt < 20 && script.sockets[0]?.readyState !== 1; attempt += 1) await flush();
    script.sockets[0]?.serverTransportSend({ t: "accepted", v: 2 });
    script.sockets[0]?.serverTransportSend({ t: "ready", v: 2 });
    for (let attempt = 0; attempt < 20 && !catalogRequestId; attempt += 1) await flush();

    expect(client.getStatus()).toMatchObject({ state: "restoring", readiness: "restoring" });
    await expect(client.sendCommand("chat.send", { text: "too early" })).rejects.toMatchObject({
      code: "not_connected",
    });
    expect(script.sockets[0]?.sent.some((envelope) => envelope.type === "command")).toBe(false);

    script.sockets[0]?.serverSend({
      type: "project_catalog",
      requestId: catalogRequestId,
      payload: { projects: helloOk().projects ?? [] },
    });
    await storage.waitForPausedPut();
    await connecting;
    expect(client.getStatus()).toMatchObject({ state: "connected", readiness: "ready" });
    expect(states).toContain("restoring");
    storage.resumePausedPut();
    client.dispose();
  });

  it("rejects every in-flight request category when the transport is lost without replaying mutations", async () => {
    const storage = new MemoryStorage();
    const environment = await makeEnvironment(storage);
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const script = createSocketFactory((socket, envelope) => {
      if (envelope.type === "hello") {
        socket.serverSend({ type: "hello_ok", requestId: envelope.requestId, payload: helloOk() });
      }
    });
    const client = new AdeSyncClient({ storage, socketFactory: script.factory, document: null });

    const connecting = client.connect(environment.envId, signedInRelayAccess);
    await vi.advanceTimersByTimeAsync(0);
    completeRelayReadyV2(script.sockets[0]);
    await connecting;
    const pending = [
      client.sendCommand("chat.send", { text: "once" }),
      client.requestFile("readFile", { workspaceId: "workspace", path: "README.md" }),
      client.requestTerminalHistory({ sessionId: "term-1", beforeOffset: 10 }),
      client.switchProject("project-2"),
    ];
    await flushMicrotasks();
    expect(script.sockets[0]?.sent.filter((envelope) => envelope.type === "command")).toHaveLength(1);
    expect(script.sockets[0]?.sent.map((envelope) => envelope.type)).toEqual(expect.arrayContaining([
      "file_request",
      "terminal_history",
      "project_switch_request",
    ]));

    script.sockets[0]?.close(4505, "superseded");
    const settled = await Promise.allSettled(pending);
    expect(settled).toHaveLength(4);
    for (const result of settled) {
      expect(result).toMatchObject({
        status: "rejected",
        reason: {
          code: "connection_lost_outcome_unknown",
          details: { closeCode: 4505, reason: "superseded" },
        },
      });
    }
    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();

    expect(script.sockets).toHaveLength(2);
    expect(script.sockets[1]?.sent.some((envelope) => envelope.type === "command")).toBe(false);
    script.sockets[0]?.serverSend({
      type: "project_catalog",
      payload: { projects: helloOk("stale-project").projects ?? [] },
    });
    await flushMicrotasks();
    await expect(client.getProjectCatalog()).resolves.toMatchObject({
      projects: [{ id: "project-1" }],
    });
    client.dispose();
  });

  it("does not open ADE Relay while signed out", async () => {
    const storage = new MemoryStorage();
    const environment = await makeEnvironment(storage, { addressCandidates: [] });
    const script = createSocketFactory(() => {
      throw new Error("signed-out Relay must not open a socket");
    });
    const client = new AdeSyncClient({ storage, socketFactory: script.factory, document: null });

    await expect(client.connect(environment.envId)).rejects.toBeInstanceOf(WebRelayAuthRequiredError);
    expect(script.sockets).toHaveLength(0);
    client.dispose();
  });

  it("reconnects a signed-out direct LAN last-good endpoint without Relay authorization", async () => {
    vi.stubGlobal("location", { protocol: "http:", hostname: "localhost" });
    const storage = new MemoryStorage();
    const directUrl = "ws://192.168.1.10:8787";
    const environment = await makeEnvironment(storage, {
      relayUrl: null,
      machineKeyUrl: null,
      explicitWssEndpoints: [],
      addressCandidates: [{ host: "192.168.1.10", kind: "lan" }],
      lastGoodEndpoint: directUrl,
      accountOwnerUserId: null,
    });
    const script = createSocketFactory((socket, envelope) => {
      if (envelope.type === "hello") {
        expect(envelope.payload).not.toMatchObject({
          auth: expect.objectContaining({ accountToken: expect.anything() }),
        });
        socket.serverSend({
          type: "hello_ok",
          requestId: envelope.requestId,
          payload: helloOk(),
        });
      }
    });
    const client = new AdeSyncClient({ storage, socketFactory: script.factory, document: null });

    await client.connect(environment.envId);

    expect(script.sockets.map((socket) => socket.url)).toEqual([directUrl]);
    client.dispose();
  });

  it("uses client heartbeats only as an inbound-silence fallback", async () => {
    const storage = new MemoryStorage();
    const environment = await makeEnvironment(storage);
    vi.useFakeTimers();
    const script = createSocketFactory((socket, envelope) => {
      if (envelope.type === "hello") {
        socket.serverSend({ type: "hello_ok", requestId: envelope.requestId, payload: helloOk() });
      }
    });
    const client = new AdeSyncClient({ storage, socketFactory: script.factory, document: null });

    const connecting = client.connect(environment.envId, signedInRelayAccess);
    await vi.advanceTimersByTimeAsync(0);
    completeRelayReadyV2(script.sockets[0]);
    await flushMicrotasks();
    await connecting;
    const socket = script.sockets[0]!;

    await vi.advanceTimersByTimeAsync(30_000);
    socket.serverSend({
      type: "heartbeat",
      payload: { kind: "ping", sentAt: new Date().toISOString(), dbVersion: 0 },
    });
    await flushMicrotasks();
    const clientPings = () => socket.sent.filter((envelope) =>
      envelope.type === "heartbeat"
      && (envelope.payload as { kind?: string } | null)?.kind === "ping");
    expect(clientPings()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(59_999);
    expect(clientPings()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(clientPings()).toHaveLength(1);
    client.dispose();
  });

  it("uses invalidation-only sync with bounded live hints", async () => {
    const environment = await makeEnvironment(new MemoryStorage(), { dpopPublicKeyX963: null });
    const script = createSocketFactory((socket, envelope) => {
      if (envelope.type === "hello") {
        socket.serverSend({ type: "hello_ok", requestId: envelope.requestId, payload: helloOk() });
      }
    });
    const connection = new SyncConnection({ socketFactory: script.factory, document: null });
    const invalidations: string[][] = [];
    connection.on("tablesChanged", (tables) => invalidations.push([...tables].sort()));
    const endpoint = { url: "ws://127.0.0.1:8787", kind: "loopback" as const, dialable: true };

    await connection.connect(environment, [endpoint]);
    const hello = script.sockets[0]?.sent.find((envelope) => envelope.type === "hello");
    expect((hello?.payload as { peer?: SyncPeerMetadata }).peer?.capabilities).toContain(
      SYNC_INVALIDATION_ONLY_V1_CAPABILITY,
    );
    expect((hello?.payload as { peer?: SyncPeerMetadata }).peer?.capabilities).toContain(
      SYNC_COMPACT_INVALIDATION_V1_CAPABILITY,
    );
    expect(invalidations).toEqual([[
      "agent_chats",
      "files",
      "github",
      "lanes",
      "pull_requests",
      "rebase",
      "sessions",
    ]]);

    script.sockets[0]?.serverSend({
      type: "invalidation_batch",
      payload: {
        fromDbVersion: 12,
        toDbVersion: 13,
        tables: ["agent_chats"],
        fullRefresh: false,
      },
    });
    await flushMicrotasks();
    expect(invalidations).toHaveLength(2);
    expect(invalidations[1]).toEqual(["agent_chats"]);
    expect(script.sockets[0]?.sent.some((envelope) => envelope.type === "changeset_ack")).toBe(false);

    script.sockets[0]?.serverSend({
      type: "invalidation_batch",
      payload: {
        fromDbVersion: 13,
        toDbVersion: 14,
        tables: ["t".repeat(SYNC_INVALIDATION_TABLE_MAX_BYTES + 1)],
        fullRefresh: false,
      },
    });
    await flushMicrotasks();
    expect(invalidations).toHaveLength(3);
    expect(invalidations[2]).toEqual(invalidations[0]);

    await connection.connect(environment, [endpoint]);
    expect(invalidations).toHaveLength(4);
    expect(invalidations[3]).toEqual(invalidations[0]);
    connection.dispose();
  });

  it("lets a locally paired environment use Relay only after the account directory verifies its host", async () => {
    const storage = new MemoryStorage();
    const environment = await makeEnvironment(storage, { accountOwnerUserId: null, addressCandidates: [] });
    const script = createSocketFactory((socket, envelope) => {
      if (envelope.type === "hello") {
        socket.serverSend({ type: "hello_ok", requestId: envelope.requestId, payload: helloOk() });
      }
    });
    const client = new AdeSyncClient({ storage, socketFactory: script.factory, document: null });

    await expect(client.connect(environment.envId, {
      kind: "signed_in",
      userId: "account-user-1",
      hostDeviceIds: ["another-host"],
      getAccessToken: async () => "relay-account-token",
    })).rejects.toBeInstanceOf(WebRelayAuthRequiredError);
    expect(script.sockets).toHaveLength(0);

    const connecting = client.connect(environment.envId, signedInRelayAccess);
    await completeRelayReadyV2AfterOpen(script.sockets, 0);
    await connecting;
    expect(script.sockets.map((socket) => socket.url)).toEqual([`${pairingPayload.relayUrl}?ready=2`]);
    expect((await client.listEnvironments())[0]?.accountOwnerUserId).toBeNull();
    client.dispose();
  });

  it("turns a Relay account rejection into sign-in guidance without deleting the pairing", async () => {
    const storage = new MemoryStorage();
    const environment = await makeEnvironment(storage, { addressCandidates: [] });
    const script = createSocketFactory((socket, envelope) => {
      if (envelope.type !== "hello") return;
      socket.serverSend({
        type: "hello_error",
        requestId: envelope.requestId,
        payload: {
          code: "relay_account_required",
          message: "Sign in with the same ADE account on both machines.",
          host: { deviceId: hostPeer.deviceId, name: hostPeer.deviceName },
        },
      });
    });
    const client = new AdeSyncClient({ storage, socketFactory: script.factory, document: null });

    await expect(client.connect(environment.envId, signedInRelayAccess)).rejects.toBeInstanceOf(WebRelayAuthRequiredError);
    expect(await client.listEnvironments()).toHaveLength(1);
    expect(client.getStatus().state).toBe("error");
    client.dispose();
  });

  it("disconnects and prunes revoked account trust while connected without deleting local pairings", async () => {
    const storage = new MemoryStorage();
    await makeEnvironment(storage, {
      envId: "local-env",
      hostDeviceId: "local-host",
      accountOwnerUserId: null,
    });
    const accountEnvironment = await makeEnvironment(storage, {
      envId: "account-env",
      accountOwnerUserId: "account-user-1",
    });
    const script = createSocketFactory((socket, envelope) => {
      if (envelope.type === "hello") {
        socket.serverSend({ type: "hello_ok", requestId: envelope.requestId, payload: helloOk() });
      }
    });
    const client = new AdeSyncClient({ storage, socketFactory: script.factory, document: null });
    await client.connect(accountEnvironment.envId, signedInRelayAccess);
    expect(client.getStatus().state).toBe("connected");

    const result = await reconcileActiveAccountLease({
      accountClient: {
        getAccessToken: async () => {
          throw new Error("ADE account session expired.");
        },
        getSnapshot: () => ({
          state: "auth_expired",
          userId: null,
          email: null,
          name: null,
          imageUrl: null,
          expiresAt: null,
          machines: [],
          relayBaseUrls: [],
          message: "Your ADE account session expired. Sign in again.",
        }),
      },
      syncClient: client,
      expectedOwnerUserId: "account-user-1",
    });

    expect(result.state).toBe("revoked");
    expect(client.getStatus().state).toBe("disconnected");
    expect((await client.listEnvironments()).map((environment) => environment.envId)).toEqual(["local-env"]);
    client.dispose();
  });

  it("disconnects a local pairing on confirmed Relay account expiry but preserves it for direct reconnect", async () => {
    const storage = new MemoryStorage();
    const localEnvironment = await makeEnvironment(storage, {
      envId: "local-relay-env",
      accountOwnerUserId: null,
    });
    const script = createSocketFactory((socket, envelope) => {
      if (envelope.type === "hello") {
        socket.serverSend({ type: "hello_ok", requestId: envelope.requestId, payload: helloOk() });
      }
    });
    const client = new AdeSyncClient({ storage, socketFactory: script.factory, document: null });
    const connecting = client.connect(localEnvironment.envId, signedInRelayAccess);
    await completeRelayReadyV2AfterOpen(script.sockets, 0);
    await connecting;
    const expectedOwnerUserId = accountLeaseOwnerForActiveConnection({
      environment: localEnvironment,
      endpoint: client.getStatus().endpoint,
      relayAccess: signedInRelayAccess,
    });
    expect(expectedOwnerUserId).toBe("account-user-1");

    const result = await reconcileActiveAccountLease({
      accountClient: {
        getAccessToken: async () => {
          throw new Error("ADE account session expired.");
        },
        getSnapshot: () => ({
          state: "auth_expired",
          userId: null,
          email: null,
          name: null,
          imageUrl: null,
          expiresAt: null,
          machines: [],
          relayBaseUrls: [],
          message: "Your ADE account session expired. Sign in again.",
        }),
      },
      syncClient: client,
      expectedOwnerUserId: expectedOwnerUserId!,
    });

    expect(result.state).toBe("revoked");
    expect(client.getStatus().state).toBe("disconnected");
    expect((await client.listEnvironments()).map((environment) => environment.envId)).toEqual([
      "local-relay-env",
    ]);
    client.dispose();
  });

  it("disconnects a cached last-good Relay connection when its account lease expires", async () => {
    const storage = new MemoryStorage();
    const cachedRelayEndpoint = "wss://cached-relay.example/connect/machine-key";
    const localEnvironment = await makeEnvironment(storage, {
      envId: "cached-last-good-relay-env",
      accountOwnerUserId: null,
      relayUrl: null,
      machineKeyUrl: null,
      lastGoodEndpoint: cachedRelayEndpoint,
      explicitWssEndpoints: [],
      addressCandidates: [],
      port: 0,
    });
    const script = createSocketFactory((socket, envelope) => {
      expect(socket.url).toBe(`${cachedRelayEndpoint}?ready=2`);
      if (envelope.type === "hello") {
        expect(envelope.payload).toMatchObject({
          auth: { relayAccountToken: "relay-account-token" },
        });
        socket.serverSend({ type: "hello_ok", requestId: envelope.requestId, payload: helloOk() });
      }
    });
    const client = new AdeSyncClient({ storage, socketFactory: script.factory, document: null });
    const connecting = client.connect(localEnvironment.envId, signedInRelayAccess);
    await completeRelayReadyV2AfterOpen(script.sockets, 0);
    await connecting;

    const expectedOwnerUserId = accountLeaseOwnerForActiveConnection({
      environment: localEnvironment,
      endpoint: client.getStatus().endpoint,
      relayAccess: signedInRelayAccess,
    });
    expect(expectedOwnerUserId).toBe("account-user-1");

    const result = await reconcileActiveAccountLease({
      accountClient: {
        getAccessToken: async () => {
          throw new Error("ADE account session expired.");
        },
        getSnapshot: () => ({
          state: "auth_expired",
          userId: null,
          email: null,
          name: null,
          imageUrl: null,
          expiresAt: null,
          machines: [],
          relayBaseUrls: [],
          message: "Your ADE account session expired. Sign in again.",
        }),
      },
      syncClient: client,
      expectedOwnerUserId: expectedOwnerUserId!,
    });

    expect(result.state).toBe("revoked");
    expect(client.getStatus().state).toBe("disconnected");
    expect((await client.listEnvironments()).map((environment) => environment.envId)).toEqual([
      "cached-last-good-relay-env",
    ]);
    client.dispose();
  });

  it("keeps a local pairing connected through Relay during a transient directory outage", async () => {
    const storage = new MemoryStorage();
    const localEnvironment = await makeEnvironment(storage, {
      envId: "local-relay-env",
      accountOwnerUserId: null,
    });
    const script = createSocketFactory((socket, envelope) => {
      if (envelope.type === "hello") {
        socket.serverSend({ type: "hello_ok", requestId: envelope.requestId, payload: helloOk() });
      }
    });
    const client = new AdeSyncClient({ storage, socketFactory: script.factory, document: null });
    await client.connect(localEnvironment.envId, signedInRelayAccess);
    const expectedOwnerUserId = accountLeaseOwnerForActiveConnection({
      environment: localEnvironment,
      endpoint: client.getStatus().endpoint,
      relayAccess: signedInRelayAccess,
    });

    const result = await reconcileActiveAccountLease({
      accountClient: {
        getAccessToken: async () => {
          throw new Error("temporary network failure");
        },
        getSnapshot: () => ({
          state: "directory_unavailable",
          userId: "account-user-1",
          email: "user@example.test",
          name: null,
          imageUrl: null,
          expiresAt: null,
          machines: [],
          relayBaseUrls: [],
          message: "Machines are temporarily unavailable.",
        }),
      },
      syncClient: client,
      expectedOwnerUserId: expectedOwnerUserId!,
    });

    expect(result.state).toBe("transient");
    expect(client.getStatus().state).toBe("connected");
    expect(await client.listEnvironments()).toHaveLength(1);
    client.dispose();
  });

  it("does not attach an account lease to an explicit direct WSS connection", async () => {
    const storage = new MemoryStorage();
    const directEndpoint = "wss://studio.example.test:8787";
    const localEnvironment = await makeEnvironment(storage, {
      accountOwnerUserId: null,
      relayUrl: null,
      machineKeyUrl: null,
      lastGoodEndpoint: directEndpoint,
      explicitWssEndpoints: [directEndpoint],
    });

    expect(accountLeaseOwnerForActiveConnection({
      environment: localEnvironment,
      endpoint: directEndpoint,
      relayAccess: signedInRelayAccess,
    })).toBeNull();
  });

  it("refreshes DPoP per account relay and reconnects with the paired secret on current endpoints", async () => {
    const storage = new MemoryStorage();
    await makeEnvironment(storage, {
      secret: "stored-paired-secret",
      relayUrl: "wss://stale-relay.example/connect/machine-key",
      machineKeyUrl: "wss://stale-relay.example/connect/machine-key",
      lastGoodEndpoint: "wss://stale-relay.example/connect/machine-key",
      explicitWssEndpoints: ["wss://stale-relay.example/connect/machine-key"],
      addressCandidates: [{ host: "10.0.0.1", kind: "lan" }],
    });
    const accountToken = "account-access-token-never-persisted";
    const accountDpopNonces: string[] = [];
    const accountMachine: AdeAccountMachine = {
      machineKey: "machine-key",
      deviceId: hostPeer.deviceId,
      name: hostPeer.deviceName,
      platform: "macOS",
      deviceType: "desktop",
      reachableEndpoints: [
        { kind: "relay", url: "ws://plaintext-relay.example/connect/machine-key" },
        { kind: "lan", url: "wss://arbitrary-origin.example/sync" },
        { kind: "lan", host: "attacker.example", port: 8787 },
        { kind: "lan", host: "192.168.1.10", port: 8787 },
        { kind: "relay", url: "wss://relay-one.example/connect/machine-key" },
        { kind: "relay", url: "wss://relay-two.example/connect/machine-key" },
      ],
      lastSeenAt: Date.now(),
      online: true,
    };
    const accountScript = createSocketFactory((socket, envelope) => {
      if (envelope.type !== "hello") return;
      const payload = envelope.payload as {
        peer: SyncPeerMetadata;
        auth: { kind: string; accountToken?: string; dpop?: { nonce?: string }; secret?: string };
      };
      if (payload.auth.kind === "paired") {
        expect(payload.auth).toMatchObject({
          secret: "stored-paired-secret",
          dpop: expect.any(Object),
        });
        socket.serverSend({ type: "hello_ok", requestId: envelope.requestId, payload: helloOk() });
        return;
      }
      expect(payload.auth).toMatchObject({
        kind: "account",
        accountToken,
        dpop: expect.any(Object),
      });
      accountDpopNonces.push(payload.auth.dpop?.nonce ?? "");
      if (socket.url.includes("relay-one")) {
        socket.serverSend({
          type: "hello_error",
          requestId: envelope.requestId,
          payload: { code: "auth_failed", message: "Retry the next relay." },
        });
        return;
      }
      socket.serverSend({
        type: "hello_ok",
        requestId: envelope.requestId,
        payload: helloOk(),
      });
    });
    const accountClient = new AdeSyncClient({
      storage,
      socketFactory: accountScript.factory,
      document: null,
    });

    const pairing = accountClient.pairWithAccountMachine({
      machine: accountMachine,
      accessToken: accountToken,
      accountSessionLease: currentAccountSessionLease,
      isAccountSessionLeaseCurrent: () => true,
      deviceName: "ADE Browser",
      relayBaseUrls: ["https://relay-one.example", "https://relay-two.example"],
    });
    await completeRelayReadyV2AfterOpen(accountScript.sockets, 0);
    await completeRelayReadyV2AfterOpen(accountScript.sockets, 1);
    const environment = await pairing;

    expect(accountScript.sockets.map((socket) => socket.url)).toEqual([
      "wss://relay-one.example/connect/machine-key?ready=2",
      "wss://relay-two.example/connect/machine-key?ready=2",
    ]);
    expect(accountDpopNonces).toHaveLength(2);
    expect(new Set(accountDpopNonces).size).toBe(2);
    expect(environment.secret).toBe("stored-paired-secret");
    expect(environment.explicitWssEndpoints).not.toContain("wss://stale-relay.example/connect/machine-key");
    expect(environment.explicitWssEndpoints).not.toContain("wss://arbitrary-origin.example/sync");
    expect(environment.addressCandidates).toContainEqual({ host: "192.168.1.10", kind: "lan" });
    expect(environment.addressCandidates).not.toContainEqual(expect.objectContaining({ host: "attacker.example" }));
    expect(environment.port).toBe(8787);
    expect(JSON.stringify(await accountClient.listEnvironments())).not.toContain(accountToken);

    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    accountScript.sockets[1]?.close(1006, "Connection dropped");
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1);
    accountScript.sockets[2]?.serverTransportSend({ t: "accepted", v: 2 });
    accountScript.sockets[2]?.serverTransportSend({ t: "ready", v: 2 });
    vi.useRealTimers();
    for (let attempt = 0; attempt < 20 && !accountScript.sockets[2]?.sent[0]; attempt += 1) {
      await flush();
    }
    expect(accountScript.sockets[2]?.url).toBe("wss://relay-two.example/connect/machine-key?ready=2");
    expect(accountScript.sockets[2]?.sent[0]?.payload).toMatchObject({
      auth: {
        kind: "paired",
        secret: "stored-paired-secret",
        dpop: expect.any(Object),
        relayAccountToken: accountToken,
      },
    });
    expect(accountClient.getStatus().state).toBe("connected");
    accountClient.dispose();
  });

  it("does not reuse another account's saved browser credentials", async () => {
    const storage = new MemoryStorage();
    const foreign = await makeEnvironment(storage, {
      envId: "foreign-env",
      accountOwnerUserId: "account-a",
      localDeviceId: "account-a-local-device",
      pairedDeviceId: "account-a-paired-device",
      secret: "account-a-secret",
    });
    let accountDeviceId: string | null = null;
    const script = createSocketFactory((socket, envelope) => {
      if (envelope.type !== "hello") return;
      const payload = envelope.payload as {
        auth: { kind: string; deviceId: string };
      };
      accountDeviceId = payload.auth.deviceId;
      socket.serverSend({
        type: "hello_ok",
        requestId: envelope.requestId,
        payload: {
          ...helloOk(),
          accountPairing: {
            deviceId: payload.auth.deviceId,
            secret: "account-b-secret",
          },
        },
      });
    });
    const client = new AdeSyncClient({
      storage,
      socketFactory: script.factory,
      document: null,
    });

    const paired = await client.pairWithAccountMachine({
      machine: {
        machineKey: "machine-key",
        deviceId: hostPeer.deviceId,
        name: hostPeer.deviceName,
        platform: "macOS",
        deviceType: "desktop",
        reachableEndpoints: [{
          kind: "relay",
          url: "wss://relay.example/connect/machine-key",
        }],
        lastSeenAt: Date.now(),
        online: true,
      },
      accessToken: "account-b-token",
      accountSessionLease: { userId: "account-b", generation: 2 },
      isAccountSessionLeaseCurrent: () => true,
      deviceName: "ADE Browser",
      relayBaseUrls: ["https://relay.example"],
    });

    expect(accountDeviceId).not.toBe(foreign.localDeviceId);
    expect(paired.envId).not.toBe(foreign.envId);
    expect(paired.secret).toBe("account-b-secret");
    expect(paired.accountOwnerUserId).toBe("account-b");
    expect(await client.listEnvironments()).toHaveLength(2);
    client.dispose();
  });

  it.each([
    { transition: "sign-out", nextLease: null },
    { transition: "account switch", nextLease: { userId: "account-user-2", generation: 2 } },
  ])("rejects a deferred account hello after $transition without saving trust", async ({ nextLease }) => {
    const storage = new MemoryStorage();
    let currentLease: { userId: string; generation: number } | null = {
      userId: "account-user-1",
      generation: 1,
    };
    let releaseHello: (() => void) | null = null;
    const script = createSocketFactory((socket, envelope) => {
      if (envelope.type !== "hello") return;
      const peer = (envelope.payload as { peer: SyncPeerMetadata }).peer;
      releaseHello = () => socket.serverSend({
        type: "hello_ok",
        requestId: envelope.requestId,
        payload: {
          ...helloOk(),
          accountPairing: {
            deviceId: peer.deviceId,
            secret: "must-not-be-saved",
          },
        },
      });
    });
    const client = new AdeSyncClient({ storage, socketFactory: script.factory, document: null });
    const pairing = client.pairWithAccountMachine({
      machine: {
        machineKey: "machine-key",
        deviceId: hostPeer.deviceId,
        name: hostPeer.deviceName,
        platform: "macOS",
        deviceType: "desktop",
        reachableEndpoints: [{
          kind: "relay",
          url: "wss://relay.example/connect/machine-key",
        }],
        lastSeenAt: Date.now(),
        online: true,
      },
      accessToken: "account-token",
      accountSessionLease: currentLease,
      isAccountSessionLeaseCurrent: (lease) => currentLease?.userId === lease.userId
        && currentLease.generation === lease.generation,
      deviceName: "ADE Browser",
      relayBaseUrls: ["https://relay.example"],
    });

    for (let attempt = 0; attempt < 20 && script.sockets[0]?.readyState !== 1; attempt += 1) await flush();
    expect(script.sockets[0]?.readyState).toBe(1);
    script.sockets[0]?.serverTransportSend({ t: "accepted", v: 2 });
    script.sockets[0]?.serverTransportSend({ t: "ready", v: 2 });
    for (let attempt = 0; attempt < 20 && !releaseHello; attempt += 1) await flush();
    expect(releaseHello).not.toBeNull();
    currentLease = nextLease;
    releaseHello!();

    await expect(pairing).rejects.toMatchObject({ code: "account_session_changed" });
    expect(await client.listEnvironments()).toEqual([]);
    expect(client.getStatus().state).toBe("disconnected");
    client.dispose();
  });

  it("rejects an ordinary paired hello from a different host identity", async () => {
    const storage = new MemoryStorage();
    const environment = await makeEnvironment(storage, {
      relayUrl: null,
      machineKeyUrl: null,
      lastGoodEndpoint: null,
      addressCandidates: [],
      port: 0,
      explicitWssEndpoints: ["wss://stale-route.example/sync"],
    });
    const script = createSocketFactory((socket, envelope) => {
      if (envelope.type !== "hello") return;
      socket.serverSend({
        type: "hello_ok",
        requestId: envelope.requestId,
        payload: {
          ...helloOk(),
          brain: { ...hostPeer, deviceId: "different-host" },
        },
      });
    });
    const client = new AdeSyncClient({ storage, socketFactory: script.factory, document: null });

    await expect(client.connect(environment.envId, signedInRelayAccess)).rejects.toThrow(/identity.*stored pairing/i);
    expect(client.getStatus().state).not.toBe("connected");
    client.dispose();
  });

  it("fails closed without opening a socket when the directory has no WSS relay route", async () => {
    const storage = new MemoryStorage();
    const script = createSocketFactory(() => {
      throw new Error("account bearer must not reach this socket");
    });
    const client = new AdeSyncClient({ storage, socketFactory: script.factory, document: null });

    await expect(client.pairWithAccountMachine({
      machine: {
        machineKey: "hostile",
        deviceId: hostPeer.deviceId,
        name: "Hostile",
        platform: "macOS",
        deviceType: "desktop",
        reachableEndpoints: [
          { kind: "relay", url: "ws://relay.example/connect/hostile" },
          { kind: "lan", url: "wss://arbitrary-origin.example/sync" },
          { kind: "relay", url: "wss://arbitrary-origin.example/connect/hostile" },
          { kind: "relay", url: "wss://relay.example/connect/hostile?bearer=steal" },
        ],
        lastSeenAt: Date.now(),
        online: true,
      },
      accessToken: "account-token",
      accountSessionLease: currentAccountSessionLease,
      isAccountSessionLeaseCurrent: () => true,
      deviceName: "ADE Browser",
      relayBaseUrls: ["https://allowed-relay.example"],
    })).rejects.toMatchObject({ code: "secure_relay_unavailable" });
    expect(script.sockets).toHaveLength(0);
    client.dispose();
  });

  it("ignores unknown rpc/fwd envelopes without disconnecting the browser client", async () => {
    const storage = new MemoryStorage();
    const environment = await makeEnvironment(storage);
    const script = createSocketFactory((socket, envelope) => {
      if (envelope.type === "hello") {
        socket.serverSend({
          type: "hello_ok",
          requestId: envelope.requestId,
          payload: helloOk(),
        });
      }
    });
    const client = new AdeSyncClient({
      storage,
      socketFactory: script.factory,
      document: null,
    });

    const connecting = client.connect(environment.envId, signedInRelayAccess);
    const socket = await completeRelayReadyV2AfterOpen(script.sockets, 0);
    await connecting;
    socket.serverSend({
      type: "rpc_open",
      payload: { channelId: "desktop-only-rpc" },
    });
    socket.serverSend({
      type: "fwd_data",
      payload: { forwardId: "desktop-only-forward", data: "YQ==" },
    });
    await flush();

    expect(client.getStatus().state).toBe("connected");
    expect(socket.readyState).toBe(1);
    expect(socket.sent.map((envelope) => envelope.type)).toEqual(["hello"]);
    client.dispose();
  });

  it("drops stored pairing only for attributed auth failures", async () => {
    const attributedStorage = new MemoryStorage();
    const attributedEnv = await makeEnvironment(attributedStorage, {
      addressCandidates: [],
      lastGoodEndpoint: null,
      port: 0,
    });
    const attributedScript = createSocketFactory((socket, envelope) => {
      if (envelope.type === "hello") {
        socket.serverSend({
          type: "hello_error",
          requestId: envelope.requestId,
          payload: {
            code: "auth_failed",
            message: "Revoked",
            host: { deviceId: hostPeer.deviceId, name: "Studio Mac" },
          },
        });
      }
    });
    const attributedClient = new AdeSyncClient({ storage: attributedStorage, socketFactory: attributedScript.factory, document: null });
    await expect(attributedClient.connect(attributedEnv.envId, signedInRelayAccess)).rejects.toThrow("Revoked");
    await flush();
    expect(await attributedClient.listEnvironments()).toHaveLength(0);
    attributedClient.dispose();

    const ambiguousStorage = new MemoryStorage();
    const ambiguousEnv = await makeEnvironment(ambiguousStorage, {
      addressCandidates: [],
      lastGoodEndpoint: null,
      port: 0,
    });
    const ambiguousScript = createSocketFactory((socket, envelope) => {
      if (envelope.type === "hello") {
        socket.serverSend({
          type: "hello_error",
          requestId: envelope.requestId,
          payload: {
            code: "auth_failed",
            message: "Wrong machine",
            host: { deviceId: "other-host", name: "Other Mac" },
          },
        });
      }
    });
    const ambiguousClient = new AdeSyncClient({ storage: ambiguousStorage, socketFactory: ambiguousScript.factory, document: null });
    await expect(ambiguousClient.connect(ambiguousEnv.envId, signedInRelayAccess)).rejects.toThrow("Wrong machine");
    expect(await ambiguousClient.listEnvironments()).toHaveLength(1);
    ambiguousClient.dispose();
  });

  it("stops reconnecting and emits auth_failed after repeated unattributed auth failures", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const storage = new MemoryStorage();
    const environment = await makeEnvironment(storage, { addressCandidates: [], port: 0, dpopPublicKeyX963: null });
    const states: string[] = [];
    let helloAttempts = 0;
    const script = createSocketFactory((socket, envelope) => {
      if (envelope.type === "hello") {
        helloAttempts += 1;
        socket.serverSend({
          type: "hello_error",
          requestId: envelope.requestId,
          payload: {
            code: "auth_failed",
            message: "Browser peer type is not recognized.",
          },
        });
      }
    });
    const client = new AdeSyncClient({ storage, socketFactory: script.factory, document: null });
    client.subscribe((status) => states.push(status.state));

    const initialConnect = client.connect(environment.envId, signedInRelayAccess).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    completeRelayReadyV2(script.sockets[0]);
    await flushMicrotasks();

    await expect(initialConnect).resolves.toBeInstanceOf(Error);
    for (let tick = 0; tick < 60 && client.getStatus().state !== "auth_failed"; tick += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(0);
      completeRelayReadyV2(script.sockets.at(-1));
      await flushMicrotasks();
    }

    expect(helloAttempts).toBe(5);
    expect(states).toContain("auth_failed");
    expect(client.getStatus()).toMatchObject({
      state: "auth_failed",
      selectedEnvId: environment.envId,
    });

    const socketCountAfterTerminalFailure = script.sockets.length;
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();
    expect(helloAttempts).toBe(5);
    expect(script.sockets).toHaveLength(socketCountAfterTerminalFailure);
    expect(await client.listEnvironments()).toHaveLength(1);
    client.dispose();
  });

  it("resubscribes chat and terminal streams with watermarks after reconnect", async () => {
    const storage = new MemoryStorage();
    const environment = await makeEnvironment(storage);
    const sentBySocket: SyncEnvelope[][] = [];
    const script = createSocketFactory((socket, envelope) => {
      if (!sentBySocket.includes(socket.sent)) sentBySocket.push(socket.sent);
      if (envelope.type === "hello") {
        socket.serverSend({ type: "hello_ok", requestId: envelope.requestId, payload: helloOk() });
      }
      if (envelope.type === "chat_subscribe" && !("sinceSeq" in (envelope.payload as object))) {
        socket.serverSend({
          type: "chat_subscribe",
          requestId: envelope.requestId,
          payload: {
            sessionId: "chat-1",
            capturedAt: new Date().toISOString(),
            truncated: false,
            events: [{ type: "status", sessionId: "chat-1", status: "running", seq: 5 }],
          },
        });
      }
      if (envelope.type === "terminal_subscribe" && !("sinceOffset" in (envelope.payload as object))) {
        socket.serverSend({
          type: "terminal_snapshot",
          requestId: envelope.requestId,
          payload: {
            sessionId: "term-1",
            transcript: "hello",
            status: "running",
            runtimeState: "running",
            lastOutputPreview: "hello",
            capturedAt: new Date().toISOString(),
            startOffset: 37,
            endOffset: 42,
            live: true,
          },
        });
      }
    });
    const client = new AdeSyncClient({ storage, socketFactory: script.factory, document: null });

    const initialConnect = client.connect(environment.envId, signedInRelayAccess);
    await completeRelayReadyV2AfterOpen(script.sockets, 0);
    await initialConnect;
    client.subscribeChat("chat-1", {}, {});
    client.subscribeTerminal("term-1", {}, {});
    await flush();
    script.sockets[0].close(1006, "network");
    const reconnect = client.connect(environment.envId, signedInRelayAccess);
    await completeRelayReadyV2AfterOpen(script.sockets, 1);
    await reconnect;
    await flush();

    const resent = script.sockets[1].sent;
    expect(resent.find((envelope) => envelope.type === "chat_subscribe")?.payload).toMatchObject({
      sessionId: "chat-1",
      sinceSeq: 5,
    });
    expect(resent.find((envelope) => envelope.type === "terminal_subscribe")?.payload).toMatchObject({
      sessionId: "term-1",
      sinceOffset: 42,
    });
    client.dispose();
  });

  it("retires old project streams and subscribes only newly requested streams after switching", async () => {
    const storage = new MemoryStorage();
    const environment = await makeEnvironment(storage);
    let helloProjectId = "project-1";
    const projectTwo = {
      ...helloOk("project-2").projects![0],
      displayName: "ADE Docs",
      rootPath: "/repo/docs",
    };
    const script = createSocketFactory((socket, envelope) => {
      if (envelope.type === "hello") {
        socket.serverSend({ type: "hello_ok", requestId: envelope.requestId, payload: helloOk(helloProjectId) });
      }
      if (envelope.type === "project_switch_request") {
        helloProjectId = "project-2";
        socket.serverSend({
          type: "project_switch_result",
          requestId: envelope.requestId,
          payload: { ok: true, project: projectTwo },
        });
      }
    });
    const client = new AdeSyncClient({ storage, socketFactory: script.factory, document: null });

    const initialConnect = client.connect(environment.envId, signedInRelayAccess);
    await completeRelayReadyV2AfterOpen(script.sockets, 0);
    await initialConnect;
    client.subscribeChat("chat-1", {}, {});
    client.subscribeTerminal("term-1", {}, {});
    await flush();

    const switching = client.switchProject("project-2");
    await completeRelayReadyV2AfterOpen(script.sockets, 1);
    await switching;
    await flush();

    expect(script.sockets).toHaveLength(2);
    expect(script.sockets[0].sent.some((envelope) => envelope.type === "chat_subscribe")).toBe(true);
    expect(script.sockets[0].sent.some((envelope) => envelope.type === "terminal_subscribe")).toBe(true);
    expect(script.sockets[1].sent.some((envelope) => envelope.type === "chat_subscribe")).toBe(false);
    expect(script.sockets[1].sent.some((envelope) => envelope.type === "terminal_subscribe")).toBe(false);

    client.subscribeChat("chat-2", {}, {});
    client.subscribeTerminal("term-2", {}, {});
    await flush();
    expect(script.sockets[1].sent.find((envelope) => envelope.type === "chat_subscribe")).toMatchObject({
      projectId: "project-2",
      payload: { sessionId: "chat-2" },
    });
    expect(script.sockets[1].sent.find((envelope) => envelope.type === "terminal_subscribe")).toMatchObject({
      projectId: "project-2",
      payload: { sessionId: "term-2" },
    });

    client.dispose();
  });

  it("rebinds /chats foreign streams while retiring active streams on a same-socket project boundary", async () => {
    const storage = new MemoryStorage();
    const environment = await makeEnvironment(storage);
    const commandProjectIds: Array<string | null | undefined> = [];
    const script = createSocketFactory((socket, envelope) => {
      if (envelope.type === "hello") {
        socket.serverSend({ type: "hello_ok", requestId: envelope.requestId, payload: helloOk("project-1") });
      }
      if (envelope.type === "command") {
        commandProjectIds.push(envelope.projectId);
        const { commandId } = envelope.payload as { commandId: string };
        socket.serverSend({
          type: "command_result",
          requestId: envelope.requestId,
          payload: { commandId, ok: true, result: { projectId: envelope.projectId } },
        });
      }
    });
    const client = new AdeSyncClient({ storage, socketFactory: script.factory, document: null });
    const changes: Array<{ previousProjectId: string | null; projectId: string }> = [];
    const deliveredChatSessionIds: string[] = [];
    client.onActiveProjectChanged(({ previousProjectId, project }) => {
      changes.push({ previousProjectId, projectId: project.id });
    });
    client.onChatEvent((payload) => deliveredChatSessionIds.push(payload.sessionId));

    const connecting = client.connect(environment.envId, signedInRelayAccess);
    await completeRelayReadyV2AfterOpen(script.sockets, 0);
    await connecting;
    client.subscribeChat("project-chat", {}, {});
    client.subscribeChat("personal-chat", { chatScope: "personal" }, {});
    client.subscribeChat("foreign-chat", {
      projectId: "project-foreign",
      projectRootPath: "/repo-foreign",
    }, {});
    client.subscribeTerminal("project-terminal", {}, {});
    await flush();
    script.sockets[0]?.serverSend({
      type: "chat_event",
      payload: {
        sessionId: "foreign-chat",
        timestamp: new Date().toISOString(),
        seq: 9,
        event: { type: "foreign-event-before-handoff" },
      },
    } as never);
    await flush();
    deliveredChatSessionIds.length = 0;

    const projectOne = { ...helloOk("project-1").projects![0], isOpen: false };
    const projectTwo = {
      ...helloOk("project-2").projects![0],
      displayName: "Repo Two",
      rootPath: "/repo-2",
      isOpen: true,
    };
    script.sockets[0]?.serverSend({
      type: "project_catalog",
      payload: { projects: [projectOne, projectTwo] },
    });
    await flush();

    expect(script.sockets).toHaveLength(1);
    expect(client.getStatus().activeProjectId).toBe("project-2");
    expect(changes).toEqual([{ previousProjectId: "project-1", projectId: "project-2" }]);
    expect(script.sockets[0].sent.filter((envelope) => (
      envelope.type === "chat_subscribe"
      && (envelope.payload as { sessionId?: string }).sessionId === "project-chat"
    ))).toEqual([expect.objectContaining({ projectId: "project-1" })]);
    expect(script.sockets[0].sent.filter((envelope) => (
      envelope.type === "chat_unsubscribe"
      && (envelope.payload as { sessionId?: string }).sessionId === "project-chat"
    ))).toEqual([expect.objectContaining({ projectId: "project-2" })]);
    expect(script.sockets[0].sent.filter((envelope) => (
      envelope.type === "chat_subscribe"
      && (envelope.payload as { sessionId?: string }).sessionId === "personal-chat"
    ))).toHaveLength(1);
    expect(script.sockets[0].sent.some((envelope) => (
      envelope.type === "chat_unsubscribe"
      && (envelope.payload as { sessionId?: string }).sessionId === "personal-chat"
    ))).toBe(false);
    expect(script.sockets[0].sent.find((envelope) => (
      envelope.type === "chat_subscribe"
      && (envelope.payload as { sessionId?: string }).sessionId === "personal-chat"
    ))?.projectId).toBeUndefined();
    const foreignSubscriptions = script.sockets[0].sent.filter((envelope) => (
      envelope.type === "chat_subscribe"
      && (envelope.payload as { sessionId?: string }).sessionId === "foreign-chat"
    ));
    expect(foreignSubscriptions).toHaveLength(2);
    expect(foreignSubscriptions).toEqual([
      expect.objectContaining({ projectId: "project-foreign" }),
      expect.objectContaining({ projectId: "project-foreign" }),
    ]);
    expect(foreignSubscriptions[1]?.payload).toMatchObject({
      sessionId: "foreign-chat",
      projectId: "project-foreign",
      projectRootPath: "/repo-foreign",
    });
    expect(foreignSubscriptions[1]?.payload).not.toHaveProperty("sinceSeq");
    expect(script.sockets[0].sent.some((envelope) => (
      envelope.type === "chat_unsubscribe"
      && (envelope.payload as { sessionId?: string }).sessionId === "foreign-chat"
    ))).toBe(false);
    expect(script.sockets[0].sent.filter((envelope) => envelope.type === "terminal_subscribe")).toEqual([
      expect.objectContaining({ projectId: "project-1" }),
    ]);
    expect(script.sockets[0].sent.filter((envelope) => envelope.type === "terminal_unsubscribe")).toEqual([
      expect.objectContaining({
        projectId: "project-2",
        payload: { sessionId: "project-terminal" },
      }),
    ]);

    script.sockets[0]?.serverSend({
      type: "chat_event",
      payload: {
        sessionId: "project-chat",
        timestamp: new Date().toISOString(),
        event: { type: "late-old-project-event" },
      },
    } as never);
    script.sockets[0]?.serverSend({
      type: "chat_event",
      payload: {
        sessionId: "personal-chat",
        timestamp: new Date().toISOString(),
        event: { type: "personal-event" },
      },
    } as never);
    await flush();
    expect(deliveredChatSessionIds).toEqual(["personal-chat"]);

    client.subscribeChat("new-project-chat", {}, {});
    client.subscribeTerminal("new-project-terminal", {}, {});
    await flush();
    expect(script.sockets[0].sent.find((envelope) => (
      envelope.type === "chat_subscribe"
      && (envelope.payload as { sessionId?: string }).sessionId === "new-project-chat"
    ))).toMatchObject({ projectId: "project-2" });
    expect(script.sockets[0].sent.find((envelope) => (
      envelope.type === "terminal_subscribe"
      && (envelope.payload as { sessionId?: string }).sessionId === "new-project-terminal"
    ))).toMatchObject({ projectId: "project-2" });

    await expect(client.sendCommand("chat.send", { text: "new project" })).resolves.toEqual({
      projectId: "project-2",
    });
    expect(commandProjectIds).toEqual(["project-2"]);
    await flush();
    await expect(new WebClientEnvStore(storage).getEnvironment(environment.envId)).resolves.toMatchObject({
      activeProjectId: "project-2",
    });

    client.dispose();
  });

  it("preserves wire order while a compressed project boundary is decoding", async () => {
    const storage = new MemoryStorage();
    const environment = await makeEnvironment(storage);
    const script = createSocketFactory((socket, envelope) => {
      if (envelope.type === "hello") {
        socket.serverSend({ type: "hello_ok", requestId: envelope.requestId, payload: helloOk("project-1") });
      }
    });
    const client = new AdeSyncClient({ storage, socketFactory: script.factory, document: null });
    const delivered: string[] = [];

    const connecting = client.connect(environment.envId, signedInRelayAccess);
    await completeRelayReadyV2AfterOpen(script.sockets, 0);
    await connecting;
    client.subscribeChat("old-project-chat", {}, {
      event: (payload) => delivered.push(String((payload.event as { type?: unknown }).type ?? "")),
    });
    await flush();

    const projectOne = { ...helloOk("project-1").projects![0], isOpen: false };
    const projectTwo = {
      ...helloOk("project-2").projects![0],
      displayName: `Repo Two ${"x".repeat(50_000)}`,
      rootPath: "/repo-2",
      isOpen: true,
    };
    script.sockets[0]?.onmessage?.({
      data: encodeSyncEnvelope({
        type: "project_catalog",
        payload: { projects: [projectOne, projectTwo] },
        compressionThresholdBytes: 0,
      }),
    } as MessageEvent<string>);
    script.sockets[0]?.serverSend({
      type: "chat_event",
      payload: {
        sessionId: "old-project-chat",
        timestamp: new Date().toISOString(),
        seq: 1,
        event: { type: "late-old-project-event" },
      },
    } as never);

    for (let attempt = 0; attempt < 20 && client.getStatus().activeProjectId !== "project-2"; attempt += 1) {
      await flush();
    }
    expect(client.getStatus().activeProjectId).toBe("project-2");
    expect(delivered).toEqual([]);
    client.dispose();
  });

  it("continues the ordered inbound queue after one malformed envelope", async () => {
    const environment = await makeEnvironment(new MemoryStorage(), { dpopPublicKeyX963: null });
    const script = createSocketFactory((socket, envelope) => {
      if (envelope.type === "hello") {
        socket.serverSend({ type: "hello_ok", requestId: envelope.requestId, payload: helloOk() });
      }
    });
    const connection = new SyncConnection({ socketFactory: script.factory, document: null });
    const statuses: SyncBrainStatusPayload[] = [];
    connection.on("brainStatus", (payload) => statuses.push(payload));
    await connection.connect(environment, [
      { url: "ws://127.0.0.1:8787", kind: "loopback", dialable: true },
    ]);

    script.sockets[0]?.onmessage?.({ data: "{not-json" } as MessageEvent<string>);
    script.sockets[0]?.serverSend({
      type: "brain_status",
      payload: { state: "ready" },
    });
    await flushMicrotasks();

    expect(statuses).toEqual([{ state: "ready" }]);
    expect(connection.getStatus().state).toBe("connected");
    connection.dispose();
  });

  it("persists rapid project boundaries in arrival order", async () => {
    const storage = new DelayedPutStorage();
    const environment = await makeEnvironment(storage);
    const script = createSocketFactory((socket, envelope) => {
      if (envelope.type === "hello") {
        socket.serverSend({ type: "hello_ok", requestId: envelope.requestId, payload: helloOk("project-1") });
      }
    });
    const client = new AdeSyncClient({ storage, socketFactory: script.factory, document: null });
    const connecting = client.connect(environment.envId, signedInRelayAccess);
    await completeRelayReadyV2AfterOpen(script.sockets, 0);
    await connecting;
    await flush();

    storage.delayNextEnvironmentPut = true;
    script.sockets[0]?.serverSend({
      type: "project_catalog",
      payload: { projects: [{ ...helloOk("project-2").projects![0], isOpen: true }] },
    });
    await storage.waitForPausedPut();
    script.sockets[0]?.serverSend({
      type: "project_catalog",
      payload: { projects: [{ ...helloOk("project-3").projects![0], isOpen: true }] },
    });
    await flush();
    storage.resumePausedPut();
    for (let attempt = 0; attempt < 10; attempt += 1) await flush();

    expect(client.getStatus().activeProjectId).toBe("project-3");
    await expect(new WebClientEnvStore(storage).getEnvironment(environment.envId)).resolves.toMatchObject({
      activeProjectId: "project-3",
    });
    client.dispose();
  });

  it("publishes the same project boundary when reconnect hello opens a different project", async () => {
    const storage = new MemoryStorage();
    const environment = await makeEnvironment(storage);
    let helloProjectId = "project-1";
    const script = createSocketFactory((socket, envelope) => {
      if (envelope.type === "hello") {
        socket.serverSend({
          type: "hello_ok",
          requestId: envelope.requestId,
          payload: helloOk(helloProjectId),
        });
      }
    });
    const client = new AdeSyncClient({ storage, socketFactory: script.factory, document: null });
    const changes: Array<{ previousProjectId: string | null; projectId: string }> = [];
    client.onActiveProjectChanged(({ previousProjectId, project }) => {
      changes.push({ previousProjectId, projectId: project.id });
    });

    const initialConnect = client.connect(environment.envId, signedInRelayAccess);
    await completeRelayReadyV2AfterOpen(script.sockets, 0);
    await initialConnect;
    client.subscribeChat("old-project-chat", {}, {});
    client.subscribeChat("personal-chat", { chatScope: "personal" }, {});
    client.subscribeTerminal("old-project-terminal", {}, {});
    await flush();

    script.sockets[0]?.close(1006, "listener handoff");
    helloProjectId = "project-2";
    const reconnect = client.connect(environment.envId, signedInRelayAccess);
    await completeRelayReadyV2AfterOpen(script.sockets, 1);
    await reconnect;
    await flush();

    expect(client.getStatus().activeProjectId).toBe("project-2");
    expect(changes).toContainEqual({ previousProjectId: "project-1", projectId: "project-2" });
    expect(script.sockets[1].sent.some((envelope) => (
      envelope.type === "chat_subscribe"
      && (envelope.payload as { sessionId?: string }).sessionId === "old-project-chat"
    ))).toBe(false);
    expect(script.sockets[1].sent.some((envelope) => envelope.type === "terminal_subscribe")).toBe(false);
    expect(script.sockets[1].sent.find((envelope) => (
      envelope.type === "chat_subscribe"
      && (envelope.payload as { sessionId?: string }).sessionId === "personal-chat"
    ))?.projectId).toBeUndefined();

    client.dispose();
  });

  it("queues stream subscriptions attempted during project switch for the new project", async () => {
    const storage = new DelayedPutStorage();
    const environment = await makeEnvironment(storage);
    let helloProjectId = "project-1";
    const projectTwo = {
      ...helloOk("project-2").projects![0],
      displayName: "ADE Docs",
      rootPath: "/repo/docs",
    };
    const script = createSocketFactory((socket, envelope) => {
      if (envelope.type === "hello") {
        socket.serverSend({ type: "hello_ok", requestId: envelope.requestId, payload: helloOk(helloProjectId) });
      }
      if (envelope.type === "project_switch_request") {
        helloProjectId = "project-2";
        socket.serverSend({
          type: "project_switch_result",
          requestId: envelope.requestId,
          payload: { ok: true, project: projectTwo },
        });
      }
    });
    const client = new AdeSyncClient({ storage, socketFactory: script.factory, document: null });

    const initialConnect = client.connect(environment.envId, signedInRelayAccess);
    await completeRelayReadyV2AfterOpen(script.sockets, 0);
    await initialConnect;
    storage.delayNextEnvironmentPut = true;
    const switchPromise = client.switchProject("project-2");
    await storage.waitForPausedPut();
    client.subscribeChat("old-chat", {}, {});
    client.subscribeTerminal("old-term", {}, {});
    storage.resumePausedPut();
    await completeRelayReadyV2AfterOpen(script.sockets, 1);
    await switchPromise;
    await flush();

    expect(script.sockets).toHaveLength(2);
    expect(script.sockets[1].sent.find((envelope) => envelope.type === "chat_subscribe")).toMatchObject({
      projectId: "project-2",
      payload: { sessionId: "old-chat" },
    });
    expect(script.sockets[1].sent.find((envelope) => envelope.type === "terminal_subscribe")).toMatchObject({
      projectId: "project-2",
      payload: { sessionId: "old-term" },
    });

    client.dispose();
  });

  it("retries acknowledged terminal input in order with stable dedupe ids and preserves old-host payloads", async () => {
    vi.useFakeTimers();
    const storage = new MemoryStorage();
    const environment = await makeEnvironment(storage);
    const received: Array<{ sessionId: string; data: string; inputId?: string }> = [];
    const script = createSocketFactory((socket, envelope) => {
      if (envelope.type === "hello") {
        socket.serverSend({
          type: "hello_ok",
          requestId: envelope.requestId,
          payload: helloOkWithTerminalInputAck(),
        });
      }
      if (envelope.type !== "terminal_input") return;
      const input = envelope.payload as { sessionId: string; data: string; inputId?: string };
      received.push(input);
      if (input.data === "rejected") {
        socket.serverSend({
          type: "terminal_input_ack",
          requestId: envelope.requestId,
          payload: {
            sessionId: input.sessionId,
            inputId: input.inputId,
            ok: false,
            duplicate: false,
            error: {
              code: "project_mismatch",
              message: "Terminal belongs to another project.",
              retryable: false,
            },
          },
        } as never);
        return;
      }
      const attemptsForInput = received.filter((entry) => entry.inputId === input.inputId).length;
      if (input.data === "first" && attemptsForInput < 2) return;
      socket.serverSend({
        type: "terminal_input_ack",
        requestId: envelope.requestId,
        payload: {
          sessionId: input.sessionId,
          inputId: input.inputId,
          ok: true,
          duplicate: attemptsForInput > 1,
        },
      } as never);
    });
    const client = new AdeSyncClient({
      storage,
      socketFactory: script.factory,
      document: null,
      terminalInputAckTimeoutMs: 100,
      terminalInputMaxAttempts: 3,
    });
    const connecting = client.connect(environment.envId, signedInRelayAccess);
    await vi.advanceTimersByTimeAsync(0);
    script.sockets[0]?.serverTransportSend({ t: "accepted", v: 2 });
    script.sockets[0]?.serverTransportSend({ t: "ready", v: 2 });
    await connecting;

    const first = client.sendTerminalInput("term-1", "first");
    const second = client.sendTerminalInput("term-1", "second");
    await flushMicrotasks();
    expect(received.map((entry) => entry.data)).toEqual(["first"]);

    await vi.advanceTimersByTimeAsync(100);
    await flushMicrotasks();
    await Promise.all([first, second]);
    expect(received.map((entry) => entry.data)).toEqual(["first", "first", "second"]);
    expect(received[0]?.inputId).toBeTruthy();
    expect(received[1]?.inputId).toBe(received[0]?.inputId);
    expect(received[2]?.inputId).not.toBe(received[0]?.inputId);

    await expect(client.sendTerminalInput("term-1", "rejected")).rejects.toMatchObject({
      code: "terminal_input_project_mismatch",
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(received.filter((entry) => entry.data === "rejected")).toHaveLength(1);
    client.dispose();

    const oldHostStorage = new MemoryStorage();
    const oldHostEnvironment = await makeEnvironment(oldHostStorage);
    const oldHostScript = createSocketFactory((socket, envelope) => {
      if (envelope.type === "hello") {
        socket.serverSend({ type: "hello_ok", requestId: envelope.requestId, payload: helloOk() });
      }
    });
    const oldHostClient = new AdeSyncClient({
      storage: oldHostStorage,
      socketFactory: oldHostScript.factory,
      document: null,
    });
    const oldHostConnect = oldHostClient.connect(oldHostEnvironment.envId, signedInRelayAccess);
    await vi.advanceTimersByTimeAsync(0);
    oldHostScript.sockets[0]?.serverTransportSend({ t: "accepted", v: 2 });
    oldHostScript.sockets[0]?.serverTransportSend({ t: "ready", v: 2 });
    await oldHostConnect;
    await oldHostClient.sendTerminalInput("term-old", "legacy");
    await flushMicrotasks();
    expect(oldHostScript.sockets[0]?.sent.find((envelope) => envelope.type === "terminal_input")?.payload).toEqual({
      sessionId: "term-old",
      data: "legacy",
    });
    oldHostClient.dispose();
  });

  it("restores the terminal subscription before replaying queued input after reconnect", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const storage = new MemoryStorage();
    const environment = await makeEnvironment(storage);
    let firstSocket: ScriptedSocket | null = null;
    const inputIds: string[] = [];
    const script = createSocketFactory((socket, envelope) => {
      if (envelope.type === "hello") {
        firstSocket ??= socket;
        socket.serverSend({
          type: "hello_ok",
          requestId: envelope.requestId,
          payload: helloOkWithTerminalInputAck(),
        });
      }
      if (envelope.type !== "terminal_input") return;
      const input = envelope.payload as unknown as { sessionId: string; inputId: string };
      inputIds.push(input.inputId);
      if (socket === firstSocket) {
        socket.close(1006, "network");
        return;
      }
      socket.serverSend({
        type: "terminal_input_ack",
        requestId: envelope.requestId,
        payload: {
          sessionId: input.sessionId,
          inputId: input.inputId,
          ok: true,
          duplicate: true,
        },
      } as never);
    });
    const client = new AdeSyncClient({
      storage,
      socketFactory: script.factory,
      document: null,
      terminalInputAckTimeoutMs: 100,
    });
    const connecting = client.connect(environment.envId, signedInRelayAccess);
    await vi.advanceTimersByTimeAsync(0);
    script.sockets[0]?.serverTransportSend({ t: "accepted", v: 2 });
    script.sockets[0]?.serverTransportSend({ t: "ready", v: 2 });
    await connecting;

    client.subscribeTerminal("term-1", {}, {});
    const input = client.sendTerminalInput("term-1", "pwd\n");
    await flushMicrotasks();
    expect(script.sockets).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1_001);
    await vi.advanceTimersByTimeAsync(0);
    script.sockets[1]?.serverTransportSend({ t: "accepted", v: 2 });
    script.sockets[1]?.serverTransportSend({ t: "ready", v: 2 });
    await flushMicrotasks();
    expect(script.sockets).toHaveLength(2);
    await input;

    const replayOrder = script.sockets[1].sent.map((envelope) => envelope.type);
    expect(replayOrder.indexOf("terminal_subscribe")).toBeGreaterThanOrEqual(0);
    expect(replayOrder.indexOf("terminal_subscribe")).toBeLessThan(replayOrder.indexOf("terminal_input"));
    expect(inputIds).toHaveLength(2);
    expect(inputIds[1]).toBe(inputIds[0]);
    expect(client.getStatus()).toMatchObject({ state: "connected", readiness: "ready" });
    client.dispose();
  });

  it("rejects a malformed terminal input acknowledgement and advances the queue", async () => {
    const storage = new MemoryStorage();
    const environment = await makeEnvironment(storage);
    const received: string[] = [];
    const script = createSocketFactory((socket, envelope) => {
      if (envelope.type === "hello") {
        socket.serverSend({
          type: "hello_ok",
          requestId: envelope.requestId,
          payload: helloOkWithTerminalInputAck(),
        });
      }
      if (envelope.type !== "terminal_input") return;
      const input = envelope.payload as { sessionId: string; data: string; inputId: string };
      received.push(input.data);
      socket.serverSend({
        type: "terminal_input_ack",
        requestId: envelope.requestId,
        payload: input.data === "malformed"
          ? {
              sessionId: input.sessionId,
              inputId: input.inputId,
              ok: false,
              duplicate: false,
            }
          : {
              sessionId: input.sessionId,
              inputId: input.inputId,
              ok: true,
              duplicate: false,
            },
      } as never);
    });
    const client = new AdeSyncClient({ storage, socketFactory: script.factory, document: null });
    const connecting = client.connect(environment.envId, signedInRelayAccess);
    await completeRelayReadyV2AfterOpen(script.sockets, 0);
    await connecting;

    const malformed = client.sendTerminalInput("term-1", "malformed");
    const next = client.sendTerminalInput("term-1", "next");
    await expect(malformed).rejects.toMatchObject({ code: "terminal_input_invalid_ack" });
    await expect(next).resolves.toBeUndefined();
    expect(received).toEqual(["malformed", "next"]);

    client.dispose();
  });

  it("expires unconfirmed terminal input while the connection remains down", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const storage = new MemoryStorage();
    const environment = await makeEnvironment(storage);
    const script = createSocketFactory((socket, envelope) => {
      if (envelope.type === "hello") {
        socket.serverSend({
          type: "hello_ok",
          requestId: envelope.requestId,
          payload: helloOkWithTerminalInputAck("project-1", 250),
        });
      }
      if (envelope.type === "terminal_input") socket.close(1006, "network");
    });
    const client = new AdeSyncClient({ storage, socketFactory: script.factory, document: null });
    const connecting = client.connect(environment.envId, signedInRelayAccess);
    await vi.advanceTimersByTimeAsync(0);
    script.sockets[0]?.serverTransportSend({ t: "accepted", v: 2 });
    script.sockets[0]?.serverTransportSend({ t: "ready", v: 2 });
    await connecting;

    const input = client.sendTerminalInput("term-1", "date\n");
    const rejection = expect(input).rejects.toMatchObject({
      code: "terminal_input_retry_window_expired",
    });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(250);
    await rejection;
    client.dispose();
  });

  it("uses terminal data offsets as reconnect watermarks", async () => {
    const storage = new MemoryStorage();
    const environment = await makeEnvironment(storage);
    const script = createSocketFactory((socket, envelope) => {
      if (envelope.type === "hello") {
        socket.serverSend({ type: "hello_ok", requestId: envelope.requestId, payload: helloOk() });
      }
      if (envelope.type === "terminal_subscribe" && !("sinceOffset" in (envelope.payload as object))) {
        socket.serverSend({
          type: "terminal_data",
          requestId: envelope.requestId,
          payload: {
            sessionId: "term-1",
            ptyId: "pty-1",
            data: "live output",
            at: new Date().toISOString(),
            offset: 105,
          },
        });
      }
    });
    const client = new AdeSyncClient({ storage, socketFactory: script.factory, document: null });

    const initialConnect = client.connect(environment.envId, signedInRelayAccess);
    await completeRelayReadyV2AfterOpen(script.sockets, 0);
    await initialConnect;
    client.subscribeTerminal("term-1", {}, {});
    await flush();
    script.sockets[0].close(1006, "network");
    const reconnect = client.connect(environment.envId, signedInRelayAccess);
    await completeRelayReadyV2AfterOpen(script.sockets, 1);
    await reconnect;
    await flush();

    expect(script.sockets[1].sent.find((envelope) => envelope.type === "terminal_subscribe")?.payload).toMatchObject({
      sessionId: "term-1",
      sinceOffset: 105,
    });

    client.dispose();
  });

  it("deduplicates UTF-8 terminal overlap and requests one recovery from the last contiguous offset", async () => {
    const storage = new MemoryStorage();
    const environment = await makeEnvironment(storage);
    const script = createSocketFactory((socket, envelope) => {
      if (envelope.type === "hello") {
        socket.serverSend({ type: "hello_ok", requestId: envelope.requestId, payload: helloOk() });
      }
    });
    const client = new AdeSyncClient({ storage, socketFactory: script.factory, document: null });
    const connecting = client.connect(environment.envId, signedInRelayAccess);
    await completeRelayReadyV2AfterOpen(script.sockets, 0);
    await connecting;

    const received: string[] = [];
    client.subscribeTerminal("term-1", {}, {
      data: (payload) => received.push(payload.data),
    });
    script.sockets[0]!.serverSend({
      type: "terminal_data",
      payload: { sessionId: "term-1", ptyId: "pty-1", data: "hello", at: new Date().toISOString(), offset: 5 },
    });
    script.sockets[0]!.serverSend({
      type: "terminal_data",
      payload: { sessionId: "term-1", ptyId: "pty-1", data: "hello", at: new Date().toISOString(), offset: 5 },
    });
    script.sockets[0]!.serverSend({
      type: "terminal_data",
      payload: { sessionId: "term-1", ptyId: "pty-1", data: "lo🙂!", at: new Date().toISOString(), offset: 10 },
    });
    script.sockets[0]!.serverSend({
      type: "terminal_data",
      payload: { sessionId: "term-1", ptyId: "pty-1", data: "gap", at: new Date().toISOString(), offset: 16 },
    });
    script.sockets[0]!.serverSend({
      type: "terminal_data",
      payload: { sessionId: "term-1", ptyId: "pty-1", data: "later", at: new Date().toISOString(), offset: 21 },
    });
    await flush();

    expect(received).toEqual(["hello", "🙂!"]);
    const subscribes = script.sockets[0]!.sent.filter((envelope) => envelope.type === "terminal_subscribe");
    expect(subscribes).toHaveLength(2);
    expect(subscribes[1]?.payload).toMatchObject({ sessionId: "term-1", sinceOffset: 10 });
    client.dispose();
  });

  it("appends only a missing delta suffix and preserves full equality snapshots as replacements", async () => {
    const storage = new MemoryStorage();
    const environment = await makeEnvironment(storage);
    const script = createSocketFactory((socket, envelope) => {
      if (envelope.type === "hello") {
        socket.serverSend({ type: "hello_ok", requestId: envelope.requestId, payload: helloOk() });
      }
    });
    const client = new AdeSyncClient({ storage, socketFactory: script.factory, document: null });
    const connecting = client.connect(environment.envId, signedInRelayAccess);
    await completeRelayReadyV2AfterOpen(script.sockets, 0);
    await connecting;

    const snapshots: Array<{ transcript: string; startOffset?: number | null; endOffset?: number | null; delta?: boolean }> = [];
    client.subscribeTerminal("term-1", {}, {
      snapshot: (payload) => snapshots.push(payload),
    });
    script.sockets[0]!.serverSend({
      type: "terminal_data",
      payload: { sessionId: "term-1", ptyId: "pty-1", data: "0123456789", at: new Date().toISOString(), offset: 10 },
    });
    script.sockets[0]!.serverSend({
      type: "terminal_snapshot",
      payload: {
        sessionId: "term-1",
        transcript: "89resume",
        status: "running",
        runtimeState: "running",
        lastOutputPreview: "resume",
        capturedAt: new Date().toISOString(),
        startOffset: 8,
        endOffset: 16,
        delta: true,
        live: true,
      },
    });
    script.sockets[0]!.serverSend({
      type: "terminal_snapshot",
      payload: {
        sessionId: "term-1",
        transcript: "full state",
        status: "running",
        runtimeState: "running",
        lastOutputPreview: "full state",
        capturedAt: new Date().toISOString(),
        startOffset: 6,
        endOffset: 16,
        live: true,
      },
    });
    await flush();

    expect(snapshots).toEqual([
      expect.objectContaining({ transcript: "resume", startOffset: 10, endOffset: 16, delta: true }),
      expect.objectContaining({ transcript: "full state", startOffset: 6, endOffset: 16 }),
    ]);
    client.dispose();
  });

  it("restores a missing hello catalog before readiness and rejects that barrier on disconnect", async () => {
    const cachedStorage = new MemoryStorage();
    const cachedEnvironment = await makeEnvironment(cachedStorage);
    let cachedCatalogRequests = 0;
    const cachedScript = createSocketFactory((socket, envelope) => {
      if (envelope.type === "hello") {
        socket.serverSend({ type: "hello_ok", requestId: envelope.requestId, payload: helloOk() });
      }
      if (envelope.type === "project_catalog_request") {
        cachedCatalogRequests += 1;
      }
    });
    const cachedClient = new AdeSyncClient({ storage: cachedStorage, socketFactory: cachedScript.factory, document: null });
    const cachedConnecting = cachedClient.connect(cachedEnvironment.envId, signedInRelayAccess);
    for (let attempt = 0; attempt < 20 && cachedScript.sockets[0]?.readyState !== 1; attempt += 1) await flush();
    cachedScript.sockets[0]?.serverTransportSend({ t: "accepted", v: 2 });
    cachedScript.sockets[0]?.serverTransportSend({ t: "ready", v: 2 });
    await cachedConnecting;

    await expect(cachedClient.getProjectCatalog()).resolves.toMatchObject({
      projects: [{ id: "project-1" }],
    });
    expect(cachedCatalogRequests).toBe(0);
    cachedClient.dispose();

    const uncachedStorage = new MemoryStorage();
    const uncachedEnvironment = await makeEnvironment(uncachedStorage);
    let catalogRequests = 0;
    let catalogRequestId: string | null = null;
    const uncachedScript = createSocketFactory((socket, envelope) => {
      if (envelope.type === "hello") {
        socket.serverSend({ type: "hello_ok", requestId: envelope.requestId, payload: helloOkWithoutProjects() });
      }
      if (envelope.type === "project_catalog_request") {
        catalogRequests += 1;
        catalogRequestId = envelope.requestId ?? null;
      }
    });
    const uncachedClient = new AdeSyncClient({ storage: uncachedStorage, socketFactory: uncachedScript.factory, document: null });
    const connecting = uncachedClient.connect(uncachedEnvironment.envId, signedInRelayAccess);
    for (let attempt = 0; attempt < 20 && uncachedScript.sockets[0]?.readyState !== 1; attempt += 1) await flush();
    uncachedScript.sockets[0]?.serverTransportSend({ t: "accepted", v: 2 });
    uncachedScript.sockets[0]?.serverTransportSend({ t: "ready", v: 2 });
    for (let attempt = 0; attempt < 20 && catalogRequests === 0; attempt += 1) await flush();
    expect(catalogRequests).toBe(1);
    expect(uncachedClient.getStatus()).toMatchObject({ state: "restoring", readiness: "restoring" });
    await expect(uncachedClient.getProjectCatalog()).rejects.toMatchObject({ code: "not_connected" });
    const catalogSocket = uncachedScript.sockets.at(-1);
    expect(catalogSocket).toBeTruthy();
    catalogSocket!.serverSend({
      type: "project_catalog",
      requestId: catalogRequestId,
      payload: { projects: helloOk("project-2").projects ?? [] },
    });
    await connecting;
    await expect(Promise.all([
      uncachedClient.getProjectCatalog(),
      uncachedClient.getProjectCatalog(),
    ])).resolves.toEqual([
      { projects: helloOk("project-2").projects },
      { projects: helloOk("project-2").projects },
    ]);
    expect(catalogRequests).toBe(1);
    uncachedClient.dispose();

    const interruptedStorage = new MemoryStorage();
    const interruptedEnvironment = await makeEnvironment(interruptedStorage);
    const interruptedScript = createSocketFactory((socket, envelope) => {
      if (envelope.type === "hello") {
        socket.serverSend({ type: "hello_ok", requestId: envelope.requestId, payload: helloOkWithoutProjects() });
      }
    });
    const interruptedClient = new AdeSyncClient({
      storage: interruptedStorage,
      socketFactory: interruptedScript.factory,
      document: null,
    });
    const interruptedConnect = interruptedClient.connect(interruptedEnvironment.envId, signedInRelayAccess);
    for (
      let attempt = 0;
      attempt < 20 && interruptedScript.sockets[0]?.readyState !== 1;
      attempt += 1
    ) await flush();
    interruptedScript.sockets[0]?.serverTransportSend({ t: "accepted", v: 2 });
    interruptedScript.sockets[0]?.serverTransportSend({ t: "ready", v: 2 });
    for (
      let attempt = 0;
      attempt < 20 && !interruptedScript.sockets[0]?.sent.some((envelope) => envelope.type === "project_catalog_request");
      attempt += 1
    ) await flush();
    expect(interruptedScript.sockets[0]?.sent.some((envelope) => envelope.type === "project_catalog_request")).toBe(true);
    interruptedScript.sockets[0]?.close(1006, "network");
    await expect(interruptedConnect).rejects.toMatchObject({ code: "connection_lost_outcome_unknown" });
    interruptedClient.dispose();
  });

  it("correlates command ack/result, tolerates result before ack, and surfaces host error codes", async () => {
    const storage = new MemoryStorage();
    const environment = await makeEnvironment(storage);
    const script = createSocketFactory((socket, envelope) => {
      if (envelope.type === "hello") {
        socket.serverSend({ type: "hello_ok", requestId: envelope.requestId, payload: helloOk() });
      }
      if (envelope.type === "command") {
        const { commandId, args } = envelope.payload as { commandId: string; args: { mode?: string } };
        if (args.mode === "result-first") {
          socket.serverSend({
            type: "command_result",
            requestId: envelope.requestId,
            payload: { commandId, ok: true, result: { value: 2 } },
          });
          socket.serverSend({
            type: "command_ack",
            requestId: envelope.requestId,
            payload: { commandId, accepted: true, status: "accepted", message: null },
          });
          return;
        }
        if (args.mode === "error") {
          socket.serverSend({
            type: "command_ack",
            requestId: envelope.requestId,
            payload: { commandId, accepted: true, status: "accepted", message: null },
          });
          socket.serverSend({
            type: "command_result",
            requestId: envelope.requestId,
            payload: {
              commandId,
              ok: false,
              error: { code: "missing_project", message: "requires projectId" },
            },
          });
          return;
        }
        if (args.mode === "timeout") return;
        socket.serverSend({
          type: "command_ack",
          requestId: envelope.requestId,
          payload: { commandId, accepted: true, status: "accepted", message: null },
        });
        socket.serverSend({
          type: "command_result",
          requestId: envelope.requestId,
          payload: { commandId, ok: true, result: { value: 1 } },
        });
      }
    });
    const client = new AdeSyncClient({ storage, socketFactory: script.factory, document: null });
    await client.connect(environment.envId, signedInRelayAccess);

    await expect(client.sendCommand("chat.send", { mode: "normal" })).resolves.toEqual({ value: 1 });
    await expect(client.sendCommand("chat.send", { mode: "result-first" })).resolves.toEqual({ value: 2 });
    await expect(client.sendCommand("chat.send", { mode: "error" })).rejects.toMatchObject({
      code: "missing_project",
    });
    const timeoutPromise = client.sendCommand("chat.send", { mode: "timeout" }, { timeoutMs: 10 });
    await expect(timeoutPromise).rejects.toMatchObject({ code: "timeout" });
    client.dispose();
  });

  it("correlates file and terminal history responses", async () => {
    const storage = new MemoryStorage();
    const environment = await makeEnvironment(storage);
    const script = createSocketFactory((socket, envelope) => {
      if (envelope.type === "hello") {
        socket.serverSend({ type: "hello_ok", requestId: envelope.requestId, payload: helloOk() });
      }
      if (envelope.type === "file_request") {
        socket.serverSend({
          type: "file_response",
          requestId: envelope.requestId,
          payload: { ok: true, action: "readFile", result: { content: "hi" } },
        });
      }
      if (envelope.type === "terminal_history") {
        socket.serverSend({
          type: "terminal_history",
          requestId: envelope.requestId,
          payload: { sessionId: "term-1", data: "older", startOffset: 0, endOffset: 5, atStart: true },
        });
      }
    });
    const client = new AdeSyncClient({ storage, socketFactory: script.factory, document: null });
    await client.connect(environment.envId, signedInRelayAccess);

    await expect(client.requestFile("readFile", { workspaceId: "w", path: "README.md" })).resolves.toEqual({ content: "hi" });
    await expect(client.requestTerminalHistory({ sessionId: "term-1", beforeOffset: 10 })).resolves.toMatchObject({
      data: "older",
      atStart: true,
    });
    client.dispose();
  });
});
