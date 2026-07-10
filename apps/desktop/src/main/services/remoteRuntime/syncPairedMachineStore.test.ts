import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import type { SyncDpopVerification } from "../../../../../ade-cli/src/services/sync/syncDpop";
import { verifySyncDpopProof } from "../../../../../ade-cli/src/services/sync/syncDpop";
import type { SyncDpopProof } from "../../../shared/types/sync";
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
    let dpopVerdict: SyncDpopVerification | null = null;

    const createWebSocket = () => new FakeWebSocket((text, ws) => {
        const envelope = parseSyncEnvelope(wsDataToText(text));
        if (envelope.type === "pairing_request") {
          const payload = envelope.payload as {
            code: string;
            dpopPublicKey?: string;
            peer: { deviceId: string; deviceType: unknown };
          };
          pairedPublicKey = payload.dpopPublicKey ?? null;
          pairedDeviceType = payload.peer.deviceType;
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
      { pairingTimeoutMs: 2_000, createWebSocket },
    );

    expect(pairedDeviceType).toBe("desktop");
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
});
