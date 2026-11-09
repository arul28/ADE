import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { WebSocket } from "ws"; import { it, vi } from "vitest";
import { createSyncHostService } from "./syncHostService";
import { createSharedSyncListener, SYNC_RELAY_BRIDGE_PROOF_HEADER } from "./sharedSyncListener";
import { encodeSyncEnvelope, parseSyncEnvelope } from "./syncProtocol";
type SyncMobileProjectSummary = any;
function createTempProjectRoot(): { projectRoot: string; cleanup: () => void } {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-sync-discovery-"));
  return {
    projectRoot,
    cleanup: () => fs.rmSync(projectRoot, { recursive: true, force: true }),
  };
}

function createDiscoveryLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createHostArgs(projectRoot: string, projects: SyncMobileProjectSummary[]) {
  return {
    db: {
      sync: {
        getSiteId: () => "site-host-1",
        getDbVersion: () => 7,
        discardUnpublishedChangesForTables: () => {},
      },
    },
    logger: createDiscoveryLogger(),
    projectRoot,
    port: 0,
    discoveryEnabled: true,
    runtimeKind: "headless" as const,
    runtimeVersion: "2.0.0",
    heartbeatIntervalMs: 60_000,
    pollIntervalMs: 60_000,
    brainStatusIntervalMs: 60_000,
    pinStore: {
      getPin: () => null,
      hasPin: () => false,
      verifyPin: () => false,
      setPin: vi.fn(),
      clearPin: vi.fn(),
    },
    deviceRegistryService: {
      ensureLocalDevice: () => ({
        deviceId: "host-device-1",
        siteId: "host-site-1",
        name: "ADE Build Host",
        platform: "linux",
        deviceType: "vps",
        createdAt: "2026-05-10T12:00:00.000Z",
        updatedAt: "2026-05-10T12:00:00.000Z",
        lastSeenAt: "2026-05-10T12:00:00.000Z",
        lastHost: "build-host.local",
        lastPort: 8787,
        tailscaleIp: "100.64.0.10",
        ipAddresses: ["192.168.1.50"],
        metadata: { tailscaleDnsName: "ade-build.tailnet.ts.net." },
      }),
    },
    fileService: {},
    laneService: {
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      archive: vi.fn(),
    },
    prService: {
      listAll: vi.fn().mockResolvedValue([]),
      getDetail: vi.fn(),
      getStatus: vi.fn(),
      getChecks: vi.fn(),
      getReviews: vi.fn(),
      getComments: vi.fn(),
      getFiles: vi.fn(),
      createFromLane: vi.fn(),
      land: vi.fn(),
      closePr: vi.fn(),
      requestReviewers: vi.fn(),
    },
    sessionService: {
      list: () => [],
      get: () => null,
      readTranscriptTail: async () => "",
    },
    ptyService: {
      create: vi.fn(),
      readTranscriptTail: vi.fn(async () => ""),
      hasLivePty: () => true,
      enrichSessions: (rows: unknown[]) => rows,
    },
    computerUseArtifactBrokerService: {
      listArtifacts: () => [],
    },
    projectCatalogProvider: {
      listProjects: vi.fn(async () => ({ projects })),
      prepareProjectConnection: vi.fn(),
    },
  };
}

it("frames", async () => {
  const { projectRoot, cleanup } = createTempProjectRoot();
  const listener = createSharedSyncListener({ bindHost: "127.0.0.1" });
  const port = await listener.ensureListening([0]);
  const base = createHostArgs(projectRoot, []);
  const host = createSyncHostService({ ...base, discoveryEnabled: false, heartbeatIntervalMs: 60000, pollIntervalMs: 400, brainStatusIntervalMs: 5000, sharedListener: listener } as any);
  await new Promise((r) => setTimeout(r, 500));
  const open = async (name: string, headers: Record<string,string>) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { headers });
    const counts: Record<string, number> = {};
    let t0 = 0; let hello = "";
    ws.on("message", (d) => { const e: any = parseSyncEnvelope(Buffer.isBuffer(d) ? d.toString("utf8") : String(d)); if (e.type === "hello_ok") { hello = "ok"; t0 = Date.now(); return; } if (e.type === "hello_error") hello = JSON.stringify(e.payload); if (t0) counts[e.type] = (counts[e.type] ?? 0) + 1; });
    await new Promise<void>((res, rej) => { ws.once("open", () => res()); ws.once("error", rej); });
    ws.send(encodeSyncEnvelope({ type: "hello", requestId: name, payload: { peer: { deviceId: name, deviceName: name, platform: "iOS", deviceType: "phone", siteId: name + "-site", dbVersion: 0 }, auth: { kind: "bootstrap", token: host.getBootstrapToken() } } } as any));
    return { name, ws, counts, helloState: () => hello };
  };
  const a = await open("direct-peer", {});
  const b = await open("relay-peer", { [SYNC_RELAY_BRIDGE_PROOF_HEADER]: listener.getRelayBridgeProof() });
  await new Promise((r) => setTimeout(r, 125000));
  for (const p of [a, b]) console.log("FRAMES", p.name, p.helloState(), JSON.stringify(p.counts));
  a.ws.terminate(); b.ws.terminate(); cleanup(); await listener.close();
}, 200000);
