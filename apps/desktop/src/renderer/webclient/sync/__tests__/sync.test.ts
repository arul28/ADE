import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type {
  SyncEnvelope,
  SyncFeatureFlags,
  SyncHelloOkPayload,
  SyncPairingQrPayload,
  SyncPeerMetadata,
} from "../../../../shared/types/sync";
import { AdeSyncClient, AdeSyncError } from "../client";
import type { WebSocketLike } from "../connection";
import { deriveBrowserSyncEndpoints } from "../endpoints";
import { MemoryStorage, WebClientEnvStore, type WebClientEnvironmentRecord } from "../envStore";
import { generateDpopKeyPair, exportPublicKeyX963Base64, rawEcdsaSignatureToDer, signDpopProof } from "../dpop";
import { randomHex, uuid } from "../ids";
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

class ScriptedSocket implements WebSocketLike {
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly sent: SyncEnvelope[] = [];

  constructor(
    readonly url: string,
    private readonly onClientEnvelope: (socket: ScriptedSocket, envelope: SyncEnvelope) => void | Promise<void>,
  ) {
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.(new Event("open"));
    }, 0);
  }

  send(data: string): void {
    void decodeEnvelopeText(data).then(async (envelope) => {
      this.sent.push(envelope);
      await this.onClientEnvelope(this, envelope);
    });
  }

  close(code = 1000, reason = ""): void {
    this.readyState = 3;
    this.onclose?.({ code, reason } as CloseEvent);
  }

  serverSend(input: Parameters<typeof encodeEnvelopeText>[0]): void {
    this.onmessage?.({ data: encodeEnvelopeText(input) } as MessageEvent<string>);
  }
}

function createSocketFactory(handler: (socket: ScriptedSocket, envelope: SyncEnvelope) => void | Promise<void>) {
  const sockets: ScriptedSocket[] = [];
  return {
    sockets,
    factory(url: string): WebSocketLike {
      const socket = new ScriptedSocket(url, handler);
      sockets.push(socket);
      return socket;
    },
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
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
});

describe("browser sync connection and client", () => {
  it("pairs, sends a paired DPoP hello, persists the environment, and connects", async () => {
    const storage = new MemoryStorage();
    const sequence: string[] = [];
    const script = createSocketFactory((socket, envelope) => {
      sequence.push(envelope.type);
      if (envelope.type === "pairing_request") {
        expect(envelope.payload).toMatchObject({ code: "123456" });
        socket.serverSend({
          type: "pairing_result",
          requestId: envelope.requestId,
          payload: {
            ok: true,
            deviceId: (envelope.payload as { peer: SyncPeerMetadata }).peer.deviceId,
            secret: "paired-secret",
          },
        });
      }
      if (envelope.type === "hello") {
        const payload = envelope.payload as { auth: { kind: string; dpop?: unknown } };
        expect(payload.auth.kind).toBe("paired");
        expect(payload.auth.dpop).toBeTruthy();
        socket.serverSend({ type: "hello_ok", requestId: envelope.requestId, payload: helloOk() });
      }
    });
    const client = new AdeSyncClient({ storage, socketFactory: script.factory, document: null });

    const environment = await client.pair({ payload: pairingPayload, pin: "123456", deviceName: "ADE Browser" });

    expect(sequence).toEqual(["pairing_request", "hello"]);
    expect(environment.secret).toBe("paired-secret");
    expect(environment.lastGoodEndpoint).toBe("wss://relay.example/connect/machine-key");
    expect(await new WebClientEnvStore(storage).getSelectedEnvId()).toBe(environment.envId);
    expect(client.getStatus().state).toBe("connected");
    client.dispose();
  });

  it("drops stored pairing only for attributed auth failures", async () => {
    const attributedStorage = new MemoryStorage();
    const attributedEnv = await makeEnvironment(attributedStorage);
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
    await expect(attributedClient.connect(attributedEnv.envId)).rejects.toThrow("Revoked");
    await flush();
    expect(await attributedClient.listEnvironments()).toHaveLength(0);
    attributedClient.dispose();

    const ambiguousStorage = new MemoryStorage();
    const ambiguousEnv = await makeEnvironment(ambiguousStorage);
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
    await expect(ambiguousClient.connect(ambiguousEnv.envId)).rejects.toThrow("Wrong machine");
    expect(await ambiguousClient.listEnvironments()).toHaveLength(1);
    ambiguousClient.dispose();
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

    await client.connect(environment.envId);
    client.subscribeChat("chat-1", {}, {});
    client.subscribeTerminal("term-1", {}, {});
    await flush();
    script.sockets[0].close(1006, "network");
    await client.connect(environment.envId);
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
    await client.connect(environment.envId);

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
    await client.connect(environment.envId);

    await expect(client.requestFile("readFile", { workspaceId: "w", path: "README.md" })).resolves.toEqual({ content: "hi" });
    await expect(client.requestTerminalHistory({ sessionId: "term-1", beforeOffset: 10 })).resolves.toMatchObject({
      data: "older",
      atStart: true,
    });
    client.dispose();
  });
});
