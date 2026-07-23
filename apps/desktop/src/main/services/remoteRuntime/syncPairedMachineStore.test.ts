import { EventEmitter } from "node:events";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { SyncDpopVerification } from "../../../../../ade-cli/src/services/sync/syncDpop";
import {
  createSyncDpopNonceCache,
  verifySyncDpopProof,
} from "../../../../../ade-cli/src/services/sync/syncDpop";
import type { SyncDpopProof } from "../../../shared/types/sync";
import type { AdeAccountMachine } from "../../../shared/types/account";
import type { DesktopPairedMachineCredentials } from "../../../shared/types/pairedRuntime";
import { encodeSyncEnvelope, parseSyncEnvelope, wsDataToText } from "../sync/syncProtocol";
import { DesktopPairedMachineStore } from "./syncPairedMachineStore";
import {
  buildAdoptChallengeSignatureInput,
  buildAdoptHelloAad,
  buildAdoptHelloOkAad,
  deriveAdoptSessionKey,
  generateX25519EphemeralKeyPair,
  rawPublicKeyFromSpki,
  seal,
  signEd25519,
  unseal,
} from "../../../shared/sync/adoptChannelCrypto";

const originalAdeHome = process.env.ADE_HOME;

afterEach(() => {
  if (originalAdeHome === undefined) delete process.env.ADE_HOME;
  else process.env.ADE_HOME = originalAdeHome;
});

class FakeWebSocket extends EventEmitter {
  readyState = 0;
  bufferedAmount = 0;

  constructor(
    private readonly onSend: (text: string, ws: FakeWebSocket) => void,
    autoOpen = true,
  ) {
    super();
    if (autoOpen) {
      queueMicrotask(() => {
        this.readyState = 1;
        this.emit("open");
      });
    }
  }

  send(data: string | Buffer): void {
    this.onSend(data.toString(), this);
  }

  receive(text: string): void {
    queueMicrotask(() => this.emit("message", Buffer.from(text, "utf8")));
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    queueMicrotask(() => this.emit("close"));
  }
}

function successfulSealedAdoptionSocket(args: {
  signingPrivateKey: Parameters<typeof signEd25519>[0];
  hostDeviceId: string;
  hostName: string;
  pairedSecret?: string;
}): FakeWebSocket {
  let hostSessionKey: Buffer | null = null;
  return new FakeWebSocket((text, ws) => {
    const envelope = parseSyncEnvelope(wsDataToText(text));
    if (envelope.type === "account_challenge") {
      const request = envelope.payload as {
        nonce: string;
        clientEphemeralPublicKey: string;
      };
      const hostEphemeral = generateX25519EphemeralKeyPair();
      const hostEphemeralPublicKey = hostEphemeral.publicKeyRaw.toString("base64");
      const ts = Date.now();
      const canonical = buildAdoptChallengeSignatureInput({
        hostDeviceId: args.hostDeviceId,
        nonce: request.nonce,
        clientEphemeralPublicKey: request.clientEphemeralPublicKey,
        hostEphemeralPublicKey,
        ts,
      });
      hostSessionKey = deriveAdoptSessionKey({
        privateKey: hostEphemeral.privateKey,
        peerPublicKeyRaw: Buffer.from(request.clientEphemeralPublicKey, "base64"),
        nonce: Buffer.from(request.nonce, "base64"),
      });
      ws.receive(encodeSyncEnvelope({
        type: "account_challenge_ok",
        requestId: envelope.requestId,
        payload: {
          v: 1,
          hostDeviceId: args.hostDeviceId,
          ts,
          hostEphemeralPublicKey,
          signature: signEd25519(
            args.signingPrivateKey,
            canonical,
          ).toString("base64"),
        },
      }));
      return;
    }
    if (envelope.type !== "hello" || !hostSessionKey) return;
    const payload = envelope.payload as {
      peer: { deviceId: string };
      auth: { kind: string; deviceId: string; sealed: string };
    };
    expect(payload.auth.kind).toBe("account_sealed");
    const helloOk = {
      peer: payload.peer,
      brain: {
        deviceId: args.hostDeviceId,
        deviceName: args.hostName,
        platform: "macOS",
        deviceType: "desktop",
        siteId: `${args.hostDeviceId}-site`,
        dbVersion: 0,
      },
      serverDbVersion: 0,
      heartbeatIntervalMs: 5_000,
      pollIntervalMs: 1_500,
      features: { rpcChannel: true, portForward: true },
      accountPairing: {
        deviceId: payload.auth.deviceId,
        secret: args.pairedSecret ?? "sealed-paired-secret",
      },
    };
    ws.receive(encodeSyncEnvelope({
      type: "hello_ok",
      requestId: envelope.requestId,
      payload: {
        v: 1,
        sealed: seal(
          hostSessionKey,
          buildAdoptHelloOkAad(args.hostDeviceId, payload.auth.deviceId),
          Buffer.from(JSON.stringify(helloOk)),
        ),
      },
    }));
  });
}

describe("DesktopPairedMachineStore", () => {
  it("pairs as a desktop with DPoP and round-trips a 0600 machine secret file", async () => {
    const adeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-desktop-pairing-"));
    process.env.ADE_HOME = adeHome;
    let pairedPublicKey: string | null = null;
    let pairedDeviceType: unknown = null;
    let pairedRuntimeHostGrant: unknown = null;
    let pairedRelayAccountToken: unknown = null;
    let helloRelayAccountToken: unknown = null;
    let dpopVerdict: SyncDpopVerification | null = null;

    const createWebSocket = () => new FakeWebSocket((text, ws) => {
        const envelope = parseSyncEnvelope(wsDataToText(text));
        if (envelope.type === "pairing_request") {
          const payload = envelope.payload as {
            code: string;
            dpopPublicKey?: string;
            relayAccountToken?: string;
            runtimeHostGrant?: string;
            peer: { deviceId: string; deviceType: unknown };
          };
          pairedPublicKey = payload.dpopPublicKey ?? null;
          pairedDeviceType = payload.peer.deviceType;
          pairedRelayAccountToken = payload.relayAccountToken;
          pairedRuntimeHostGrant = payload.runtimeHostGrant;
          ws.receive(encodeSyncEnvelope({
            type: "pairing_result",
            requestId: envelope.requestId,
            payload: {
              ok: true,
              deviceId: payload.peer.deviceId,
              secret: "host-issued-secret",
            },
          }));
          return;
        }
        if (envelope.type !== "hello") return;
        const payload = envelope.payload as {
          peer: unknown;
          auth: {
            deviceId: string;
            secret: string;
            dpop: SyncDpopProof;
            relayAccountToken?: string | null;
          };
        };
        helloRelayAccountToken = payload.auth.relayAccountToken;
        if (pairedPublicKey) {
          dpopVerdict = verifySyncDpopProof({
            publicKeyX963Base64: pairedPublicKey,
            deviceId: payload.auth.deviceId,
            secret: payload.auth.secret,
            proof: payload.auth.dpop,
          });
        }
        ws.receive(encodeSyncEnvelope({
          type: "hello_ok",
          requestId: envelope.requestId,
          payload: {
            peer: payload.peer,
            brain: {
              deviceId: "mac-studio-host",
              deviceName: "Studio",
              platform: "macOS",
              deviceType: "desktop",
              siteId: "mac-studio-site",
              dbVersion: 0,
            },
            serverDbVersion: 0,
            heartbeatIntervalMs: 5_000,
            pollIntervalMs: 1_500,
            cloudRelayWssUrl: "wss://relay.example/connect/machine-123",
            features: { rpcChannel: true, portForward: true },
          },
        }));
    }) as unknown as WebSocket;

    const store = new DesktopPairedMachineStore();
    const paired = await store.pairWithMachine(
      "ws://studio.local:8787",
      "123456",
      "Desktop client",
      {
        pairingTimeoutMs: 2_000,
        createWebSocket,
        relayAccountToken: "short-lived-account-token",
        runtimeHostGrant: "server-issued-runtime-grant",
      },
    );

    expect(pairedDeviceType).toBe("desktop");
    expect(pairedRelayAccountToken).toBe("short-lived-account-token");
    expect(helloRelayAccountToken).toBe("short-lived-account-token");
    expect(pairedRuntimeHostGrant).toBe("server-issued-runtime-grant");
    expect(dpopVerdict).toEqual({ ok: true });
    expect(paired).toMatchObject({
      version: 1,
      hostIdentity: {
        deviceId: "mac-studio-host",
        siteId: "mac-studio-site",
        name: "Studio",
        deviceType: "desktop",
      },
      machineKey: "machine-123",
      deviceName: "Desktop client",
      secret: "host-issued-secret",
      dpopPrivateKey: expect.any(String),
      dpopPublicKey: pairedPublicKey,
      endpoints: [
        "ws://studio.local:8787/",
        "wss://relay.example/connect/machine-123",
      ],
    });
    expect(store.path).toBe(path.join(adeHome, "secrets", "desktop-paired-machines.json"));
    expect(fs.statSync(store.path).mode & 0o777).toBe(0o600);
    expect(new DesktopPairedMachineStore().get("mac-studio-host")).toEqual(paired);
    expect(new DesktopPairedMachineStore().get("machine-123")).toEqual(paired);
    expect(new DesktopPairedMachineStore().getForReference({
      hostIdentity: "missing-host-identity",
      machineKey: "machine-123",
    })).toEqual(paired);

    const marked = store.markEndpointSucceeded(
      "mac-studio-host",
      "wss://relay.example/connect/machine-123",
      1_700_000_000_000,
    );
    expect(marked.endpointStates).toContainEqual({
      endpoint: "wss://relay.example/connect/machine-123",
      lastSucceededAt: 1_700_000_000_000,
    });
    expect(new DesktopPairedMachineStore().get("mac-studio-host"))
      .toEqual(marked);
  });

  it("replaces stale relay connection metadata only when explicitly requested", () => {
    const filePath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "ade-desktop-pairing-store-")),
      "paired.json",
    );
    const store = new DesktopPairedMachineStore({ filePath });
    const credentials: DesktopPairedMachineCredentials = {
      version: 1,
      hostIdentity: {
        deviceId: "host-1",
        siteId: "host-site-1",
        name: "Studio",
        platform: "macOS",
        deviceType: "desktop",
      },
      machineKey: "machine-1",
      deviceId: "desktop-1",
      siteId: "desktop-site-1",
      deviceName: "Laptop",
      secret: "secret",
      dpopPrivateKey: "private",
      dpopPublicKey: "public",
      endpoints: [
        "ws://studio.local:8787",
        "wss://relay.example/connect/old",
      ],
      relayUrl: "wss://relay.example/connect/old",
      endpointStates: [{
        endpoint: "wss://relay.example/connect/old",
        lastSucceededAt: 123,
      }],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    store.save(credentials);

    const merged = store.save({
      ...credentials,
      endpoints: ["ws://studio.local:8787"],
      relayUrl: null,
    });
    expect(merged.endpoints).toContain("wss://relay.example/connect/old");
    expect(merged.relayUrl).toBe("wss://relay.example/connect/old");

    const replaced = store.save(
      {
        ...credentials,
        endpoints: ["ws://studio.local:8787"],
        relayUrl: null,
      },
      { replaceConnectionMetadata: true },
    );
    expect(replaced.endpoints).toEqual(["ws://studio.local:8787/"]);
    expect(replaced.relayUrl).toBeNull();
    expect(replaced.endpointStates).toEqual([{
      endpoint: "ws://studio.local:8787/",
      lastSucceededAt: null,
    }]);
  });

  it("removes one account's credentials without touching user-paired or other-account credentials", () => {
    const filePath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "ade-account-pairing-store-")),
      "paired.json",
    );
    const store = new DesktopPairedMachineStore({ filePath });
    const credentials = (
      hostDeviceId: string,
      accountOwnerUserId: string | null,
    ): DesktopPairedMachineCredentials => ({
      version: 1,
      hostIdentity: {
        deviceId: hostDeviceId,
        siteId: `${hostDeviceId}-site`,
        name: hostDeviceId,
        platform: "macOS",
        deviceType: "desktop",
      },
      accountOwnerUserId,
      deviceId: `${hostDeviceId}-client`,
      siteId: `${hostDeviceId}-client-site`,
      deviceName: "Laptop",
      secret: `${hostDeviceId}-secret`,
      dpopPrivateKey: `${hostDeviceId}-private`,
      dpopPublicKey: `${hostDeviceId}-public`,
      endpoints: [`ws://${hostDeviceId}.local:8787`],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const manual = store.save(credentials("manual", null));
    const owned = store.save(credentials("owned", "account-a"));
    const other = store.save(credentials("other", "account-b"));

    expect(store.removeAccountOwned("account-a")).toEqual([owned]);
    expect(store.list().map((machine) => machine.hostIdentity.deviceId)).toEqual([
      other.hostIdentity.deviceId,
      manual.hostIdentity.deviceId,
    ]);
    expect(store.pruneAccountOwned("account-b")).toEqual([]);
    expect(store.pruneAccountOwned(null)).toEqual([other]);
    expect(store.list()).toEqual([manual]);
  });

  it("uses a verified WSS relay despite stale presence and preserves an existing paired secret", async () => {
    const adeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-desktop-account-pairing-"));
    process.env.ADE_HOME = adeHome;
    const openedEndpoints: string[] = [];
    const accountDpopVerdicts: SyncDpopVerification[] = [];
    let successfulHelloCount = 0;
    const nonceCache = createSyncDpopNonceCache();
    const machine: AdeAccountMachine = {
      machineKey: "machine-account-1",
      deviceId: "host-account-1",
      name: "Account Studio",
      platform: "macOS",
      deviceType: "desktop",
      online: false,
      lastSeenAt: Date.now(),
      reachableEndpoints: [
        { kind: "relay", url: "ws://relay-one.example/connect/plaintext" },
        { kind: "relay", url: "wss://relay-one.example/connect/machine-account-1?token=hostile" },
        { kind: "lan", url: "wss://arbitrary.example/account" },
        { kind: "lan", host: "studio.local", port: 8787 },
        { kind: "relay", url: "wss://relay-one.example/connect/machine-account-1" },
        { kind: "relay", url: "wss://relay-two.example/connect/machine-account-1" },
      ],
    };
    const createWebSocket = (endpoint: string) => {
      openedEndpoints.push(endpoint);
      return new FakeWebSocket((text, ws) => {
        const envelope = parseSyncEnvelope(wsDataToText(text));
        if (envelope.type !== "hello") return;
        const payload = envelope.payload as {
          peer: unknown;
          auth: {
            kind: string;
            deviceId: string;
            accountToken: string;
            dpop: SyncDpopProof;
          };
        };
        expect(payload.auth.kind).toBe("account");
        expect(payload.auth.accountToken).toBe("clerk-access-token");
        accountDpopVerdicts.push(verifySyncDpopProof({
          publicKeyX963Base64: payload.auth.dpop.publicKey ?? "",
          deviceId: payload.auth.deviceId,
          secret: payload.auth.accountToken,
          proof: payload.auth.dpop,
          checkAndRecordNonce: (nonce) => nonceCache.checkAndRecord(payload.auth.deviceId, nonce),
        }));
        if (endpoint.includes("relay-one")) {
          ws.receive(encodeSyncEnvelope({
            type: "hello_error",
            requestId: envelope.requestId,
            payload: { code: "auth_failed", message: "Retry the next verified relay." },
          }));
          return;
        }
        successfulHelloCount += 1;
        ws.receive(encodeSyncEnvelope({
          type: "hello_ok",
          requestId: envelope.requestId,
          payload: {
            peer: payload.peer,
            brain: {
              deviceId: "host-account-1",
              deviceName: "Account Studio",
              platform: "macOS",
              deviceType: "desktop",
              siteId: "host-account-site-1",
              dbVersion: 0,
            },
            serverDbVersion: 0,
            heartbeatIntervalMs: 5_000,
            pollIntervalMs: 1_500,
            cloudRelayWssUrl: "wss://relay-two.example/connect/machine-account-1",
            features: { rpcChannel: true, portForward: true },
            ...(successfulHelloCount === 1 || successfulHelloCount === 3
              ? {
                  accountPairing: {
                    deviceId: payload.auth.deviceId,
                    secret: successfulHelloCount === 1
                      ? "account-issued-paired-secret"
                      : "second-account-secret",
                  },
                }
              : {}),
          },
        }));
      }) as unknown as WebSocket;
    };

    const store = new DesktopPairedMachineStore();
    const adopted = await store.pairWithAccountMachine(
      machine,
      "clerk-access-token",
      "Web account client",
      {
        accountOwnerUserId: "account-user-1",
        pairingTimeoutMs: 2_000,
        createWebSocket,
        relayBaseUrls: ["https://relay-one.example", "https://relay-two.example"],
      },
    );
    const reauthenticated = await store.pairWithAccountMachine(
      machine,
      "clerk-access-token",
      "Web account client",
      {
        accountOwnerUserId: "account-user-1",
        pairingTimeoutMs: 2_000,
        createWebSocket,
        relayBaseUrls: ["https://relay-one.example", "https://relay-two.example"],
      },
    );
    const secondAccount = await store.pairWithAccountMachine(
      machine,
      "clerk-access-token",
      "Second account client",
      {
        accountOwnerUserId: "account-user-2",
        pairingTimeoutMs: 2_000,
        createWebSocket,
        relayBaseUrls: ["https://relay-one.example", "https://relay-two.example"],
      },
    );

    expect(openedEndpoints).toEqual([
      "wss://relay-one.example/connect/machine-account-1",
      "wss://relay-two.example/connect/machine-account-1",
      "wss://relay-one.example/connect/machine-account-1",
      "wss://relay-two.example/connect/machine-account-1",
      "wss://relay-one.example/connect/machine-account-1",
      "wss://relay-two.example/connect/machine-account-1",
    ]);
    expect(accountDpopVerdicts).toEqual([
      { ok: true },
      { ok: true },
      { ok: true },
      { ok: true },
      { ok: true },
      { ok: true },
    ]);
    expect(adopted.secret).toBe("account-issued-paired-secret");
    expect(reauthenticated.secret).toBe("account-issued-paired-secret");
    expect(reauthenticated.deviceId).toBe(adopted.deviceId);
    expect(reauthenticated.dpopPublicKey).toBe(adopted.dpopPublicKey);
    expect(adopted.accountOwnerUserId).toBe("account-user-1");
    expect(secondAccount.accountOwnerUserId).toBe("account-user-2");
    expect(secondAccount.deviceId).not.toBe(adopted.deviceId);
    expect(secondAccount.dpopPublicKey).not.toBe(adopted.dpopPublicKey);
    expect(secondAccount.secret).toBe("second-account-secret");
    expect(reauthenticated.endpoints).toContain("ws://studio.local:8787/");
    expect(reauthenticated.endpoints).not.toContain("wss://arbitrary.example/account");
    expect(reauthenticated.endpoints).not.toContain("ws://relay-one.example/connect/plaintext");
    expect(fs.readFileSync(store.path, "utf8")).not.toContain("clerk-access-token");
  });

  it("does not dial direct adoption routes when the directory row has no pubkey", async () => {
    const openedEndpoints: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const machine: AdeAccountMachine = {
      machineKey: "machine-legacy-relay-only",
      deviceId: "host-legacy-relay-only",
      name: "Legacy Studio",
      platform: "macOS",
      deviceType: "desktop",
      online: true,
      lastSeenAt: Date.now(),
      reachableEndpoints: [
        {
          kind: "relay",
          url: "wss://relay.example/connect/machine-legacy-relay-only",
        },
        { kind: "tailnet", host: "100.75.20.63", port: 8787 },
        { kind: "lan", host: "legacy-studio.local", port: 8787 },
      ],
    };

    try {
      await expect(new DesktopPairedMachineStore().pairWithAccountMachine(
        machine,
        "legacy-token",
        "Laptop",
        {
          accountOwnerUserId: "account-user",
          relayBaseUrls: ["https://relay.example"],
          createWebSocket: (endpoint) => {
            openedEndpoints.push(endpoint);
            const ws = new FakeWebSocket(() => {}, false);
            queueMicrotask(() => ws.emit("error", new Error("relay refused")));
            return ws as unknown as WebSocket;
          },
        },
      )).rejects.toThrow(/relay relay\.example:.*relay refused/i);
    } finally {
      warn.mockRestore();
    }

    expect(openedEndpoints).toEqual([
      "wss://relay.example/connect/machine-legacy-relay-only",
    ]);
  });

  it("stops after a successful sealed relay adoption without dialing direct routes", async () => {
    process.env.ADE_HOME = fs.mkdtempSync(
      path.join(os.tmpdir(), "ade-desktop-relay-wins-"),
    );
    const signing = generateKeyPairSync("ed25519");
    const openedEndpoints: string[] = [];
    const stages: Array<{
      kind: "relay" | "tailnet" | "lan";
      phase: "connecting" | "verifying";
    }> = [];
    const machine: AdeAccountMachine = {
      machineKey: "machine-relay-wins",
      deviceId: "host-relay-wins",
      name: "Relay Studio",
      platform: "macOS",
      deviceType: "desktop",
      pubkey: `ed25519:${rawPublicKeyFromSpki(signing.publicKey).toString("base64")}`,
      online: true,
      lastSeenAt: Date.now(),
      reachableEndpoints: [
        { kind: "lan", host: "relay-studio.local", port: 8787 },
        { kind: "tailnet", host: "100.75.20.63", port: 8787 },
        {
          kind: "relay",
          url: "wss://relay.example/connect/machine-relay-wins",
        },
      ],
    };

    await expect(new DesktopPairedMachineStore().pairWithAccountMachine(
      machine,
      "sealed-token",
      "Laptop",
      {
        accountOwnerUserId: "account-user",
        relayBaseUrls: ["https://relay.example"],
        onStage: (stage) => stages.push(stage),
        createWebSocket: (endpoint) => {
          openedEndpoints.push(endpoint);
          return successfulSealedAdoptionSocket({
            signingPrivateKey: signing.privateKey,
            hostDeviceId: "host-relay-wins",
            hostName: "Relay Studio",
          }) as unknown as WebSocket;
        },
      },
    )).resolves.toMatchObject({
      hostIdentity: { deviceId: "host-relay-wins" },
      secret: "sealed-paired-secret",
    });
    expect(openedEndpoints).toEqual([
      "wss://relay.example/connect/machine-relay-wins",
    ]);
    expect(stages).toEqual([
      { kind: "relay", phase: "connecting" },
      { kind: "relay", phase: "verifying" },
    ]);
  });

  it("falls through a closed relay to sealed tailnet adoption with exact stages", async () => {
    process.env.ADE_HOME = fs.mkdtempSync(
      path.join(os.tmpdir(), "ade-desktop-tailnet-fallback-"),
    );
    const signing = generateKeyPairSync("ed25519");
    const openedEndpoints: string[] = [];
    const stages: Array<{
      kind: "relay" | "tailnet" | "lan";
      phase: "connecting" | "verifying";
    }> = [];
    const machine: AdeAccountMachine = {
      machineKey: "machine-tailnet-fallback",
      deviceId: "host-tailnet-fallback",
      name: "Tailnet Studio",
      platform: "macOS",
      deviceType: "desktop",
      pubkey: `ed25519:${rawPublicKeyFromSpki(signing.publicKey).toString("base64")}`,
      online: true,
      lastSeenAt: Date.now(),
      reachableEndpoints: [
        { kind: "lan", host: "tailnet-studio.local", port: 8787 },
        { kind: "tailnet", host: "100.75.20.63", port: 8787 },
        {
          kind: "relay",
          url: "wss://relay.example/connect/machine-tailnet-fallback",
        },
      ],
    };

    await expect(new DesktopPairedMachineStore().pairWithAccountMachine(
      machine,
      "sealed-token",
      "Laptop",
      {
        accountOwnerUserId: "account-user",
        relayBaseUrls: ["https://relay.example"],
        onStage: (stage) => stages.push(stage),
        createWebSocket: (endpoint) => {
          openedEndpoints.push(endpoint);
          if (endpoint.startsWith("wss://")) {
            return new FakeWebSocket((text, ws) => {
              const envelope = parseSyncEnvelope(wsDataToText(text));
              if (envelope.type === "account_challenge") ws.close();
            }) as unknown as WebSocket;
          }
          return successfulSealedAdoptionSocket({
            signingPrivateKey: signing.privateKey,
            hostDeviceId: "host-tailnet-fallback",
            hostName: "Tailnet Studio",
          }) as unknown as WebSocket;
        },
      },
    )).resolves.toMatchObject({
      hostIdentity: { deviceId: "host-tailnet-fallback" },
      secret: "sealed-paired-secret",
    });

    expect(openedEndpoints).toEqual([
      "wss://relay.example/connect/machine-tailnet-fallback",
      "ws://100.75.20.63:8787/",
    ]);
    expect(stages).toEqual([
      { kind: "relay", phase: "connecting" },
      { kind: "tailnet", phase: "connecting" },
      { kind: "tailnet", phase: "verifying" },
    ]);
  });

  it("verifies a directory signing key before sending a sealed account hello over a direct route", async () => {
    const adeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-desktop-sealed-pairing-"));
    process.env.ADE_HOME = adeHome;
    const signing = generateKeyPairSync("ed25519");
    const hostSigningPublicKey = rawPublicKeyFromSpki(signing.publicKey);
    const sentTypes: string[] = [];
    let hostSessionKey: Buffer | null = null;
    const machine: AdeAccountMachine = {
      machineKey: "machine-sealed",
      deviceId: "host-sealed",
      name: "Sealed Studio",
      platform: "macOS",
      deviceType: "desktop",
      pubkey: `ed25519:${hostSigningPublicKey.toString("base64")}`,
      online: true,
      lastSeenAt: Date.now(),
      reachableEndpoints: [
        { kind: "lan", host: "sealed-studio.local", port: 8787 },
      ],
    };
    const createWebSocket = () => new FakeWebSocket((text, ws) => {
      const envelope = parseSyncEnvelope(wsDataToText(text));
      sentTypes.push(envelope.type);
      if (envelope.type === "account_challenge") {
        const request = envelope.payload as {
          nonce: string;
          clientEphemeralPublicKey: string;
        };
        const hostEphemeral = generateX25519EphemeralKeyPair();
        const hostEphemeralPublicKey = hostEphemeral.publicKeyRaw.toString("base64");
        const ts = Date.now();
        const canonical = buildAdoptChallengeSignatureInput({
          hostDeviceId: "host-sealed",
          nonce: request.nonce,
          clientEphemeralPublicKey: request.clientEphemeralPublicKey,
          hostEphemeralPublicKey,
          ts,
        });
        hostSessionKey = deriveAdoptSessionKey({
          privateKey: hostEphemeral.privateKey,
          peerPublicKeyRaw: Buffer.from(request.clientEphemeralPublicKey, "base64"),
          nonce: Buffer.from(request.nonce, "base64"),
        });
        ws.receive(encodeSyncEnvelope({
          type: "account_challenge_ok",
          requestId: envelope.requestId,
          payload: {
            v: 1,
            hostDeviceId: "host-sealed",
            ts,
            hostEphemeralPublicKey,
            signature: signEd25519(signing.privateKey, canonical).toString("base64"),
          },
        }));
        return;
      }
      if (envelope.type !== "hello" || !hostSessionKey) return;
      const payload = envelope.payload as {
        peer: { deviceId: string };
        auth: {
          kind: string;
          deviceId: string;
          sealed: string;
        };
      };
      expect(payload.auth.kind).toBe("account_sealed");
      expect(text).not.toContain("clerk-sealed-token");
      const accountAuth = JSON.parse(unseal(
        hostSessionKey,
        buildAdoptHelloAad("host-sealed", payload.auth.deviceId),
        payload.auth.sealed,
      ).toString("utf8")) as {
        deviceId: string;
        accountToken: string;
        dpop: SyncDpopProof;
      };
      expect(accountAuth).toMatchObject({
        deviceId: payload.auth.deviceId,
        accountToken: "clerk-sealed-token",
        dpop: { publicKey: expect.any(String) },
      });
      const helloOk = {
        peer: payload.peer,
        brain: {
          deviceId: "host-sealed",
          deviceName: "Sealed Studio",
          platform: "macOS",
          deviceType: "desktop",
          siteId: "host-sealed-site",
          dbVersion: 0,
        },
        serverDbVersion: 0,
        heartbeatIntervalMs: 5_000,
        pollIntervalMs: 1_500,
        connectionTransport: "direct",
        features: { rpcChannel: true, portForward: true },
        accountPairing: {
          deviceId: payload.auth.deviceId,
          secret: "sealed-paired-secret",
        },
      };
      ws.receive(encodeSyncEnvelope({
        type: "hello_ok",
        requestId: envelope.requestId,
        payload: {
          v: 1,
          sealed: seal(
            hostSessionKey,
            buildAdoptHelloOkAad("host-sealed", payload.auth.deviceId),
            Buffer.from(JSON.stringify(helloOk)),
          ),
        },
      }));
    }) as unknown as WebSocket;

    const adopted = await new DesktopPairedMachineStore().pairWithAccountMachine(
      machine,
      "clerk-sealed-token",
      "Sealed client",
      {
        accountOwnerUserId: "account-user-sealed",
        pairingTimeoutMs: 2_000,
        createWebSocket,
        relayBaseUrls: ["https://relay.example"],
      },
    );

    expect(sentTypes).toEqual(["account_challenge", "hello"]);
    expect(adopted.hostIdentity.deviceId).toBe("host-sealed");
    expect(adopted.secret).toBe("sealed-paired-secret");
    expect(adopted.endpoints[0]).toBe("ws://sealed-studio.local:8787/");
  });

  it.each([
    { name: "bad signature", mode: "bad_signature" as const },
    { name: "device id mismatch", mode: "device_mismatch" as const },
    { name: "stale timestamp", mode: "stale_timestamp" as const },
  ])("aborts before hello when signed host verification fails: $name", async ({ mode }) => {
    const adeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-desktop-bad-host-"));
    process.env.ADE_HOME = adeHome;
    const signing = generateKeyPairSync("ed25519");
    const sentTypes: string[] = [];
    const machine: AdeAccountMachine = {
      machineKey: `machine-${mode}`,
      deviceId: "expected-host",
      name: "Expected host",
      platform: "macOS",
      deviceType: "desktop",
      pubkey: `ed25519:${rawPublicKeyFromSpki(signing.publicKey).toString("base64")}`,
      online: true,
      lastSeenAt: Date.now(),
      reachableEndpoints: [
        { kind: "relay", url: `wss://relay.example/connect/machine-${mode}` },
      ],
    };

    const pairing = new DesktopPairedMachineStore().pairWithAccountMachine(
      machine,
      "must-not-leave-client",
      "Laptop",
      {
        accountOwnerUserId: "account-user",
        pairingTimeoutMs: 500,
        relayBaseUrls: ["https://relay.example"],
        createWebSocket: () => new FakeWebSocket((text, ws) => {
          const envelope = parseSyncEnvelope(wsDataToText(text));
          sentTypes.push(envelope.type);
          if (envelope.type !== "account_challenge") return;
          const request = envelope.payload as {
            nonce: string;
            clientEphemeralPublicKey: string;
          };
          const hostEphemeral = generateX25519EphemeralKeyPair();
          const hostDeviceId = mode === "device_mismatch"
            ? "impersonated-host"
            : "expected-host";
          const ts = mode === "stale_timestamp"
            ? Date.now() - 120_001
            : Date.now();
          const hostEphemeralPublicKey = hostEphemeral.publicKeyRaw.toString("base64");
          const canonical = buildAdoptChallengeSignatureInput({
            hostDeviceId,
            nonce: request.nonce,
            clientEphemeralPublicKey: request.clientEphemeralPublicKey,
            hostEphemeralPublicKey,
            ts,
          });
          const signature = mode === "bad_signature"
            ? Buffer.alloc(64, 7)
            : signEd25519(signing.privateKey, canonical);
          ws.receive(encodeSyncEnvelope({
            type: "account_challenge_ok",
            requestId: envelope.requestId,
            payload: {
              v: 1,
              hostDeviceId,
              ts,
              hostEphemeralPublicKey,
              signature: signature.toString("base64"),
            },
          }));
        }) as unknown as WebSocket,
      },
    );
    await expect(pairing).rejects.toThrow(
      "Host identity verification failed — the machine may be running an older ADE.",
    );
    await expect(pairing).rejects.toMatchObject({
      code: "account_host_identity_verification_failed",
    });
    expect(sentTypes).toEqual(["account_challenge"]);
  });

  it("surfaces a host challenge decline as a route failure without leaking a hello", async () => {
    // A host that declines to issue a challenge (e.g. rate-limit cooldown) is
    // NOT an identity-proof failure: adoption must report the host's real reason
    // and never send a sealed hello — but it must not be conflated with the
    // "older ADE" identity-verification abort.
    const adeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-desktop-challenge-decline-"));
    process.env.ADE_HOME = adeHome;
    const signing = generateKeyPairSync("ed25519");
    const sentTypes: string[] = [];
    const machine: AdeAccountMachine = {
      machineKey: "machine-challenge-decline",
      deviceId: "expected-host",
      name: "Expected host",
      platform: "macOS",
      deviceType: "desktop",
      pubkey: `ed25519:${rawPublicKeyFromSpki(signing.publicKey).toString("base64")}`,
      online: true,
      lastSeenAt: Date.now(),
      reachableEndpoints: [
        { kind: "relay", url: "wss://relay.example/connect/machine-challenge-decline" },
      ],
    };

    const pairing = new DesktopPairedMachineStore().pairWithAccountMachine(
      machine,
      "must-not-leave-client",
      "Laptop",
      {
        accountOwnerUserId: "account-user",
        pairingTimeoutMs: 500,
        relayBaseUrls: ["https://relay.example"],
        createWebSocket: () => new FakeWebSocket((text, ws) => {
          const envelope = parseSyncEnvelope(wsDataToText(text));
          sentTypes.push(envelope.type);
          if (envelope.type !== "account_challenge") return;
          ws.receive(encodeSyncEnvelope({
            type: "account_challenge_error",
            requestId: envelope.requestId,
            payload: { message: "Too many failed authentication attempts. Try again in 3 minutes." },
          }));
        }) as unknown as WebSocket,
      },
    );
    // The host's real reason is surfaced, not the identity-verification error.
    await expect(pairing).rejects.toThrow(/Try again in 3 minutes/);
    await expect(pairing).rejects.not.toMatchObject({
      code: "account_host_identity_verification_failed",
    });
    // Credential safety invariant: no sealed hello ever left the client.
    expect(sentTypes).toEqual(["account_challenge"]);
  });

  it("aborts on a direct-route impostor without dialing later routes or sending hello", async () => {
    const signing = generateKeyPairSync("ed25519");
    const openedEndpoints: string[] = [];
    const sentTypes: string[] = [];
    const machine: AdeAccountMachine = {
      machineKey: "machine-direct-impostor",
      deviceId: "expected-direct-host",
      name: "Expected Direct Host",
      platform: "macOS",
      deviceType: "desktop",
      pubkey: `ed25519:${rawPublicKeyFromSpki(signing.publicKey).toString("base64")}`,
      online: true,
      lastSeenAt: Date.now(),
      reachableEndpoints: [
        { kind: "tailnet", host: "100.75.20.63", port: 8787 },
        { kind: "lan", host: "expected-direct-host.local", port: 8787 },
      ],
    };

    const pairing = new DesktopPairedMachineStore().pairWithAccountMachine(
      machine,
      "must-remain-sealed",
      "Laptop",
      {
        accountOwnerUserId: "account-user",
        createWebSocket: (endpoint) => {
          openedEndpoints.push(endpoint);
          return new FakeWebSocket((text, ws) => {
            const envelope = parseSyncEnvelope(wsDataToText(text));
            sentTypes.push(envelope.type);
            if (envelope.type !== "account_challenge") return;
            const hostEphemeral = generateX25519EphemeralKeyPair();
            ws.receive(encodeSyncEnvelope({
              type: "account_challenge_ok",
              requestId: envelope.requestId,
              payload: {
                v: 1,
                hostDeviceId: "expected-direct-host",
                ts: Date.now(),
                hostEphemeralPublicKey:
                  hostEphemeral.publicKeyRaw.toString("base64"),
                signature: Buffer.alloc(64, 9).toString("base64"),
              },
            }));
          }) as unknown as WebSocket;
        },
      },
    );

    await expect(pairing).rejects.toMatchObject({
      code: "account_host_identity_verification_failed",
    });
    expect(openedEndpoints).toEqual(["ws://100.75.20.63:8787/"]);
    expect(sentTypes).toEqual(["account_challenge"]);
  });

  it("aggregates every failed adoption route with its kind and host", async () => {
    const signing = generateKeyPairSync("ed25519");
    const openedEndpoints: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const machine: AdeAccountMachine = {
      machineKey: "machine-all-routes-fail",
      deviceId: "host-all-routes-fail",
      name: "Unavailable Studio",
      platform: "macOS",
      deviceType: "desktop",
      pubkey: `ed25519:${rawPublicKeyFromSpki(signing.publicKey).toString("base64")}`,
      online: true,
      lastSeenAt: Date.now(),
      reachableEndpoints: [
        {
          kind: "relay",
          url: "wss://relay.example/connect/machine-all-routes-fail",
        },
        { kind: "tailnet", host: "100.75.20.63", port: 8787 },
        { kind: "lan", host: "unavailable-studio.local", port: 8787 },
      ],
    };

    let failure: Error | null = null;
    try {
      await new DesktopPairedMachineStore().pairWithAccountMachine(
        machine,
        "sealed-token",
        "Laptop",
        {
          accountOwnerUserId: "account-user",
          relayBaseUrls: ["https://relay.example"],
          createWebSocket: (endpoint) => {
            openedEndpoints.push(endpoint);
            const ws = new FakeWebSocket(() => {}, false);
            queueMicrotask(() => ws.emit("error", new Error(`refused ${endpoint}`)));
            return ws as unknown as WebSocket;
          },
        },
      );
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    } finally {
      warn.mockRestore();
    }

    expect(failure?.message).toMatch(/relay relay\.example:/);
    expect(failure?.message).toMatch(/tailnet 100\.75\.20\.63:/);
    expect(failure?.message).toMatch(/lan unavailable-studio\.local:/);
    expect(openedEndpoints).toEqual([
      "wss://relay.example/connect/machine-all-routes-fail",
      "ws://100.75.20.63:8787/",
      "ws://unavailable-studio.local:8787/",
    ]);
  });

  it.each([
    { name: "sign-out", ownerUserId: null },
    { name: "account switch", ownerUserId: "account-user-2" },
  ])("does not commit credentials when $name wins a deferred account hello", async ({
    ownerUserId,
  }) => {
    const adeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-desktop-account-race-"));
    process.env.ADE_HOME = adeHome;
    let currentOwnerUserId: string | null = "account-user-1";
    let releaseHello: (() => void) | null = null;
    let markHelloSent: (() => void) | null = null;
    const helloSent = new Promise<void>((resolve) => {
      markHelloSent = resolve;
    });
    const machine: AdeAccountMachine = {
      machineKey: "machine-race",
      deviceId: "host-race",
      name: "Race Studio",
      platform: "macOS",
      deviceType: "desktop",
      online: true,
      lastSeenAt: Date.now(),
      reachableEndpoints: [
        { kind: "relay", url: "wss://relay.example/connect/machine-race" },
      ],
    };
    const store = new DesktopPairedMachineStore();
    const pairing = store.pairWithAccountMachine(
      machine,
      "account-token",
      "Laptop",
      {
        accountOwnerUserId: "account-user-1",
        relayBaseUrls: ["https://relay.example"],
        authorizeAccountCommit: (expectedOwnerUserId) => (
          currentOwnerUserId === expectedOwnerUserId
        ),
        createWebSocket: () => new FakeWebSocket((text, ws) => {
          const envelope = parseSyncEnvelope(wsDataToText(text));
          if (envelope.type !== "hello") return;
          const payload = envelope.payload as { peer: unknown; auth: { deviceId: string } };
          releaseHello = () => ws.receive(encodeSyncEnvelope({
            type: "hello_ok",
            requestId: envelope.requestId,
            payload: {
              peer: payload.peer,
              brain: {
                deviceId: "host-race",
                deviceName: "Race Studio",
                platform: "macOS",
                deviceType: "desktop",
                siteId: "host-race-site",
                dbVersion: 0,
              },
              serverDbVersion: 0,
              heartbeatIntervalMs: 5_000,
              pollIntervalMs: 1_500,
              cloudRelayWssUrl: "wss://relay.example/connect/machine-race",
              features: { rpcChannel: true, portForward: true },
              accountPairing: {
                deviceId: payload.auth.deviceId,
                secret: "account-paired-secret",
              },
            },
          }));
          markHelloSent?.();
        }) as unknown as WebSocket,
      },
    );

    await helloSent;
    currentOwnerUserId = ownerUserId;
    releaseHello!();

    await expect(pairing).rejects.toThrow(/account changed/i);
    expect(store.list()).toEqual([]);
  });

  it("stops account endpoint fallback immediately when authentication is cancelled", async () => {
    const adeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-desktop-account-cancel-"));
    process.env.ADE_HOME = adeHome;
    const controller = new AbortController();
    const openedEndpoints: string[] = [];
    const machine: AdeAccountMachine = {
      machineKey: "machine-cancel",
      deviceId: "host-cancel",
      name: "Cancelled Studio",
      platform: "macOS",
      deviceType: "desktop",
      online: true,
      lastSeenAt: Date.now(),
      reachableEndpoints: [
        { kind: "relay", url: "wss://relay-one.example/connect/machine-cancel" },
        { kind: "relay", url: "wss://relay-two.example/connect/machine-cancel" },
      ],
    };

    await expect(new DesktopPairedMachineStore().pairWithAccountMachine(
      machine,
      "account-token",
      "Laptop",
      {
        accountOwnerUserId: "account-user-1",
        signal: controller.signal,
        relayBaseUrls: ["https://relay-one.example", "https://relay-two.example"],
        createWebSocket: (endpoint) => {
          openedEndpoints.push(endpoint);
          return new FakeWebSocket((text) => {
            const envelope = parseSyncEnvelope(wsDataToText(text));
            if (envelope.type === "hello") {
              controller.abort(new Error("cancel account authentication"));
            }
          }) as unknown as WebSocket;
        },
      },
    )).rejects.toThrow("cancel account authentication");

    expect(openedEndpoints).toEqual([
      "wss://relay-one.example/connect/machine-cancel",
    ]);
  });

  it("stops account endpoint fallback immediately when connection opening is cancelled", async () => {
    const adeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-desktop-account-connect-cancel-"));
    process.env.ADE_HOME = adeHome;
    const controller = new AbortController();
    const openedEndpoints: string[] = [];
    const machine: AdeAccountMachine = {
      machineKey: "machine-connect-cancel",
      deviceId: "host-connect-cancel",
      name: "Cancelled Studio",
      platform: "macOS",
      deviceType: "desktop",
      online: true,
      lastSeenAt: Date.now(),
      reachableEndpoints: [
        { kind: "relay", url: "wss://relay-one.example/connect/machine-connect-cancel" },
        { kind: "relay", url: "wss://relay-two.example/connect/machine-connect-cancel" },
      ],
    };

    const pairing = new DesktopPairedMachineStore().pairWithAccountMachine(
      machine,
      "account-token",
      "Laptop",
      {
        accountOwnerUserId: "account-user-1",
        signal: controller.signal,
        relayBaseUrls: ["https://relay-one.example", "https://relay-two.example"],
        createWebSocket: (endpoint) => {
          openedEndpoints.push(endpoint);
          return new FakeWebSocket(() => {}, false) as unknown as WebSocket;
        },
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort(new Error("cancel account connection"));

    await expect(pairing).rejects.toThrow("cancel account connection");
    expect(openedEndpoints).toEqual([
      "wss://relay-one.example/connect/machine-connect-cancel",
    ]);
  });
});
