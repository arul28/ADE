import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import type { SyncDpopVerification } from "../../../../../ade-cli/src/services/sync/syncDpop";
import { verifySyncDpopProof } from "../../../../../ade-cli/src/services/sync/syncDpop";
import type { SyncDpopProof } from "../../../shared/types/sync";
import type { AdeAccountMachine } from "../../../shared/types/account";
import type { DesktopPairedMachineCredentials } from "../../../shared/types/pairedRuntime";
import { encodeSyncEnvelope, parseSyncEnvelope, wsDataToText } from "../sync/syncProtocol";
import { DesktopPairedMachineStore } from "./syncPairedMachineStore";

const originalAdeHome = process.env.ADE_HOME;

afterEach(() => {
  if (originalAdeHome === undefined) delete process.env.ADE_HOME;
  else process.env.ADE_HOME = originalAdeHome;
});

class FakeWebSocket extends EventEmitter {
  readyState = 0;
  bufferedAmount = 0;

  constructor(private readonly onSend: (text: string, ws: FakeWebSocket) => void) {
    super();
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit("open");
    });
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

describe("DesktopPairedMachineStore", () => {
  it("pairs as a desktop with DPoP and round-trips a 0600 machine secret file", async () => {
    const adeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-desktop-pairing-"));
    process.env.ADE_HOME = adeHome;
    let pairedPublicKey: string | null = null;
    let pairedDeviceType: unknown = null;
    let pairedRuntimeHostGrant: unknown = null;
    let dpopVerdict: SyncDpopVerification | null = null;

    const createWebSocket = () => new FakeWebSocket((text, ws) => {
        const envelope = parseSyncEnvelope(wsDataToText(text));
        if (envelope.type === "pairing_request") {
          const payload = envelope.payload as {
            code: string;
            dpopPublicKey?: string;
            runtimeHostGrant?: string;
            peer: { deviceId: string; deviceType: unknown };
          };
          pairedPublicKey = payload.dpopPublicKey ?? null;
          pairedDeviceType = payload.peer.deviceType;
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
          };
        };
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
        runtimeHostGrant: "server-issued-runtime-grant",
      },
    );

    expect(pairedDeviceType).toBe("desktop");
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

  it("uses account auth only on a verified WSS relay and preserves an existing paired secret", async () => {
    const adeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-desktop-account-pairing-"));
    process.env.ADE_HOME = adeHome;
    const openedEndpoints: string[] = [];
    const accountDpopVerdicts: SyncDpopVerification[] = [];
    let accountHelloCount = 0;
    const machine: AdeAccountMachine = {
      machineKey: "machine-account-1",
      deviceId: "host-account-1",
      name: "Account Studio",
      platform: "macOS",
      deviceType: "desktop",
      online: true,
      lastSeenAt: Date.now(),
      reachableEndpoints: [
        { kind: "relay", url: "ws://relay.example/connect/plaintext" },
        { kind: "relay", url: "wss://relay.example/connect/machine-account-1?token=hostile" },
        { kind: "lan", url: "wss://arbitrary.example/account" },
        { kind: "lan", host: "studio.local", port: 8787 },
        { kind: "relay", url: "wss://relay.example/connect/machine-account-1" },
      ],
    };
    const createWebSocket = (endpoint: string) => {
      openedEndpoints.push(endpoint);
      return new FakeWebSocket((text, ws) => {
        const envelope = parseSyncEnvelope(wsDataToText(text));
        if (envelope.type !== "hello") return;
        accountHelloCount += 1;
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
        }));
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
            cloudRelayWssUrl: "wss://relay.example/connect/machine-account-1",
            features: { rpcChannel: true, portForward: true },
            ...(accountHelloCount === 1
              ? {
                  accountPairing: {
                    deviceId: payload.auth.deviceId,
                    secret: "account-issued-paired-secret",
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
      { pairingTimeoutMs: 2_000, createWebSocket, relayBaseUrls: ["https://relay.example"] },
    );
    const reauthenticated = await store.pairWithAccountMachine(
      machine,
      "clerk-access-token",
      "Web account client",
      { pairingTimeoutMs: 2_000, createWebSocket, relayBaseUrls: ["https://relay.example"] },
    );

    expect(openedEndpoints).toEqual([
      "wss://relay.example/connect/machine-account-1",
      "wss://relay.example/connect/machine-account-1",
    ]);
    expect(accountDpopVerdicts).toEqual([{ ok: true }, { ok: true }]);
    expect(adopted.secret).toBe("account-issued-paired-secret");
    expect(reauthenticated.secret).toBe("account-issued-paired-secret");
    expect(reauthenticated.deviceId).toBe(adopted.deviceId);
    expect(reauthenticated.dpopPublicKey).toBe(adopted.dpopPublicKey);
    expect(reauthenticated.endpoints).toContain("ws://studio.local:8787/");
    expect(reauthenticated.endpoints).not.toContain("wss://arbitrary.example/account");
    expect(reauthenticated.endpoints).not.toContain("ws://relay.example/connect/plaintext");
    expect(fs.readFileSync(store.path, "utf8")).not.toContain("clerk-access-token");
  });
});
