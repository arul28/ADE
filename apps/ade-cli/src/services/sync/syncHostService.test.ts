import fs from "node:fs";
import { createSign, generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { WebSocket, WebSocketServer } from "ws";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentChatEventEnvelope,
  CrsqlChangeRow,
  PersonalChatAction,
  PersonalChatScopeContract,
  SyncChangesetAckPayload,
  SyncChangesetBatchPayload,
  SyncCommandPayload,
  SyncInvalidationBatchPayload,
  SyncMobileProjectSummary,
  SyncPeerMetadata,
  SyncProjectCatalogPayload,
  SyncRemoteCommandDescriptor,
} from "../../../../desktop/src/shared/types";
import {
  SYNC_COMPACT_INVALIDATION_V1_CAPABILITY,
  SYNC_INVALIDATION_BATCH_MAX_ENVELOPE_BYTES,
  SYNC_INVALIDATION_TABLE_MAX_BYTES,
  SYNC_INVALIDATION_ONLY_V1_CAPABILITY,
  SYNC_RELAY_REAUTHORIZE_V1_CAPABILITY,
} from "../../../../desktop/src/shared/types";
import {
  MOBILE_SYNC_COMPATIBILITY_CONTRACT_VERSION,
  MOBILE_SYNC_OPTIONAL_REMOTE_COMMAND_ACTIONS,
  MOBILE_SYNC_REQUIRED_REMOTE_COMMAND_ACTIONS,
} from "../../../../desktop/src/shared/syncMobileCompatibility";
import {
  CHAT_EVENT_REPLAY_MAX_BYTES,
  CHAT_EVENT_REPLAY_MAX_EVENTS,
  CONNECTION_ATTEMPT_RESERVATION_TTL_MS,
  SYNC_HOST_CHAT_ACTIVE_BACKGROUND_BACKPRESSURE_BYTES,
  SYNC_HOST_CHAT_TRANSCRIPT_DELTA_MAX_BYTES,
  SYNC_HOST_CHAT_TRANSCRIPT_MAX_RECORD_BYTES,
  SYNC_HOST_MOBILE_REPLICA_RESEED_GAP,
  SYNC_HOST_PRIORITY_MAX_CHANGESET_DEFER_MS,
  buildSyncInvalidationBatchPayload,
  buildSyncHostHelloOkPayload,
  buildSyncProjectCatalogMessages,
  compactChatEventEnvelopeForSync,
  createChatEventReplayBuffer,
  createSyncHostService,
  createTerminalInputDedupeLedger,
  adoptedSyncHostCursorForPeer,
  initialSyncHostCursorForPeer,
  isRuntimeOnlySyncPeer,
  isRuntimeHostPairingRecord,
  planChatEventResume,
  recordChatEventInReplayBuffer,
  resolveSyncHostInboundProjectScope,
  selectChangesetBatchChunk,
  staleAdeTailnetServePorts,
  syncConnectionTransportForOrigin,
} from "./syncHostService";
import { createBrainProjectActionsSyncHandler } from "./brainProjectActionsSyncHandler";
import {
  generateMachinePairingPin,
  resetBrainMachineSyncStoresForTests,
  resolveBrainMachineSyncStores,
} from "./brainMachineSyncStores";
import { buildChangesetBatchPayload } from "./changesetPump";
import { createSharedSyncListener, SYNC_RELAY_BRIDGE_PROOF_HEADER } from "./sharedSyncListener";
import type { SyncLoopbackProbeResult } from "./syncLoopbackProbe";
import { createSyncPairingStore, type SyncPairingRecord } from "./syncPairingStore";
import { createSyncPinStore } from "./syncPinStore";
import { PAIR_FAILURE_THRESHOLD } from "./syncPairFailureTracker";
import { buildSyncDpopChallenge, sha256Hex } from "./syncDpop";
import {
  buildRelayReauthorizationChallenge,
  sha256RelayToken,
} from "./relayAuthorization";
import { DEFAULT_SYNC_MAX_FRAME_BYTES, encodeSyncEnvelope, negotiateSyncApplicationCompression, parseSyncEnvelope, PEER_BACKPRESSURE_BYTES, SYNC_CHUNKED_ENVELOPES_CAPABILITY, SYNC_PROTOCOL_VERSION_MISMATCH_CLOSE_CODE, SYNC_RUNTIME_ONLY_CAPABILITY, wsDataToText, type ParsedSyncEnvelope } from "./syncProtocol";
import { EncryptedFileCredentialStore } from "../credentials/credentialStore";
import { verifyClerkAccountAttestation } from "../account/accountAttestationVerifier";
import {
  buildAdoptChallengeSignatureInput,
  buildAdoptHelloAad,
  buildAdoptHelloOkAad,
  deriveAdoptSessionKey,
  generateX25519EphemeralKeyPair,
  seal,
  unseal,
  verifyEd25519,
} from "../../../../desktop/src/shared/sync/adoptChannelCrypto";
import { createMachineIdentitySigningStore } from "./machineIdentitySigningStore";

// The sync host now binds to all interfaces (0.0.0.0) by default so phones on
// the LAN can reach it. These tests assert the LOOPBACK-only posture (no LAN
// Bonjour advertisement), which is now an opt-in mode selected via
// ADE_SYNC_BIND_HOST=127.0.0.1. SYNC_HOST_BIND_HOST is captured at module-load,
// so this must be set (via vi.hoisted) before syncHostService.ts is imported.
const ORIGINAL_ADE_SYNC_BIND_HOST = vi.hoisted(() => process.env.ADE_SYNC_BIND_HOST);
vi.hoisted(() => {
  process.env.ADE_SYNC_BIND_HOST = "127.0.0.1";
});

afterAll(() => {
  if (ORIGINAL_ADE_SYNC_BIND_HOST === undefined) {
    delete process.env.ADE_SYNC_BIND_HOST;
  } else {
    process.env.ADE_SYNC_BIND_HOST = ORIGINAL_ADE_SYNC_BIND_HOST;
  }
});

const publishMock = vi.hoisted(() => vi.fn());
const bonjourDestroyMock = vi.hoisted(() => vi.fn());
const bonjourConstructorMock = vi.hoisted(() => vi.fn());
const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("bonjour-service", () => ({
  Bonjour: bonjourConstructorMock,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: spawnMock,
  };
});

type BonjourPublishArgs = {
  name: string;
  type: string;
  protocol: string;
  port: number;
  txt: Record<string, string>;
  disableIPv6: boolean;
};

// Regression: `tailscale serve --bg` outlives the process that registered it,
// but ADE tracked the served port in memory only. Every restart -- and every
// force-kill that skipped teardown -- orphaned the previous entry, which stayed
// bound on the tailnet address and made ADE's own next wildcard bind fail
// EADDRINUSE against its own leftovers. It walked one port higher and leaked
// another, ratcheting forever: 66 stranded ports and ~70 failed binds per start
// on one machine.
describe("staleAdeTailnetServePorts", () => {
  const serveStatus = (ports: Record<string, string>) =>
    JSON.stringify({
      TCP: Object.fromEntries(
        Object.entries(ports).map(([port, forward]) => [port, { TCPForward: forward }]),
      ),
    });

  it("reclaims ADE's own stranded ports and keeps the live one", () => {
    const json = serveStatus({
      "8787": "127.0.0.1:8787",
      "8788": "127.0.0.1:8788",
      "8852": "127.0.0.1:8852",
    });
    expect(staleAdeTailnetServePorts(json, 8852)).toEqual([8787, 8788]);
  });

  it("leaves a hand-rolled serve in the same range alone", () => {
    const json = serveStatus({
      // Same port range, but forwarding somewhere ADE never would.
      "8790": "127.0.0.1:3000",
      "8791": "192.168.1.5:8791",
      "8792": "127.0.0.1:8792",
    });
    expect(staleAdeTailnetServePorts(json, 8852)).toEqual([8792]);
  });

  it("ignores ports outside ADE's sync range", () => {
    const json = serveStatus({ "443": "127.0.0.1:443", "9100": "127.0.0.1:9100" });
    expect(staleAdeTailnetServePorts(json, 8852)).toEqual([]);
  });

  it("returns nothing for unparseable or empty status", () => {
    expect(staleAdeTailnetServePorts("not json", 8852)).toEqual([]);
    expect(staleAdeTailnetServePorts(JSON.stringify({}), 8852)).toEqual([]);
  });
});

describe("resolveSyncHostInboundProjectScope", () => {
  it("keeps runtime-scoped envelopes projectless", () => {
    expect(resolveSyncHostInboundProjectScope("hello", "project-1", "project-1")).toEqual({
      ok: true,
      projectId: null,
      usedSingleProjectFallback: false,
    });
    expect(resolveSyncHostInboundProjectScope("project_catalog_request", null, "project-1")).toEqual({
      ok: true,
      projectId: null,
      usedSingleProjectFallback: false,
    });
  });

  it("resolves missing project id through the single-active-project fallback", () => {
    expect(resolveSyncHostInboundProjectScope("file_request", null, " project-1 ")).toEqual({
      ok: true,
      projectId: "project-1",
      usedSingleProjectFallback: true,
    });
    expect(resolveSyncHostInboundProjectScope("terminal_input", "  ", "project-1")).toEqual({
      ok: true,
      projectId: "project-1",
      usedSingleProjectFallback: true,
    });
    expect(resolveSyncHostInboundProjectScope("terminal_history", null, "project-1")).toEqual({
      ok: true,
      projectId: "project-1",
      usedSingleProjectFallback: true,
    });
  });

  it("accepts matching project-scoped envelopes", () => {
    expect(resolveSyncHostInboundProjectScope("changeset_batch", " project-1 ", "project-1")).toEqual({
      ok: true,
      projectId: "project-1",
      usedSingleProjectFallback: false,
    });
    expect(resolveSyncHostInboundProjectScope("chat_subscribe", "project-1", " project-1 ")).toEqual({
      ok: true,
      projectId: "project-1",
      usedSingleProjectFallback: false,
    });
  });

  it("accepts project-scoped envelopes that use the hosted DB project id alias", () => {
    expect(resolveSyncHostInboundProjectScope(
      "changeset_ack",
      "24b96ceb-7ff6-4852-af99-2c36ffa6e9bf",
      "project_80c9b7785de5e4060adf68c2",
      ["24b96ceb-7ff6-4852-af99-2c36ffa6e9bf"],
    )).toEqual({
      ok: true,
      projectId: "project_80c9b7785de5e4060adf68c2",
      usedSingleProjectFallback: false,
    });
  });

  it("rejects project-scoped envelopes for a different active project", () => {
    expect(resolveSyncHostInboundProjectScope("changeset_ack", "project-2", "project-1")).toMatchObject({
      ok: false,
      code: "project_mismatch",
      expectedProjectId: "project-1",
      receivedProjectId: "project-2",
    });
  });

  it("rejects project-scoped envelopes when no project is open", () => {
    expect(resolveSyncHostInboundProjectScope("terminal_subscribe", "project-1", null)).toMatchObject({
      ok: false,
      code: "project_not_open",
      expectedProjectId: null,
      receivedProjectId: "project-1",
    });
  });
});

describe("buildSyncHostHelloOkPayload", () => {
  it("selects deflate only when the peer explicitly offers it", () => {
    expect(negotiateSyncApplicationCompression(undefined)).toBeNull();
    expect(negotiateSyncApplicationCompression([])).toBeNull();
    expect(negotiateSyncApplicationCompression(["zstd-dict-v1", "gzip"])).toBeNull();
    expect(negotiateSyncApplicationCompression(["zstd-dict-v1", "deflate"])).toBe("deflate");
  });

  it("reports the host-observed connection transport", () => {
    expect(syncConnectionTransportForOrigin("direct")).toBe("direct");
    expect(syncConnectionTransportForOrigin("relay-bridge")).toBe("relay");
  });

  it("acknowledges invalidation-only sync only to peers that requested it", () => {
    const peer = {
      deviceId: "browser-1",
      deviceName: "ADE Browser",
      platform: "macOS",
      deviceType: "browser",
      siteId: "browser-site-1",
      dbVersion: 0,
      capabilities: [SYNC_INVALIDATION_ONLY_V1_CAPABILITY],
    } satisfies SyncPeerMetadata;
    const base = {
      brain: peer,
      serverDbVersion: 0,
      heartbeatIntervalMs: 30_000,
      pollIntervalMs: 400,
      projectCatalog: { projects: [] },
      projectCatalogEnabled: false,
      projectActionsEnabled: false,
      crossProjectChatEnabled: false,
      remoteCommandSupportedActions: [],
      remoteCommandDescriptors: [],
      localCommandDescriptors: [],
    };

    expect(buildSyncHostHelloOkPayload({ ...base, peer }).features.invalidationOnlyV1).toEqual({ enabled: true });
    expect(buildSyncHostHelloOkPayload({ ...base, peer }).features).not.toHaveProperty("chunkedEnvelopes");
    expect(buildSyncHostHelloOkPayload({
      ...base,
      peer,
      chunkedEnvelopes: true,
    }).features.chunkedEnvelopes).toEqual({
      enabled: true,
      maxFrameBytes: DEFAULT_SYNC_MAX_FRAME_BYTES,
    });
    expect(buildSyncHostHelloOkPayload({ ...base, peer }).features).not.toHaveProperty("compactInvalidationV1");
    expect(buildSyncHostHelloOkPayload({
      ...base,
      peer: {
        ...peer,
        capabilities: [
          SYNC_INVALIDATION_ONLY_V1_CAPABILITY,
          SYNC_COMPACT_INVALIDATION_V1_CAPABILITY,
        ],
      },
    }).features.compactInvalidationV1).toEqual({ enabled: true });
    const phoneFeatures = buildSyncHostHelloOkPayload({
      ...base,
      peer: {
        ...peer,
        deviceType: "phone",
        capabilities: [
          SYNC_INVALIDATION_ONLY_V1_CAPABILITY,
          SYNC_COMPACT_INVALIDATION_V1_CAPABILITY,
        ],
      },
    }).features;
    expect(phoneFeatures).not.toHaveProperty("invalidationOnlyV1");
    expect(phoneFeatures).not.toHaveProperty("compactInvalidationV1");
  });

  it("keeps invalidation envelopes bounded when table metadata is oversized", () => {
    const oversizedNamePayload = buildSyncInvalidationBatchPayload({
      fromDbVersion: 4,
      toDbVersion: 5,
      changes: [{
        ...makeChange(5, 0),
        table: "t".repeat(SYNC_INVALIDATION_TABLE_MAX_BYTES + 1),
      }],
      compressionThresholdBytes: Number.MAX_SAFE_INTEGER,
    });

    expect(oversizedNamePayload).toEqual({
      fromDbVersion: 4,
      toDbVersion: 5,
      tables: [],
      fullRefresh: true,
    });
    const oversizedEnvelopePayload = buildSyncInvalidationBatchPayload({
      fromDbVersion: 5,
      toDbVersion: 6,
      changes: Array.from({ length: 128 }, (_, index) => ({
        ...makeChange(6, index),
        table: `${String(index).padStart(3, "0")}${"t".repeat(253)}`,
      })),
      compressionThresholdBytes: Number.MAX_SAFE_INTEGER,
    });
    expect(oversizedEnvelopePayload).toEqual({
      fromDbVersion: 5,
      toDbVersion: 6,
      tables: [],
      fullRefresh: true,
    });

    for (const payload of [oversizedNamePayload, oversizedEnvelopePayload]) {
      expect(Buffer.byteLength(encodeSyncEnvelope({
        type: "invalidation_batch",
        payload,
        compressionThresholdBytes: Number.MAX_SAFE_INTEGER,
      }), "utf8")).toBeLessThanOrEqual(SYNC_INVALIDATION_BATCH_MAX_ENVELOPE_BYTES);
    }
  });

  it("advertises daemon-hosted project catalog support in hello_ok without desktop", () => {
    const peer = {
      deviceId: "ios-phone-1",
      deviceName: "Arul iPhone",
      platform: "iOS",
      deviceType: "phone",
      siteId: "ios-site-1",
      dbVersion: 0,
    } satisfies SyncPeerMetadata;
    const brain = {
      deviceId: "daemon-host-1",
      deviceName: "ADE daemon",
      platform: "linux",
      deviceType: "vps",
      siteId: "daemon-site-1",
      dbVersion: 7,
    } satisfies SyncPeerMetadata;
    const project = {
      id: "project-1",
      displayName: "ADE",
      rootPath: "/Users/admin/Projects/ADE",
      defaultBaseRef: "main",
      lastOpenedAt: "2026-04-22T12:00:00.000Z",
      laneCount: 3,
      isAvailable: true,
      isCached: true,
      isOpen: false,
    } satisfies SyncMobileProjectSummary;
    const remoteCommand = {
      action: "work.runQuickCommand",
      scope: "project",
      policy: { viewerAllowed: true },
    } satisfies SyncRemoteCommandDescriptor;
    const localPresenceCommand = {
      action: "lanes.presence.announce",
      scope: "project",
      policy: { viewerAllowed: true },
    } satisfies SyncRemoteCommandDescriptor;

    const payload = buildSyncHostHelloOkPayload({
      peer,
      brain,
      serverDbVersion: 7,
      heartbeatIntervalMs: 30_000,
      pollIntervalMs: 400,
      projectCatalog: { projects: [project] },
      projectCatalogEnabled: true,
      projectActionsEnabled: false,
      crossProjectChatEnabled: true,
      remoteCommandSupportedActions: [remoteCommand.action],
      remoteCommandDescriptors: [remoteCommand],
      localCommandDescriptors: [localPresenceCommand],
      compressionThresholdBytes: 100_000,
      connectionTransport: "relay",
    });

    expect(payload.peer).toBe(peer);
    expect(payload.brain).toBe(brain);
    expect(payload.serverDbVersion).toBe(7);
    expect(payload.connectionTransport).toBe("relay");
    expect(payload.projects).toEqual([project]);
    expect(payload.features.projectCatalog).toEqual({ enabled: true });
    expect(payload.features.projectActions).toEqual({ enabled: false });
    expect(payload.features.crossProjectChat).toEqual({ enabled: true });
    expect(payload.features.fileAccess).toBe(true);
    expect(payload.features.terminalStreaming).toBe(true);
    expect(payload.features.chatStreaming).toEqual({ enabled: true });
    // Phone peer without runtimeChannelEnabled: runtime channel + port-forward
    // must NOT be advertised as available.
    expect(payload.features.rpcChannel).toBe(false);
    expect(payload.features.portForward).toBe(false);
    expect(payload.features.commandRouting).toEqual({
      mode: "allowlisted",
      supportedActions: [remoteCommand.action, localPresenceCommand.action],
      actions: [remoteCommand, localPresenceCommand],
    });
    expect(payload.features.mobileCompatibility).toEqual({
      contractVersion: MOBILE_SYNC_COMPATIBILITY_CONTRACT_VERSION,
      mode: "limited",
      requiredActions: [...MOBILE_SYNC_REQUIRED_REMOTE_COMMAND_ACTIONS],
      missingActions: MOBILE_SYNC_REQUIRED_REMOTE_COMMAND_ACTIONS.filter(
        (action) => action !== remoteCommand.action && action !== localPresenceCommand.action,
      ),
    });
    // No relay URL supplied → field omitted for backward-compatible payloads.
    expect("cloudRelayWssUrl" in payload).toBe(false);
  });

  it("advertises the runtime RPC channel + port-forward only when the peer is an authorized desktop host", () => {
    const desktop = {
      deviceId: "mac-studio-1",
      deviceName: "Mac Studio",
      platform: "macOS",
      deviceType: "desktop",
      siteId: "desktop-site-1",
      dbVersion: 0,
    } satisfies SyncPeerMetadata;
    const base = {
      brain: desktop,
      serverDbVersion: 0,
      heartbeatIntervalMs: 30_000,
      pollIntervalMs: 400,
      projectCatalog: { projects: [] },
      projectCatalogEnabled: false,
      projectActionsEnabled: false,
      crossProjectChatEnabled: false,
      remoteCommandSupportedActions: [],
      remoteCommandDescriptors: [],
      localCommandDescriptors: [],
    };

    const enabled = buildSyncHostHelloOkPayload({
      ...base,
      peer: desktop,
      runtimeChannelEnabled: true,
    });
    expect(enabled.features.rpcChannel).toBe(true);
    expect(enabled.features.portForward).toBe(true);

    const disabled = buildSyncHostHelloOkPayload({
      ...base,
      peer: desktop,
      runtimeChannelEnabled: false,
    });
    expect(disabled.features.rpcChannel).toBe(false);
    expect(disabled.features.portForward).toBe(false);
  });

  it("derives runtime-channel authorization from the pairing record, not spoofed hello metadata", () => {
    const spoofedDesktopHello = {
      deviceId: "paired-mobile-1",
      deviceName: "Spoofed desktop",
      platform: "macOS",
      deviceType: "desktop",
      siteId: "paired-mobile-site-1",
      dbVersion: 0,
    } satisfies SyncPeerMetadata;
    const record = (runtimeHostGranted: boolean): SyncPairingRecord => ({
      secretHash: "hash",
      createdAt: "2026-07-10T00:00:00.000Z",
      lastUsedAt: null,
      peerName: "Paired peer",
      peerPlatform: "macOS",
      peerDeviceType: "desktop",
      runtimeHostGranted,
    });
    const base = {
      peer: spoofedDesktopHello,
      brain: spoofedDesktopHello,
      serverDbVersion: 0,
      heartbeatIntervalMs: 30_000,
      pollIntervalMs: 400,
      projectCatalog: { projects: [] },
      projectCatalogEnabled: false,
      projectActionsEnabled: false,
      crossProjectChatEnabled: false,
      remoteCommandSupportedActions: [],
      remoteCommandDescriptors: [],
      localCommandDescriptors: [],
    };

    const ungranted = buildSyncHostHelloOkPayload({
      ...base,
      runtimeChannelEnabled: isRuntimeHostPairingRecord(record(false)),
    });
    expect(ungranted.features.rpcChannel).toBe(false);
    expect(ungranted.features.portForward).toBe(false);

    const genuineDesktop = buildSyncHostHelloOkPayload({
      ...base,
      runtimeChannelEnabled: isRuntimeHostPairingRecord(record(true)),
    });
    expect(genuineDesktop.features.rpcChannel).toBe(true);
    expect(genuineDesktop.features.portForward).toBe(true);
  });

  it("advertises the cloud relay connect URL so already-paired phones learn the off-LAN route", () => {
    const metadata = {
      deviceId: "d",
      deviceName: "n",
      platform: "iOS",
      deviceType: "phone",
      siteId: "s",
      dbVersion: 0,
    } satisfies SyncPeerMetadata;
    const payload = buildSyncHostHelloOkPayload({
      peer: metadata,
      brain: metadata,
      serverDbVersion: 0,
      heartbeatIntervalMs: 30_000,
      pollIntervalMs: 400,
      projectCatalog: { projects: [] },
      projectCatalogEnabled: false,
      projectActionsEnabled: false,
      crossProjectChatEnabled: false,
      remoteCommandSupportedActions: [],
      remoteCommandDescriptors: [],
      localCommandDescriptors: [],
      cloudRelayWssUrl: "wss://relay.example/connect/abc123",
    });
    expect(payload.cloudRelayWssUrl).toBe("wss://relay.example/connect/abc123");
  });

  it("sends an explicit null when the relay is disabled so clients drop saved routes", () => {
    const metadata = {
      deviceId: "d",
      deviceName: "n",
      platform: "iOS",
      deviceType: "phone",
      siteId: "s",
      dbVersion: 0,
    } satisfies SyncPeerMetadata;
    const payload = buildSyncHostHelloOkPayload({
      peer: metadata,
      brain: metadata,
      serverDbVersion: 0,
      heartbeatIntervalMs: 30_000,
      pollIntervalMs: 400,
      projectCatalog: { projects: [] },
      projectCatalogEnabled: false,
      projectActionsEnabled: false,
      crossProjectChatEnabled: false,
      remoteCommandSupportedActions: [],
      remoteCommandDescriptors: [],
      localCommandDescriptors: [],
      cloudRelayWssUrl: null,
    });
    // Present-with-null ≠ absent: absent means "older host, keep saved relay
    // routes"; null means "kill-switch off, clear them".
    expect("cloudRelayWssUrl" in payload).toBe(true);
    expect(payload.cloudRelayWssUrl).toBeNull();
  });
});

describe("runtime-only paired host changesets", () => {
  const metadata = {
    deviceId: "desktop-runtime-1",
    deviceName: "Desktop runtime",
    platform: "macOS",
    deviceType: "desktop",
    siteId: "desktop-runtime-site-1",
    dbVersion: 0,
    capabilities: [SYNC_RUNTIME_ONLY_CAPABILITY],
  } satisfies SyncPeerMetadata;
  const pairingRecord = (runtimeHostGranted: boolean): SyncPairingRecord => ({
    secretHash: "hash",
    createdAt: "2026-07-10T00:00:00.000Z",
    lastUsedAt: null,
    peerName: "Paired peer",
    peerPlatform: "macOS",
    peerDeviceType: "desktop",
    runtimeHostGranted,
  });

  it("suppresses CRDT only for an authenticated runtime-host grant", () => {
    expect(isRuntimeOnlySyncPeer({
      authKind: "paired",
      pairingRecord: pairingRecord(true),
      metadata,
    })).toBe(true);

    expect(isRuntimeOnlySyncPeer({
      authKind: "paired",
      pairingRecord: pairingRecord(false),
      metadata,
    })).toBe(false);
    expect(isRuntimeOnlySyncPeer({
      authKind: "bootstrap",
      pairingRecord: pairingRecord(true),
      metadata,
    })).toBe(false);
    expect(isRuntimeOnlySyncPeer({
      authKind: "paired",
      pairingRecord: pairingRecord(true),
      metadata: { ...metadata, capabilities: [] },
    })).toBe(false);
  });
});

describe("buildSyncProjectCatalogMessages", () => {
  it("keeps small catalogs as a single catalog message", () => {
    const project = createDiscoveryProject({ id: "project-small", rootPath: "/srv/small" });

    expect(buildSyncProjectCatalogMessages({
      projectCatalog: { projects: [project] },
      requestId: "catalog-small",
      compressionThresholdBytes: Number.MAX_SAFE_INTEGER,
    })).toEqual([{
      type: "project_catalog",
      payload: { projects: [project] },
      requestId: "catalog-small",
    }]);
  });

  it("chunks oversized fallback catalogs with stable request metadata", () => {
    const projects = Array.from({ length: 3 }, (_, index) =>
      createDiscoveryProject({
        id: `project-large-${index}`,
        rootPath: `/srv/${"x".repeat(130_000)}-${index}`,
      }));

    const messages = buildSyncProjectCatalogMessages({
      projectCatalog: { projects },
      requestId: "catalog-large",
      compressionThresholdBytes: Number.MAX_SAFE_INTEGER,
      maxProjectCatalogEnvelopeBytes: 512,
    });

    expect(messages.length).toBeGreaterThan(1);
    expect(messages.every((message) => message.type === "project_catalog_chunk")).toBe(true);
    expect(messages.every((message) => message.requestId === "catalog-large")).toBe(true);
    const payloads = messages.map((message) => message.payload as { catalogId: string; index: number; total: number; done: boolean; projects: SyncMobileProjectSummary[] });
    expect(new Set(payloads.map((payload) => payload.catalogId)).size).toBe(1);
    expect(payloads.map((payload) => payload.index)).toEqual([0, 1, 2]);
    expect(payloads.every((payload) => payload.total === messages.length)).toBe(true);
    expect(payloads.map((payload) => payload.done)).toEqual([false, false, true]);
    expect(payloads.flatMap((payload) => payload.projects).map((project) => project.id)).toEqual(projects.map((project) => project.id));
  });
});

function makeChange(dbVersion: number, seq: number, value = `value-${seq}`): CrsqlChangeRow {
  return {
    table: "kv",
    pk: `key-${seq}`,
    cid: "value",
    val: value,
    col_version: dbVersion,
    db_version: dbVersion,
    site_id: "site-host",
    cl: 1,
    seq,
  };
}

describe("selectChangesetBatchChunk", () => {
  it("keeps a single db_version together when the row limit would split it", () => {
    const changes = [
      ...Array.from({ length: 400 }, (_, seq) => makeChange(7, seq)),
      makeChange(8, 400),
    ];

    const chunk = selectChangesetBatchChunk({
      changes,
      fromDbVersion: 0,
      toDbVersion: 8,
      maxRows: 250,
      maxBytes: Number.MAX_SAFE_INTEGER,
    });

    expect(chunk?.changes).toHaveLength(400);
    expect(chunk?.changes.every((change) => change.db_version === 7)).toBe(true);
    expect(chunk?.toDbVersion).toBe(7);
  });

  it("does not spread an unbounded same-db_version chunk to compute the watermark", () => {
    const changes = Array.from({ length: 70_000 }, (_, seq) => makeChange(9, seq));

    const chunk = selectChangesetBatchChunk({
      changes,
      fromDbVersion: 0,
      toDbVersion: 9,
      maxRows: 250,
      maxBytes: Number.MAX_SAFE_INTEGER,
    });

    expect(chunk?.changes).toHaveLength(70_000);
    expect(chunk?.toDbVersion).toBe(9);
  });

  it("keeps a single db_version together when the byte limit would split it", () => {
    const largeValue = "x".repeat(180_000);
    const changes = [
      makeChange(4, 0, largeValue),
      makeChange(4, 1, largeValue),
      makeChange(5, 2, "next-version"),
    ];

    const chunk = selectChangesetBatchChunk({
      changes,
      fromDbVersion: 0,
      toDbVersion: 5,
      maxRows: 250,
      maxBytes: 256 * 1024,
    });

    expect(chunk?.changes).toEqual(changes.slice(0, 2));
    expect(chunk?.toDbVersion).toBe(4);
  });

  it("includes one oversized row so sync can keep making progress", () => {
    const oversizedChange = makeChange(4, 0, "x".repeat(1024));
    const nextChange = makeChange(5, 1, "next-version");

    const chunk = selectChangesetBatchChunk({
      changes: [oversizedChange, nextChange],
      fromDbVersion: 0,
      toDbVersion: 5,
      maxRows: 250,
      maxBytes: 16,
    });

    expect(chunk?.changes).toEqual([oversizedChange]);
    expect(chunk?.toDbVersion).toBe(4);
  });

  it("can advance an empty changeset when all changes were filtered locally", () => {
    const chunk = selectChangesetBatchChunk({
      changes: [],
      fromDbVersion: 3,
      toDbVersion: 4,
      maxRows: 250,
      maxBytes: 256 * 1024,
    });

    expect(chunk).toEqual({ changes: [], toDbVersion: 4 });
  });
});

describe("buildChangesetBatchPayload", () => {
  it("does not build sendable payloads with empty changes", () => {
    const payload = buildChangesetBatchPayload({
      deviceId: "device-1",
      reason: "broadcast",
      fromDbVersion: 3,
      toDbVersion: 4,
      changes: [],
      maxRows: 250,
      maxBytes: 256 * 1024,
    });

    expect(payload).toBeNull();
  });
});

describe("brain project actions fallback handler", () => {
  it("switches fallback responses to deflate only after hello negotiation", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const secretsDir = path.join(projectRoot, "secrets");
    fs.mkdirSync(secretsDir, { recursive: true });
    const credentials = new EncryptedFileCredentialStore({
      secretsDir,
      keyMaterial: { read: () => null },
    });
    credentials.setSync("test.bootstrap", "bootstrap-token");
    const projects = Array.from({ length: 30 }, (_, index) => createDiscoveryProject({
      id: `project-${index}`,
      displayName: `Project ${index} ${"catalog-data ".repeat(20)}`,
    }));
    const handler = createBrainProjectActionsSyncHandler({
      logger: createDiscoveryLogger(),
      projectCatalogProvider: {
        listProjects: vi.fn(async () => ({ projects })),
        prepareProjectConnection: vi.fn(),
      },
      bootstrapCredentialStore: credentials,
      bootstrapTokenKey: "test.bootstrap",
      secretsDir,
      localDeviceIdPath: path.join(secretsDir, "device-id"),
      localSiteIdPath: path.join(secretsDir, "site-id"),
    });
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    server.on("connection", (ws, request) => handler({
      ws,
      remoteAddress: request.socket.remoteAddress ?? null,
      remotePort: request.socket.remotePort ?? null,
      transportOrigin: "direct",
    }));
    let client: WebSocket | null = null;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
      client = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`);
      const { envelopes } = trackClientEnvelopes(client);
      await new Promise<void>((resolve, reject) => {
        client!.once("open", resolve);
        client!.once("error", reject);
      });
      client.send(encodeSyncEnvelope({
        type: "hello",
        requestId: "compression-hello",
        payload: {
          peer: {
            deviceId: "ios-compression-device",
            deviceName: "Compression iPhone",
            platform: "iOS",
            deviceType: "phone",
            siteId: "ios-compression-site",
            dbVersion: 0,
          },
          auth: { kind: "bootstrap", token: "bootstrap-token" },
          compression: ["deflate"],
        },
      }));
      const hello = await waitForEnvelope(envelopes, "hello_ok", "compression-hello");
      expect(hello.compression).toBe("gzip");
      expect(hello.payload).toMatchObject({
        compression: { codec: "deflate", thresholdBytes: 512 },
      });

      client.send(encodeSyncEnvelope({
        type: "project_catalog_request",
        requestId: "compressed-catalog",
        payload: {},
      }));
      const catalog = await waitForEnvelope(envelopes, "project_catalog", "compressed-catalog");
      expect(catalog.compression).toBe("deflate");
      expect((catalog.payload as SyncProjectCatalogPayload).projects).toHaveLength(projects.length);
    } finally {
      client?.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      cleanup();
    }
  });

  it.each(["close", "account-switch"] as const)(
    "cancels deferred Relay verification on peer %s before fallback authentication commits",
    async (mode) => {
      const { projectRoot, cleanup } = createTempProjectRoot();
      const secretsDir = path.join(projectRoot, "secrets");
      const pairing = createSpoofedDesktopPairing(secretsDir);
      let currentUserId = "account-a";
      let resolveVerification!: (value: never) => void;
      const verification = new Promise<never>((resolve) => { resolveVerification = resolve; });
      const verify = vi.fn(async () => await verification);
      const handler = createBrainProjectActionsSyncHandler({
        logger: createDiscoveryLogger(),
        projectCatalogProvider: {
          listProjects: vi.fn(async () => ({ projects: [] })),
          prepareProjectConnection: vi.fn(),
        },
        bootstrapCredentialStore: new EncryptedFileCredentialStore({
          secretsDir,
          keyMaterial: { read: () => null },
        }),
        secretsDir,
        localDeviceIdPath: path.join(secretsDir, "sync-device-id"),
        localSiteIdPath: path.join(secretsDir, "sync-site-id"),
        accountAuthService: {
          getStatus: () => ({
            signedIn: true,
            userId: currentUserId,
            email: null,
            name: null,
            expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
          }),
          getAccessToken: async () => "host-account-token",
        },
        getAccountAttestationConfig: () => ({
          issuer: "https://issuer.example",
          jwksUrl: "https://issuer.example/jwks",
          oauthClientId: "client-id",
        }),
        verifyAccountAttestation: verify,
      });
      const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      server.on("connection", (ws, request) => handler({
        ws,
        remoteAddress: request.socket.remoteAddress ?? null,
        remotePort: request.socket.remotePort ?? null,
        transportOrigin: "relay-bridge",
      }));
      let client: WebSocket | null = null;
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("listening", resolve);
          server.once("error", reject);
        });
        const port = (server.address() as AddressInfo).port;
        client = new WebSocket(`ws://127.0.0.1:${port}`);
        const { envelopes } = trackClientEnvelopes(client);
        await new Promise<void>((resolve, reject) => {
          client!.once("open", resolve);
          client!.once("error", reject);
        });
        sendSpoofedPairedHello(client, pairing.helloPeer, pairing.secret, "client-account-token");
        await vi.waitFor(() => expect(verify).toHaveBeenCalledTimes(1));
        if (mode === "close") {
          client.close();
          await new Promise((resolve) => setTimeout(resolve, 25));
        } else currentUserId = "account-b";
        resolveVerification({
          userId: "account-a",
          expiresAtMs: Date.now() + 60_000,
        } as never);

        if (mode === "account-switch") {
          await expect(waitForEnvelope(envelopes, "hello_error", "spoofed-hello"))
            .resolves.toMatchObject({ payload: { code: "relay_account_required" } });
        } else {
          await new Promise((resolve) => setTimeout(resolve, 25));
          expect(envelopes.some((entry) => entry.type === "hello_ok")).toBe(false);
        }
      } finally {
        resolveVerification({ userId: "account-a", expiresAtMs: Date.now() + 60_000 } as never);
        client?.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        cleanup();
      }
    },
  );

  it("does not send fallback hello_ok when the peer closes during deferred catalog load", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const secretsDir = path.join(projectRoot, "secrets");
    fs.mkdirSync(secretsDir, { recursive: true });
    const credentials = new EncryptedFileCredentialStore({ secretsDir, keyMaterial: { read: () => null } });
    credentials.setSync("test.bootstrap", "bootstrap-token");
    let resolveCatalog!: () => void;
    const catalogGate = new Promise<void>((resolve) => { resolveCatalog = resolve; });
    const listProjects = vi.fn(async () => {
      await catalogGate;
      return { projects: [] };
    });
    const handler = createBrainProjectActionsSyncHandler({
      logger: createDiscoveryLogger(),
      projectCatalogProvider: { listProjects, prepareProjectConnection: vi.fn() },
      bootstrapCredentialStore: credentials,
      bootstrapTokenKey: "test.bootstrap",
      secretsDir,
      localDeviceIdPath: path.join(secretsDir, "device-id"),
      localSiteIdPath: path.join(secretsDir, "site-id"),
    });
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    server.on("connection", (ws, request) => handler({
      ws,
      remoteAddress: request.socket.remoteAddress ?? null,
      remotePort: request.socket.remotePort ?? null,
      transportOrigin: "direct",
    }));
    let client: WebSocket | null = null;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
      client = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`);
      const { envelopes } = trackClientEnvelopes(client);
      await new Promise<void>((resolve, reject) => {
        client!.once("open", resolve);
        client!.once("error", reject);
      });
      sendHello(client, "bootstrap-token");
      await vi.waitFor(() => expect(listProjects).toHaveBeenCalledTimes(1));
      client.close();
      await new Promise((resolve) => setTimeout(resolve, 25));
      resolveCatalog();
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(envelopes.some((entry) => entry.type === "hello_ok")).toBe(false);
    } finally {
      resolveCatalog();
      client?.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      cleanup();
    }
  });

  it("closes a fallback Relay peer when its account proof expires", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const secretsDir = path.join(projectRoot, "secrets");
    const pairing = createSpoofedDesktopPairing(secretsDir);
    const handler = createBrainProjectActionsSyncHandler({
      logger: createDiscoveryLogger(),
      projectCatalogProvider: {
        listProjects: vi.fn(async () => ({ projects: [] })),
        prepareProjectConnection: vi.fn(),
      },
      bootstrapCredentialStore: new EncryptedFileCredentialStore({
        secretsDir,
        keyMaterial: { read: () => null },
      }),
      secretsDir,
      localDeviceIdPath: path.join(secretsDir, "sync-device-id"),
      localSiteIdPath: path.join(secretsDir, "sync-site-id"),
      accountAuthService: {
        getStatus: () => ({
          signedIn: true,
          userId: "account-a",
          email: null,
          name: null,
          expiresAt: null,
        }),
        getAccessToken: async () => "host-account-token",
      },
      getAccountAttestationConfig: () => ({
        issuer: "https://issuer.example",
        jwksUrl: "https://issuer.example/jwks",
        oauthClientId: "client-id",
      }),
      verifyAccountAttestation: async () => ({
        userId: "account-a",
        expiresAtMs: Date.now() + 100,
      }) as never,
    });
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    server.on("connection", (ws, request) => handler({
      ws,
      remoteAddress: request.socket.remoteAddress ?? null,
      remotePort: request.socket.remotePort ?? null,
      transportOrigin: "relay-bridge",
    }));
    let client: WebSocket | null = null;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      client = new WebSocket(`ws://127.0.0.1:${port}`);
      const { envelopes } = trackClientEnvelopes(client);
      await new Promise<void>((resolve, reject) => {
        client!.once("open", resolve);
        client!.once("error", reject);
      });
      const closed = new Promise<{ code: number; reason: string }>((resolve) => {
        client!.once("close", (code, reason) => resolve({
          code,
          reason: reason.toString("utf8"),
        }));
      });
      sendSpoofedPairedHello(
        client,
        pairing.helloPeer,
        pairing.secret,
        "client-account-token",
      );
      await waitForEnvelope(envelopes, "hello_ok", "spoofed-hello");
      await expect(closed).resolves.toEqual({
        code: 4003,
        reason: "ADE Relay account proof expired",
      });
    } finally {
      client?.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      cleanup();
    }
  });

  it("serves personal commands and chat streams with zero projects", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const secretsDir = path.join(projectRoot, "secrets");
    fs.mkdirSync(secretsDir, { recursive: true });
    const transcriptPath = path.join(projectRoot, "personal-chat.jsonl");
    fs.writeFileSync(transcriptPath, "");
    const credentialStore = new EncryptedFileCredentialStore({
      secretsDir,
      keyMaterial: { read: () => null },
    });
    credentialStore.setSync("test.bootstrap", "bootstrap-token");
    const logger = createDiscoveryLogger();
    const personalChatScope: PersonalChatScopeContract = {
      capabilities: vi.fn(() => ({
        version: 1 as const,
        actions: ["list", "terminalCreate", "saveTempAttachment"],
      })),
      call: vi.fn(async (action: unknown, args: unknown) => {
        if (
          action === "getEventHistoryPage"
          && (args as { beforeOffset?: number } | null)?.beforeOffset === 4_096
        ) {
          throw new Error("personal history unavailable");
        }
        return {
          action: action as PersonalChatAction,
          result: action === "getEventHistory"
            ? { events: [], truncated: false }
            : action === "getEventHistoryPage"
              ? {
                  sessionId: "personal-1",
                  events: [],
                  startOffset: 1_024,
                  hasMore: true,
                  sessionFound: true,
                }
              : [{ sessionId: "personal-1", surface: "personal" }],
        };
      }),
      streamEvents: vi.fn(async () => ({ events: [], nextCursor: 0, hasMore: false })),
      transcriptPath: vi.fn(async () => transcriptPath),
      isTurnActive: vi.fn(async () => true),
    };
    const handler = createBrainProjectActionsSyncHandler({
      logger,
      projectCatalogProvider: {
        listProjects: vi.fn(async () => ({ projects: [] })),
        prepareProjectConnection: vi.fn(async () => ({ ok: false, message: "No projects." })),
      },
      bootstrapCredentialStore: credentialStore,
      bootstrapTokenKey: "test.bootstrap",
      secretsDir,
      localDeviceIdPath: path.join(secretsDir, "sync-device-id"),
      localSiteIdPath: path.join(secretsDir, "sync-site-id"),
      pollIntervalMs: 100,
      personalChatScope,
    });
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    server.on("connection", (ws, request) => handler({
      ws,
      remoteAddress: request.socket.remoteAddress ?? null,
      remotePort: request.socket.remotePort ?? null,
      transportOrigin: "direct",
    }));
    let client: WebSocket | null = null;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("listening", () => resolve());
        server.once("error", reject);
      });
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      client = new WebSocket(`ws://127.0.0.1:${port}`);
      const { envelopes } = trackClientEnvelopes(client);
      await new Promise<void>((resolve, reject) => {
        client!.once("open", () => resolve());
        client!.once("error", reject);
      });
      sendHello(client, "bootstrap-token");
      const hello = await waitForValue(
        () => envelopes.find((envelope) => envelope.type === "hello_ok"),
        "personal fallback hello",
      );
      expect(hello.payload).toMatchObject({
        projects: [],
        features: {
          commandRouting: {
            actions: expect.arrayContaining([
              expect.objectContaining({ action: "personalChats.list", scope: "runtime" }),
              expect.objectContaining({ action: "personalChats.terminalCreate", scope: "runtime" }),
              expect.objectContaining({ action: "personalChats.streamEvents", scope: "runtime" }),
            ]),
          },
        },
      });

      client.send(encodeSyncEnvelope({
        type: "command",
        requestId: "personal-list-request",
        payload: {
          commandId: "personal-list",
          action: "personalChats.list",
          args: {},
        },
      }));
      const result = await waitForEnvelope(envelopes, "command_result", "personal-list-request");
      expect(result.payload).toMatchObject({
        commandId: "personal-list",
        ok: true,
        result: [{ sessionId: "personal-1", surface: "personal" }],
      });

      client.send(encodeSyncEnvelope({
        type: "chat_subscribe",
        requestId: "personal-subscribe",
        payload: { sessionId: "personal-1", chatScope: "personal" },
      }));
      const snapshot = await waitForEnvelope(envelopes, "chat_subscribe", "personal-subscribe");
      expect(snapshot.payload).toMatchObject({
        sessionId: "personal-1",
        events: [],
        turnActive: true,
      });

      client.send(encodeSyncEnvelope({
        type: "chat_history",
        requestId: "personal-history",
        payload: {
          sessionId: "personal-1",
          chatScope: "personal",
          beforeOffset: 2_048,
        },
      }));
      const historyPage = await waitForEnvelope(envelopes, "chat_history", "personal-history");
      expect(historyPage.payload).toMatchObject({
        sessionId: "personal-1",
        startOffset: 1_024,
        hasMore: true,
        sessionFound: true,
      });

      client.send(encodeSyncEnvelope({
        type: "chat_history",
        requestId: "personal-history-failed",
        payload: {
          sessionId: "personal-1",
          chatScope: "personal",
          beforeOffset: 4_096,
        },
      }));
      const failedHistoryPage = await waitForEnvelope(
        envelopes,
        "chat_history",
        "personal-history-failed",
      );
      expect(failedHistoryPage.payload).toMatchObject({
        sessionId: "personal-1",
        startOffset: 4_096,
        unavailable: true,
      });
      expect(logger.warn).toHaveBeenCalledWith("sync_brain.chat_history_failed", {
        sessionId: "personal-1",
        beforeOffset: 4_096,
        error: "personal history unavailable",
      });

      client.send(encodeSyncEnvelope({
        type: "chat_history",
        requestId: "unsupported-project-history",
        payload: {
          sessionId: "project-1",
          beforeOffset: 2_048,
        },
      }));
      const unsupportedPage = await waitForEnvelope(
        envelopes,
        "chat_history",
        "unsupported-project-history",
      );
      expect(unsupportedPage.payload).toMatchObject({
        sessionId: "project-1",
        startOffset: 2_048,
        unavailable: true,
      });
      const event: AgentChatEventEnvelope = {
        sessionId: "personal-1",
        timestamp: "2026-07-09T12:00:00.000Z",
        sequence: 1,
        event: { type: "text", text: "hello from fallback" },
      };
      fs.appendFileSync(transcriptPath, `${JSON.stringify(event)}\n`);
      const streamed = await waitForValue(
        () => envelopes.find((envelope) =>
          envelope.type === "chat_event"
          && (envelope.payload as AgentChatEventEnvelope).event.type === "text"
        ),
        "personal fallback chat event",
      );
      expect(streamed.payload).toMatchObject({ sessionId: "personal-1", sequence: 1 });
    } finally {
      try { client?.close(); } catch {}
      await new Promise<void>((resolve) => server.close(() => resolve()));
      cleanup();
    }
  });

  it("does not send a second switch result if post-response project completion fails", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const secretsDir = path.join(projectRoot, "secrets");
    fs.mkdirSync(secretsDir, { recursive: true });
    const credentialStore = new EncryptedFileCredentialStore({
      secretsDir,
      keyMaterial: { read: () => null },
    });
    credentialStore.setSync("test.bootstrap", "bootstrap-token");

    const project = createDiscoveryProject({
      id: "project-1",
      rootPath: projectRoot,
      isOpen: true,
    });
    const logger = createDiscoveryLogger();
    const handler = createBrainProjectActionsSyncHandler({
      logger,
      projectCatalogProvider: {
        listProjects: vi.fn(async () => ({ projects: [project] })),
        prepareProjectConnection: vi.fn(async () => ({
          ok: true,
          project,
          connection: null,
        })),
        completeProjectConnection: vi.fn(async () => {
          throw new Error("activation failed");
        }),
      },
      bootstrapCredentialStore: credentialStore,
      bootstrapTokenKey: "test.bootstrap",
      secretsDir,
      localDeviceIdPath: path.join(secretsDir, "sync-device-id"),
      localSiteIdPath: path.join(secretsDir, "sync-site-id"),
    });
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    server.on("connection", (ws, request) => {
      handler({
        ws,
        remoteAddress: request.socket.remoteAddress ?? null,
        remotePort: request.socket.remotePort ?? null,
        transportOrigin: "direct",
      });
    });

    let client: WebSocket | null = null;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("listening", () => resolve());
        server.once("error", reject);
      });
      const address = server.address();
      expect(typeof address).toBe("object");
      const port = typeof address === "object" && address ? address.port : 0;
      expect(port).toBeGreaterThan(0);

      client = new WebSocket(`ws://127.0.0.1:${port}`);
      const { envelopes } = trackClientEnvelopes(client);
      await new Promise<void>((resolve, reject) => {
        client!.once("open", () => resolve());
        client!.once("error", reject);
      });
      sendHello(client, "bootstrap-token");
      await waitForValue(
        () => envelopes.find((envelope) => envelope.type === "hello_ok"),
        "fallback hello_ok",
      );

      client.send(encodeSyncEnvelope({
        type: "project_switch_request",
        requestId: "switch-1",
        payload: { projectId: "project-1" },
      }));
      const result = await waitForEnvelope(envelopes, "project_switch_result", "switch-1");
      expect(result.payload).toMatchObject({ ok: true });

      await new Promise((resolve) => setTimeout(resolve, 100));
      const switchResults = envelopes.filter(
        (envelope) => envelope.type === "project_switch_result" && envelope.requestId === "switch-1",
      );
      expect(switchResults).toHaveLength(1);
      expect(logger.warn).toHaveBeenCalledWith(
        "sync_brain.project_switch_failed",
        expect.objectContaining({ message: "activation failed" }),
      );
    } finally {
      try {
        client?.close();
      } catch {
        // ignore
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      cleanup();
    }
  });

  it("refuses rpc/fwd when a PIN-authorized brain pairing request merely claims desktop", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const secretsDir = path.join(projectRoot, "secrets");
    const pairing = createSpoofedDesktopPairing(secretsDir);
    const handler = createBrainProjectActionsSyncHandler({
      logger: createDiscoveryLogger(),
      projectCatalogProvider: {
        listProjects: vi.fn(async () => ({ projects: [] })),
        prepareProjectConnection: vi.fn(),
      },
      bootstrapCredentialStore: new EncryptedFileCredentialStore({
        secretsDir,
        keyMaterial: { read: () => null },
      }),
      secretsDir,
      localDeviceIdPath: path.join(secretsDir, "sync-device-id"),
      localSiteIdPath: path.join(secretsDir, "sync-site-id"),
    });
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    server.on("connection", (ws, request) => {
      handler({
        ws,
        remoteAddress: request.socket.remoteAddress ?? null,
        remotePort: request.socket.remotePort ?? null,
        transportOrigin: "direct",
      });
    });
    let client: WebSocket | null = null;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
      const address = server.address();
      expect(typeof address).toBe("object");
      const port = typeof address === "object" && address ? address.port : 0;
      expect(port).toBeGreaterThan(0);
      client = new WebSocket(`ws://127.0.0.1:${port}`);
      const { envelopes } = trackClientEnvelopes(client);
      await new Promise<void>((resolve, reject) => {
        client!.once("open", resolve);
        client!.once("error", reject);
      });
      sendSpoofedPairedHello(client, pairing.helloPeer, pairing.secret);
      await expectSpoofedRuntimeChannelRefused(client, envelopes);
    } finally {
      client?.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      cleanup();
    }
  });

  it("rate-limits failed PIN pairing attempts before a project host owns the listener", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const secretsDir = path.join(projectRoot, "secrets");
    fs.mkdirSync(secretsDir, { recursive: true });
    const pinPath = path.join(secretsDir, "sync-pin.json");
    createSyncPinStore({ filePath: pinPath }).setPin("428193");

    const logger = createDiscoveryLogger();
    const bootstrapTokenPath = path.join(secretsDir, "sync-bootstrap-token");
    const handler = createBrainProjectActionsSyncHandler({
      logger,
      projectCatalogProvider: {
        listProjects: vi.fn(async () => ({ projects: [] })),
        prepareProjectConnection: vi.fn(async () => ({
          ok: false,
          message: "No hosted project is ready.",
        })),
      },
      bootstrapCredentialStore: new EncryptedFileCredentialStore({
        secretsDir,
        keyMaterial: { read: () => null },
      }),
      secretsDir,
      localDeviceIdPath: path.join(secretsDir, "sync-device-id"),
      localSiteIdPath: path.join(secretsDir, "sync-site-id"),
    });
    expect(fs.existsSync(bootstrapTokenPath)).toBe(false);
    expect(fs.existsSync(path.join(secretsDir, "credentials.json.enc"))).toBe(true);
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    server.on("connection", (ws, request) => {
      handler({
        ws,
        remoteAddress: request.socket.remoteAddress ?? null,
        remotePort: request.socket.remotePort ?? null,
        transportOrigin: "direct",
      });
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("listening", () => resolve());
        server.once("error", reject);
      });
      const address = server.address();
      expect(typeof address).toBe("object");
      const port = typeof address === "object" && address ? address.port : 0;
      expect(port).toBeGreaterThan(0);

      const sendPairingRequest = async (requestId: string, code: string, deviceId: string) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        const envelopes: ParsedSyncEnvelope[] = [];
        ws.on("message", (raw) => {
          envelopes.push(parseSyncEnvelope(wsDataToText(raw)));
        });
        await new Promise<void>((resolve, reject) => {
          ws.once("open", () => resolve());
          ws.once("error", reject);
        });
        const closed = new Promise<{ code: number; reason: string }>((resolve) => {
          ws.once("close", (closeCode, reason) => {
            resolve({ code: closeCode, reason: reason.toString("utf8") });
          });
        });
        ws.send(encodeSyncEnvelope({
          type: "pairing_request",
          requestId,
          payload: {
            code,
            peer: {
              deviceId,
              deviceName: "Fallback iPhone",
              platform: "iOS",
              deviceType: "phone",
              siteId: `${deviceId}-site`,
              dbVersion: 0,
            },
          },
        }));
        const response = await waitForValue(
          () => envelopes.find((envelope) => envelope.type === "pairing_result"),
          `pairing_result ${requestId}`,
        );
        return {
          payload: response.payload as {
            ok: boolean;
            error?: { code?: string; message?: string };
          },
          closed: await closed,
        };
      };

      for (let attempt = 0; attempt < PAIR_FAILURE_THRESHOLD; attempt += 1) {
        const failed = await sendPairingRequest(`bad-pin-${attempt}`, "000000", `ios-bad-${attempt}`);
        expect(failed.payload.ok).toBe(false);
        expect(failed.payload.error?.code).toBe("invalid_pin");
        expect(failed.closed.code).toBe(4003);
      }

      const limited = await sendPairingRequest("bad-pin-cooldown", "000000", "ios-rate-limited");
      expect(limited.payload.ok).toBe(false);
      expect(limited.payload.error?.code).toBe("pairing_failed");
      expect(limited.payload.error?.message).toMatch(/Too many failed PIN attempts/i);
      expect(limited.closed.code).toBe(4004);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      cleanup();
    }
  });
});

function createDiscoveryLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createTempProjectRoot(): { projectRoot: string; cleanup: () => void } {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-sync-discovery-"));
  return {
    projectRoot,
    cleanup: () => fs.rmSync(projectRoot, { recursive: true, force: true }),
  };
}

function createSpoofedDesktopPairing(secretsDir: string) {
  fs.mkdirSync(secretsDir, { recursive: true });
  const pinPath = path.join(secretsDir, "sync-pin.json");
  const pairingSecretsPath = path.join(secretsDir, "sync-paired-devices.json");
  const pinStore = createSyncPinStore({ filePath: pinPath });
  pinStore.setPin("428193");
  const recordedPeer = {
    deviceId: "spoofed-mobile-1",
    deviceName: "Self-claimed desktop",
    platform: "macOS",
    deviceType: "desktop",
    siteId: "spoofed-mobile-site-1",
    dbVersion: 0,
  } satisfies SyncPeerMetadata;
  const { secret } = createSyncPairingStore({
    filePath: pairingSecretsPath,
    pinStore,
  }).pairPeer(recordedPeer, "428193");
  return {
    pairingSecretsPath,
    pinPath,
    pinStore,
    secret,
    helloPeer: {
      ...recordedPeer,
      deviceName: "Self-claimed desktop",
    } satisfies SyncPeerMetadata,
  };
}

function sendSpoofedPairedHello(
  client: WebSocket,
  peer: SyncPeerMetadata,
  secret: string,
  relayAccountToken?: string,
): void {
  client.send(encodeSyncEnvelope({
    type: "hello",
    requestId: "spoofed-hello",
    payload: {
      peer,
      auth: {
        kind: "paired",
        deviceId: peer.deviceId,
        secret,
        relayAccountToken,
      },
    },
  }));
}

async function expectSpoofedRuntimeChannelRefused(
  client: WebSocket,
  envelopes: ParsedSyncEnvelope[],
): Promise<void> {
  const hello = await waitForEnvelope(envelopes, "hello_ok", "spoofed-hello");
  expect(hello.payload).toMatchObject({
    features: { rpcChannel: false, portForward: false },
  });
  client.send(encodeSyncEnvelope({
    type: "rpc_open",
    payload: { channelId: "spoofed-rpc" },
  }));
  client.send(encodeSyncEnvelope({
    type: "fwd_open",
    payload: { forwardId: "spoofed-forward", host: "127.0.0.1", port: 4173 },
  }));
  const rpcClose = await waitForValue(
    () => envelopes.find((envelope) =>
      envelope.type === "rpc_close"
      && (envelope.payload as { channelId?: unknown }).channelId === "spoofed-rpc"),
    "spoofed rpc_close",
  );
  const forwardClose = await waitForValue(
    () => envelopes.find((envelope) =>
      envelope.type === "fwd_close"
      && (envelope.payload as { forwardId?: unknown }).forwardId === "spoofed-forward"),
    "spoofed fwd_close",
  );
  expect(rpcClose.payload).toMatchObject({
    reason: "Runtime channel is only available to desktop clients.",
  });
  expect(forwardClose.payload).toMatchObject({
    reason: "Runtime channel is only available to desktop clients.",
  });
}

function createDiscoveryProject(overrides: Partial<SyncMobileProjectSummary>): SyncMobileProjectSummary {
  return {
    id: "project-1",
    displayName: "Project",
    rootPath: "/srv/project",
    defaultBaseRef: "main",
    lastOpenedAt: "2026-05-10T12:00:00.000Z",
    laneCount: 0,
    isAvailable: true,
    isCached: true,
    isOpen: false,
    ...overrides,
  };
}

function publishedAnnouncements(): BonjourPublishArgs[] {
  return publishMock.mock.calls.map(([payload]) => payload as BonjourPublishArgs);
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

describe("sync host account authentication", () => {
  const issuer = "https://sync-host-clerk.test";
  const oauthClientId = "sync-host-client";
  const ownerUserId = "user_sync_owner";
  let jwksServer: Server;
  let jwksUrl = "";
  let signingKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

  beforeAll(async () => {
    const keyPair = await generateKeyPair("RS256", { extractable: true });
    signingKey = keyPair.privateKey;
    const publicJwk = await exportJWK(keyPair.publicKey);
    const jwks = { keys: [{ ...publicJwk, alg: "RS256", kid: "sync-host-test-key", use: "sig" }] };
    jwksServer = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(jwks));
    });
    await new Promise<void>((resolve, reject) => {
      jwksServer.once("error", reject);
      jwksServer.listen(0, "127.0.0.1", resolve);
    });
    jwksUrl = `http://127.0.0.1:${(jwksServer.address() as AddressInfo).port}/jwks`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      jwksServer.close((error) => error ? reject(error) : resolve());
    });
  });

  async function mintAccountToken(
    sub = ownerUserId,
    expiresInSeconds = 600,
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "sync-host-test-key" })
      .setIssuer(issuer)
      .setSubject(sub)
      .setAudience(oauthClientId)
      .setIssuedAt(now)
      .setExpirationTime(now + expiresInSeconds)
      .sign(signingKey);
  }

  function makeDpopKeyPair() {
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
    const publicKeyX963 = Buffer.concat([
      Buffer.from([4]),
      Buffer.from(jwk.x, "base64url"),
      Buffer.from(jwk.y, "base64url"),
    ]).toString("base64");
    return { privateKey, publicKeyX963 };
  }

  function signAccountDpop(args: {
    privateKey: ReturnType<typeof makeDpopKeyPair>["privateKey"];
    publicKeyX963: string;
    deviceId: string;
    accountToken: string;
    advertisedPublicKeyX963?: string;
    signedDeviceId?: string;
  }) {
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = `account-${args.deviceId}-${Math.random()}`;
    const challenge = buildSyncDpopChallenge({
      deviceId: args.signedDeviceId ?? args.deviceId,
      secretSha256Hex: sha256Hex(args.accountToken),
      timestamp,
      nonce,
    });
    return {
      publicKey: args.advertisedPublicKeyX963 ?? args.publicKeyX963,
      timestamp,
      nonce,
      signature: createSign("sha256")
        .update(challenge, "utf8")
        .sign(args.privateKey)
        .toString("base64"),
    };
  }

  function signPairedDpop(args: {
    privateKey: ReturnType<typeof makeDpopKeyPair>["privateKey"];
    publicKeyX963: string;
    deviceId: string;
    secret: string;
  }) {
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = `paired-${args.deviceId}-${Math.random()}`;
    const challenge = buildSyncDpopChallenge({
      deviceId: args.deviceId,
      secretSha256Hex: sha256Hex(args.secret),
      timestamp,
      nonce,
    });
    return {
      publicKey: args.publicKeyX963,
      timestamp,
      nonce,
      signature: createSign("sha256")
        .update(challenge, "utf8")
        .sign(args.privateKey)
        .toString("base64"),
    };
  }

  function signRelayReauthorization(args: {
    privateKey: ReturnType<typeof makeDpopKeyPair>["privateKey"];
    deviceId: string;
    relayAccountToken: string;
    challenge: string;
    nonce?: string;
  }) {
    const timestamp = Math.floor(Date.now() / 1_000);
    const nonce = args.nonce ?? `relay-${args.deviceId}-${Math.random()}`;
    const canonical = buildRelayReauthorizationChallenge({
      deviceId: args.deviceId,
      relayAccountTokenSha256: sha256RelayToken(args.relayAccountToken),
      challenge: args.challenge,
      timestamp,
      nonce,
    });
    return {
      timestamp,
      nonce,
      signature: createSign("sha256")
        .update(canonical, "utf8")
        .sign(args.privateKey)
        .toString("base64"),
    };
  }

  function accountDependencies(signedIn = true) {
    return {
      accountAuthService: {
        getStatus: () => ({
          signedIn,
          userId: signedIn ? ownerUserId : null,
          email: null,
          name: null,
          expiresAt: null,
        }),
        getAccessToken: async () => {
          if (!signedIn) throw new Error("Signed out");
          return "host-account-lease";
        },
      },
      getAccountAttestationConfig: () => ({
        issuer,
        jwksUrl,
        oauthClientId,
      }),
    };
  }

  async function openAccountClient(port: number, relayBridgeProof?: string | null) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, relayBridgeProof
      ? { headers: { [SYNC_RELAY_BRIDGE_PROOF_HEADER]: relayBridgeProof } }
      : undefined);
    const tracked = trackClientEnvelopes(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    return { ws, ...tracked };
  }

  function sendAccountHello(args: {
    ws: WebSocket;
    peer: SyncPeerMetadata;
    accountToken: string;
    dpop?: ReturnType<typeof signAccountDpop> | null;
    runtimeHostGrant?: string | null;
  }): void {
    args.ws.send(encodeSyncEnvelope({
      type: "hello",
      payload: {
        peer: args.peer,
        auth: {
          kind: "account",
          deviceId: args.peer.deviceId,
          accountToken: args.accountToken,
          dpop: args.dpop ?? null,
          runtimeHostGrant: args.runtimeHostGrant ?? null,
        },
      },
    }));
  }

  function sendPairedHello(args: {
    ws: WebSocket;
    peer: SyncPeerMetadata;
    secret: string;
    dpop: ReturnType<typeof signPairedDpop>;
    relayAccountToken?: string | null;
  }): void {
    args.ws.send(encodeSyncEnvelope({
      type: "hello",
      payload: {
        peer: args.peer,
        auth: {
          kind: "paired",
          deviceId: args.peer.deviceId,
          secret: args.secret,
          dpop: args.dpop,
          relayAccountToken: args.relayAccountToken ?? null,
        },
      },
    }));
  }

  it("authenticates a signed sealed account hello over direct transport and seals hello_ok", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const secretsDir = path.join(projectRoot, ".ade", "secrets");
    const pinStore = createSyncPinStore({ filePath: path.join(secretsDir, "sync-pin.json") });
    const pairingSecretsPath = path.join(secretsDir, "sync-paired-devices.json");
    const pairingStore = createSyncPairingStore({ filePath: pairingSecretsPath, pinStore });
    const machineIdentitySigningStore = createMachineIdentitySigningStore({
      filePath: path.join(secretsDir, "machine-identity-signing.json"),
    });
    const baseArgs = createHostArgs(projectRoot, []);
    let adoptNow = Date.now();
    const host = createSyncHostService({
      ...baseArgs,
      ...accountDependencies(),
      pinStore,
      pairingStore,
      pairingSecretsPath,
      machineIdentitySigningStore,
      adoptNow: () => adoptNow,
      discoveryEnabled: false,
      deviceRegistryService: {
        ...baseArgs.deviceRegistryService,
        upsertPeerMetadata: vi.fn(),
      },
    } as unknown as Parameters<typeof createSyncHostService>[0]);
    const clients: Array<Awaited<ReturnType<typeof openAccountClient>>> = [];
    const issueChallenge = async (
      client: Awaited<ReturnType<typeof openAccountClient>>,
      requestId: string,
      supportedAeads?: string[],
    ) => {
      const nonce = Buffer.alloc(32, requestId.length);
      const ephemeral = generateX25519EphemeralKeyPair();
      client.ws.send(encodeSyncEnvelope({
        type: "account_challenge",
        requestId,
        payload: {
          v: 1,
          nonce: nonce.toString("base64"),
          clientEphemeralPublicKey: ephemeral.publicKeyRaw.toString("base64"),
          ...(supportedAeads ? { supportedAeads } : {}),
        },
      }));
      const envelope = await waitForValue(
        () => client.envelopes.find((entry) =>
          entry.type === "account_challenge_ok" && entry.requestId === requestId
        ),
        `${requestId} challenge`,
      );
      const payload = envelope.payload as {
        v: number;
        hostDeviceId: string;
        ts: number;
        hostEphemeralPublicKey: string;
        signature: string;
        aead?: string;
      };
      const canonical = buildAdoptChallengeSignatureInput({
        hostDeviceId: payload.hostDeviceId,
        nonce: nonce.toString("base64"),
        clientEphemeralPublicKey: ephemeral.publicKeyRaw.toString("base64"),
        hostEphemeralPublicKey: payload.hostEphemeralPublicKey,
        ts: payload.ts,
        ...(payload.aead ? { aead: payload.aead } : {}),
      });
      expect(verifyEd25519(
        Buffer.from(
          machineIdentitySigningStore.getOrCreate().publicKeyRawBase64,
          "base64",
        ),
        canonical,
        Buffer.from(payload.signature, "base64"),
      )).toBe(true);
      return {
        payload,
        sessionKey: deriveAdoptSessionKey({
          privateKey: ephemeral.privateKey,
          peerPublicKeyRaw: Buffer.from(payload.hostEphemeralPublicKey, "base64"),
          nonce,
        }),
      };
    };

    try {
      const port = await host.waitUntilListening();
      const client = await openAccountClient(port);
      clients.push(client);
      const challenge = await issueChallenge(client, "sealed-direct");
      expect(challenge.payload).toMatchObject({
        v: 1,
        hostDeviceId: "host-device-1",
        ts: adoptNow,
      });
      expect(challenge.payload).not.toHaveProperty("aead");
      const duplicateEphemeral = generateX25519EphemeralKeyPair();
      client.ws.send(encodeSyncEnvelope({
        type: "account_challenge",
        requestId: "duplicate-challenge",
        payload: {
          v: 1,
          nonce: Buffer.alloc(32, 9).toString("base64"),
          clientEphemeralPublicKey:
            duplicateEphemeral.publicKeyRaw.toString("base64"),
        },
      }));
      const duplicateChallenge = await waitForValue(
        () => client.envelopes.find((entry) =>
          entry.type === "account_challenge_error"
          && entry.requestId === "duplicate-challenge"
        ),
        "duplicate challenge rejection",
      );
      expect(duplicateChallenge.payload).toMatchObject({
        message: expect.stringMatching(/already active/i),
      });

      const accountToken = await mintAccountToken();
      const dpopKey = makeDpopKeyPair();
      const peer = {
        deviceId: "sealed-direct-device",
        deviceName: "Sealed direct device",
        platform: "macOS",
        deviceType: "desktop",
        siteId: "sealed-direct-site",
        dbVersion: 0,
        appVersion: "1.8.0",
      } satisfies SyncPeerMetadata;
      const accountAuth = {
        deviceId: peer.deviceId,
        accountToken,
        dpop: signAccountDpop({
          privateKey: dpopKey.privateKey,
          publicKeyX963: dpopKey.publicKeyX963,
          deviceId: peer.deviceId,
          accountToken,
        }),
      };
      client.ws.send(encodeSyncEnvelope({
        type: "hello",
        requestId: "sealed-hello",
        payload: {
          peer,
          auth: {
            kind: "account_sealed",
            v: 1,
            deviceId: peer.deviceId,
            sealed: seal(
              challenge.sessionKey,
              buildAdoptHelloAad(challenge.payload.hostDeviceId, peer.deviceId),
              Buffer.from(JSON.stringify(accountAuth)),
            ),
          },
        },
      }));
      const sealedHelloOk = await waitForValue(
        () => client.envelopes.find((entry) =>
          entry.type === "hello_ok" && entry.requestId === "sealed-hello"
        ),
        "sealed direct hello_ok",
      );
      expect(sealedHelloOk.payload).toMatchObject({
        v: 1,
        sealed: expect.any(String),
      });
      const openedHelloOk = JSON.parse(unseal(
        challenge.sessionKey,
        buildAdoptHelloOkAad(challenge.payload.hostDeviceId, peer.deviceId),
        (sealedHelloOk.payload as { sealed: string }).sealed,
      ).toString("utf8")) as {
        brain: { deviceId: string };
        connectionTransport: string;
        accountPairing: { deviceId: string; secret: string };
      };
      expect(openedHelloOk).toMatchObject({
        brain: { deviceId: "host-device-1" },
        connectionTransport: "direct",
        accountPairing: {
          deviceId: peer.deviceId,
          secret: expect.any(String),
        },
      });
      expect(pairingStore.authenticate(
        peer.deviceId,
        openedHelloOk.accountPairing.secret,
      )).toBe(true);
      expect(baseArgs.logger.warn).toHaveBeenCalledWith(
        "sync_host.legacy_adoption_aead_unbound",
        {
          deviceId: peer.deviceId,
          clientVersion: "1.8.0",
          aead: "chacha20-poly1305",
          transportOrigin: "direct",
        },
      );
      expect(baseArgs.logger.warn.mock.calls.some(
        ([message]) => message === "sync_host.account_auth_requires_relay",
      )).toBe(false);

      const aesClient = await openAccountClient(port);
      clients.push(aesClient);
      const aesChallenge = await issueChallenge(
        aesClient,
        "aes-challenge",
        ["aes-256-gcm"],
      );
      expect(aesChallenge.payload.aead).toBe("aes-256-gcm");
      const aesPeer = {
        ...peer,
        deviceId: "sealed-aes-device",
        siteId: "sealed-aes-site",
      };
      const aesAccountAuth = {
        deviceId: aesPeer.deviceId,
        accountToken,
        dpop: signAccountDpop({
          privateKey: dpopKey.privateKey,
          publicKeyX963: dpopKey.publicKeyX963,
          deviceId: aesPeer.deviceId,
          accountToken,
        }),
      };
      aesClient.ws.send(encodeSyncEnvelope({
        type: "hello",
        requestId: "sealed-aes-hello",
        payload: {
          peer: aesPeer,
          auth: {
            kind: "account_sealed",
            v: 1,
            deviceId: aesPeer.deviceId,
            sealed: seal(
              aesChallenge.sessionKey,
              buildAdoptHelloAad(
                aesChallenge.payload.hostDeviceId,
                aesPeer.deviceId,
              ),
              Buffer.from(JSON.stringify(aesAccountAuth)),
              undefined,
              "aes-256-gcm",
            ),
          },
        },
      }));
      const aesSealedHelloOk = await waitForValue(
        () => aesClient.envelopes.find((entry) =>
          entry.type === "hello_ok" && entry.requestId === "sealed-aes-hello"
        ),
        "AES sealed direct hello_ok",
      );
      const aesOpenedHelloOk = JSON.parse(unseal(
        aesChallenge.sessionKey,
        buildAdoptHelloOkAad(
          aesChallenge.payload.hostDeviceId,
          aesPeer.deviceId,
        ),
        (aesSealedHelloOk.payload as { sealed: string }).sealed,
        "aes-256-gcm",
      ).toString("utf8")) as {
        brain: { deviceId: string };
        accountPairing: { deviceId: string; secret: string };
      };
      expect(aesOpenedHelloOk).toMatchObject({
        brain: { deviceId: "host-device-1" },
        accountPairing: {
          deviceId: aesPeer.deviceId,
          secret: expect.any(String),
        },
      });
      expect(pairingStore.authenticate(
        aesPeer.deviceId,
        aesOpenedHelloOk.accountPairing.secret,
      )).toBe(true);
      expect(baseArgs.logger.warn.mock.calls.filter(
        ([message]) => message === "sync_host.legacy_adoption_aead_unbound",
      )).toHaveLength(1);

      const plainClient = await openAccountClient(port);
      clients.push(plainClient);
      const plainPeer = {
        ...peer,
        deviceId: "plain-direct-device",
        siteId: "plain-direct-site",
      };
      sendAccountHello({
        ws: plainClient.ws,
        peer: plainPeer,
        accountToken,
        dpop: signAccountDpop({
          privateKey: dpopKey.privateKey,
          publicKeyX963: dpopKey.publicKeyX963,
          deviceId: plainPeer.deviceId,
          accountToken,
        }),
      });
      await waitForValue(
        () => plainClient.envelopes.find((entry) => entry.type === "hello_error"),
        "plain direct account rejection",
      );
      expect(baseArgs.logger.warn.mock.calls.some(
        ([message]) => message === "sync_host.account_auth_requires_relay",
      )).toBe(true);

      const noChallengeClient = await openAccountClient(port);
      clients.push(noChallengeClient);
      noChallengeClient.ws.send(encodeSyncEnvelope({
        type: "hello",
        requestId: "missing-challenge",
        payload: {
          peer: { ...peer, deviceId: "missing-challenge-device" },
          auth: {
            kind: "account_sealed",
            v: 1,
            deviceId: "missing-challenge-device",
            sealed: Buffer.alloc(28).toString("base64"),
          },
        },
      }));
      const missingChallenge = await waitForValue(
        () => noChallengeClient.envelopes.find((entry) =>
          entry.type === "hello_error" && entry.requestId === "missing-challenge"
        ),
        "missing challenge rejection",
      );
      expect(missingChallenge.payload).toMatchObject({
        code: "invalid_hello",
        message: expect.stringMatching(/challenge is required/i),
      });

      const expiredClient = await openAccountClient(port);
      clients.push(expiredClient);
      await issueChallenge(expiredClient, "expired-challenge");
      adoptNow += 60_001;
      expiredClient.ws.send(encodeSyncEnvelope({
        type: "hello",
        requestId: "expired-hello",
        payload: {
          peer: { ...peer, deviceId: "expired-challenge-device" },
          auth: {
            kind: "account_sealed",
            v: 1,
            deviceId: "expired-challenge-device",
            sealed: Buffer.alloc(28).toString("base64"),
          },
        },
      }));
      const expired = await waitForValue(
        () => expiredClient.envelopes.find((entry) =>
          entry.type === "hello_error" && entry.requestId === "expired-hello"
        ),
        "expired challenge rejection",
      );
      expect(expired.payload).toMatchObject({
        code: "invalid_hello",
        message: expect.stringMatching(/expired/i),
      });

      const corruptClient = await openAccountClient(port);
      clients.push(corruptClient);
      await issueChallenge(corruptClient, "corrupt-sealed-challenge");
      corruptClient.ws.send(encodeSyncEnvelope({
        type: "hello",
        requestId: "corrupt-sealed-hello",
        payload: {
          peer: { ...peer, deviceId: "corrupt-sealed-device" },
          auth: {
            kind: "account_sealed",
            v: 1,
            deviceId: "corrupt-sealed-device",
            sealed: Buffer.alloc(28).toString("base64"),
          },
        },
      }));
      const corruptSealed = await waitForValue(
        () => corruptClient.envelopes.find((entry) =>
          entry.type === "hello_error" && entry.requestId === "corrupt-sealed-hello"
        ),
        "corrupt sealed hello rejection",
      );
      expect(corruptSealed.payload).toMatchObject({
        code: "invalid_hello",
        message: expect.stringMatching(/could not be opened/i),
      });
      expect(baseArgs.logger.warn).toHaveBeenCalledWith(
        "sync_host.account_sealed_open_failed",
        expect.objectContaining({
          aead: "chacha20-poly1305",
          transportOrigin: "direct",
        }),
      );

      const incompatibleClient = await openAccountClient(port);
      clients.push(incompatibleClient);
      const incompatibleEphemeral = generateX25519EphemeralKeyPair();
      incompatibleClient.ws.send(encodeSyncEnvelope({
        type: "account_challenge",
        requestId: "incompatible-aead",
        payload: {
          v: 1,
          nonce: Buffer.alloc(32, 11).toString("base64"),
          clientEphemeralPublicKey:
            incompatibleEphemeral.publicKeyRaw.toString("base64"),
          supportedAeads: ["future-aead"],
        },
      }));
      const incompatible = await waitForValue(
        () => incompatibleClient.envelopes.find((entry) =>
          entry.type === "account_challenge_error"
          && entry.requestId === "incompatible-aead"
        ),
        "incompatible AEAD rejection",
      );
      expect(incompatible.payload).toEqual({
        message:
          "No compatible account adoption cipher is available. Update ADE on both devices.",
      });
      expect(incompatibleClient.envelopes.some(
        (entry) => entry.type === "account_challenge_ok",
      )).toBe(false);
      incompatibleClient.ws.send(encodeSyncEnvelope({
        type: "account_challenge",
        requestId: "incompatible-aead-repeat",
        payload: {
          v: 1,
          nonce: Buffer.alloc(32, 12).toString("base64"),
          clientEphemeralPublicKey:
            incompatibleEphemeral.publicKeyRaw.toString("base64"),
          supportedAeads: ["future-aead"],
        },
      }));
      await waitForValue(
        () => incompatibleClient.envelopes.find((entry) =>
          entry.type === "account_challenge_error"
          && entry.requestId === "incompatible-aead-repeat"
        ),
        "repeated incompatible AEAD rejection",
      );
      expect(baseArgs.logger.warn.mock.calls.filter(
        ([event]) => event === "sync_host.account_challenge_cipher_incompatible",
      )).toHaveLength(1);

      // Well-formed challenges only trigger a public signature and are the
      // normal adoption operation, so they must NEVER trip the abuse throttle —
      // otherwise a few normal relay adoptions (all sharing the loopback origin)
      // would lock every adopter out. Issue several in a row; all are admitted.
      for (let index = 0; index < 8; index += 1) {
        const okClient = await openAccountClient(port);
        clients.push(okClient);
        await issueChallenge(okClient, `well-formed-${index}`);
      }

      // Only MALFORMED challenges (genuine abuse signals) count toward the
      // limiter. Five trip the cooldown; the sixth is throttled — and once
      // tripped, even a subsequent well-formed challenge is refused.
      const sendMalformedChallenge = (
        client: Awaited<ReturnType<typeof openAccountClient>>,
        requestId: string,
      ): void => {
        client.ws.send(encodeSyncEnvelope({
          type: "account_challenge",
          requestId,
          payload: { v: 1, nonce: "not-32-bytes", clientEphemeralPublicKey: "bad" },
        }));
      };
      for (let index = 0; index < PAIR_FAILURE_THRESHOLD; index += 1) {
        const badClient = await openAccountClient(port);
        clients.push(badClient);
        sendMalformedChallenge(badClient, `malformed-${index}`);
        await waitForValue(
          () => badClient.envelopes.find((entry) =>
            entry.type === "account_challenge_error"
            && entry.requestId === `malformed-${index}`
          ),
          `malformed-${index} rejection`,
        );
      }
      const throttledClient = await openAccountClient(port);
      clients.push(throttledClient);
      const throttledEphemeral = generateX25519EphemeralKeyPair();
      throttledClient.ws.send(encodeSyncEnvelope({
        type: "account_challenge",
        requestId: "rate-throttled",
        payload: {
          v: 1,
          nonce: Buffer.alloc(32, 10).toString("base64"),
          clientEphemeralPublicKey:
            throttledEphemeral.publicKeyRaw.toString("base64"),
        },
      }));
      const throttled = await waitForValue(
        () => throttledClient.envelopes.find((entry) =>
          entry.type === "account_challenge_error"
          && entry.requestId === "rate-throttled"
        ),
        "challenge issuance throttle",
      );
      expect(throttled.payload).toMatchObject({
        message: expect.stringMatching(/too many failed authentication attempts/i),
      });
    } finally {
      for (const client of clients) client.ws.close();
      await host.dispose();
      cleanup();
    }
  });

  it("commits exactly one concurrent account hello winner for the same connection attempt", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const secretsDir = path.join(projectRoot, ".ade", "secrets");
    const pinStore = createSyncPinStore({ filePath: path.join(secretsDir, "sync-pin.json") });
    const pairingSecretsPath = path.join(secretsDir, "sync-paired-devices.json");
    const pairingStore = createSyncPairingStore({ filePath: pairingSecretsPath, pinStore });
    const listener = createSharedSyncListener({ bindHost: "127.0.0.1" });
    const baseArgs = createHostArgs(projectRoot, []);
    const accountToken = await mintAccountToken();
    const attestation = await verifyClerkAccountAttestation({
      token: accountToken,
      expectedUserId: ownerUserId,
      config: { issuer, jwksUrl, oauthClientId },
    });
    let verifierCalls = 0;
    let releaseVerifier!: () => void;
    const verifierGate = new Promise<void>((resolve) => { releaseVerifier = resolve; });
    const pairCommit = vi.spyOn(pairingStore, "pairPeerViaAccount");
    const host = createSyncHostService({
      ...baseArgs,
      ...accountDependencies(),
      pinStore,
      pairingStore,
      pairingSecretsPath,
      sharedListener: listener,
      discoveryEnabled: false,
      verifyAccountAttestation: vi.fn(async () => {
        verifierCalls += 1;
        if (verifierCalls === 2) releaseVerifier();
        await verifierGate;
        return attestation;
      }),
      deviceRegistryService: {
        ...baseArgs.deviceRegistryService,
        upsertPeerMetadata: vi.fn(),
      },
    } as unknown as Parameters<typeof createSyncHostService>[0]);
    const clients: Array<Awaited<ReturnType<typeof openAccountClient>>> = [];
    try {
      const port = await host.waitUntilListening();
      const keys = makeDpopKeyPair();
      const attempt = { id: "parallel-account-race", startedAtMs: Date.now() };
      const peer = {
        deviceId: "parallel-account-device",
        deviceName: "Parallel account device",
        platform: "iOS",
        deviceType: "phone",
        siteId: "parallel-account-site",
        dbVersion: 0,
        connectionAttempt: attempt,
      } satisfies SyncPeerMetadata;
      for (let index = 0; index < 2; index += 1) {
        const client = await openAccountClient(port, listener.getRelayBridgeProof());
        clients.push(client);
        sendAccountHello({
          ws: client.ws,
          peer: { ...peer, siteId: `${peer.siteId}-${index}` },
          accountToken,
          dpop: signAccountDpop({
            privateKey: keys.privateKey,
            publicKeyX963: keys.publicKeyX963,
            deviceId: peer.deviceId,
            accountToken,
          }),
        });
      }

      await waitForValue(
        () => clients.flatMap((client) => client.envelopes)
          .filter((envelope) => envelope.type === "hello_ok" || envelope.type === "hello_error").length === 2
          ? true
          : null,
        "concurrent account race results",
      );
      const helloOks = clients.flatMap((client) => client.envelopes)
        .filter((envelope) => envelope.type === "hello_ok");
      const helloErrors = clients.flatMap((client) => client.envelopes)
        .filter((envelope) => envelope.type === "hello_error");
      expect(helloOks).toHaveLength(1);
      expect(helloErrors).toHaveLength(1);
      expect(helloErrors[0]?.payload).toMatchObject({ code: "connection_attempt_superseded" });
      expect(pairCommit).toHaveBeenCalledTimes(1);
      const winnerSecret = (helloOks[0]?.payload as { accountPairing?: { secret?: string } }).accountPairing?.secret;
      expect(winnerSecret).toEqual(expect.any(String));
      expect(pairingStore.authenticate(peer.deviceId, winnerSecret!)).toBe(true);
    } finally {
      pairCommit.mockRestore();
      for (const client of clients) client.ws.close();
      await host.dispose();
      await listener.close();
      cleanup();
    }
  });

  it("invalidates a timed-out account hello before its deferred verifier can mutate pairing state", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const secretsDir = path.join(projectRoot, ".ade", "secrets");
    const pinStore = createSyncPinStore({ filePath: path.join(secretsDir, "sync-pin.json") });
    const pairingSecretsPath = path.join(secretsDir, "sync-paired-devices.json");
    const pairingStore = createSyncPairingStore({ filePath: pairingSecretsPath, pinStore });
    const listener = createSharedSyncListener({ bindHost: "127.0.0.1" });
    const baseArgs = createHostArgs(projectRoot, []);
    const accountToken = await mintAccountToken();
    const attestation = await verifyClerkAccountAttestation({
      token: accountToken,
      expectedUserId: ownerUserId,
      config: { issuer, jwksUrl, oauthClientId },
    });
    let releaseVerifier!: () => void;
    const verifierGate = new Promise<void>((resolve) => { releaseVerifier = resolve; });
    const verify = vi.fn(async () => {
      await verifierGate;
      return attestation;
    });
    const host = createSyncHostService({
      ...baseArgs,
      ...accountDependencies(),
      pinStore,
      pairingSecretsPath,
      sharedListener: listener,
      discoveryEnabled: false,
      messageTimeoutMs: 100,
      verifyAccountAttestation: verify,
      deviceRegistryService: {
        ...baseArgs.deviceRegistryService,
        upsertPeerMetadata: vi.fn(),
      },
    } as unknown as Parameters<typeof createSyncHostService>[0]);
    let client: Awaited<ReturnType<typeof openAccountClient>> | null = null;
    try {
      const peer = {
        deviceId: "timed-out-account-device",
        deviceName: "Timed out account device",
        platform: "iOS",
        deviceType: "phone",
        siteId: "timed-out-account-site",
        dbVersion: 0,
        connectionAttempt: { id: "timed-out-attempt", startedAtMs: Date.now() },
      } satisfies SyncPeerMetadata;
      const keys = makeDpopKeyPair();
      client = await openAccountClient(await host.waitUntilListening(), listener.getRelayBridgeProof());
      sendAccountHello({
        ws: client.ws,
        peer,
        accountToken,
        dpop: signAccountDpop({
          privateKey: keys.privateKey,
          publicKeyX963: keys.publicKeyX963,
          deviceId: peer.deviceId,
          accountToken,
        }),
      });
      await vi.waitFor(() => expect(verify).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => setTimeout(resolve, 150));
      releaseVerifier();
      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(pairingStore.getPairingRecord(peer.deviceId)).toBeNull();
      expect(client.envelopes.some((envelope) => envelope.type === "hello_ok")).toBe(false);
    } finally {
      releaseVerifier();
      client?.ws.close();
      await host.dispose();
      await listener.close();
      cleanup();
    }
  });

  it("keeps direct desktop PIN capability separate from Relay and phone pairing", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const secretsDir = path.join(projectRoot, ".ade", "secrets");
    const pinStore = createSyncPinStore({ filePath: path.join(secretsDir, "sync-pin.json") });
    pinStore.setPin("428193");
    const pairingSecretsPath = path.join(secretsDir, "sync-paired-devices.json");
    const bootstrapTokenPath = path.join(secretsDir, "sync-bootstrap-token");
    const pairingStore = createSyncPairingStore({ filePath: pairingSecretsPath, pinStore });
    const listener = createSharedSyncListener({ bindHost: "127.0.0.1" });
    const baseArgs = createHostArgs(projectRoot, []);
    const host = createSyncHostService({
      ...baseArgs,
      ...accountDependencies(),
      pinStore,
      pairingSecretsPath,
      bootstrapTokenPath,
      sharedListener: listener,
      discoveryEnabled: false,
      deviceRegistryService: {
        ...baseArgs.deviceRegistryService,
        upsertPeerMetadata: vi.fn(),
      },
    } as unknown as Parameters<typeof createSyncHostService>[0]);
    const clients: Array<Awaited<ReturnType<typeof openAccountClient>>> = [];
    const pair = async (args: {
      deviceId: string;
      relay: boolean;
      relayAccountToken?: string | null;
      deviceType?: "desktop" | "phone";
    }) => {
      const client = await openAccountClient(
        await host.waitUntilListening(),
        args.relay ? listener.getRelayBridgeProof() : null,
      );
      clients.push(client);
      client.ws.send(encodeSyncEnvelope({
        type: "pairing_request",
        requestId: `pair-${args.deviceId}`,
        payload: {
          code: "428193",
          peer: {
            deviceId: args.deviceId,
            deviceName: args.deviceId,
            platform: args.deviceType === "phone" ? "iOS" : "macOS",
            deviceType: args.deviceType ?? "desktop",
            siteId: `${args.deviceId}-site`,
            dbVersion: 0,
          },
          relayAccountToken: args.relayAccountToken ?? null,
        },
      }));
      return await waitForValue(
        () => client.envelopes.find((envelope) => envelope.type === "pairing_result"),
        `pairing result ${args.deviceId}`,
      );
    };

    try {
      const missing = await pair({ deviceId: "relay-missing-account", relay: true });
      expect(missing.payload).toMatchObject({
        ok: false,
        error: { code: "relay_account_required" },
      });
      expect(pairingStore.getPairingRecord("relay-missing-account")).toBeNull();

      const wrongUser = await pair({
        deviceId: "relay-other-account",
        relay: true,
        relayAccountToken: await mintAccountToken("user_someone_else"),
      });
      expect(wrongUser.payload).toMatchObject({
        ok: false,
        error: { code: "relay_account_required" },
      });
      expect(pairingStore.getPairingRecord("relay-other-account")).toBeNull();

      const direct = await pair({ deviceId: "direct-no-account", relay: false });
      expect(direct.payload).toMatchObject({ ok: true });
      expect(pairingStore.getPairingRecord("direct-no-account")).toMatchObject({
        peerDeviceType: "desktop",
        runtimeHostGranted: true,
      });

      const directPhone = await pair({
        deviceId: "direct-phone",
        relay: false,
        deviceType: "phone",
      });
      expect(directPhone.payload).toMatchObject({ ok: true });
      expect(pairingStore.getPairingRecord("direct-phone")).toMatchObject({
        peerDeviceType: "phone",
        runtimeHostGranted: false,
      });

      const sameAccount = await pair({
        deviceId: "relay-same-account",
        relay: true,
        relayAccountToken: await mintAccountToken(),
      });
      expect(sameAccount.payload).toMatchObject({ ok: true });
      expect(pairingStore.getPairingRecord("relay-same-account")).toMatchObject({
        peerDeviceType: "desktop",
        runtimeHostGranted: false,
      });

      const bootstrapClient = await openAccountClient(
        await host.waitUntilListening(),
        listener.getRelayBridgeProof(),
      );
      clients.push(bootstrapClient);
      bootstrapClient.ws.send(encodeSyncEnvelope({
        type: "hello",
        requestId: "legacy-bootstrap-over-relay",
        payload: {
          peer: {
            deviceId: "legacy-relay-peer",
            deviceName: "Legacy Relay peer",
            platform: "iOS",
            deviceType: "phone",
            siteId: "legacy-relay-site",
            dbVersion: 0,
          },
          auth: {
            kind: "bootstrap",
            token: fs.readFileSync(bootstrapTokenPath, "utf8").trim(),
          },
        },
      }));
      const bootstrapRejected = await waitForValue(
        () => bootstrapClient.envelopes.find((envelope) => envelope.type === "hello_error"),
        "legacy Relay bootstrap rejection",
      );
      expect(bootstrapRejected.payload).toMatchObject({
        code: "relay_account_required",
        message: "Sign in with the same ADE account on both machines.",
      });
    } finally {
      for (const client of clients) client.ws.close();
      await host.dispose();
      await listener.close();
      cleanup();
    }
  });

  it("adopts through an authenticated relay handoff and returns credentials for ordinary paired DPoP", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const secretsDir = path.join(projectRoot, ".ade", "secrets");
    const pinStore = createSyncPinStore({ filePath: path.join(secretsDir, "sync-pin.json") });
    const pairingSecretsPath = path.join(secretsDir, "sync-paired-devices.json");
    const pairingStore = createSyncPairingStore({ filePath: pairingSecretsPath, pinStore });
    const runtimeHostGrant = pairingStore.issueRuntimeHostGrant();
    const baseArgs = createHostArgs(projectRoot, []);
    const listener = createSharedSyncListener({ bindHost: "127.0.0.1" });
    let host: ReturnType<typeof createSyncHostService> | null = null;
    let client: Awaited<ReturnType<typeof openAccountClient>> | null = null;
    let pairedClient: Awaited<ReturnType<typeof openAccountClient>> | null = null;
    try {
      const port = await listener.ensureListening([0]);
      client = await openAccountClient(port, listener.getRelayBridgeProof());
      const peer = {
        deviceId: "account-desktop-runtime",
        deviceName: "Account desktop runtime",
        platform: "macOS",
        deviceType: "desktop",
        siteId: "account-desktop-runtime-site",
        dbVersion: 0,
        capabilities: [SYNC_RUNTIME_ONLY_CAPABILITY],
      } satisfies SyncPeerMetadata;
      const accountToken = await mintAccountToken();
      const dpopKey = makeDpopKeyPair();
      sendAccountHello({
        ws: client.ws,
        peer,
        accountToken,
        dpop: signAccountDpop({
          privateKey: dpopKey.privateKey,
          publicKeyX963: dpopKey.publicKeyX963,
          deviceId: peer.deviceId,
          accountToken,
        }),
        runtimeHostGrant,
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(client.envelopes).toEqual([]);

      host = createSyncHostService({
        ...baseArgs,
        ...accountDependencies(),
        pinStore,
        pairingSecretsPath,
        sharedListener: listener,
        discoveryEnabled: false,
        deviceRegistryService: {
          ...baseArgs.deviceRegistryService,
          upsertPeerMetadata: vi.fn(),
        },
      } as unknown as Parameters<typeof createSyncHostService>[0]);
      expect(await host.waitUntilListening()).toBe(port);

      const hello = await waitForValue(
        () => client?.envelopes.find((envelope) => envelope.type === "hello_ok"),
        "account hello_ok",
      );
      expect(hello.payload).toMatchObject({
        features: { rpcChannel: true, portForward: true },
        accountPairing: {
          deviceId: peer.deviceId,
          secret: expect.stringMatching(/^[0-9a-f]{48}$/),
        },
      });
      const returnedSecret = (hello.payload as { accountPairing: { secret: string } }).accountPairing.secret;
      expect(pairingStore.authenticate(peer.deviceId, returnedSecret)).toBe(true);
      expect(pinStore.hasPin()).toBe(false);
      expect(pairingStore.getPairingRecord(peer.deviceId)).toMatchObject({
        dpopPublicKey: dpopKey.publicKeyX963,
        runtimeHostGranted: true,
        peerDeviceType: "desktop",
        lastUsedAt: expect.any(String),
      });
      expect(isRuntimeOnlySyncPeer({
        authKind: "account",
        pairingRecord: pairingStore.getPairingRecord(peer.deviceId),
        metadata: peer,
      })).toBe(true);

      const pairedConnection = await openAccountClient(port);
      pairedClient = pairedConnection;
      sendPairedHello({
        ws: pairedConnection.ws,
        peer,
        secret: returnedSecret,
        dpop: signPairedDpop({
          privateKey: dpopKey.privateKey,
          publicKeyX963: dpopKey.publicKeyX963,
          deviceId: peer.deviceId,
          secret: returnedSecret,
        }),
      });
      await waitForValue(
        () => pairedConnection.envelopes.find((envelope) => envelope.type === "hello_ok"),
        "paired hello after account adoption",
      );
    } finally {
      pairedClient?.ws.close();
      client?.ws.close();
      await host?.dispose();
      await listener.close();
      cleanup();
    }
  });

  it("rejects missing, forged, and stale relay proofs for first-time account adoption", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const secretsDir = path.join(projectRoot, ".ade", "secrets");
    const pinStore = createSyncPinStore({ filePath: path.join(secretsDir, "sync-pin.json") });
    const pairingSecretsPath = path.join(secretsDir, "sync-paired-devices.json");
    const pairingStore = createSyncPairingStore({ filePath: pairingSecretsPath, pinStore });
    const staleListener = createSharedSyncListener({ bindHost: "127.0.0.1" });
    const staleProof = staleListener.getRelayBridgeProof();
    await staleListener.close();
    const listener = createSharedSyncListener({ bindHost: "127.0.0.1" });
    const baseArgs = createHostArgs(projectRoot, []);
    const host = createSyncHostService({
      ...baseArgs,
      ...accountDependencies(),
      pinStore,
      pairingSecretsPath,
      sharedListener: listener,
      discoveryEnabled: false,
      deviceRegistryService: {
        ...baseArgs.deviceRegistryService,
        upsertPeerMetadata: vi.fn(),
      },
    } as unknown as Parameters<typeof createSyncHostService>[0]);
    const clients: Array<Awaited<ReturnType<typeof openAccountClient>>> = [];
    try {
      const port = await host.waitUntilListening();
      const accountToken = await mintAccountToken();
      const rejectedProofs = [
        ["missing", null],
        ["forged-static", "c".repeat(43)],
        ["stale-process", staleProof],
      ] as const;
      for (const [label, proof] of rejectedProofs) {
        const peer = {
          deviceId: `account-${label}-relay-proof`,
          deviceName: `Account ${label} relay proof`,
          platform: "iOS",
          deviceType: "phone",
          siteId: `account-${label}-relay-proof-site`,
          dbVersion: 0,
        } satisfies SyncPeerMetadata;
        const dpopKey = makeDpopKeyPair();
        const client = await openAccountClient(port, proof);
        clients.push(client);
        sendAccountHello({
          ws: client.ws,
          peer,
          accountToken,
          dpop: signAccountDpop({
            privateKey: dpopKey.privateKey,
            publicKeyX963: dpopKey.publicKeyX963,
            deviceId: peer.deviceId,
            accountToken,
          }),
        });
        await waitForValue(
          () => client.envelopes.find((envelope) => envelope.type === "hello_error"),
          `${label} relay proof rejection`,
        );
        expect(pairingStore.getPairingRecord(peer.deviceId)).toBeNull();
      }
    } finally {
      for (const client of clients) client.ws.close();
      await host.dispose();
      await listener.close();
      cleanup();
    }
  });

  it.each([
    { name: "sign-out", nextUserId: null, nextLease: null },
    { name: "account switch", nextUserId: "user_sync_other", nextLease: "host-lease-b" },
  ])("does not resurrect account trust when $name wins deferred attestation", async ({
    nextUserId,
    nextLease,
  }) => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const secretsDir = path.join(projectRoot, ".ade", "secrets");
    const pinStore = createSyncPinStore({ filePath: path.join(secretsDir, "sync-pin.json") });
    const pairingSecretsPath = path.join(secretsDir, "sync-paired-devices.json");
    const pairingStore = createSyncPairingStore({ filePath: pairingSecretsPath, pinStore });
    const accountToken = await mintAccountToken();
    const attestation = await verifyClerkAccountAttestation({
      token: accountToken,
      expectedUserId: ownerUserId,
      config: { issuer, jwksUrl, oauthClientId },
    });
    let currentUserId: string | null = ownerUserId;
    let currentLease: string | null = "host-lease-a";
    let finishVerification: ((value: typeof attestation) => void) | null = null;
    let markVerificationStarted: (() => void) | null = null;
    const verificationStarted = new Promise<void>((resolve) => {
      markVerificationStarted = resolve;
    });
    const baseArgs = createHostArgs(projectRoot, []);
    const listener = createSharedSyncListener({ bindHost: "127.0.0.1" });
    const host = createSyncHostService({
      ...baseArgs,
      accountAuthService: {
        getStatus: () => ({
          signedIn: currentUserId != null,
          userId: currentUserId,
          email: null,
          name: null,
          expiresAt: null,
        }),
        getAccessToken: async () => {
          if (!currentLease) throw new Error("Signed out");
          return currentLease;
        },
      },
      getAccountAttestationConfig: () => ({ issuer, jwksUrl, oauthClientId }),
      verifyAccountAttestation: async () => {
        markVerificationStarted?.();
        return await new Promise((resolve) => {
          finishVerification = resolve;
        });
      },
      pinStore,
      pairingSecretsPath,
      sharedListener: listener,
      discoveryEnabled: false,
      deviceRegistryService: {
        ...baseArgs.deviceRegistryService,
        upsertPeerMetadata: vi.fn(),
      },
    } as unknown as Parameters<typeof createSyncHostService>[0]);
    const client = await openAccountClient(
      await host.waitUntilListening(),
      listener.getRelayBridgeProof(),
    );
    const peer = {
      deviceId: `deferred-account-${nextUserId ?? "signed-out"}`,
      deviceName: "Deferred account client",
      platform: "iOS",
      deviceType: "phone",
      siteId: "deferred-account-site",
      dbVersion: 0,
    } satisfies SyncPeerMetadata;
    const key = makeDpopKeyPair();
    try {
      sendAccountHello({
        ws: client.ws,
        peer,
        accountToken,
        dpop: signAccountDpop({
          privateKey: key.privateKey,
          publicKeyX963: key.publicKeyX963,
          deviceId: peer.deviceId,
          accountToken,
        }),
      });
      await verificationStarted;
      currentUserId = nextUserId;
      currentLease = nextLease;
      finishVerification!(attestation);

      await waitForValue(
        () => client.envelopes.find((envelope) => envelope.type === "hello_error"),
        "deferred account hello rejection",
      );
      expect(pairingStore.getPairingRecord(peer.deviceId)).toBeNull();
    } finally {
      client.ws.close();
      await host.dispose();
      await listener.close();
      cleanup();
    }
  });

  it("closes an authenticated Relay peer when its account proof expires", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const secretsDir = path.join(projectRoot, ".ade", "secrets");
    const pinStore = createSyncPinStore({ filePath: path.join(secretsDir, "sync-pin.json") });
    const pairingSecretsPath = path.join(secretsDir, "sync-paired-devices.json");
    const listener = createSharedSyncListener({ bindHost: "127.0.0.1" });
    const baseArgs = createHostArgs(projectRoot, []);
    const host = createSyncHostService({
      ...baseArgs,
      ...accountDependencies(),
      pinStore,
      pairingSecretsPath,
      sharedListener: listener,
      discoveryEnabled: false,
      deviceRegistryService: {
        ...baseArgs.deviceRegistryService,
        upsertPeerMetadata: vi.fn(),
      },
    } as unknown as Parameters<typeof createSyncHostService>[0]);
    const client = await openAccountClient(
      await host.waitUntilListening(),
      listener.getRelayBridgeProof(),
    );
    const peer = {
      deviceId: "expiring-relay-account-peer",
      deviceName: "Expiring Relay peer",
      platform: "iOS",
      deviceType: "phone",
      siteId: "expiring-relay-site",
      dbVersion: 0,
    } satisfies SyncPeerMetadata;
    const accountToken = await mintAccountToken(ownerUserId, 2);
    const key = makeDpopKeyPair();
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      client.ws.once("close", (code, reason) => resolve({
        code,
        reason: reason.toString("utf8"),
      }));
    });
    try {
      sendAccountHello({
        ws: client.ws,
        peer,
        accountToken,
        dpop: signAccountDpop({
          privateKey: key.privateKey,
          publicKeyX963: key.publicKeyX963,
          deviceId: peer.deviceId,
          accountToken,
        }),
      });
      await waitForValue(
        () => client.envelopes.find((envelope) => envelope.type === "hello_ok"),
        "expiring Relay account hello_ok",
      );
      await expect(Promise.race([
        closed,
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error("Relay proof expiry did not close the peer")), 4_000);
        }),
      ])).resolves.toEqual({
        code: 4003,
        reason: "ADE Relay account proof expired",
      });
    } finally {
      client.ws.close();
      await host.dispose();
      await listener.close();
      cleanup();
    }
  }, 8_000);

  it("reissues an account-owned credential after a dropped hello and accepts the replacement directly", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const secretsDir = path.join(projectRoot, ".ade", "secrets");
    const pinStore = createSyncPinStore({ filePath: path.join(secretsDir, "sync-pin.json") });
    const pairingSecretsPath = path.join(secretsDir, "sync-paired-devices.json");
    const pairingStore = createSyncPairingStore({ filePath: pairingSecretsPath, pinStore });
    const peer = {
      deviceId: "existing-account-device",
      deviceName: "Existing account device",
      platform: "iOS",
      deviceType: "phone",
      siteId: "existing-account-device-site",
      dbVersion: 0,
    } satisfies SyncPeerMetadata;
    const legitimateKey = makeDpopKeyPair();
    const attackerKey = makeDpopKeyPair();
    const accountToken = await mintAccountToken();
    const attestation = await verifyClerkAccountAttestation({
      token: accountToken,
      expectedUserId: ownerUserId,
      config: { issuer, jwksUrl, oauthClientId },
    });
    const pairing = pairingStore.pairPeerViaAccount(peer, attestation, {
      dpopPublicKey: legitimateKey.publicKeyX963,
    });
    const baseArgs = createHostArgs(projectRoot, []);
    const listener = createSharedSyncListener({ bindHost: "127.0.0.1" });
    const host = createSyncHostService({
      ...baseArgs,
      ...accountDependencies(),
      pinStore,
      pairingSecretsPath,
      sharedListener: listener,
      discoveryEnabled: false,
      deviceRegistryService: {
        ...baseArgs.deviceRegistryService,
        upsertPeerMetadata: vi.fn(),
      },
    } as unknown as Parameters<typeof createSyncHostService>[0]);
    const clients: Array<Awaited<ReturnType<typeof openAccountClient>>> = [];
    try {
      const port = await host.waitUntilListening();
      const directAccountClient = await openAccountClient(port);
      clients.push(directAccountClient);
      sendAccountHello({
        ws: directAccountClient.ws,
        peer,
        accountToken,
        dpop: signAccountDpop({
          privateKey: legitimateKey.privateKey,
          publicKeyX963: legitimateKey.publicKeyX963,
          deviceId: peer.deviceId,
          accountToken,
        }),
      });
      const directAccountRejected = await waitForValue(
        () => directAccountClient.envelopes.find((envelope) => envelope.type === "hello_error"),
        "direct stored-key account rejection",
      );
      expect(directAccountRejected.payload).toMatchObject({
        code: "auth_failed",
        message: expect.stringMatching(/Connect through ADE Relay, or pair this device with a PIN/),
      });
      expect(pairingStore.getPairingRecord(peer.deviceId)?.dpopPublicKey).toBe(legitimateKey.publicKeyX963);

      const relayAttackerClient = await openAccountClient(port, listener.getRelayBridgeProof());
      clients.push(relayAttackerClient);
      sendAccountHello({
        ws: relayAttackerClient.ws,
        peer,
        accountToken,
        dpop: signAccountDpop({
          privateKey: attackerKey.privateKey,
          publicKeyX963: attackerKey.publicKeyX963,
          deviceId: peer.deviceId,
          accountToken,
        }),
      });
      const relayAttackerRejected = await waitForValue(
        () => relayAttackerClient.envelopes.find((envelope) => envelope.type === "hello_error"),
        "relay stored-key account hijack rejection",
      );
      expect(relayAttackerRejected.payload).toMatchObject({
        code: "auth_failed",
        message: expect.stringMatching(/could not prove it holds the security key.*Pair it again/i),
      });
      expect(pairingStore.getPairingRecord(peer.deviceId)?.dpopPublicKey).toBe(legitimateKey.publicKeyX963);

      const relayAccountClient = await openAccountClient(port, listener.getRelayBridgeProof());
      clients.push(relayAccountClient);
      sendAccountHello({
        ws: relayAccountClient.ws,
        peer,
        accountToken,
        dpop: signAccountDpop({
          privateKey: legitimateKey.privateKey,
          publicKeyX963: legitimateKey.publicKeyX963,
          advertisedPublicKeyX963: attackerKey.publicKeyX963,
          deviceId: peer.deviceId,
          accountToken,
        }),
      });
      const accountHello = await waitForValue(
        () => relayAccountClient.envelopes.find((envelope) => envelope.type === "hello_ok"),
        "relay stored-key account hello_ok",
      );
      expect(pairingStore.getPairingRecord(peer.deviceId)?.dpopPublicKey).toBe(legitimateKey.publicKeyX963);
      const replacement = (accountHello.payload as {
        accountPairing?: { deviceId: string; secret: string };
      }).accountPairing;
      expect(replacement).toMatchObject({
        deviceId: peer.deviceId,
        secret: expect.stringMatching(/^[0-9a-f]{48}$/),
      });
      expect(replacement?.secret).not.toBe(pairing.secret);
      expect(pairingStore.authenticate(peer.deviceId, pairing.secret)).toBe(false);
      expect(pairingStore.authenticate(peer.deviceId, replacement!.secret)).toBe(true);
      const activeSecret = replacement!.secret;

      const directPairedClient = await openAccountClient(port);
      clients.push(directPairedClient);
      directPairedClient.ws.send(encodeSyncEnvelope({
        type: "hello",
        payload: {
          peer,
          auth: {
            kind: "paired",
            deviceId: peer.deviceId,
            secret: activeSecret,
            dpop: signPairedDpop({
              privateKey: legitimateKey.privateKey,
              publicKeyX963: legitimateKey.publicKeyX963,
              deviceId: peer.deviceId,
              secret: activeSecret,
            }),
          },
        },
      }));
      await waitForValue(
        () => directPairedClient.envelopes.find((envelope) => envelope.type === "hello_ok"),
        "direct account-minted paired hello_ok after relay re-auth",
      );

      const relayWithoutAccount = await openAccountClient(port, listener.getRelayBridgeProof());
      clients.push(relayWithoutAccount);
      sendPairedHello({
        ws: relayWithoutAccount.ws,
        peer,
        secret: activeSecret,
        dpop: signPairedDpop({
          privateKey: legitimateKey.privateKey,
          publicKeyX963: legitimateKey.publicKeyX963,
          deviceId: peer.deviceId,
          secret: activeSecret,
        }),
      });
      const missingRelayProof = await waitForValue(
        () => relayWithoutAccount.envelopes.find((envelope) => envelope.type === "hello_error"),
        "paired relay missing account proof",
      );
      expect(missingRelayProof.payload).toMatchObject({
        code: "relay_account_required",
        message: "Sign in with the same ADE account on both machines.",
      });

      const relayWrongAccount = await openAccountClient(port, listener.getRelayBridgeProof());
      clients.push(relayWrongAccount);
      sendPairedHello({
        ws: relayWrongAccount.ws,
        peer,
        secret: activeSecret,
        relayAccountToken: await mintAccountToken("different-user"),
        dpop: signPairedDpop({
          privateKey: legitimateKey.privateKey,
          publicKeyX963: legitimateKey.publicKeyX963,
          deviceId: peer.deviceId,
          secret: activeSecret,
        }),
      });
      const wrongRelayProof = await waitForValue(
        () => relayWrongAccount.envelopes.find((envelope) => envelope.type === "hello_error"),
        "paired relay wrong account proof",
      );
      expect(wrongRelayProof.payload).toMatchObject({
        code: "relay_account_required",
        message: "Sign in with the same ADE account on both machines.",
      });

      const relayPairedClient = await openAccountClient(port, listener.getRelayBridgeProof());
      clients.push(relayPairedClient);
      sendPairedHello({
        ws: relayPairedClient.ws,
        peer,
        secret: activeSecret,
        relayAccountToken: accountToken,
        dpop: signPairedDpop({
          privateKey: legitimateKey.privateKey,
          publicKeyX963: legitimateKey.publicKeyX963,
          deviceId: peer.deviceId,
          secret: activeSecret,
        }),
      });
      await waitForValue(
        () => relayPairedClient.envelopes.find((envelope) => envelope.type === "hello_ok"),
        "paired relay same-account hello_ok",
      );
    } finally {
      for (const client of clients) client.ws.close();
      await host.dispose();
      await listener.close();
      cleanup();
    }
  });

  it("processes Relay reauthorization while an ordinary peer handler is blocked", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const secretsDir = path.join(projectRoot, ".ade", "secrets");
    const pinStore = createSyncPinStore({ filePath: path.join(secretsDir, "sync-pin.json") });
    const pairingSecretsPath = path.join(secretsDir, "sync-paired-devices.json");
    const pairingStore = createSyncPairingStore({ filePath: pairingSecretsPath, pinStore });
    const keys = makeDpopKeyPair();
    const peer = {
      deviceId: "relay-fast-control-peer",
      deviceName: "Relay fast control peer",
      platform: "unknown",
      deviceType: "browser",
      siteId: "relay-fast-control-site",
      dbVersion: 0,
      capabilities: [SYNC_RELAY_REAUTHORIZE_V1_CAPABILITY],
    } satisfies SyncPeerMetadata;
    const initialToken = await mintAccountToken(ownerUserId, 300);
    const freshToken = await mintAccountToken(ownerUserId, 900);
    const initialAttestation = await verifyClerkAccountAttestation({
      token: initialToken,
      expectedUserId: ownerUserId,
      config: { issuer, jwksUrl, oauthClientId },
    });
    const pairing = pairingStore.pairPeerViaAccount(peer, initialAttestation, {
      dpopPublicKey: keys.publicKeyX963,
    });
    let blockCatalog = false;
    let markCatalogStarted!: () => void;
    let releaseCatalog!: () => void;
    const catalogStarted = new Promise<void>((resolve) => { markCatalogStarted = resolve; });
    const catalogReleased = new Promise<void>((resolve) => { releaseCatalog = resolve; });
    const baseArgs = createHostArgs(projectRoot, []);
    const listener = createSharedSyncListener({ bindHost: "127.0.0.1" });
    const host = createSyncHostService({
      ...baseArgs,
      ...accountDependencies(),
      pinStore,
      pairingSecretsPath,
      sharedListener: listener,
      discoveryEnabled: false,
      projectCatalogProvider: {
        listProjects: vi.fn(async () => {
          if (blockCatalog) {
            markCatalogStarted();
            await catalogReleased;
          }
          return { projects: [] };
        }),
        prepareProjectConnection: vi.fn(),
      },
      deviceRegistryService: {
        ...baseArgs.deviceRegistryService,
        upsertPeerMetadata: vi.fn(),
      },
    } as unknown as Parameters<typeof createSyncHostService>[0]);
    let client: Awaited<ReturnType<typeof openAccountClient>> | null = null;
    try {
      client = await openAccountClient(await host.waitUntilListening(), listener.getRelayBridgeProof());
      sendPairedHello({
        ws: client.ws,
        peer,
        secret: pairing.secret,
        relayAccountToken: initialToken,
        dpop: signPairedDpop({
          privateKey: keys.privateKey,
          publicKeyX963: keys.publicKeyX963,
          deviceId: peer.deviceId,
          secret: pairing.secret,
        }),
      });
      const hello = await waitForValue(
        () => client?.envelopes.find((envelope) => envelope.type === "hello_ok"),
        "refreshable Relay hello_ok",
      );
      const lease = (hello.payload as {
        relayAuthorization?: { challenge: string };
      }).relayAuthorization;
      expect(lease?.challenge).toEqual(expect.any(String));

      blockCatalog = true;
      client.ws.send(encodeSyncEnvelope({
        type: "project_catalog_request",
        requestId: "slow-catalog",
        payload: {},
      }));
      await catalogStarted;
      client.ws.send(encodeSyncEnvelope({
        type: "relay_reauthorize",
        requestId: "reauth-while-slow",
        payload: {
          deviceId: peer.deviceId,
          relayAccountToken: freshToken,
          proof: signRelayReauthorization({
            privateKey: keys.privateKey,
            deviceId: peer.deviceId,
            relayAccountToken: freshToken,
            challenge: lease!.challenge,
          }),
        },
      }));

      await expect(waitForEnvelope(
        client.envelopes,
        "relay_reauthorize_result",
        "reauth-while-slow",
      )).resolves.toMatchObject({ payload: { ok: true } });
      expect(client.envelopes.some((envelope) => envelope.requestId === "slow-catalog")).toBe(false);
      releaseCatalog();
      await waitForEnvelope(client.envelopes, "project_catalog", "slow-catalog");
    } finally {
      releaseCatalog();
      client?.ws.close();
      await host.dispose();
      await listener.close();
      cleanup();
    }
  });

  // A phone that paired by QR/PIN and later lost its stored secret (an iOS
  // security migration wipes saved profiles but keeps the Secure Enclave DPoP
  // key) can only come back through account sign-in. The host used to answer
  // that hello with hello_ok and NO `accountPairing`, so the client failed with
  // "The Mac did not return saved connection details" and the only remedy was
  // physically walking to the Mac.
  describe("legacy manual pairing adoption", () => {
    const legacyPeer = {
      deviceId: "legacy-manual-phone",
      deviceName: "iPhone",
      platform: "iOS",
      deviceType: "phone",
      siteId: "legacy-manual-phone-site",
      dbVersion: 0,
    } satisfies SyncPeerMetadata;

    function createLegacyHarness(options?: { pin?: string }) {
      const { projectRoot, cleanup } = createTempProjectRoot();
      const secretsDir = path.join(projectRoot, ".ade", "secrets");
      const pinStore = createSyncPinStore({ filePath: path.join(secretsDir, "sync-pin.json") });
      pinStore.setPin(options?.pin ?? "428193");
      const pairingSecretsPath = path.join(secretsDir, "sync-paired-devices.json");
      const pairingStore = createSyncPairingStore({ filePath: pairingSecretsPath, pinStore });
      const baseArgs = createHostArgs(projectRoot, []);
      const listener = createSharedSyncListener({ bindHost: "127.0.0.1" });
      const host = createSyncHostService({
        ...baseArgs,
        ...accountDependencies(),
        pinStore,
        pairingSecretsPath,
        sharedListener: listener,
        discoveryEnabled: false,
        deviceRegistryService: {
          ...baseArgs.deviceRegistryService,
          upsertPeerMetadata: vi.fn(),
        },
      } as unknown as Parameters<typeof createSyncHostService>[0]);
      const clients: Array<Awaited<ReturnType<typeof openAccountClient>>> = [];
      return {
        baseArgs,
        pairingStore,
        pairingSecretsPath,
        host,
        listener,
        clients,
        cleanup: async () => {
          for (const client of clients) client.ws.close();
          await host.dispose();
          await listener.close();
          cleanup();
        },
      };
    }

    /** Strips the field entirely, which is the true on-disk legacy shape. */
    function dropAccountOwnerField(pairingSecretsPath: string, deviceId: string): void {
      const records = JSON.parse(fs.readFileSync(pairingSecretsPath, "utf8")) as Record<
        string,
        Record<string, unknown>
      >;
      delete records[deviceId]?.accountOwnerUserId;
      fs.writeFileSync(pairingSecretsPath, `${JSON.stringify(records, null, 2)}\n`);
    }

    // The deferral is the one remaining path that answers hello_ok WITHOUT
    // `accountPairing`, so it is also the only end-to-end exercise of the iOS
    // stored-secret fallback. Adoption writes through, which would drop a PIN
    // re-pair the device has not acknowledged yet and leave its
    // `pairing_commit` with nothing to promote.
    it("defers adoption while a PIN re-pair is still staged", async () => {
      const harness = createLegacyHarness();
      const deviceKey = makeDpopKeyPair();
      harness.pairingStore.pairPeer(legacyPeer, "428193", {
        dpopPublicKey: deviceKey.publicKeyX963,
      });
      dropAccountOwnerField(harness.pairingSecretsPath, legacyPeer.deviceId);
      // A second PIN pair stages a rotation the device has not proven it got.
      const staged = harness.pairingStore.pairPeer(legacyPeer, "428193", {
        dpopPublicKey: deviceKey.publicKeyX963,
      });
      expect(harness.pairingStore.hasPendingRotation(legacyPeer.deviceId)).toBe(true);
      try {
        const port = await harness.host.waitUntilListening();
        const accountToken = await mintAccountToken();
        const relayClient = await openAccountClient(port, harness.listener.getRelayBridgeProof());
        harness.clients.push(relayClient);
        sendAccountHello({
          ws: relayClient.ws,
          peer: legacyPeer,
          accountToken,
          dpop: signAccountDpop({
            privateKey: deviceKey.privateKey,
            publicKeyX963: deviceKey.publicKeyX963,
            deviceId: legacyPeer.deviceId,
            accountToken,
          }),
        });
        const helloOk = await waitForValue(
          () => relayClient.envelopes.find((envelope) => envelope.type === "hello_ok"),
          "deferred adoption hello_ok",
        );
        // Authenticated, but deliberately no new credential.
        expect((helloOk.payload as { accountPairing?: unknown }).accountPairing).toBeUndefined();
        // The staged re-pair is untouched and still promotable.
        expect(harness.pairingStore.hasPendingRotation(legacyPeer.deviceId)).toBe(true);
        expect(harness.pairingStore.verifySecret(legacyPeer.deviceId, staged.secret)).toBe("pending");
        expect(harness.baseArgs.logger.info).toHaveBeenCalledWith(
          "sync_host.account_adoption_deferred_pending_rotation",
          { deviceId: legacyPeer.deviceId },
        );
      } finally {
        await harness.cleanup();
      }
    });

    it("adopts a keyed legacy pairing on an account hello and returns a usable secret", async () => {
      const harness = createLegacyHarness();
      const deviceKey = makeDpopKeyPair();
      const legacyPairing = harness.pairingStore.pairPeer(legacyPeer, "428193", {
        dpopPublicKey: deviceKey.publicKeyX963,
      });
      dropAccountOwnerField(harness.pairingSecretsPath, legacyPeer.deviceId);
      const legacyRecord = harness.pairingStore.getPairingRecord(legacyPeer.deviceId);
      expect(legacyRecord?.accountOwnerUserId ?? null).toBeNull();
      expect(legacyRecord?.dpopPublicKey).toBe(deviceKey.publicKeyX963);
      try {
        const port = await harness.host.waitUntilListening();
        const accountToken = await mintAccountToken();
        const relayClient = await openAccountClient(port, harness.listener.getRelayBridgeProof());
        harness.clients.push(relayClient);
        sendAccountHello({
          ws: relayClient.ws,
          peer: legacyPeer,
          accountToken,
          dpop: signAccountDpop({
            privateKey: deviceKey.privateKey,
            publicKeyX963: deviceKey.publicKeyX963,
            deviceId: legacyPeer.deviceId,
            accountToken,
          }),
        });
        const helloOk = await waitForValue(
          () => relayClient.envelopes.find((envelope) => envelope.type === "hello_ok"),
          "legacy adoption hello_ok",
        );
        const adopted = (helloOk.payload as {
          accountPairing?: { deviceId: string; secret: string };
        }).accountPairing;
        expect(adopted).toMatchObject({
          deviceId: legacyPeer.deviceId,
          secret: expect.stringMatching(/^[0-9a-f]{48}$/),
        });
        expect(adopted?.secret).not.toBe(legacyPairing.secret);

        const upgraded = harness.pairingStore.getPairingRecord(legacyPeer.deviceId);
        expect(upgraded?.accountOwnerUserId).toBe(ownerUserId);
        // The pinned key is the identity proof; adoption must never swap it for
        // the key the hello advertised inline.
        expect(upgraded?.dpopPublicKey).toBe(deviceKey.publicKeyX963);
        // `getPairingRecord` returns a committed view that strips
        // `pendingRotation` unconditionally, so asserting its absence there
        // proves nothing. `hasPendingRotation` reads the raw record.
        expect(harness.pairingStore.hasPendingRotation(legacyPeer.deviceId)).toBe(false);
        // Adoption must not hand the account power to delete a hand-made
        // pairing when this Mac signs out.
        expect(upgraded?.localTrustOrigin).toBe(true);
        expect(harness.pairingStore.verifySecret(legacyPeer.deviceId, adopted!.secret)).toBe("committed");
        expect(harness.pairingStore.verifySecret(legacyPeer.deviceId, legacyPairing.secret)).toBeNull();
        expect(harness.baseArgs.logger.info).toHaveBeenCalledWith(
          "sync_host.account_legacy_pairing_upgraded",
          { deviceId: legacyPeer.deviceId },
        );

        // The whole point: the phone reconnects on its own with what hello_ok
        // handed it, without anyone touching the Mac.
        const pairedClient = await openAccountClient(port);
        harness.clients.push(pairedClient);
        sendPairedHello({
          ws: pairedClient.ws,
          peer: legacyPeer,
          secret: adopted!.secret,
          dpop: signPairedDpop({
            privateKey: deviceKey.privateKey,
            publicKeyX963: deviceKey.publicKeyX963,
            deviceId: legacyPeer.deviceId,
            secret: adopted!.secret,
          }),
        });
        await waitForValue(
          () => pairedClient.envelopes.find((envelope) => envelope.type === "hello_ok"),
          "adopted paired hello_ok",
        );
      } finally {
        await harness.cleanup();
      }
    });

    it("still refuses a legacy pairing that has no device key on record", async () => {
      const harness = createLegacyHarness();
      const deviceKey = makeDpopKeyPair();
      const legacyPairing = harness.pairingStore.pairPeer(legacyPeer, "428193");
      dropAccountOwnerField(harness.pairingSecretsPath, legacyPeer.deviceId);
      expect(harness.pairingStore.getPairingRecord(legacyPeer.deviceId)?.dpopPublicKey ?? null)
        .toBeNull();
      try {
        const port = await harness.host.waitUntilListening();
        const accountToken = await mintAccountToken();
        const relayClient = await openAccountClient(port, harness.listener.getRelayBridgeProof());
        harness.clients.push(relayClient);
        sendAccountHello({
          ws: relayClient.ws,
          peer: legacyPeer,
          accountToken,
          dpop: signAccountDpop({
            privateKey: deviceKey.privateKey,
            publicKeyX963: deviceKey.publicKeyX963,
            deviceId: legacyPeer.deviceId,
            accountToken,
          }),
        });
        const rejected = await waitForValue(
          () => relayClient.envelopes.find((envelope) => envelope.type === "hello_error"),
          "keyless legacy adoption rejection",
        );
        expect(rejected.payload).toMatchObject({
          code: "auth_failed",
          message: expect.stringMatching(/predates device-key security/i),
        });
        const untouched = harness.pairingStore.getPairingRecord(legacyPeer.deviceId);
        expect(untouched?.accountOwnerUserId ?? null).toBeNull();
        expect(untouched?.dpopPublicKey ?? null).toBeNull();
        expect(harness.pairingStore.verifySecret(legacyPeer.deviceId, legacyPairing.secret))
          .toBe("committed");
        expect(harness.baseArgs.logger.info).not.toHaveBeenCalledWith(
          "sync_host.account_legacy_pairing_upgraded",
          expect.anything(),
        );
      } finally {
        await harness.cleanup();
      }
    });

    it("still refuses a pairing already owned by a different ADE account", async () => {
      const harness = createLegacyHarness();
      const deviceKey = makeDpopKeyPair();
      const otherUserId = "user_someone_else";
      const otherAttestation = await verifyClerkAccountAttestation({
        token: await mintAccountToken(otherUserId),
        expectedUserId: otherUserId,
        config: { issuer, jwksUrl, oauthClientId },
      });
      const otherOwnerPairing = harness.pairingStore.pairPeerViaAccount(legacyPeer, otherAttestation, {
        dpopPublicKey: deviceKey.publicKeyX963,
      });
      try {
        const port = await harness.host.waitUntilListening();
        const accountToken = await mintAccountToken();
        const relayClient = await openAccountClient(port, harness.listener.getRelayBridgeProof());
        harness.clients.push(relayClient);
        sendAccountHello({
          ws: relayClient.ws,
          peer: legacyPeer,
          accountToken,
          dpop: signAccountDpop({
            privateKey: deviceKey.privateKey,
            publicKeyX963: deviceKey.publicKeyX963,
            deviceId: legacyPeer.deviceId,
            accountToken,
          }),
        });
        const rejected = await waitForValue(
          () => relayClient.envelopes.find((envelope) => envelope.type === "hello_error"),
          "cross-account adoption rejection",
        );
        expect(rejected.payload).toMatchObject({
          code: "auth_failed",
          message: expect.stringMatching(/already paired to this machine under a different ADE account/i),
        });
        expect(harness.pairingStore.getPairingRecord(legacyPeer.deviceId)?.accountOwnerUserId)
          .toBe(otherUserId);
        expect(harness.pairingStore.verifySecret(legacyPeer.deviceId, otherOwnerPairing.secret))
          .toBe("committed");
      } finally {
        await harness.cleanup();
      }
    });

    it.each([
      { label: "a missing proof", useProof: false, message: /did not present its security key/i },
      { label: "a wrong-key proof", useProof: true, message: /could not prove it holds the security key/i },
    ])("still refuses to adopt a legacy pairing on $label", async ({ useProof, message }) => {
      const harness = createLegacyHarness();
      const deviceKey = makeDpopKeyPair();
      const attackerKey = makeDpopKeyPair();
      const legacyPairing = harness.pairingStore.pairPeer(legacyPeer, "428193", {
        dpopPublicKey: deviceKey.publicKeyX963,
      });
      dropAccountOwnerField(harness.pairingSecretsPath, legacyPeer.deviceId);
      try {
        const port = await harness.host.waitUntilListening();
        const accountToken = await mintAccountToken();
        const relayClient = await openAccountClient(port, harness.listener.getRelayBridgeProof());
        harness.clients.push(relayClient);
        sendAccountHello({
          ws: relayClient.ws,
          peer: legacyPeer,
          accountToken,
          dpop: useProof
            ? signAccountDpop({
                privateKey: attackerKey.privateKey,
                publicKeyX963: attackerKey.publicKeyX963,
                deviceId: legacyPeer.deviceId,
                accountToken,
              })
            : null,
        });
        const rejected = await waitForValue(
          () => relayClient.envelopes.find((envelope) => envelope.type === "hello_error"),
          "DPoP-failed legacy adoption rejection",
        );
        expect(rejected.payload).toMatchObject({
          code: "auth_failed",
          message: expect.stringMatching(message),
        });
        const untouched = harness.pairingStore.getPairingRecord(legacyPeer.deviceId);
        expect(untouched?.accountOwnerUserId ?? null).toBeNull();
        expect(untouched?.dpopPublicKey).toBe(deviceKey.publicKeyX963);
        expect(harness.pairingStore.verifySecret(legacyPeer.deviceId, legacyPairing.secret))
          .toBe("committed");
      } finally {
        await harness.cleanup();
      }
    });
  });

  it("revokes account-owned trust and closes Relay plus account peers when the host lease expires", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const secretsDir = path.join(projectRoot, ".ade", "secrets");
    const pinStore = createSyncPinStore({ filePath: path.join(secretsDir, "sync-pin.json") });
    const pairingSecretsPath = path.join(secretsDir, "sync-paired-devices.json");
    const pairingStore = createSyncPairingStore({ filePath: pairingSecretsPath, pinStore });
    const accountToken = await mintAccountToken();
    const attestation = await verifyClerkAccountAttestation({
      token: accountToken,
      expectedUserId: ownerUserId,
      config: { issuer, jwksUrl, oauthClientId },
    });
    const accountKey = makeDpopKeyPair();
    const manualKey = makeDpopKeyPair();
    const accountPeer = {
      deviceId: "lease-account-peer",
      deviceName: "Lease account peer",
      platform: "iOS",
      deviceType: "phone",
      siteId: "lease-account-site",
      dbVersion: 0,
    } satisfies SyncPeerMetadata;
    const manualPeer = {
      ...accountPeer,
      deviceId: "lease-manual-relay-peer",
      deviceName: "Lease manual Relay peer",
      siteId: "lease-manual-site",
    } satisfies SyncPeerMetadata;
    const accountPairing = pairingStore.pairPeerViaAccount(accountPeer, attestation, {
      dpopPublicKey: accountKey.publicKeyX963,
    });
    const manualPairing = pairingStore.pairPeerViaLocalTrust(manualPeer, {
      dpopPublicKey: manualKey.publicKeyX963,
    });
    let leaseValid = true;
    const baseArgs = createHostArgs(projectRoot, []);
    const listener = createSharedSyncListener({ bindHost: "127.0.0.1" });
    const host = createSyncHostService({
      ...baseArgs,
      accountAuthService: {
        getStatus: () => ({
          signedIn: leaseValid,
          userId: leaseValid ? ownerUserId : null,
          email: null,
          name: null,
          expiresAt: null,
        }),
        getAccessToken: async () => {
          if (!leaseValid) throw new Error("refresh failed");
          return "valid-host-lease";
        },
      },
      getAccountAttestationConfig: () => ({ issuer, jwksUrl, oauthClientId }),
      accountLeasePollMs: 250,
      pinStore,
      pairingSecretsPath,
      sharedListener: listener,
      discoveryEnabled: false,
      deviceRegistryService: {
        ...baseArgs.deviceRegistryService,
        upsertPeerMetadata: vi.fn(),
      },
    } as unknown as Parameters<typeof createSyncHostService>[0]);
    const clients: Array<Awaited<ReturnType<typeof openAccountClient>>> = [];
    try {
      const port = await host.waitUntilListening();
      const accountClient = await openAccountClient(port);
      clients.push(accountClient);
      sendPairedHello({
        ws: accountClient.ws,
        peer: accountPeer,
        secret: accountPairing.secret,
        dpop: signPairedDpop({
          privateKey: accountKey.privateKey,
          publicKeyX963: accountKey.publicKeyX963,
          deviceId: accountPeer.deviceId,
          secret: accountPairing.secret,
        }),
      });
      await waitForValue(
        () => accountClient.envelopes.find((envelope) => envelope.type === "hello_ok"),
        "account-owned direct hello_ok",
      );

      const relayClient = await openAccountClient(port, listener.getRelayBridgeProof());
      clients.push(relayClient);
      sendPairedHello({
        ws: relayClient.ws,
        peer: manualPeer,
        secret: manualPairing.secret,
        relayAccountToken: accountToken,
        dpop: signPairedDpop({
          privateKey: manualKey.privateKey,
          publicKeyX963: manualKey.publicKeyX963,
          deviceId: manualPeer.deviceId,
          secret: manualPairing.secret,
        }),
      });
      await waitForValue(
        () => relayClient.envelopes.find((envelope) => envelope.type === "hello_ok"),
        "manual Relay hello_ok",
      );
      const accountClosed = new Promise<number>((resolve) => accountClient.ws.once("close", resolve));
      const relayClosed = new Promise<number>((resolve) => relayClient.ws.once("close", resolve));

      leaseValid = false;
      await expect(accountClosed).resolves.toBe(4003);
      await expect(relayClosed).resolves.toBe(4003);
      expect(pairingStore.getPairingRecord(accountPeer.deviceId)).toBeNull();
      expect(pairingStore.getPairingRecord(manualPeer.deviceId)?.accountOwnerUserId).toBeNull();
    } finally {
      for (const client of clients) client.ws.close();
      await host.dispose();
      await listener.close();
      cleanup();
    }
  });

  it("rejects missing and device-mismatched DPoP proofs without minting pairing records", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const secretsDir = path.join(projectRoot, ".ade", "secrets");
    const pinStore = createSyncPinStore({ filePath: path.join(secretsDir, "sync-pin.json") });
    const pairingSecretsPath = path.join(secretsDir, "sync-paired-devices.json");
    const pairingStore = createSyncPairingStore({ filePath: pairingSecretsPath, pinStore });
    const baseArgs = createHostArgs(projectRoot, []);
    const listener = createSharedSyncListener({ bindHost: "127.0.0.1" });
    const host = createSyncHostService({
      ...baseArgs,
      ...accountDependencies(),
      pinStore,
      pairingSecretsPath,
      sharedListener: listener,
      discoveryEnabled: false,
      deviceRegistryService: {
        ...baseArgs.deviceRegistryService,
        upsertPeerMetadata: vi.fn(),
      },
    } as unknown as Parameters<typeof createSyncHostService>[0]);
    const clients: Array<Awaited<ReturnType<typeof openAccountClient>>> = [];
    try {
      const port = await host.waitUntilListening();
      const accountToken = await mintAccountToken();
      const missingPeer = {
        deviceId: "account-missing-dpop",
        deviceName: "Missing DPoP",
        platform: "iOS",
        deviceType: "phone",
        siteId: "account-missing-dpop-site",
        dbVersion: 0,
      } satisfies SyncPeerMetadata;
      const missing = await openAccountClient(port, listener.getRelayBridgeProof());
      clients.push(missing);
      sendAccountHello({ ws: missing.ws, peer: missingPeer, accountToken, dpop: null });
      const missingDpopRejected = await waitForValue(
        () => missing.envelopes.find((envelope) => envelope.type === "hello_error"),
        "missing DPoP hello_error",
      );
      expect(missingDpopRejected.payload).toMatchObject({
        code: "auth_failed",
        message: expect.stringMatching(/did not present its security key.*pair it again/i),
      });

      const invalidPeer = {
        ...missingPeer,
        deviceId: "account-invalid-dpop",
        deviceName: "Invalid DPoP",
        siteId: "account-invalid-dpop-site",
      };
      const invalid = await openAccountClient(port, listener.getRelayBridgeProof());
      clients.push(invalid);
      const dpopKey = makeDpopKeyPair();
      sendAccountHello({
        ws: invalid.ws,
        peer: invalidPeer,
        accountToken,
        dpop: signAccountDpop({
          privateKey: dpopKey.privateKey,
          publicKeyX963: dpopKey.publicKeyX963,
          deviceId: invalidPeer.deviceId,
          accountToken,
          signedDeviceId: "different-account-device",
        }),
      });
      const invalidDpopRejected = await waitForValue(
        () => invalid.envelopes.find((envelope) => envelope.type === "hello_error"),
        "invalid DPoP hello_error",
      );
      expect(invalidDpopRejected.payload).toMatchObject({
        code: "auth_failed",
        message: expect.stringMatching(/could not prove it holds the security key.*Pair it again/i),
      });

      expect(pairingStore.getPairingRecord(missingPeer.deviceId)).toBeNull();
      expect(pairingStore.getPairingRecord(invalidPeer.deviceId)).toBeNull();
    } finally {
      for (const client of clients) client.ws.close();
      await host.dispose();
      await listener.close();
      cleanup();
    }
  });

  /**
   * The keychain-clobber incident on the project-scoped host. Retaining the
   * last known owner only helps a process that already saw one — a host that
   * STARTS with a locked keychain has nothing retained, so reading "unreadable"
   * as a sign-out ran `applyAccountLease(null)` and deleted every account-owned
   * pairing on the machine before the user could unlock anything.
   */
  it.each(["expired", "unreadable"] as const)(
    "keeps account-owned pairings when it starts with a %s credential store",
    async (sessionState) => {
      const { projectRoot, cleanup } = createTempProjectRoot();
      const secretsDir = path.join(projectRoot, ".ade", "secrets");
      const pinStore = createSyncPinStore({ filePath: path.join(secretsDir, "sync-pin.json") });
      const pairingSecretsPath = path.join(secretsDir, "sync-paired-devices.json");
      const pairingStore = createSyncPairingStore({ filePath: pairingSecretsPath, pinStore });
      const peer = {
        deviceId: "cold-boot-account-peer",
        deviceName: "Account-owned iPhone",
        platform: "iOS",
        deviceType: "phone",
        siteId: "cold-boot-account-site",
        dbVersion: 0,
      } satisfies SyncPeerMetadata;
      const attestation = await verifyClerkAccountAttestation({
        token: await mintAccountToken(),
        expectedUserId: ownerUserId,
        config: { issuer, jwksUrl, oauthClientId },
      });
      pairingStore.pairPeerViaAccount(peer, attestation);
      const baseArgs = createHostArgs(projectRoot, []);
      // Deterministic synchronization: the lease refresh is what this test is
      // about, so wait for the host to actually READ the account status rather
      // than for a sleep long enough to hide a regression.
      const getStatus = vi.fn(() => ({
        signedIn: false,
        userId: null,
        email: null,
        name: null,
        expiresAt: null,
        sessionState,
      }));
      const host = createSyncHostService({
        ...baseArgs,
        ...accountDependencies(),
        accountAuthService: {
          getStatus,
          getAccessToken: async () => {
            throw new Error("Credential store is unreadable");
          },
        },
        pinStore,
        pairingStore,
        pairingSecretsPath,
        discoveryEnabled: false,
        deviceRegistryService: {
          ...baseArgs.deviceRegistryService,
          upsertPeerMetadata: vi.fn(),
        },
      } as unknown as Parameters<typeof createSyncHostService>[0]);
      try {
        await host.waitUntilListening();
        const deadline = Date.now() + 5_000;
        while (getStatus.mock.calls.length === 0 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        expect(getStatus.mock.calls.length).toBeGreaterThan(0);
        expect(pairingStore.getPairingRecord(peer.deviceId)).not.toBeNull();
      } finally {
        await host.dispose();
        cleanup();
      }
    },
  );

  it("rejects account auth while signed out and leaves PIN pairing available", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const secretsDir = path.join(projectRoot, ".ade", "secrets");
    const pinStore = createSyncPinStore({ filePath: path.join(secretsDir, "sync-pin.json") });
    const pairingSecretsPath = path.join(secretsDir, "sync-paired-devices.json");
    pinStore.setPin("428193");
    const baseArgs = createHostArgs(projectRoot, []);
    const listener = createSharedSyncListener({ bindHost: "127.0.0.1" });
    const host = createSyncHostService({
      ...baseArgs,
      ...accountDependencies(false),
      pinStore,
      pairingSecretsPath,
      sharedListener: listener,
      discoveryEnabled: false,
      deviceRegistryService: {
        ...baseArgs.deviceRegistryService,
        upsertPeerMetadata: vi.fn(),
      },
    } as unknown as Parameters<typeof createSyncHostService>[0]);
    const clients: Array<Awaited<ReturnType<typeof openAccountClient>>> = [];
    try {
      const port = await host.waitUntilListening();
      const peer = {
        deviceId: "signed-out-account-peer",
        deviceName: "Signed-out account peer",
        platform: "iOS",
        deviceType: "phone",
        siteId: "signed-out-account-site",
        dbVersion: 0,
      } satisfies SyncPeerMetadata;
      const accountToken = await mintAccountToken();
      const dpopKey = makeDpopKeyPair();
      const accountClient = await openAccountClient(port, listener.getRelayBridgeProof());
      clients.push(accountClient);
      sendAccountHello({
        ws: accountClient.ws,
        peer,
        accountToken,
        dpop: signAccountDpop({
          privateKey: dpopKey.privateKey,
          publicKeyX963: dpopKey.publicKeyX963,
          deviceId: peer.deviceId,
          accountToken,
        }),
      });
      const signedOutRejected = await waitForValue(
        () => accountClient.envelopes.find((envelope) => envelope.type === "hello_error"),
        "signed-out account hello_error",
      );
      expect(signedOutRejected.payload).toMatchObject({
        code: "auth_failed",
        message: expect.stringMatching(/not signed in.*Sign in on this computer/i),
      });

      const pinClient = await openAccountClient(port);
      clients.push(pinClient);
      pinClient.ws.send(encodeSyncEnvelope({
        type: "pairing_request",
        requestId: "pin-fallback",
        payload: { code: "428193", peer },
      }));
      const pairingResult = await waitForValue(
        () => pinClient.envelopes.find((envelope) =>
          envelope.type === "pairing_result" && envelope.requestId === "pin-fallback"),
        "PIN fallback pairing_result",
      );
      expect(pairingResult.payload).toMatchObject({
        ok: true,
        deviceId: peer.deviceId,
        secret: expect.stringMatching(/^[0-9a-f]{48}$/),
      });
    } finally {
      for (const client of clients) client.ws.close();
      await host.dispose();
      await listener.close();
      cleanup();
    }
  });

  // A re-pair used to overwrite the device's working secret the instant the
  // host answered, two round trips before the device could persist the reply.
  // Dropping the socket in that gap — the ordinary outcome on a flaky network —
  // left the host holding credentials the phone never saw, and the only way
  // back was walking to the Mac for another PIN. Retrying was what broke you.
  it("survives a re-pair that drops before the device ever uses the new secret", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const secretsDir = path.join(projectRoot, ".ade", "secrets");
    const pinStore = createSyncPinStore({ filePath: path.join(secretsDir, "sync-pin.json") });
    pinStore.setPin("428193");
    const pairingSecretsPath = path.join(secretsDir, "sync-paired-devices.json");
    const pairingStore = createSyncPairingStore({ filePath: pairingSecretsPath, pinStore });
    const baseArgs = createHostArgs(projectRoot, []);
    const host = createSyncHostService({
      ...baseArgs,
      ...accountDependencies(),
      pinStore,
      pairingStore,
      pairingSecretsPath,
      discoveryEnabled: false,
      deviceRegistryService: {
        ...baseArgs.deviceRegistryService,
        upsertPeerMetadata: vi.fn(),
      },
    } as unknown as Parameters<typeof createSyncHostService>[0]);
    const peer = {
      deviceId: "flaky-repair-phone",
      deviceName: "Flaky iPhone",
      platform: "iOS",
      deviceType: "phone",
      siteId: "flaky-repair-site",
      dbVersion: 0,
    } satisfies SyncPeerMetadata;
    const dpopKey = makeDpopKeyPair();
    const clients: Array<Awaited<ReturnType<typeof openAccountClient>>> = [];

    const requestPairing = async (requestId: string, pairingCommitVersion?: 1) => {
      const port = await host.waitUntilListening();
      const client = await openAccountClient(port);
      clients.push(client);
      client.ws.send(encodeSyncEnvelope({
        type: "pairing_request",
        requestId,
        payload: {
          code: "428193",
          peer,
          dpopPublicKey: dpopKey.publicKeyX963,
          ...(pairingCommitVersion ? { pairingCommitVersion } : {}),
        },
      }));
      const result = await waitForValue(
        () => client.envelopes.find((envelope) =>
          envelope.type === "pairing_result" && envelope.requestId === requestId),
        `pairing_result ${requestId}`,
      );
      return {
        client,
        payload: result.payload as { secret: string; rotation?: unknown },
      };
    };

    const helloWith = async (secret: string) => {
      const port = await host.waitUntilListening();
      const client = await openAccountClient(port);
      clients.push(client);
      sendPairedHello({
        ws: client.ws,
        peer,
        secret,
        dpop: signPairedDpop({
          privateKey: dpopKey.privateKey,
          publicKeyX963: dpopKey.publicKeyX963,
          deviceId: peer.deviceId,
          secret,
        }),
      });
      const envelope = await waitForValue(
        () => client.envelopes.find((candidate) =>
          candidate.type === "hello_ok" || candidate.type === "hello_error"),
        `hello outcome for ${secret.slice(0, 6)}`,
      );
      return envelope.type;
    };

    try {
      const first = await requestPairing("pair-initial");
      // Nothing to protect on a first pair, so nothing is staged.
      expect(first.payload.rotation).toBeUndefined();
      expect(await helloWith(first.payload.secret)).toBe("hello_ok");

      const rotated = await requestPairing("pair-retry", 1);
      expect(rotated.payload.secret).not.toBe(first.payload.secret);
      // The drop: the device never gets to send its hello.
      rotated.client.ws.close();

      // Both ends still agree on the secret the device is actually holding.
      expect(await helloWith(first.payload.secret)).toBe("hello_ok");
      expect(rotated.payload.rotation).toMatchObject({ pendingCommit: true });

      const committed = await requestPairing("pair-commit", 1);
      // A commit-capable client uses the same socket for its staged hello. Even
      // after hello_ok, the old secret remains live until the client explicitly
      // proves it received that response.
      sendPairedHello({
        ws: committed.client.ws,
        peer,
        secret: committed.payload.secret,
        dpop: signPairedDpop({
          privateKey: dpopKey.privateKey,
          publicKeyX963: dpopKey.publicKeyX963,
          deviceId: peer.deviceId,
          secret: committed.payload.secret,
        }),
      });
      await waitForValue(
        () => committed.client.envelopes.find((candidate) => candidate.type === "hello_ok"),
        "staged hello_ok",
      );
      expect(pairingStore.verifySecret(peer.deviceId, first.payload.secret)).toBe("committed");
      expect(pairingStore.verifySecret(peer.deviceId, committed.payload.secret)).toBe("pending");

      committed.client.ws.send(encodeSyncEnvelope({
        type: "pairing_commit",
        requestId: "pairing-commit",
        payload: { deviceId: peer.deviceId },
      }));
      await expect(waitForValue(
        () => committed.client.envelopes.find((candidate) =>
          candidate.type === "pairing_commit_result"
          && candidate.requestId === "pairing-commit"),
        "pairing_commit_result",
      )).resolves.toMatchObject({ payload: { ok: true } });

      // The explicit acknowledgement retires the previous credential.
      expect(await helloWith(first.payload.secret)).toBe("hello_error");
      expect(await helloWith(committed.payload.secret)).toBe("hello_ok");
    } finally {
      for (const client of clients) client.ws.close();
      await host.dispose();
      cleanup();
    }
  });

  /**
   * Regression: a machine installed with the one-liner, signed in, brain
   * running, and NO project ever opened.
   *
   * Projectless connections never touch the project sync host — cli.ts attaches
   * `createBrainProjectActionsSyncHandler` as the shared listener's FALLBACK
   * handler, and that handler used to carry its own narrower hello parser plus a
   * blanket refusal of account auth. The ADE web client authenticates with an
   * `account` hello and nothing else, so it was answered with a flat "Invalid
   * hello payload." on exactly the machine ADE promises you can reach from
   * anywhere. Both handlers now share `syncHelloProtocol`, and this path
   * authenticates accounts the same way the project host does.
   */
  it("projectless brain: accepts a signed-in web client account hello and adopts a pairing", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const secretsDir = path.join(projectRoot, "secrets");
    fs.mkdirSync(secretsDir, { recursive: true });
    // The machine stores are cached per secretsDir for the life of the process,
    // so drop the cache before the handler resolves them against this fixture's
    // fresh temp directory.
    resetBrainMachineSyncStoresForTests();
    const deviceKey = makeDpopKeyPair();
    const accountToken = await mintAccountToken();
    const handler = createBrainProjectActionsSyncHandler({
      logger: createDiscoveryLogger(),
      // No projects registered: the whole point of the fixture.
      projectCatalogProvider: {
        listProjects: vi.fn(async () => ({ projects: [] })),
        prepareProjectConnection: vi.fn(),
      },
      bootstrapCredentialStore: new EncryptedFileCredentialStore({
        secretsDir,
        keyMaterial: { read: () => null },
      }),
      secretsDir,
      localDeviceIdPath: path.join(secretsDir, "sync-device-id"),
      localSiteIdPath: path.join(secretsDir, "sync-site-id"),
      accountAuthService: {
        getStatus: () => ({
          signedIn: true,
          userId: ownerUserId,
          email: null,
          name: null,
          expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        }),
        getAccessToken: async () => "host-account-lease",
      },
      getAccountAttestationConfig: () => ({ issuer, jwksUrl, oauthClientId }),
    });
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    server.on("connection", (ws, request) => handler({
      ws,
      remoteAddress: request.socket.remoteAddress ?? null,
      remotePort: request.socket.remotePort ?? null,
      // Account credentials are relay-only on both handlers.
      transportOrigin: "relay-bridge",
    }));
    let client: WebSocket | null = null;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
      const opened = await openAccountClient((server.address() as AddressInfo).port);
      client = opened.ws;
      opened.ws.send(encodeSyncEnvelope({
        type: "hello",
        requestId: "account-hello",
        payload: {
          peer: {
            deviceId: "web-projectless-device",
            deviceName: "ADE Web",
            platform: "unknown",
            deviceType: "browser",
            siteId: "web-projectless-site",
            dbVersion: 0,
            // The capability list and the connection attempt are exactly what
            // the old private parser silently dropped or choked on.
            capabilities: [
              "sync.relay.reauthorize.v1",
              "sync.invalidationOnly.v1",
              "sync.compactInvalidation.v1",
            ],
            connectionAttempt: { id: "attempt-1", startedAtMs: Date.now() },
          },
          auth: {
            kind: "account",
            deviceId: "web-projectless-device",
            accountToken,
            dpop: signAccountDpop({
              privateKey: deviceKey.privateKey,
              publicKeyX963: deviceKey.publicKeyX963,
              deviceId: "web-projectless-device",
              accountToken,
            }),
          },
        },
      }));
      const hello = await waitForEnvelope(opened.envelopes, "hello_ok", "account-hello");
      // A real secret comes back, so the browser can reconnect as a paired
      // device instead of re-proving its account on every socket.
      expect(hello.payload).toMatchObject({
        accountPairing: { deviceId: "web-projectless-device" },
      });
      expect(
        (hello.payload as { accountPairing?: { secret?: string } }).accountPairing?.secret,
      ).toBeTruthy();
    } finally {
      client?.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      cleanup();
    }
  });

  /**
   * Regression: the same fresh machine, reached by a phone over the LAN.
   * `ade sync pin generate` and the desktop's pairing card write the machine
   * PIN through `resolveBrainMachineSyncStores`; the ingress handler has to
   * verify against that SAME instance, because `createSyncPinStore` caches its
   * record and a second instance would never see the write.
   */
  it("projectless brain: pairs a phone against the PIN written through the shared machine store", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const secretsDir = path.join(projectRoot, "secrets");
    fs.mkdirSync(secretsDir, { recursive: true });
    resetBrainMachineSyncStoresForTests();
    const stores = resolveBrainMachineSyncStores(secretsDir);
    const handler = createBrainProjectActionsSyncHandler({
      logger: createDiscoveryLogger(),
      projectCatalogProvider: {
        listProjects: vi.fn(async () => ({ projects: [] })),
        prepareProjectConnection: vi.fn(),
      },
      bootstrapCredentialStore: new EncryptedFileCredentialStore({
        secretsDir,
        keyMaterial: { read: () => null },
      }),
      secretsDir,
      localDeviceIdPath: path.join(secretsDir, "sync-device-id"),
      localSiteIdPath: path.join(secretsDir, "sync-site-id"),
    });
    // Stands in for `ade sync pin generate` / the desktop pairing card, which
    // both reach this store through the brain's RPC surface.
    const pin = generateMachinePairingPin();
    stores.pinStore.setPin(pin);
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    server.on("connection", (ws, request) => handler({
      ws,
      remoteAddress: request.socket.remoteAddress ?? null,
      remotePort: request.socket.remotePort ?? null,
      transportOrigin: "direct",
    }));
    let client: WebSocket | null = null;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
      client = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`);
      const { envelopes } = trackClientEnvelopes(client);
      await new Promise<void>((resolve, reject) => {
        client!.once("open", resolve);
        client!.once("error", reject);
      });
      const phonePeer = {
        deviceId: "ios-projectless-device",
        deviceName: "Projectless iPhone",
        platform: "iOS" as const,
        deviceType: "phone" as const,
        siteId: "ios-projectless-site",
        dbVersion: 0,
      };
      client.send(encodeSyncEnvelope({
        type: "pairing_request",
        requestId: "projectless-pair",
        payload: { code: pin, peer: phonePeer },
      }));
      const paired = await waitForEnvelope(envelopes, "pairing_result", "projectless-pair");
      expect(paired.payload).toMatchObject({ ok: true, deviceId: phonePeer.deviceId });
      const secret = (paired.payload as { secret: string }).secret;

      client.close();
      client = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`);
      const second = trackClientEnvelopes(client);
      await new Promise<void>((resolve, reject) => {
        client!.once("open", resolve);
        client!.once("error", reject);
      });
      client.send(encodeSyncEnvelope({
        type: "hello",
        requestId: "projectless-hello",
        payload: {
          peer: phonePeer,
          auth: { kind: "paired", deviceId: phonePeer.deviceId, secret },
        },
      }));
      // An empty roster is legitimate here — transport, auth and pairing are
      // what a projectless machine owes its phone.
      await expect(waitForEnvelope(second.envelopes, "hello_ok", "projectless-hello"))
        .resolves.toBeTruthy();
    } finally {
      client?.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      cleanup();
    }
  });

  /**
   * Regression (2026-08-06): an expired or unreadable account session read as a
   * deliberate sign-out.
   *
   * `readExplicitAccountStatus` blanked `userId` for both, so the ingress
   * called `applyExplicitAccountUserId(null)` -> `revokeAccountOwnedExcept(null)`
   * and DELETED every account-owned pairing on the machine. That is the same
   * token accident that used to take every remote route down, except this time
   * it destroys credentials: the fix is a walk back to the Mac. Ownership now
   * survives the accident; only a genuine sign-out, or a different user signing
   * in, revokes.
   */
  describe("projectless brain: account ownership across session states", () => {
    type BrainAccountStatus = {
      signedIn: boolean;
      userId: string | null;
      email: null;
      name: null;
      expiresAt: string | null;
      sessionState?: "active" | "signed_out" | "expired" | "unreadable";
    };

    const signedInStatus = (userId: string): BrainAccountStatus => ({
      signedIn: true,
      userId,
      email: null,
      name: null,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      sessionState: "active",
    });

    async function createOwnershipHarness(initialStatus?: BrainAccountStatus) {
      const { projectRoot, cleanup } = createTempProjectRoot();
      const secretsDir = path.join(projectRoot, "secrets");
      fs.mkdirSync(secretsDir, { recursive: true });
      // The SAME stores the handler resolves, so assertions read the instance
      // the ingress path mutates rather than a second view of the same files.
      resetBrainMachineSyncStoresForTests();
      const { pinStore, pairingStore } = resolveBrainMachineSyncStores(secretsDir);
      pinStore.setPin("428193");
      const peer = {
        deviceId: "brain-account-owned-device",
        deviceName: "Account-owned iPhone",
        platform: "iOS",
        deviceType: "phone",
        siteId: "brain-account-owned-site",
        dbVersion: 0,
      } satisfies SyncPeerMetadata;
      const attestation = await verifyClerkAccountAttestation({
        token: await mintAccountToken(),
        expectedUserId: ownerUserId,
        config: { issuer, jwksUrl, oauthClientId },
      });
      // No device key on purpose: this fixture exercises the account-ownership
      // gate, not DPoP.
      const { secret } = pairingStore.pairPeerViaAccount(peer, attestation);
      let status: BrainAccountStatus = initialStatus ?? signedInStatus(ownerUserId);
      const handler = createBrainProjectActionsSyncHandler({
        logger: createDiscoveryLogger(),
        projectCatalogProvider: {
          listProjects: vi.fn(async () => ({ projects: [] })),
          prepareProjectConnection: vi.fn(),
        },
        bootstrapCredentialStore: new EncryptedFileCredentialStore({
          secretsDir,
          keyMaterial: { read: () => null },
        }),
        secretsDir,
        localDeviceIdPath: path.join(secretsDir, "sync-device-id"),
        localSiteIdPath: path.join(secretsDir, "sync-site-id"),
        accountAuthService: {
          getStatus: () => status,
          getAccessToken: async () => (status.signedIn ? "host-account-lease" : ""),
        },
        getAccountAttestationConfig: () => ({ issuer, jwksUrl, oauthClientId }),
      });
      const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      server.on("connection", (ws, request) => handler({
        ws,
        remoteAddress: request.socket.remoteAddress ?? null,
        remotePort: request.socket.remotePort ?? null,
        transportOrigin: "direct",
      }));
      await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
      const port = (server.address() as AddressInfo).port;
      const openClients: WebSocket[] = [];
      const pairedHello = async (
        requestId: string,
        overrides: { deviceId?: string; secret?: string } = {},
      ): Promise<ParsedSyncEnvelope> => {
        const client = new WebSocket(`ws://127.0.0.1:${port}`);
        openClients.push(client);
        const { envelopes } = trackClientEnvelopes(client);
        await new Promise<void>((resolve, reject) => {
          client.once("open", resolve);
          client.once("error", reject);
        });
        client.send(encodeSyncEnvelope({
          type: "hello",
          requestId,
          payload: {
            // A real client's peer identity and paired auth identity are the
            // same device. Overriding only the auth id would send a MALFORMED
            // hello (identity disagreement), which is a different rejection
            // than "this machine has never seen you".
            peer: overrides.deviceId ? { ...peer, deviceId: overrides.deviceId } : peer,
            auth: {
              kind: "paired",
              deviceId: overrides.deviceId ?? peer.deviceId,
              secret: overrides.secret ?? secret,
            },
          },
        }));
        const reply = await waitForValue(
          () => envelopes.find((envelope) =>
            (envelope.type === "hello_ok" || envelope.type === "hello_error")
            && envelope.requestId === requestId),
          `hello reply ${requestId}`,
        );
        client.close();
        return reply;
      };
      return {
        peer,
        pairingStore,
        pairedHello,
        setStatus: (next: BrainAccountStatus) => { status = next; },
        cleanup: async () => {
          for (const client of openClients) client.close();
          await new Promise<void>((resolve) => server.close(() => resolve()));
          cleanup();
        },
      };
    }

    it.each(["expired", "unreadable"] as const)(
      "keeps account-owned pairings usable while the session is %s",
      async (sessionState) => {
        const harness = await createOwnershipHarness();
        try {
          // Seeds the last known owner, exactly as a working machine would.
          expect((await harness.pairedHello("owned-hello-1")).type).toBe("hello_ok");

          harness.setStatus({
            signedIn: false,
            userId: null,
            email: null,
            name: null,
            expiresAt: null,
            sessionState,
          });

          expect((await harness.pairedHello("owned-hello-2")).type).toBe("hello_ok");
          expect(harness.pairingStore.getPairingRecord(harness.peer.deviceId)).not.toBeNull();
        } finally {
          await harness.cleanup();
        }
      },
    );

    /**
     * The keychain-clobber incident, from the top. Retaining the last known
     * owner only helps a process that already saw one — a brain that BOOTS with
     * a locked keychain has nothing retained, so reading "unreadable" as a
     * sign-out deleted every account-owned pairing on the machine before the
     * user could unlock anything. No information is not a sign-out.
     */
    it.each(["expired", "unreadable"] as const)(
      "keeps account-owned pairings when it boots with a %s credential store",
      async (sessionState) => {
        const harness = await createOwnershipHarness({
          signedIn: false,
          userId: null,
          email: null,
          name: null,
          expiresAt: null,
          sessionState,
        });
        try {
          // No prior hello: this process has never seen the owner.
          expect((await harness.pairedHello("cold-boot-hello")).type).toBe("hello_ok");
          expect(harness.pairingStore.getPairingRecord(harness.peer.deviceId)).not.toBeNull();
        } finally {
          await harness.cleanup();
        }
      },
    );

    it("revokes account-owned pairings when the machine actually signs out", async () => {
      const harness = await createOwnershipHarness();
      try {
        expect((await harness.pairedHello("signed-out-hello-1")).type).toBe("hello_ok");

        harness.setStatus({
          signedIn: false,
          userId: null,
          email: null,
          name: null,
          expiresAt: null,
          sessionState: "signed_out",
        });

        expect((await harness.pairedHello("signed-out-hello-2")).type).toBe("hello_error");
        expect(harness.pairingStore.getPairingRecord(harness.peer.deviceId)).toBeNull();
      } finally {
        await harness.cleanup();
      }
    });

    it("revokes account-owned pairings when a different user signs in", async () => {
      const harness = await createOwnershipHarness();
      try {
        expect((await harness.pairedHello("switch-hello-1")).type).toBe("hello_ok");

        harness.setStatus(signedInStatus("user_someone_else"));

        expect((await harness.pairedHello("switch-hello-2")).type).toBe("hello_error");
        expect(harness.pairingStore.getPairingRecord(harness.peer.deviceId)).toBeNull();
      } finally {
        await harness.cleanup();
      }
    });

    /**
     * The brain answered every paired rejection with a bare
     * "Sync authentication failed." under `auth_failed`. Clients classify from
     * the code, so an unknown device and a stale secret both have to arrive as
     * `repair_required` — identical on the wire, so the handshake stays out of
     * the business of confirming which device ids this machine knows.
     */
    it("rejects an unusable paired secret with repair_required, not a bare auth_failed", async () => {
      const harness = await createOwnershipHarness();
      try {
        const stale = await harness.pairedHello("stale-secret-hello", { secret: "not-the-secret" });
        expect(stale.type).toBe("hello_error");
        expect(stale.payload).toMatchObject({ code: "repair_required" });
        // A device id this machine has never paired — NOT harness.peer's, which
        // would only re-test the stale-secret path above.
        const unknown = await harness.pairedHello("unknown-device-hello", {
          deviceId: "device-this-machine-never-paired",
          secret: "still-not-the-secret",
        });
        expect(unknown.payload).toMatchObject({
          code: "repair_required",
          message: (stale.payload as { message: string }).message,
        });
      } finally {
        await harness.cleanup();
      }
    });
  });

  /**
   * `auth_failed` reads as "pair it again" on every client. A machine that
   * simply cannot verify accounts yet has nothing wrong with its pairing, so it
   * says so with its own code and the client shows the update headline.
   */
  it("projectless brain: answers an account hello with host_update_required when it cannot verify accounts", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const secretsDir = path.join(projectRoot, "secrets");
    fs.mkdirSync(secretsDir, { recursive: true });
    // The machine stores are cached per secretsDir for the life of the process,
    // so drop the cache before the handler resolves them against this fixture's
    // fresh temp directory.
    resetBrainMachineSyncStoresForTests();
    const deviceKey = makeDpopKeyPair();
    const accountToken = await mintAccountToken();
    const handler = createBrainProjectActionsSyncHandler({
      logger: createDiscoveryLogger(),
      projectCatalogProvider: {
        listProjects: vi.fn(async () => ({ projects: [] })),
        prepareProjectConnection: vi.fn(),
      },
      bootstrapCredentialStore: new EncryptedFileCredentialStore({
        secretsDir,
        keyMaterial: { read: () => null },
      }),
      secretsDir,
      localDeviceIdPath: path.join(secretsDir, "sync-device-id"),
      localSiteIdPath: path.join(secretsDir, "sync-site-id"),
      accountAuthService: {
        getStatus: () => ({
          signedIn: true,
          userId: ownerUserId,
          email: null,
          name: null,
          expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        }),
        getAccessToken: async () => "host-account-lease",
      },
      // The whole fixture: this build has no attestation configuration.
      getAccountAttestationConfig: () => null,
    });
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    server.on("connection", (ws, request) => handler({
      ws,
      remoteAddress: request.socket.remoteAddress ?? null,
      remotePort: request.socket.remotePort ?? null,
      transportOrigin: "relay-bridge",
    }));
    let client: WebSocket | null = null;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
      const opened = await openAccountClient((server.address() as AddressInfo).port);
      client = opened.ws;
      opened.ws.send(encodeSyncEnvelope({
        type: "hello",
        requestId: "unverifiable-account-hello",
        payload: {
          peer: {
            deviceId: "web-unverifiable-device",
            deviceName: "ADE Web",
            platform: "unknown",
            deviceType: "browser",
            siteId: "web-unverifiable-site",
            dbVersion: 0,
          },
          auth: {
            kind: "account",
            deviceId: "web-unverifiable-device",
            accountToken,
            dpop: signAccountDpop({
              privateKey: deviceKey.privateKey,
              publicKeyX963: deviceKey.publicKeyX963,
              deviceId: "web-unverifiable-device",
              accountToken,
            }),
          },
        },
      }));
      const rejection = await waitForEnvelope(
        opened.envelopes,
        "hello_error",
        "unverifiable-account-hello",
      );
      expect(rejection.payload).toMatchObject({ code: "host_update_required" });
    } finally {
      client?.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      cleanup();
    }
  });

});

describe("paired runtime host authorization", () => {
  it("refuses rpc/fwd when a PIN-authorized project-host pairing request merely claims desktop", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const pairing = createSpoofedDesktopPairing(path.join(projectRoot, ".ade", "secrets"));
    const baseArgs = createHostArgs(projectRoot, []);
    const host = createSyncHostService({
      ...baseArgs,
      discoveryEnabled: false,
      pinStore: pairing.pinStore,
      pairingSecretsPath: pairing.pairingSecretsPath,
      deviceRegistryService: {
        ...baseArgs.deviceRegistryService,
        upsertPeerMetadata: vi.fn(),
      },
    } as unknown as Parameters<typeof createSyncHostService>[0]);
    let client: WebSocket | null = null;
    try {
      const port = await host.waitUntilListening();
      expect(port).toBeGreaterThan(0);
      client = new WebSocket(`ws://127.0.0.1:${port}`);
      const { envelopes } = trackClientEnvelopes(client);
      await new Promise<void>((resolve, reject) => {
        client!.once("open", resolve);
        client!.once("error", reject);
      });
      sendSpoofedPairedHello(client, pairing.helloPeer, pairing.secret);
      await expectSpoofedRuntimeChannelRefused(client, envelopes);
    } finally {
      client?.close();
      await host.dispose();
      cleanup();
    }
  });

  it.each([
    ["project", "project-1"],
    ["brain", null],
  ] as const)("does not send CRDT changesets to a genuine runtime-only %s host peer", async (_mode, projectId) => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const secretsDir = path.join(projectRoot, ".ade", "secrets");
    const pinStore = createSyncPinStore({ filePath: path.join(secretsDir, "sync-pin.json") });
    const pairingSecretsPath = path.join(secretsDir, "sync-paired-devices.json");
    pinStore.setPin("428193");
    const pairingStore = createSyncPairingStore({ filePath: pairingSecretsPath, pinStore });
    const runtimePeer = {
      deviceId: `runtime-only-${_mode}`,
      deviceName: `Runtime-only ${_mode}`,
      platform: "macOS",
      deviceType: "desktop",
      siteId: `runtime-only-${_mode}-site`,
      dbVersion: 0,
      capabilities: [SYNC_RUNTIME_ONLY_CAPABILITY],
    } satisfies SyncPeerMetadata;
    const runtimeHostGrant = pairingStore.issueRuntimeHostGrant();
    const { secret } = pairingStore.pairPeer(runtimePeer, "428193", { runtimeHostGrant });
    const baseArgs = createHostArgs(projectRoot, []);
    const exportChangesSince = vi.fn(() => [makeChange(1, 0)]);
    const host = createSyncHostService({
      ...baseArgs,
      projectId,
      discoveryEnabled: false,
      pollIntervalMs: 100,
      pinStore,
      pairingSecretsPath,
      db: {
        sync: {
          getSiteId: () => "runtime-host-site",
          getDbVersion: () => 1,
          exportChangesSince,
          applyChanges: () => ({ appliedCount: 0 }),
          discardUnpublishedChangesForTables: () => {},
        },
      },
      deviceRegistryService: {
        ...baseArgs.deviceRegistryService,
        upsertPeerMetadata: vi.fn(),
      },
    } as unknown as Parameters<typeof createSyncHostService>[0]);
    let client: WebSocket | null = null;
    try {
      const port = await host.waitUntilListening();
      client = new WebSocket(`ws://127.0.0.1:${port}`);
      const { envelopes } = trackClientEnvelopes(client);
      await new Promise<void>((resolve, reject) => {
        client!.once("open", resolve);
        client!.once("error", reject);
      });
      client.send(encodeSyncEnvelope({
        type: "hello",
        payload: {
          peer: runtimePeer,
          auth: { kind: "paired", deviceId: runtimePeer.deviceId, secret },
        },
      }));

      const hello = await waitForValue(
        () => envelopes.find((envelope) => envelope.type === "hello_ok"),
        `${_mode} runtime-only hello_ok`,
      );
      expect(hello.payload).toMatchObject({
        features: { rpcChannel: true, portForward: true },
      });
      await new Promise((resolve) => setTimeout(resolve, 250));

      expect(envelopes.some((envelope) => envelope.type === "changeset_batch")).toBe(false);
      expect(exportChangesSince).not.toHaveBeenCalled();
    } finally {
      client?.close();
      await host.dispose();
      cleanup();
    }
  });
});

describe("createSyncHostService LAN discovery", () => {
  let originalPlatform: PropertyDescriptor | undefined;
  let originalElectronVersion: PropertyDescriptor | undefined;

  beforeEach(() => {
    publishMock.mockReset();
    spawnMock.mockReset();
    bonjourDestroyMock.mockReset();
    bonjourConstructorMock.mockReset();
    originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    originalElectronVersion = Object.getOwnPropertyDescriptor(process.versions, "electron");
    bonjourConstructorMock.mockImplementation(() => ({
      publish: publishMock,
      destroy: bonjourDestroyMock,
    }));
    spawnMock.mockImplementation(() => ({
      kill: vi.fn(),
      once: vi.fn(),
      unref: vi.fn(),
    }));
    publishMock.mockImplementation(() => ({
      on: vi.fn(),
      stop: vi.fn(),
    }));
  });

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, "platform", originalPlatform);
    }
    if (originalElectronVersion) {
      Object.defineProperty(process.versions, "electron", originalElectronVersion);
    } else {
      Reflect.deleteProperty(process.versions, "electron");
    }
    vi.restoreAllMocks();
  });

  it("rejects a self-owned listener before discovery when loopback is not ADE", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const host = createSyncHostService({
      ...createHostArgs(projectRoot, [createDiscoveryProject({ id: "project-1" })]),
      port: 0,
      loopbackProbe: async (port: number) => ({
        ok: false,
        port,
        statusCode: 404,
        statusMessage: "Not Found",
        markerValue: null,
        checkedAt: new Date().toISOString(),
        reason: "foreign loopback listener",
      }),
    } as unknown as Parameters<typeof createSyncHostService>[0]);

    try {
      await expect(host.waitUntilListening()).rejects.toThrow("foreign loopback listener");
      expect(host.getLoopbackValidationStatus()).toMatchObject({
        loopbackAdeValidated: false,
        reason: "foreign loopback listener",
      });
      expect(host.getTailnetDiscoveryStatus().updatedAt).toBeNull();
      expect(publishMock).not.toHaveBeenCalled();
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      await host.dispose();
      cleanup();
    }
  });

  it("re-validates the loopback listener before refreshLanDiscovery and skips (re)publish on a post-startup shadow", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    let probeOk = true;
    const loopbackProbe = vi.fn(async (
      port: number,
      expectedNonce: string,
    ): Promise<SyncLoopbackProbeResult> =>
      probeOk
        ? { ok: true, port, statusCode: 426, statusMessage: "Upgrade Required", markerValue: expectedNonce, checkedAt: new Date().toISOString(), reason: null }
        : { ok: false, port, statusCode: 404, statusMessage: "Not Found", markerValue: null, checkedAt: new Date().toISOString(), reason: "shadow appeared after startup" });
    const host = createSyncHostService({
      ...createHostArgs(projectRoot, [createDiscoveryProject({ id: "project-1" })]),
      port: 0,
      loopbackProbe,
    } as unknown as Parameters<typeof createSyncHostService>[0]);

    try {
      await host.waitUntilListening();
      expect(host.getLoopbackValidationStatus().loopbackAdeValidated).toBe(true);
      const probeCallsAfterStartup = loopbackProbe.mock.calls.length;
      const publishCallsAfterStartup = publishMock.mock.calls.length;
      const spawnCallsAfterStartup = spawnMock.mock.calls.length;
      const tailnetUpdatedAfterStartup = host.getTailnetDiscoveryStatus().updatedAt;

      // A foreign listener shadows the loopback route AFTER startup.
      probeOk = false;
      host.refreshLanDiscovery({ forceLan: true, forceTailnet: true });

      // The refresh forces a re-probe (bypassing the validated-port short-circuit)
      // and, seeing the shadow, marks the route unvalidated and skips publishing.
      await vi.waitFor(() =>
        expect(host.getLoopbackValidationStatus().loopbackAdeValidated).toBe(false));
      expect(loopbackProbe.mock.calls.length).toBeGreaterThan(probeCallsAfterStartup);
      expect(host.getLoopbackValidationStatus().reason).toMatch(/shadow appeared/);
      // No new bonjour/tailnet advertisement for the stale port.
      expect(publishMock.mock.calls.length).toBe(publishCallsAfterStartup);
      expect(spawnMock.mock.calls.length).toBe(spawnCallsAfterStartup);
      expect(host.getTailnetDiscoveryStatus().updatedAt).toBe(tailnetUpdatedAfterStartup);
    } finally {
      await host.dispose();
      cleanup();
    }
  });

  it("re-validates the loopback listener before setDiscoveryEnabled(true) and skips publish on a post-startup shadow", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    let probeOk = true;
    const loopbackProbe = vi.fn(async (
      port: number,
      expectedNonce: string,
    ): Promise<SyncLoopbackProbeResult> =>
      probeOk
        ? { ok: true, port, statusCode: 426, statusMessage: "Upgrade Required", markerValue: expectedNonce, checkedAt: new Date().toISOString(), reason: null }
        : { ok: false, port, statusCode: 404, statusMessage: "Not Found", markerValue: null, checkedAt: new Date().toISOString(), reason: "shadow appeared while disabled" });
    const host = createSyncHostService({
      ...createHostArgs(projectRoot, [createDiscoveryProject({ id: "project-1" })]),
      port: 0,
      loopbackProbe,
    } as unknown as Parameters<typeof createSyncHostService>[0]);

    try {
      await host.waitUntilListening();
      expect(host.getLoopbackValidationStatus().loopbackAdeValidated).toBe(true);
      // Turn discovery off, then let a shadow take over the loopback route.
      host.setDiscoveryEnabled(false);
      const probeCallsBeforeReenable = loopbackProbe.mock.calls.length;
      const publishCallsBeforeReenable = publishMock.mock.calls.length;
      const spawnCallsBeforeReenable = spawnMock.mock.calls.length;

      probeOk = false;
      host.setDiscoveryEnabled(true);

      // Re-enabling forces a fresh loopback check; the shadow blocks (re)publish.
      await vi.waitFor(() =>
        expect(host.getLoopbackValidationStatus().loopbackAdeValidated).toBe(false));
      expect(loopbackProbe.mock.calls.length).toBeGreaterThan(probeCallsBeforeReenable);
      expect(publishMock.mock.calls.length).toBe(publishCallsBeforeReenable);
      expect(spawnMock.mock.calls.length).toBe(spawnCallsBeforeReenable);
    } finally {
      await host.dispose();
      cleanup();
    }
  });

  it("closes inbound sockets that never authenticate", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const host = createSyncHostService({
      ...createHostArgs(projectRoot, [createDiscoveryProject({ id: "project-1" })]),
      authTimeoutMs: 1_000,
    } as unknown as Parameters<typeof createSyncHostService>[0]);
    let client: WebSocket | null = null;

    try {
      const port = await host.waitUntilListening();
      client = new WebSocket(`ws://127.0.0.1:${port}`);
      await new Promise<void>((resolve, reject) => {
        client!.once("open", () => resolve());
        client!.once("error", reject);
      });

      const closeEvent = await Promise.race([
        new Promise<{ code: number; reason: string }>((resolve) => {
          client!.once("close", (code, reason) => {
            resolve({ code, reason: reason.toString("utf8") });
          });
        }),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("Timed out waiting for unauthenticated socket close.")), 3_000);
        }),
      ]);
      expect(closeEvent).toEqual({
        code: 4003,
        reason: "Authentication timed out",
      });
    } finally {
      try {
        client?.close();
      } catch {
        // ignore close failures
      }
      await host.dispose();
      cleanup();
    }
  });

  it.each([
    [0, "client"],
    [2, "host"],
  ] as const)("returns a typed error immediately for protocol version %i", async (version, updateTarget) => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const host = createSyncHostService({
      ...createHostArgs(projectRoot, [createDiscoveryProject({ id: "project-1" })]),
      authTimeoutMs: 15_000,
    } as unknown as Parameters<typeof createSyncHostService>[0]);
    let client: WebSocket | null = null;

    try {
      const port = await host.waitUntilListening();
      client = new WebSocket(`ws://127.0.0.1:${port}`);
      await new Promise<void>((resolve, reject) => {
        client!.once("open", resolve);
        client!.once("error", reject);
      });
      const startedAt = Date.now();
      const response = new Promise<ParsedSyncEnvelope>((resolve, reject) => {
        client!.once("message", (raw) => {
          try {
            resolve(parseSyncEnvelope(wsDataToText(raw)));
          } catch (error) {
            reject(error);
          }
        });
      });
      const closed = new Promise<{ code: number; reason: string }>((resolve) => {
        client!.once("close", (code, reason) => {
          resolve({ code, reason: reason.toString("utf8") });
        });
      });
      client.send(JSON.stringify({
        version,
        type: "hello",
        requestId: `mismatch-${version}`,
        compression: "none",
        payloadEncoding: "json",
        payload: {},
      }));

      const mismatch = await response;
      expect(mismatch.type).toBe("hello_error");
      expect(mismatch.requestId).toBe(`mismatch-${version}`);
      expect(mismatch.payload).toMatchObject({
        code: "protocol_version_mismatch",
        receivedVersion: version,
        currentVersion: 1,
        minSupportedVersion: 1,
        updateTarget,
      });
      expect(await closed).toEqual({
        code: SYNC_PROTOCOL_VERSION_MISMATCH_CLOSE_CODE,
        reason: "Sync protocol version mismatch",
      });
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    } finally {
      try {
        client?.close();
      } catch {
        // ignore close failures
      }
      await host.dispose();
      cleanup();
    }
  });

  it("does not publish LAN Bonjour metadata when the sync host is loopback-bound", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const projects = [
      createDiscoveryProject({ id: "project-1", displayName: "API, Server\nOne", rootPath: "/srv/api" }),
      createDiscoveryProject({ id: "project-2", displayName: "Worker", rootPath: "/srv/worker" }),
    ];
    const host = createSyncHostService(
      createHostArgs(projectRoot, projects) as unknown as Parameters<typeof createSyncHostService>[0],
    );

    try {
      await host.waitUntilListening();
      host.refreshLanDiscovery({ forceLan: true });
      expect(publishedAnnouncements()).toEqual([]);
      expect(bonjourConstructorMock).not.toHaveBeenCalled();
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      await host.dispose();
      cleanup();
    }
  });

  it("keeps LAN discovery unpublished when discovery is explicitly refreshed", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const publishedServices: Array<{ on: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }> = [];
    publishMock.mockImplementation(() => {
      const service = { on: vi.fn(), stop: vi.fn() };
      publishedServices.push(service);
      return service;
    });
    const host = createSyncHostService(
      createHostArgs(projectRoot, [createDiscoveryProject({ id: "project-1" })]) as unknown as Parameters<
        typeof createSyncHostService
      >[0],
    );

    try {
      await host.waitUntilListening();
      publishMock.mockClear();

      host.refreshLanDiscovery();
      expect(publishMock).not.toHaveBeenCalled();

      host.refreshLanDiscovery({ forceLan: true });

      expect(publishMock).not.toHaveBeenCalled();
      expect(publishedServices).toEqual([]);
    } finally {
      await host.dispose();
      cleanup();
    }
  });

  it("does not publish native LAN discovery when running under Electron on macOS", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    Object.defineProperty(process.versions, "electron", {
      value: "35.0.0",
      configurable: true,
    });
    const { projectRoot, cleanup } = createTempProjectRoot();
    const nativeProcesses: Array<{ kill: ReturnType<typeof vi.fn>; once: ReturnType<typeof vi.fn>; unref: ReturnType<typeof vi.fn> }> = [];
    spawnMock.mockImplementation(() => {
      const child = { kill: vi.fn(), once: vi.fn(), unref: vi.fn() };
      nativeProcesses.push(child);
      return child;
    });
    const host = createSyncHostService(
      createHostArgs(projectRoot, [createDiscoveryProject({ id: "project-1" })]) as unknown as Parameters<
        typeof createSyncHostService
      >[0],
    );

    try {
      await host.waitUntilListening();

      expect(bonjourConstructorMock).not.toHaveBeenCalled();
      expect(publishMock).not.toHaveBeenCalled();
      expect(spawnMock).not.toHaveBeenCalled();
      expect(nativeProcesses).toEqual([]);
    } finally {
      await host.dispose();
      cleanup();
    }
  });
});

async function waitForValue<T>(get: () => T | null | undefined, label: string, timeoutMs = 4_000): Promise<T> {
  const startedAt = Date.now();
  for (;;) {
    const value = get();
    if (value != null) return value;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

type HandoffDbOptions = {
  siteId: string;
  dbVersion: number;
  changes: CrsqlChangeRow[];
};

function createHandoffHostArgs(
  projectRoot: string,
  bootstrapTokenPath: string,
  db: HandoffDbOptions,
) {
  const base = createHostArgs(projectRoot, []);
  return {
    ...base,
    db: {
      sync: {
        getSiteId: () => db.siteId,
        getDbVersion: () => db.dbVersion,
        exportChangesSince: (fromDbVersion: number) =>
          db.changes.filter((change) => Number(change.db_version) > fromDbVersion),
        applyChanges: () => ({ appliedCount: 0 }),
        discardUnpublishedChangesForTables: () => {},
      },
    },
    deviceRegistryService: {
      ...base.deviceRegistryService,
      upsertPeerMetadata: vi.fn(),
    },
    bootstrapTokenPath,
  };
}

function trackClientEnvelopes(client: WebSocket): {
  envelopes: ParsedSyncEnvelope[];
  closeEvents: Array<{ code: number; reason: string }>;
} {
  const envelopes: ParsedSyncEnvelope[] = [];
  const closeEvents: Array<{ code: number; reason: string }> = [];
  client.on("message", (data) => {
    envelopes.push(parseSyncEnvelope(wsDataToText(data)));
  });
  client.on("close", (code, reason) => {
    closeEvents.push({ code, reason: reason.toString("utf8") });
  });
  return { envelopes, closeEvents };
}

function sendHello(client: WebSocket, token: string): void {
  client.send(encodeSyncEnvelope({
    type: "hello",
    payload: {
      peer: {
        deviceId: "ios-device-1",
        deviceName: "Test iPhone",
        platform: "iOS",
        deviceType: "phone",
        siteId: "ios-site-1",
        dbVersion: 0,
      },
      auth: { kind: "bootstrap", token },
    },
  }));
}

function waitForEnvelope(envelopes: ParsedSyncEnvelope[], type: string, requestId: string) {
  return waitForValue(
    () => envelopes.find((envelope) => envelope.type === type && envelope.requestId === requestId),
    `${type} response ${requestId}`,
  );
}

async function connectPeer(
  port: number,
  token: string,
  deviceId: string,
  peerOverrides: Partial<SyncPeerMetadata> = {},
) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const tracked = trackClientEnvelopes(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  ws.send(encodeSyncEnvelope({
    type: "hello",
    payload: {
      peer: {
        deviceId,
        deviceName: deviceId,
        platform: "iOS",
        deviceType: "phone",
        siteId: `${deviceId}-site`,
        dbVersion: 0,
        ...peerOverrides,
      },
      auth: { kind: "bootstrap", token },
    },
  }));
  await waitForValue(
    () => tracked.envelopes.find((envelope) => envelope.type === "hello_ok"),
    `hello_ok for ${deviceId}`,
  );
  return { ws, ...tracked };
}

async function openPeerHello(
  port: number,
  token: string,
  deviceId: string,
  peerOverrides: Partial<SyncPeerMetadata> = {},
) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const tracked = trackClientEnvelopes(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  ws.send(encodeSyncEnvelope({
    type: "hello",
    requestId: `hello-${deviceId}`,
    payload: {
      peer: {
        deviceId,
        deviceName: deviceId,
        platform: "iOS",
        deviceType: "phone",
        siteId: `${deviceId}-site`,
        dbVersion: 0,
        ...peerOverrides,
      },
      auth: { kind: "bootstrap", token },
    },
  }));
  return { ws, ...tracked };
}

describe("connection-attempt arbitration", () => {
  beforeEach(() => {
    publishMock.mockReset();
    spawnMock.mockReset();
    bonjourDestroyMock.mockReset();
    bonjourConstructorMock.mockReset();
    spawnMock.mockImplementation(() => ({ kill: vi.fn(), once: vi.fn(), unref: vi.fn() }));
  });

  function createAttemptHost(projectRoot: string) {
    const base = createHostArgs(projectRoot, []);
    return createSyncHostService({
      ...base,
      deviceRegistryService: {
        ...base.deviceRegistryService,
        upsertPeerMetadata: vi.fn(),
      },
    } as unknown as Parameters<typeof createSyncHostService>[0]);
  }

  it("rejects a slow loser from the winning race without evicting the winner", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const host = createAttemptHost(projectRoot);
    let winner: Awaited<ReturnType<typeof connectPeer>> | null = null;
    let loser: Awaited<ReturnType<typeof openPeerHello>> | null = null;
    try {
      const port = await host.waitUntilListening();
      const attempt = { id: "race-one", startedAtMs: Date.now() };
      winner = await connectPeer(port, host.getBootstrapToken(), "race-device", {
        connectionAttempt: attempt,
      });
      loser = await openPeerHello(port, host.getBootstrapToken(), "race-device", {
        connectionAttempt: attempt,
      });

      await expect(waitForValue(
        () => loser?.envelopes.find((envelope) => envelope.type === "hello_error"),
        "same-attempt loser rejection",
      )).resolves.toMatchObject({
        payload: { code: "connection_attempt_superseded" },
      });
      await waitForValue(() => loser?.closeEvents[0], "same-attempt loser close");
      expect(winner.closeEvents).toEqual([]);
      expect(winner.ws.readyState).toBe(WebSocket.OPEN);
      expect(host.getPeerStates()).toHaveLength(1);
    } finally {
      try { winner?.ws.close(); } catch { /* ignore */ }
      try { loser?.ws.close(); } catch { /* ignore */ }
      await host.dispose();
      cleanup();
    }
  });

  it("rejects an older race after a newer attempt has authenticated", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const host = createAttemptHost(projectRoot);
    let winner: Awaited<ReturnType<typeof connectPeer>> | null = null;
    let older: Awaited<ReturnType<typeof openPeerHello>> | null = null;
    try {
      const port = await host.waitUntilListening();
      const newestStartedAt = Date.now();
      winner = await connectPeer(port, host.getBootstrapToken(), "race-order-device", {
        connectionAttempt: { id: "new-race", startedAtMs: newestStartedAt },
      });
      older = await openPeerHello(port, host.getBootstrapToken(), "race-order-device", {
        connectionAttempt: { id: "old-race", startedAtMs: newestStartedAt - 1 },
      });
      await expect(waitForValue(
        () => older?.envelopes.find((envelope) => envelope.type === "hello_error"),
        "older attempt rejection",
      )).resolves.toMatchObject({ payload: { code: "connection_attempt_superseded" } });
      expect(winner.ws.readyState).toBe(WebSocket.OPEN);
      expect(winner.closeEvents).toEqual([]);
    } finally {
      try { winner?.ws.close(); } catch { /* ignore */ }
      try { older?.ws.close(); } catch { /* ignore */ }
      await host.dispose();
      cleanup();
    }
  });

  it("lets a candidate from the same race claim ownership after its winner closes", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const host = createAttemptHost(projectRoot);
    let first: Awaited<ReturnType<typeof connectPeer>> | null = null;
    let replacement: Awaited<ReturnType<typeof connectPeer>> | null = null;
    try {
      const port = await host.waitUntilListening();
      const attempt = { id: "recover-race", startedAtMs: Date.now() };
      first = await connectPeer(port, host.getBootstrapToken(), "race-recover-device", {
        connectionAttempt: attempt,
      });
      first.ws.close();
      await waitForValue(
        () => (host.getPeerStates().length === 0 ? true : null),
        "winner ownership release",
      );

      replacement = await connectPeer(port, host.getBootstrapToken(), "race-recover-device", {
        connectionAttempt: attempt,
      });
      expect(replacement.ws.readyState).toBe(WebSocket.OPEN);
      expect(host.getPeerStates()).toHaveLength(1);
    } finally {
      try { first?.ws.close(); } catch { /* ignore */ }
      try { replacement?.ws.close(); } catch { /* ignore */ }
      await host.dispose();
      cleanup();
    }
  });

  it("lets a genuinely newer authenticated attempt supersede the prior winner", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const host = createAttemptHost(projectRoot);
    let first: Awaited<ReturnType<typeof connectPeer>> | null = null;
    let newer: Awaited<ReturnType<typeof connectPeer>> | null = null;
    try {
      const port = await host.waitUntilListening();
      const startedAtMs = Date.now();
      first = await connectPeer(port, host.getBootstrapToken(), "newer-race-device", {
        connectionAttempt: { id: "old-live-race", startedAtMs },
      });
      newer = await connectPeer(port, host.getBootstrapToken(), "newer-race-device", {
        connectionAttempt: { id: "new-live-race", startedAtMs: startedAtMs + 1 },
      });
      await waitForValue(() => first?.closeEvents[0], "older live winner superseded");
      expect(newer.ws.readyState).toBe(WebSocket.OPEN);
      expect(host.getPeerStates()).toHaveLength(1);
    } finally {
      try { first?.ws.close(); } catch { /* ignore */ }
      try { newer?.ws.close(); } catch { /* ignore */ }
      await host.dispose();
      cleanup();
    }
  });

  it("retains a disconnected winner watermark briefly, then permits lower-clock recovery", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const host = createAttemptHost(projectRoot);
    let now = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    let winner: Awaited<ReturnType<typeof connectPeer>> | null = null;
    let stale: Awaited<ReturnType<typeof openPeerHello>> | null = null;
    let recovered: Awaited<ReturnType<typeof connectPeer>> | null = null;
    try {
      const port = await host.waitUntilListening();
      winner = await connectPeer(port, host.getBootstrapToken(), "clock-recovery-device", {
        connectionAttempt: { id: "ahead-race", startedAtMs: now + 10_000 },
      });
      winner.ws.close();
      await waitForValue(() => host.getPeerStates().length === 0 ? true : null, "ahead winner close");
      stale = await openPeerHello(port, host.getBootstrapToken(), "clock-recovery-device", {
        connectionAttempt: { id: "lower-race", startedAtMs: now },
      });
      await expect(waitForValue(
        () => stale?.envelopes.find((entry) => entry.type === "hello_error"),
        "fresh stale watermark rejection",
      )).resolves.toMatchObject({ payload: { code: "connection_attempt_superseded" } });

      now += CONNECTION_ATTEMPT_RESERVATION_TTL_MS + 1;
      recovered = await connectPeer(port, host.getBootstrapToken(), "clock-recovery-device", {
        connectionAttempt: { id: "lower-race-retry", startedAtMs: now - 60_000 },
      });
      expect(recovered.ws.readyState).toBe(WebSocket.OPEN);
    } finally {
      nowSpy.mockRestore();
      try { winner?.ws.close(); } catch { /* ignore */ }
      try { stale?.ws.close(); } catch { /* ignore */ }
      try { recovered?.ws.close(); } catch { /* ignore */ }
      await host.dispose();
      cleanup();
    }
  });

  it("keeps last-authenticated-hello-wins behavior for legacy clients", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const host = createAttemptHost(projectRoot);
    let first: Awaited<ReturnType<typeof connectPeer>> | null = null;
    let second: Awaited<ReturnType<typeof connectPeer>> | null = null;
    try {
      const port = await host.waitUntilListening();
      first = await connectPeer(port, host.getBootstrapToken(), "legacy-race-device");
      second = await connectPeer(port, host.getBootstrapToken(), "legacy-race-device");
      await waitForValue(() => first?.closeEvents[0], "legacy peer superseded close");
      expect(second.ws.readyState).toBe(WebSocket.OPEN);
      expect(host.getPeerStates()).toHaveLength(1);
    } finally {
      try { first?.ws.close(); } catch { /* ignore */ }
      try { second?.ws.close(); } catch { /* ignore */ }
      await host.dispose();
      cleanup();
    }
  });
});

describe("PR snapshot invalidation push", () => {
  beforeEach(() => {
    publishMock.mockReset();
    spawnMock.mockReset();
    bonjourDestroyMock.mockReset();
    bonjourConstructorMock.mockReset();
    spawnMock.mockImplementation(() => ({ kill: vi.fn(), once: vi.fn(), unref: vi.fn() }));
  });

  it("broadcasts one lightweight prs_updated envelope to an authenticated peer", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const base = createHostArgs(projectRoot, []);
    const host = createSyncHostService({
      ...base,
      deviceRegistryService: {
        ...base.deviceRegistryService,
        upsertPeerMetadata: vi.fn(),
      },
    } as unknown as Parameters<typeof createSyncHostService>[0]);
    let peer: Awaited<ReturnType<typeof connectPeer>> | null = null;
    try {
      const port = await host.waitUntilListening();
      peer = await connectPeer(port, host.getBootstrapToken(), "ios-pr-invalidation");
      const envelopeCount = peer.envelopes.length;

      host.broadcastPrsUpdated();

      const envelope = await waitForValue(
        () => peer?.envelopes.slice(envelopeCount).find((entry) => entry.type === "prs_updated"),
        "prs_updated push",
      );
      const payload = envelope.payload as { updatedAt?: string };
      expect(envelope.type).toBe("prs_updated");
      expect(payload).toEqual({ updatedAt: expect.any(String) });
      expect(Number.isNaN(Date.parse(payload.updatedAt ?? ""))).toBe(false);
    } finally {
      try {
        peer?.ws.close();
      } catch {
        // ignore
      }
      await host.dispose();
      cleanup();
    }
  });
});

describe("CTO-gated Linear sync commands", () => {
  beforeEach(() => {
    publishMock.mockReset();
    spawnMock.mockReset();
    bonjourDestroyMock.mockReset();
    bonjourConstructorMock.mockReset();
    spawnMock.mockImplementation(() => ({ kill: vi.fn(), once: vi.fn(), unref: vi.fn() }));
  });

  it("advertises them as optional capabilities and forbids the credential writers at the gate", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const base = createHostArgs(projectRoot, []);
    const host = createSyncHostService({
      ...base,
      projectId: "project-1",
      discoveryEnabled: false,
      deviceRegistryService: {
        ...base.deviceRegistryService,
        upsertPeerMetadata: vi.fn(),
      },
    } as unknown as Parameters<typeof createSyncHostService>[0]);
    let peer: Awaited<ReturnType<typeof connectPeer>> | null = null;

    try {
      peer = await connectPeer(
        await host.waitUntilListening(),
        host.getBootstrapToken(),
        "viewer-linear-controller",
      );
      const hello = peer.envelopes.find((envelope) => envelope.type === "hello_ok");
      const actions = (hello?.payload as {
        features?: { commandRouting?: { actions?: SyncRemoteCommandDescriptor[] } };
      })?.features?.commandRouting?.actions ?? [];

      expect(MOBILE_SYNC_OPTIONAL_REMOTE_COMMAND_ACTIONS).toEqual([
        "cto.startLinearMobileOAuth",
        "cto.completeLinearMobileOAuth",
        "cto.setLinearToken",
        "cto.clearLinearToken",
        "cto.getAttention",
        "session.settleSessions",
        "session.unsettleSessions",
        "session.setSettleOverride",
        "session.snoozeSession",
        "session.wakeSession",
        "session.clearWokeMarker",
        "prs.listGithubStacks",
        "prs.syncGithubStacks",
        "prs.createGithubStack",
        "prs.addGithubStackPullRequests",
        "prs.unstackGithubStack",
      ]);
      expect(MOBILE_SYNC_REQUIRED_REMOTE_COMMAND_ACTIONS).not.toEqual(
        expect.arrayContaining([...MOBILE_SYNC_OPTIONAL_REMOTE_COMMAND_ACTIONS]),
      );
      // The two direct credential-store writers stay advertised — a phone still
      // feature-detects them — but are host-local, so the gate rejects them
      // (C12-sec). Clients hide the affordance by reading the advertised
      // policy, which is why the descriptor is asserted either way.
      const viewerBlockedActions = new Set<string>([
        "cto.setLinearToken",
        "cto.clearLinearToken",
      ]);

      for (const action of MOBILE_SYNC_OPTIONAL_REMOTE_COMMAND_ACTIONS) {
        const viewerBlocked = viewerBlockedActions.has(action);
        // Policy shape varies (lifecycle mutations are additionally queueable);
        // what matters for feature detection is that the action is advertised
        // with an accurate viewerAllowed bit.
        expect(actions).toContainEqual(expect.objectContaining({
          action,
          scope: "project",
          policy: expect.objectContaining({ viewerAllowed: !viewerBlocked }),
        }));

        const requestId = `viewer-${action}`;
        peer.ws.send(encodeSyncEnvelope({
          type: "command",
          requestId,
          projectId: "project-1",
          payload: {
            commandId: `command-${action}`,
            projectId: "project-1",
            action,
            args: action === "cto.completeLinearMobileOAuth"
              ? { sessionId: "session-1", code: "code-1", state: "state-1" }
              : action === "cto.setLinearToken"
                ? { token: "lin_api_viewer_must_not_write" }
                : {},
          },
        }));

        const result = await waitForEnvelope(peer.envelopes, "command_result", requestId);
        const errorCode = (result.payload as { error?: { code?: string } }).error?.code;
        if (viewerBlocked) {
          // The registry is the gate: a paired controller never reaches the
          // credential store, even though the action is advertised.
          expect(errorCode).toBe("forbidden_command");
        } else {
          // Everything else clears the authorization gate at the same trust
          // level as lanes.create/delete. It may still fail downstream on a
          // service not wired into this host harness, which is fine here — the
          // handler success paths live in syncRemoteCommandService tests.
          expect(errorCode).not.toBe("forbidden_command");
        }
      }
    } finally {
      peer?.ws.close();
      await host.dispose();
      cleanup();
    }
  });
});

describe("initial hydration priority", () => {
  it("keeps historical catch-up for legacy browsers without the invalidation-only capability", () => {
    expect(initialSyncHostCursorForPeer({
      peer: {
        deviceType: "browser",
        dbVersion: 7,
        dbVersionBySite: { "site-host": 11 },
        capabilities: [],
      },
      serverDbSiteId: "site-host",
      serverDbVersion: 99,
    })).toBe(11);
  });

  it("preserves an invalidation browser's same-DB handoff cursor but resets for a new DB", () => {
    const peer = {
      deviceType: "browser" as const,
      dbVersion: 0,
      dbVersionBySite: { "site-host": 4 },
      capabilities: [SYNC_INVALIDATION_ONLY_V1_CAPABILITY],
    };

    expect(adoptedSyncHostCursorForPeer({
      peer,
      serverDbSiteId: "site-host",
      serverDbVersion: 9,
      snapshotServerDbSiteId: "site-host",
      snapshotLastKnownServerDbVersion: 6,
    })).toBe(6);
    expect(adoptedSyncHostCursorForPeer({
      peer,
      serverDbSiteId: "site-new",
      serverDbVersion: 9,
      snapshotServerDbSiteId: "site-host",
      snapshotLastKnownServerDbVersion: 6,
    })).toBe(9);
    expect(adoptedSyncHostCursorForPeer({
      peer,
      serverDbSiteId: "site-host",
      serverDbVersion: 9,
      snapshotServerDbSiteId: "site-host",
      snapshotLastKnownServerDbVersion: 12,
    })).toBe(9);
  });

  it("admits a queued chat subscription before a replica peer's initial catch-up", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const exportChangesSince = vi.fn(() => [makeChange(1, 0)]);
    const base = createHostArgs(projectRoot, []);
    const host = createSyncHostService({
      ...base,
      projectId: "project-1",
      discoveryEnabled: false,
      pollIntervalMs: 60_000,
      db: {
        sync: {
          getSiteId: () => "site-host-queued-subscribe",
          getDbVersion: () => 1,
          exportChangesSince,
          applyChanges: () => ({ appliedCount: 0 }),
          discardUnpublishedChangesForTables: () => {},
        },
      },
    } as unknown as Parameters<typeof createSyncHostService>[0]);
    let client: WebSocket | null = null;

    try {
      const port = await host.waitUntilListening();
      client = new WebSocket(`ws://127.0.0.1:${port}`);
      const { envelopes } = trackClientEnvelopes(client);
      await new Promise<void>((resolve, reject) => {
        client!.once("open", resolve);
        client!.once("error", reject);
      });
      client.send(encodeSyncEnvelope({
        type: "hello",
        requestId: "phone-hello",
        payload: {
          peer: {
            deviceId: "phone-initial-hydration",
            deviceName: "Phone",
            platform: "iOS",
            deviceType: "phone",
            siteId: "phone-initial-hydration-site",
            dbVersion: 0,
          },
          auth: { kind: "bootstrap", token: host.getBootstrapToken() },
        },
      }));
      client.send(encodeSyncEnvelope({
        type: "chat_subscribe",
        requestId: "phone-chat-subscribe",
        projectId: "project-1",
        payload: { sessionId: "selected-chat" },
      }));

      await waitForEnvelope(envelopes, "chat_subscribe", "phone-chat-subscribe");
      expect(exportChangesSince).not.toHaveBeenCalled();
    } finally {
      try {
        client?.close();
      } catch {
        // ignore
      }
      await host.dispose();
      cleanup();
    }
  });

  it("serves other peers while one foreground queue is slow, then admits a bounded batch", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const state = {
      dbVersion: 0,
      changes: Array.from({ length: 200 }, (_, index) => makeChange(index + 1, index)),
    };
    const exportChangesSince = vi.fn(
      (fromDbVersion: number, options?: { maxRows?: number; throughDbVersion?: number }) =>
        state.changes
          .filter((change) => Number(change.db_version) > fromDbVersion)
          .filter((change) => Number(change.db_version) <= (options?.throughDbVersion ?? Number.MAX_SAFE_INTEGER))
          .slice(0, options?.maxRows ?? state.changes.length),
    );
    let releaseSummary!: (summary: { status: string }) => void;
    const summaryGate = new Promise<{ status: string }>((resolve) => {
      releaseSummary = resolve;
    });
    const getSessionSummary = vi.fn((sessionId: string) =>
      sessionId === "slow-chat" ? summaryGate : Promise.resolve(null)
    );
    const logger = createDiscoveryLogger();
    const base = createHostArgs(projectRoot, []);
    const host = createSyncHostService({
      ...base,
      logger,
      projectId: "project-1",
      discoveryEnabled: false,
      pollIntervalMs: 25,
      db: {
        sync: {
          getSiteId: () => "site-host-peer-fairness",
          getDbVersion: () => state.dbVersion,
          exportChangesSince,
          applyChanges: () => ({ appliedCount: 0 }),
          discardUnpublishedChangesForTables: () => {},
        },
      },
      agentChatService: {
        subscribeToEvents: vi.fn().mockReturnValue(() => {}),
        getChatEventHistory: vi.fn(() => ({
          sessionId: "slow-chat",
          events: [],
          truncated: false,
          transcriptTruncated: false,
          windowTruncated: false,
          sessionFound: true,
        })),
        getSessionSummary,
      },
      deviceRegistryService: {
        ...base.deviceRegistryService,
        upsertPeerMetadata: vi.fn(),
      },
    } as unknown as Parameters<typeof createSyncHostService>[0]);
    let slowPeer: Awaited<ReturnType<typeof connectPeer>> | null = null;
    let fastPeer: Awaited<ReturnType<typeof connectPeer>> | null = null;
    let dateNowSpy: { mockRestore(): void } | null = null;

    try {
      const port = await host.waitUntilListening();
      slowPeer = await connectPeer(port, host.getBootstrapToken(), "slow-foreground-peer", {
        platform: "macOS",
        deviceType: "browser",
        capabilities: [
          SYNC_INVALIDATION_ONLY_V1_CAPABILITY,
          SYNC_COMPACT_INVALIDATION_V1_CAPABILITY,
          "changesetAck",
        ],
      });
      fastPeer = await connectPeer(port, host.getBootstrapToken(), "independent-peer", {
        platform: "macOS",
        deviceType: "browser",
        capabilities: [
          SYNC_INVALIDATION_ONLY_V1_CAPABILITY,
          SYNC_COMPACT_INVALIDATION_V1_CAPABILITY,
          "changesetAck",
        ],
      });
      const baseNowMs = Date.now();
      let clockOffsetMs = 0;
      dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => baseNowMs + clockOffsetMs);

      slowPeer.ws.send(encodeSyncEnvelope({
        type: "chat_subscribe",
        requestId: "slow-chat-subscribe",
        projectId: "project-1",
        payload: { sessionId: "slow-chat" },
      }));
      await waitForValue(() => getSessionSummary.mock.calls[0], "slow foreground handler");
      state.dbVersion = 200;

      await waitForValue(
        () => logger.debug.mock.calls.find(([event, fields]) =>
          event === "sync_host.changeset_priority_deferral_started"
          && fields?.peerDeviceId === "slow-foreground-peer"
        ),
        "per-peer foreground deferral",
      );
      const independentBatch = await waitForValue(
        () => fastPeer?.envelopes.find((envelope) => envelope.type === "invalidation_batch"),
        "independent peer invalidation",
      );
      expect(independentBatch.payload as SyncInvalidationBatchPayload).toEqual({
        fromDbVersion: 0,
        toDbVersion: 200,
        tables: ["kv"],
        fullRefresh: false,
      });
      expect(slowPeer.envelopes.some((envelope) =>
        envelope.type === "changeset_batch" || envelope.type === "invalidation_batch"
      )).toBe(false);
      expect(getSessionSummary).toHaveBeenCalledWith("slow-chat");

      clockOffsetMs += SYNC_HOST_PRIORITY_MAX_CHANGESET_DEFER_MS + 25;
      const boundedSlowBatch = await waitForValue(
        () => slowPeer?.envelopes.find((envelope) => envelope.type === "invalidation_batch"),
        "bounded slow-peer invalidation",
      );
      expect(boundedSlowBatch.payload as SyncInvalidationBatchPayload).toEqual({
        fromDbVersion: 0,
        toDbVersion: 64,
        tables: ["kv"],
        fullRefresh: false,
      });
      expect(logger.debug).toHaveBeenCalledWith(
        "sync_host.changeset_priority_deferral_ended",
        expect.objectContaining({
          peerDeviceId: "slow-foreground-peer",
          reason: "batch_admitted",
        }),
      );
      expect(slowPeer.envelopes.some((envelope) => envelope.type === "chat_subscribe")).toBe(false);

      releaseSummary({ status: "idle" });
      await waitForEnvelope(slowPeer.envelopes, "chat_subscribe", "slow-chat-subscribe");
    } finally {
      releaseSummary({ status: "idle" });
      dateNowSpy?.mockRestore();
      slowPeer?.ws.close();
      fastPeer?.ws.close();
      await host.dispose();
      cleanup();
    }
  });

  it("keeps an independent replica delivering and retrying while another peer's transcript read is stalled", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const transcriptPath = path.join(projectRoot, "transcripts", "stalled-chat.chat.jsonl");
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    fs.writeFileSync(transcriptPath, "", "utf8");
    const session = {
      id: "stalled-chat",
      laneId: "lane-1",
      transcriptPath,
      status: "running",
      runtimeState: "running",
      lastOutputPreview: "",
    };
    const state = { dbVersion: 0, changes: [] as CrsqlChangeRow[] };
    const logger = createDiscoveryLogger();
    const base = createHostArgs(projectRoot, []);
    const host = createSyncHostService({
      ...base,
      logger,
      projectId: "project-1",
      discoveryEnabled: false,
      pollIntervalMs: 100,
      db: {
        sync: {
          getSiteId: () => "site-host-transcript-fairness",
          getDbVersion: () => state.dbVersion,
          exportChangesSince: (fromDbVersion: number) =>
            state.changes.filter((change) => Number(change.db_version) > fromDbVersion),
          applyChanges: () => ({ appliedCount: 0 }),
          discardUnpublishedChangesForTables: () => {},
        },
      },
      sessionService: {
        list: () => [session],
        get: (id: string) => id === session.id ? session : null,
        readTranscriptTail: async () => "",
      },
      agentChatService: {
        subscribeToEvents: vi.fn().mockReturnValue(() => {}),
        getChatEventHistory: vi.fn().mockReturnValue({
          sessionId: session.id,
          events: [],
          truncated: false,
          transcriptTruncated: false,
          windowTruncated: false,
          sessionFound: true,
        }),
        getSessionSummary: vi.fn().mockResolvedValue({ status: "active" }),
      },
      deviceRegistryService: {
        ...base.deviceRegistryService,
        upsertPeerMetadata: vi.fn(),
      },
    } as unknown as Parameters<typeof createSyncHostService>[0]);
    let stalledPeer: Awaited<ReturnType<typeof connectPeer>> | null = null;
    let replicaPeer: Awaited<ReturnType<typeof connectPeer>> | null = null;
    let openSpy: { mockRestore(): void } | null = null;
    let dateNowSpy: { mockRestore(): void } | null = null;
    let releaseTranscriptRead = () => {};

    try {
      const port = await host.waitUntilListening();
      stalledPeer = await connectPeer(port, host.getBootstrapToken(), "stalled-chat-peer", {
        capabilities: ["changesetAck"],
      });
      replicaPeer = await connectPeer(port, host.getBootstrapToken(), "independent-replica-peer", {
        capabilities: ["changesetAck"],
      });
      stalledPeer.ws.send(encodeSyncEnvelope({
        type: "chat_subscribe",
        requestId: "stalled-chat-subscribe",
        projectId: "project-1",
        payload: { sessionId: session.id },
      }));
      await waitForEnvelope(stalledPeer.envelopes, "chat_subscribe", "stalled-chat-subscribe");

      const realOpen = fs.promises.open.bind(fs.promises);
      let markTranscriptReadStarted = () => {};
      const transcriptReadStarted = new Promise<void>((resolve) => {
        markTranscriptReadStarted = resolve;
      });
      const transcriptReadGate = new Promise<void>((resolve) => {
        releaseTranscriptRead = resolve;
      });
      let shouldStallTranscriptRead = true;
      openSpy = vi.spyOn(fs.promises, "open").mockImplementation((async (
        ...openArgs: Parameters<typeof fs.promises.open>
      ) => {
        if (String(openArgs[0]) === transcriptPath && shouldStallTranscriptRead) {
          shouldStallTranscriptRead = false;
          markTranscriptReadStarted();
          await transcriptReadGate;
        }
        return realOpen(...openArgs);
      }) as typeof fs.promises.open);

      const realDateNow = Date.now.bind(Date);
      let clockOffsetMs = 0;
      dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => realDateNow() + clockOffsetMs);
      const chatEvent: AgentChatEventEnvelope = {
        sessionId: session.id,
        timestamp: "2026-07-22T10:00:00.000Z",
        sequence: 1,
        event: { type: "text", text: "chat must lead its own catch-up" },
      };
      fs.appendFileSync(transcriptPath, `${JSON.stringify(chatEvent)}\n`, "utf8");
      state.dbVersion = 1;
      state.changes.push(makeChange(1, 0));
      const stalledEnvelopeStart = stalledPeer.envelopes.length;

      await transcriptReadStarted;
      const firstReplicaBatch = await waitForValue(
        () => replicaPeer?.envelopes.find((entry) => entry.type === "changeset_batch"),
        "independent replica changeset while transcript is stalled",
      );
      expect(stalledPeer.envelopes.slice(stalledEnvelopeStart).some((entry) =>
        entry.type === "changeset_batch" || entry.type === "chat_event"
      )).toBe(false);

      const firstPayload = firstReplicaBatch.payload as SyncChangesetBatchPayload;
      replicaPeer.ws.send(encodeSyncEnvelope({
        type: "changeset_ack",
        requestId: firstPayload.batchId,
        projectId: "project-1",
        payload: {
          batchId: firstPayload.batchId,
          fromDbVersion: firstPayload.fromDbVersion,
          toDbVersion: firstPayload.toDbVersion,
          appliedDbVersion: firstPayload.fromDbVersion,
          appliedCount: 0,
          ok: false,
          error: { code: "apply_failed", message: "retry deterministically" },
        } satisfies SyncChangesetAckPayload,
      }));
      await waitForValue(
        () => logger.warn.mock.calls.find(([event, fields]) =>
          event === "sync_host.changeset_ack_failed"
          && fields?.peerDeviceId === "independent-replica-peer"
        ),
        "independent replica retry scheduling",
      );
      clockOffsetMs += 60_000;
      await waitForValue(
        () => replicaPeer?.envelopes.filter((entry) =>
          entry.type === "changeset_batch"
          && (entry.payload as SyncChangesetBatchPayload).batchId === firstPayload.batchId
        ).length === 2 ? true : null,
        "independent replica retry while transcript remains stalled",
      );

      releaseTranscriptRead();
      const stalledChatEvent = await waitForValue(
        () => stalledPeer?.envelopes.slice(stalledEnvelopeStart).find((entry) => entry.type === "chat_event"),
        "stalled peer chat event after read release",
      );
      const stalledBatch = await waitForValue(
        () => stalledPeer?.envelopes.slice(stalledEnvelopeStart).find((entry) => entry.type === "changeset_batch"),
        "stalled peer changeset after chat",
      );
      expect(stalledChatEvent.payload).toMatchObject({
        sessionId: session.id,
        event: { type: "text", text: "chat must lead its own catch-up" },
      });
      expect(stalledPeer.envelopes.indexOf(stalledChatEvent)).toBeLessThan(
        stalledPeer.envelopes.indexOf(stalledBatch),
      );
    } finally {
      releaseTranscriptRead();
      openSpy?.mockRestore();
      dateNowSpy?.mockRestore();
      stalledPeer?.ws.close();
      replicaPeer?.ws.close();
      await host.dispose();
      cleanup();
    }
  });

  it("hydrates the selected browser chat without replaying historical CRDT rows", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const transcriptPath = path.join(projectRoot, "transcripts", "selected-chat.chat.jsonl");
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    const event: AgentChatEventEnvelope = {
      sessionId: "selected-chat",
      timestamp: "2026-07-22T04:50:55.000Z",
      sequence: 1,
      event: { type: "text", text: "selected transcript" },
    };
    fs.writeFileSync(transcriptPath, `${JSON.stringify(event)}\n`, "utf8");

    const state = {
      dbVersion: 1,
      changes: [makeChange(1, 0)],
    };
    const exportChangesSince = vi.fn(
      (fromDbVersion: number, options?: { maxRows?: number; throughDbVersion?: number }) =>
        state.changes
          .filter((change) => Number(change.db_version) > fromDbVersion)
          .filter((change) => Number(change.db_version) <= (options?.throughDbVersion ?? Number.MAX_SAFE_INTEGER))
          .slice(0, options?.maxRows ?? state.changes.length),
    );
    const getChatEventHistory = vi.fn(() => ({
      sessionId: "selected-chat",
      events: [event],
      truncated: false,
      transcriptTruncated: false,
      windowTruncated: false,
      sessionFound: true,
    }));
    let releaseSummary!: (summary: { status: string }) => void;
    const summaryGate = new Promise<{ status: string }>((resolve) => {
      releaseSummary = resolve;
    });
    const base = createHostArgs(projectRoot, []);
    const host = createSyncHostService({
      ...base,
      projectId: "project-1",
      discoveryEnabled: false,
      pollIntervalMs: 100,
      db: {
        sync: {
          getSiteId: () => "site-host-initial-hydration",
          getDbVersion: () => state.dbVersion,
          exportChangesSince,
          applyChanges: () => ({ appliedCount: 0 }),
          discardUnpublishedChangesForTables: () => {},
        },
      },
      sessionService: {
        list: () => [],
        get: (sessionId: string) => sessionId === "selected-chat"
          ? { id: sessionId, transcriptPath, status: "running" }
          : null,
        readTranscriptTail: async () => "",
      },
      agentChatService: {
        subscribeToEvents: vi.fn().mockReturnValue(() => {}),
        getChatEventHistory,
        getSessionSummary: vi.fn(() => summaryGate),
      },
    } as unknown as Parameters<typeof createSyncHostService>[0]);
    let client: WebSocket | null = null;

    try {
      const port = await host.waitUntilListening();
      client = new WebSocket(`ws://127.0.0.1:${port}`);
      const { envelopes } = trackClientEnvelopes(client);
      await new Promise<void>((resolve, reject) => {
        client!.once("open", resolve);
        client!.once("error", reject);
      });

      // Browsers send their selected-chat subscription as soon as hello_ok
      // arrives. Queue both frames here to make the host ordering contract
      // deterministic: foreground hydration must beat the initial backlog.
      client.send(encodeSyncEnvelope({
        type: "hello",
        requestId: "browser-hello",
        payload: {
          peer: {
            deviceId: "browser-initial-hydration",
            deviceName: "Browser",
            platform: "macOS",
            deviceType: "browser",
            siteId: "browser-initial-hydration-site",
            dbVersion: 0,
            capabilities: [
              SYNC_INVALIDATION_ONLY_V1_CAPABILITY,
              SYNC_COMPACT_INVALIDATION_V1_CAPABILITY,
            ],
          },
          auth: { kind: "bootstrap", token: host.getBootstrapToken() },
        },
      }));
      client.send(encodeSyncEnvelope({
        type: "chat_subscribe",
        requestId: "selected-chat-subscribe",
        projectId: "project-1",
        payload: { sessionId: "selected-chat", maxBytes: 64 * 1024 },
      }));

      await waitForValue(
        () => getChatEventHistory.mock.calls[0],
        "selected chat history read",
      );
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(exportChangesSince).not.toHaveBeenCalled();
      releaseSummary({ status: "idle" });

      const snapshot = await waitForEnvelope(
        envelopes,
        "chat_subscribe",
        "selected-chat-subscribe",
      );
      expect(snapshot.payload).toMatchObject({
        sessionId: "selected-chat",
        events: [event],
        turnActive: false,
      });
      expect(getChatEventHistory).toHaveBeenCalledTimes(1);
      expect(envelopes.some((envelope) => envelope.type === "changeset_batch")).toBe(false);

      // A browser is invalidation-only: historical rows are skipped, while a
      // mutation committed after hello produces a compact live signal even
      // when the source row itself is larger than the Relay peer budget.
      state.dbVersion = 2;
      const oversizedValue = "x".repeat(PEER_BACKPRESSURE_BYTES + 1);
      state.changes.push({
        ...makeChange(2, 1, oversizedValue),
        table: "operations",
      });
      const liveInvalidation = await waitForValue(
        () => envelopes.find((envelope) => envelope.type === "invalidation_batch"),
        "post-connect browser invalidation",
      );
      expect(exportChangesSince).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ throughDbVersion: 2 }),
      );
      const invalidationPayload = liveInvalidation.payload as SyncInvalidationBatchPayload;
      expect(invalidationPayload).toEqual({
        fromDbVersion: 1,
        toDbVersion: 2,
        tables: ["operations"],
        fullRefresh: false,
      });
      expect(envelopes.some((envelope) => envelope.type === "changeset_batch")).toBe(false);
      expect(Buffer.byteLength(encodeSyncEnvelope({
        type: "invalidation_batch",
        payload: invalidationPayload,
        compressionThresholdBytes: Number.MAX_SAFE_INTEGER,
      }), "utf8")).toBeLessThanOrEqual(SYNC_INVALIDATION_BATCH_MAX_ENVELOPE_BYTES);
    } finally {
      try {
        client?.close();
      } catch {
        // ignore
      }
      await host.dispose();
      cleanup();
    }
  });

  it("keeps older invalidation-only browsers on changeset hints", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const state = {
      dbVersion: 0,
      changes: [] as CrsqlChangeRow[],
    };
    const base = createHostArgs(projectRoot, []);
    const host = createSyncHostService({
      ...base,
      projectId: "project-1",
      discoveryEnabled: false,
      pollIntervalMs: 25,
      db: {
        sync: {
          getSiteId: () => "site-host-legacy-browser",
          getDbVersion: () => state.dbVersion,
          exportChangesSince: (fromDbVersion: number) =>
            state.changes.filter((change) => Number(change.db_version) > fromDbVersion),
          applyChanges: () => ({ appliedCount: 0 }),
          discardUnpublishedChangesForTables: () => {},
        },
      },
      deviceRegistryService: {
        ...base.deviceRegistryService,
        upsertPeerMetadata: vi.fn(),
      },
    } as unknown as Parameters<typeof createSyncHostService>[0]);
    let browser: WebSocket | null = null;
    let envelopes: ParsedSyncEnvelope[] = [];

    try {
      const port = await host.waitUntilListening();
      browser = new WebSocket(`ws://127.0.0.1:${port}`);
      ({ envelopes } = trackClientEnvelopes(browser));
      await new Promise<void>((resolve, reject) => {
        browser!.once("open", resolve);
        browser!.once("error", reject);
      });
      browser.send(encodeSyncEnvelope({
        type: "hello",
        requestId: "legacy-browser-hello",
        payload: {
          peer: {
            deviceId: "legacy-invalidation-browser",
            deviceName: "Legacy Browser",
            platform: "macOS",
            deviceType: "browser",
            siteId: "legacy-invalidation-browser-site",
            dbVersion: 0,
            capabilities: [SYNC_INVALIDATION_ONLY_V1_CAPABILITY],
          },
          auth: { kind: "bootstrap", token: host.getBootstrapToken() },
        },
      }));
      const helloOkEnvelope = await waitForEnvelope(envelopes, "hello_ok", "legacy-browser-hello");
      expect((helloOkEnvelope.payload as { features?: Record<string, unknown> }).features)
        .not.toHaveProperty("compactInvalidationV1");
      expect(envelopes.some((envelope) =>
        envelope.type === "changeset_batch" || envelope.type === "invalidation_batch"
      )).toBe(false);

      state.dbVersion = 1;
      state.changes.push(makeChange(1, 0));
      const legacyBatch = await waitForValue(
        () => envelopes.find((envelope) => envelope.type === "changeset_batch"),
        "legacy browser changeset hint",
      );
      expect((legacyBatch.payload as SyncChangesetBatchPayload).changes).toEqual([
        expect.objectContaining({ db_version: 1, table: "kv" }),
      ]);
      expect(envelopes.some((envelope) => envelope.type === "invalidation_batch")).toBe(false);
    } finally {
      browser?.close();
      await host.dispose();
      cleanup();
    }
  });
});

describe("outbound changeset ack retries", () => {
  beforeEach(() => {
    publishMock.mockReset();
    spawnMock.mockReset();
    bonjourDestroyMock.mockReset();
    bonjourConstructorMock.mockReset();
    spawnMock.mockImplementation(() => ({ kill: vi.fn(), once: vi.fn(), unref: vi.fn() }));
  });

  function createAckRetryHost(projectRoot: string) {
    const base = createHostArgs(projectRoot, []);
    const changes = [makeChange(1, 0)];
    return createSyncHostService({
      ...base,
      pollIntervalMs: 25,
      projectId: "project-1",
      db: {
        sync: {
          getSiteId: () => "site-host-ack",
          getDbVersion: () => 1,
          exportChangesSince: (fromDbVersion: number) =>
            changes.filter((change) => Number(change.db_version) > fromDbVersion),
          applyChanges: () => ({ appliedCount: 0 }),
          discardUnpublishedChangesForTables: () => {},
        },
      },
      deviceRegistryService: {
        ...base.deviceRegistryService,
        upsertPeerMetadata: vi.fn(),
      },
    } as unknown as Parameters<typeof createSyncHostService>[0]);
  }

  function createControlledChangesetHost(
    projectRoot: string,
    state: { dbVersion: number; changes: CrsqlChangeRow[] },
    logger = createDiscoveryLogger(),
    options: { pollIntervalMs?: number } = {},
  ) {
    const base = createHostArgs(projectRoot, []);
    const exportChangesSince = vi.fn(
      (fromDbVersion: number, options?: {
        maxRows?: number;
        throughDbVersion?: number;
        excludeTables?: readonly string[];
        rejectOversizedVersionGroup?: boolean;
      }) =>
        state.changes
          .filter((change) => Number(change.db_version) > fromDbVersion)
          .filter((change) => Number(change.db_version) <= (options?.throughDbVersion ?? Number.MAX_SAFE_INTEGER))
          .filter((change) => !options?.excludeTables?.includes(change.table))
          .slice(0, options?.maxRows ?? state.changes.length),
    );
    const host = createSyncHostService({
      ...base,
      logger,
      pollIntervalMs: options.pollIntervalMs ?? 25,
      projectId: "project-1",
      db: {
        sync: {
          getSiteId: () => "site-host-controlled",
          getDbVersion: () => state.dbVersion,
          exportChangesSince,
          applyChanges: () => ({ appliedCount: 0 }),
          discardUnpublishedChangesForTables: () => {},
        },
      },
      deviceRegistryService: {
        ...base.deviceRegistryService,
        upsertPeerMetadata: vi.fn(),
      },
    } as unknown as Parameters<typeof createSyncHostService>[0]);
    return { host, logger, exportChangesSince };
  }

  it("reseeds a far-behind iOS replica once, then resumes incrementally from the acknowledged watermark", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const state = {
      dbVersion: SYNC_HOST_MOBILE_REPLICA_RESEED_GAP + 1,
      changes: Array.from({ length: 2_500 }, (_, index) => makeChange(index + 1, index)),
    };
    const { host, exportChangesSince } = createControlledChangesetHost(projectRoot, state);
    let peer: Awaited<ReturnType<typeof connectPeer>> | null = null;
    try {
      const port = await host.waitUntilListening();
      peer = await connectPeer(port, host.getBootstrapToken(), "ios-far-behind", {
        capabilities: ["changesetAck", SYNC_CHUNKED_ENVELOPES_CAPABILITY],
      });

      const reseedEnvelope = await waitForValue(
        () => peer?.envelopes.find((envelope) => envelope.type === "changeset_batch"),
        "far-behind replica reseed",
      );
      const reseed = reseedEnvelope.payload as SyncChangesetBatchPayload;
      expect(reseed.reason).toBe("catchup");
      expect(reseed.fromDbVersion).toBe(0);
      expect(reseed.toDbVersion).toBe(SYNC_HOST_MOBILE_REPLICA_RESEED_GAP + 1);
      expect(reseed.changes).toHaveLength(2_500);
      expect(peer.envelopes.filter((envelope) => envelope.type === "changeset_batch")).toHaveLength(1);
      expect(exportChangesSince.mock.calls.length).toBeGreaterThan(1);
      expect(exportChangesSince.mock.calls.every(([, options]) => options?.maxRows === 1_000)).toBe(true);
      expect(exportChangesSince.mock.calls.every(([, options]) => options?.rejectOversizedVersionGroup === true)).toBe(true);
      expect(exportChangesSince.mock.calls[0]?.[1]?.excludeTables).toEqual(expect.arrayContaining([
        "operations",
        "attempt_transcripts",
        "sync_cluster_state",
      ]));

      peer.ws.send(encodeSyncEnvelope({
        type: "changeset_ack",
        requestId: reseed.batchId,
        payload: {
          batchId: reseed.batchId,
          fromDbVersion: reseed.fromDbVersion,
          toDbVersion: reseed.toDbVersion,
          appliedDbVersion: reseed.toDbVersion,
          appliedCount: reseed.changes.length,
          ok: true,
        } satisfies SyncChangesetAckPayload,
      }));

      state.dbVersion += 1;
      state.changes.push(makeChange(state.dbVersion, state.changes.length));
      const incrementalEnvelope = await waitForValue(
        () => peer?.envelopes.find((envelope) =>
          envelope.type === "changeset_batch"
          && (envelope.payload as SyncChangesetBatchPayload).batchId !== reseed.batchId),
        "post-reseed incremental batch",
      );
      expect(incrementalEnvelope.payload).toMatchObject({
        reason: "broadcast",
        fromDbVersion: SYNC_HOST_MOBILE_REPLICA_RESEED_GAP + 1,
        toDbVersion: SYNC_HOST_MOBILE_REPLICA_RESEED_GAP + 2,
      });
      expect((incrementalEnvelope.payload as SyncChangesetBatchPayload).changes).toHaveLength(1);
    } finally {
      peer?.ws.close();
      await host.dispose();
      cleanup();
    }
  });

  it("retries an abandoned far-behind replica reseed from its old cursor after recovery backoff", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const targetDbVersion = SYNC_HOST_MOBILE_REPLICA_RESEED_GAP + 1;
    const state = {
      dbVersion: targetDbVersion,
      changes: Array.from({ length: 10 }, (_, index) => makeChange(index + 1, index)),
    };
    const { host, logger } = createControlledChangesetHost(projectRoot, state);
    let peer: Awaited<ReturnType<typeof connectPeer>> | null = null;
    let dateNowSpy: { mockRestore(): void } | null = null;
    try {
      const port = await host.waitUntilListening();
      peer = await connectPeer(port, host.getBootstrapToken(), "ios-reseed-recovery", {
        capabilities: ["changesetAck", SYNC_CHUNKED_ENVELOPES_CAPABILITY],
      });

      const firstEnvelope = await waitForValue(
        () => peer?.envelopes.find((envelope) => envelope.type === "changeset_batch"),
        "initial compact reseed",
      );
      const firstReseed = firstEnvelope.payload as SyncChangesetBatchPayload;
      expect(firstReseed).toMatchObject({
        reason: "catchup",
        fromDbVersion: 0,
        toDbVersion: targetDbVersion,
      });

      const realDateNow = Date.now.bind(Date);
      let clockOffsetMs = 0;
      dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => realDateNow() + clockOffsetMs);
      for (let attemptCount = 2; attemptCount <= 6; attemptCount += 1) {
        clockOffsetMs += 11_000;
        await waitForValue(
          () => peer?.envelopes.filter((envelope) =>
            envelope.type === "changeset_batch"
            && (envelope.payload as SyncChangesetBatchPayload).batchId === firstReseed.batchId
          )[attemptCount - 1],
          `compact reseed send attempt ${attemptCount}`,
        );
      }

      clockOffsetMs += 11_000;
      await waitForValue(
        () => logger.warn.mock.calls.find(([event, fields]) =>
          event === "sync_host.changeset_recovery_started"
          && fields?.abandonedBatchId === firstReseed.batchId
        ),
        "compact reseed abandonment",
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(peer.envelopes.filter((envelope) =>
        envelope.type === "changeset_batch"
        && (envelope.payload as SyncChangesetBatchPayload).batchId !== firstReseed.batchId
      )).toHaveLength(0);

      clockOffsetMs += 500;
      const retryEnvelope = await waitForValue(
        () => peer?.envelopes.find((envelope) =>
          envelope.type === "changeset_batch"
          && (envelope.payload as SyncChangesetBatchPayload).batchId !== firstReseed.batchId),
        "compact reseed after recovery backoff",
      );
      const retryReseed = retryEnvelope.payload as SyncChangesetBatchPayload;
      expect(retryReseed.batchId).not.toBe(firstReseed.batchId);
      expect(retryReseed).toMatchObject({
        reason: "catchup",
        fromDbVersion: 0,
        toDbVersion: targetDbVersion,
      });
    } finally {
      dateNowSpy?.mockRestore();
      peer?.ws.close();
      await host.dispose();
      cleanup();
    }
  }, 15_000);

  it("admits only one new compact reseed per poll before sending the next far-behind phone", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const state = {
      dbVersion: SYNC_HOST_MOBILE_REPLICA_RESEED_GAP + 1,
      changes: Array.from({ length: 2_500 }, (_, index) => makeChange(index + 1, index)),
    };
    const { host } = createControlledChangesetHost(projectRoot, state, createDiscoveryLogger(), {
      pollIntervalMs: 250,
    });
    let firstPeer: Awaited<ReturnType<typeof connectPeer>> | null = null;
    let secondPeer: Awaited<ReturnType<typeof connectPeer>> | null = null;
    try {
      const port = await host.waitUntilListening();
      firstPeer = await connectPeer(port, host.getBootstrapToken(), "ios-reseed-admission-first", {
        capabilities: ["changesetAck", SYNC_CHUNKED_ENVELOPES_CAPABILITY],
      });
      secondPeer = await connectPeer(port, host.getBootstrapToken(), "ios-reseed-admission-second", {
        capabilities: ["changesetAck", SYNC_CHUNKED_ENVELOPES_CAPABILITY],
      });

      const firstEnvelope = await waitForValue(
        () => firstPeer?.envelopes.find((envelope) => envelope.type === "changeset_batch"),
        "first admitted compact reseed",
      );
      expect((firstEnvelope.payload as SyncChangesetBatchPayload).reason).toBe("catchup");
      // The shared cache becomes ready for both peers on this poll. The second
      // send must wait for the following generation instead of gzip/framing two
      // logical snapshots back-to-back on the host event loop.
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(secondPeer.envelopes.some((envelope) => envelope.type === "changeset_batch")).toBe(false);

      const secondEnvelope = await waitForValue(
        () => secondPeer?.envelopes.find((envelope) => envelope.type === "changeset_batch"),
        "second compact reseed on a later poll",
      );
      expect((secondEnvelope.payload as SyncChangesetBatchPayload).reason).toBe("catchup");
    } finally {
      firstPeer?.ws.close();
      secondPeer?.ws.close();
      await host.dispose();
      cleanup();
    }
  });

  it("crosses a sparse 16.8m-version reseed gap in bounded empty-window bursts", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const state = {
      dbVersion: 16_800_000,
      changes: [] as CrsqlChangeRow[],
    };
    const { host, exportChangesSince } = createControlledChangesetHost(projectRoot, state, createDiscoveryLogger(), {
      pollIntervalMs: 100,
    });
    let peer: Awaited<ReturnType<typeof connectPeer>> | null = null;
    try {
      const port = await host.waitUntilListening();
      peer = await connectPeer(port, host.getBootstrapToken(), "ios-sparse-16m-reseed", {
        capabilities: ["changesetAck", SYNC_CHUNKED_ENVELOPES_CAPABILITY],
      });
      const reseedEnvelope = await waitForValue(
        () => peer?.envelopes.find((envelope) => envelope.type === "changeset_batch"),
        "accelerated sparse compact reseed",
        2_000,
      );
      expect(reseedEnvelope.payload).toMatchObject({
        reason: "catchup",
        fromDbVersion: 0,
        toDbVersion: state.dbVersion,
        changes: [],
      });
      expect(exportChangesSince).toHaveBeenCalledTimes(Math.ceil(state.dbVersion / 250_000));
      expect(exportChangesSince.mock.calls.every(([fromDbVersion, options]) =>
        (options?.throughDbVersion ?? fromDbVersion) - fromDbVersion <= 250_000,
      )).toBe(true);
      expect(exportChangesSince.mock.calls.every(([, options]) => options?.maxRows === 1_000)).toBe(true);
    } finally {
      peer?.ws.close();
      await host.dispose();
      cleanup();
    }
  }, 3_000);

  it("rebuilds an oversized compact cache after later database changes make it eligible", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const initialTarget = (SYNC_HOST_MOBILE_REPLICA_RESEED_GAP * 2) + 1;
    const state = {
      dbVersion: initialTarget,
      changes: Array.from({ length: 10_001 }, (_, index) => makeChange(index + 1, index)),
    };
    const { host } = createControlledChangesetHost(projectRoot, state);
    let firstPeer: Awaited<ReturnType<typeof connectPeer>> | null = null;
    let secondPeer: Awaited<ReturnType<typeof connectPeer>> | null = null;
    try {
      const port = await host.waitUntilListening();
      firstPeer = await connectPeer(port, host.getBootstrapToken(), "ios-oversized-cache-first", {
        capabilities: ["changesetAck", SYNC_CHUNKED_ENVELOPES_CAPABILITY],
      });
      const fallback = await waitForValue(
        () => firstPeer?.envelopes.find((envelope) => envelope.type === "changeset_batch"),
        "initial oversized compact fallback",
      );
      expect((fallback.payload as SyncChangesetBatchPayload).reason).toBe("broadcast");
      firstPeer.ws.close();
      firstPeer = null;

      state.dbVersion += SYNC_HOST_MOBILE_REPLICA_RESEED_GAP + 1;
      state.changes = [makeChange(state.dbVersion, 0)];
      secondPeer = await connectPeer(port, host.getBootstrapToken(), "ios-oversized-cache-second", {
        capabilities: ["changesetAck", SYNC_CHUNKED_ENVELOPES_CAPABILITY],
      });
      const rebuilt = await waitForValue(
        () => secondPeer?.envelopes.find((envelope) => envelope.type === "changeset_batch"),
        "rebuilt compact cache",
      );
      expect(rebuilt.payload).toMatchObject({
        reason: "catchup",
        fromDbVersion: 0,
        toDbVersion: state.dbVersion,
      });
      expect((rebuilt.payload as SyncChangesetBatchPayload).changes).toHaveLength(1);
    } finally {
      firstPeer?.ws.close();
      secondPeer?.ws.close();
      await host.dispose();
      cleanup();
    }
  });

  it("refreshes a shared reseed cache before it can leave another replica far behind", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const firstTarget = SYNC_HOST_MOBILE_REPLICA_RESEED_GAP + 1;
    const state = {
      dbVersion: firstTarget,
      changes: Array.from({ length: 10 }, (_, index) => makeChange(index + 1, index)),
    };
    const { host } = createControlledChangesetHost(projectRoot, state);
    let firstPeer: Awaited<ReturnType<typeof connectPeer>> | null = null;
    let secondPeer: Awaited<ReturnType<typeof connectPeer>> | null = null;
    try {
      const port = await host.waitUntilListening();
      firstPeer = await connectPeer(port, host.getBootstrapToken(), "ios-first-reseed", {
        capabilities: ["changesetAck", SYNC_CHUNKED_ENVELOPES_CAPABILITY],
      });
      const firstEnvelope = await waitForValue(
        () => firstPeer?.envelopes.find((envelope) => envelope.type === "changeset_batch"),
        "first compact reseed",
      );
      expect((firstEnvelope.payload as SyncChangesetBatchPayload).toDbVersion).toBe(firstTarget);
      firstPeer.ws.close();
      firstPeer = null;

      const secondTarget = firstTarget + SYNC_HOST_MOBILE_REPLICA_RESEED_GAP + 1;
      state.dbVersion = secondTarget;
      state.changes.push(makeChange(secondTarget, state.changes.length));
      secondPeer = await connectPeer(port, host.getBootstrapToken(), "ios-later-reseed", {
        capabilities: ["changesetAck", SYNC_CHUNKED_ENVELOPES_CAPABILITY],
      });
      const secondEnvelope = await waitForValue(
        () => secondPeer?.envelopes.find((envelope) => envelope.type === "changeset_batch"),
        "refreshed compact reseed",
      );
      const secondReseed = secondEnvelope.payload as SyncChangesetBatchPayload;
      expect(secondReseed.reason).toBe("catchup");
      expect(secondReseed.toDbVersion).toBe(secondTarget);
      expect(secondReseed.changes).toHaveLength(11);
    } finally {
      firstPeer?.ws.close();
      secondPeer?.ws.close();
      await host.dispose();
      cleanup();
    }
  });

  it("retargets a compact reseed when the database advances beyond the threshold during construction", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const firstTarget = SYNC_HOST_MOBILE_REPLICA_RESEED_GAP + 1;
    const secondTarget = firstTarget + SYNC_HOST_MOBILE_REPLICA_RESEED_GAP + 1;
    const state = {
      dbVersion: firstTarget,
      changes: Array.from({ length: 2_500 }, (_, index) => makeChange(index + 1, index)),
    };
    const { host, exportChangesSince } = createControlledChangesetHost(projectRoot, state);
    let advancedDuringBuild = false;
    exportChangesSince.mockImplementation((fromDbVersion, options) => {
      const exported = state.changes
        .filter((change) => Number(change.db_version) > fromDbVersion)
        .filter((change) => Number(change.db_version) <= (options?.throughDbVersion ?? Number.MAX_SAFE_INTEGER))
        .filter((change) => !options?.excludeTables?.includes(change.table))
        .slice(0, options?.maxRows ?? state.changes.length);
      if (!advancedDuringBuild) {
        advancedDuringBuild = true;
        state.dbVersion = secondTarget;
        state.changes.push(makeChange(secondTarget, state.changes.length));
      }
      return exported;
    });
    let peer: Awaited<ReturnType<typeof connectPeer>> | null = null;
    try {
      const port = await host.waitUntilListening();
      peer = await connectPeer(port, host.getBootstrapToken(), "ios-growing-reseed", {
        capabilities: ["changesetAck", SYNC_CHUNKED_ENVELOPES_CAPABILITY],
      });
      const envelope = await waitForValue(
        () => peer?.envelopes.find((candidate) => candidate.type === "changeset_batch"),
        "retargeted compact reseed",
      );
      const reseed = envelope.payload as SyncChangesetBatchPayload;
      expect(reseed.reason).toBe("catchup");
      expect(reseed.toDbVersion).toBe(secondTarget);
      expect(reseed.changes).toHaveLength(2_501);
    } finally {
      peer?.ws.close();
      await host.dispose();
      cleanup();
    }
  });

  it("falls back to bounded incremental replay when the compact replica state exceeds the reseed row cap", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const state = {
      dbVersion: (SYNC_HOST_MOBILE_REPLICA_RESEED_GAP * 2) + 1,
      changes: Array.from({ length: 10_001 }, (_, index) => makeChange(index + 1, index)),
    };
    const logger = createDiscoveryLogger();
    const { host } = createControlledChangesetHost(projectRoot, state, logger);
    let peer: Awaited<ReturnType<typeof connectPeer>> | null = null;
    try {
      const port = await host.waitUntilListening();
      peer = await connectPeer(port, host.getBootstrapToken(), "ios-reseed-too-large", {
        capabilities: ["changesetAck", SYNC_CHUNKED_ENVELOPES_CAPABILITY],
      });
      const batchEnvelope = await waitForValue(
        () => peer?.envelopes.find((envelope) => envelope.type === "changeset_batch"),
        "incremental fallback after oversized reseed",
      );
      const batch = batchEnvelope.payload as SyncChangesetBatchPayload;
      expect(batch.reason).toBe("broadcast");
      expect(batch.fromDbVersion).toBe(0);
      expect(batch.toDbVersion).toBe(250);
      expect(batch.changes).toHaveLength(250);
      expect(logger.info).toHaveBeenCalledWith(
        "sync_host.mobile_replica_reseed_fallback",
        expect.objectContaining({
          peerDeviceId: "ios-reseed-too-large",
          reason: "compacted_state_too_large",
        }),
      );
    } finally {
      peer?.ws.close();
      await host.dispose();
      cleanup();
    }
  });

  it.each([
    {
      name: "a replica at the reseed threshold",
      dbVersion: SYNC_HOST_MOBILE_REPLICA_RESEED_GAP,
      capabilities: ["changesetAck", SYNC_CHUNKED_ENVELOPES_CAPABILITY],
    },
    {
      name: "a legacy replica without chunked envelopes",
      dbVersion: SYNC_HOST_MOBILE_REPLICA_RESEED_GAP + 1,
      capabilities: ["changesetAck"],
    },
  ])("keeps $name on bounded incremental batches", async ({ dbVersion, capabilities }) => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const state = {
      dbVersion,
      changes: Array.from({ length: 600 }, (_, index) => makeChange(index + 1, index)),
    };
    const { host } = createControlledChangesetHost(projectRoot, state);
    let peer: Awaited<ReturnType<typeof connectPeer>> | null = null;
    try {
      const port = await host.waitUntilListening();
      peer = await connectPeer(port, host.getBootstrapToken(), `ios-incremental-${dbVersion}`, {
        capabilities,
      });
      const batchEnvelope = await waitForValue(
        () => peer?.envelopes.find((envelope) => envelope.type === "changeset_batch"),
        "bounded incremental changeset",
      );
      const batch = batchEnvelope.payload as SyncChangesetBatchPayload;
      expect(batch.reason).toBe("broadcast");
      expect(batch.fromDbVersion).toBe(0);
      expect(batch.changes).toHaveLength(250);
      expect(batch.toDbVersion).toBe(250);
    } finally {
      peer?.ws.close();
      await host.dispose();
      cleanup();
    }
  });

  it("processes pending ACK retries before active-chat background deferral", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const host = createAckRetryHost(projectRoot);
    let peer: Awaited<ReturnType<typeof connectPeer>> | null = null;
    let bufferedAmountSpy: { mockRestore(): void } | null = null;
    let dateNowSpy: { mockRestore(): void } | null = null;
    try {
      const port = await host.waitUntilListening();
      peer = await connectPeer(port, host.getBootstrapToken(), "ios-ack-retry", {
        capabilities: ["changesetAck"],
      });

      const firstBatch = await waitForValue(
        () => peer?.envelopes.find((envelope) => envelope.type === "changeset_batch"),
        "initial changeset batch",
      );
      const firstPayload = firstBatch.payload as { batchId: string; toDbVersion: number };

      peer.ws.send(encodeSyncEnvelope({
        type: "chat_subscribe",
        requestId: "chat-subscribe",
        payload: { sessionId: "session-1" },
      }));
      await waitForEnvelope(peer.envelopes, "chat_subscribe", "chat-subscribe");

      bufferedAmountSpy = vi
        .spyOn(WebSocket.prototype, "bufferedAmount", "get")
        .mockReturnValue(SYNC_HOST_CHAT_ACTIVE_BACKGROUND_BACKPRESSURE_BYTES);
      const realDateNow = Date.now.bind(Date);
      dateNowSpy = vi
        .spyOn(Date, "now")
        .mockImplementation(() => realDateNow() + 11_000);

      const resentBatch = await waitForValue(
        () => peer?.envelopes.filter((envelope) =>
          envelope.type === "changeset_batch"
          && (envelope.payload as { batchId?: string }).batchId === firstPayload.batchId
        )[1],
        "resent changeset batch under chat backpressure",
      );
      expect(resentBatch.payload).toMatchObject({
        batchId: firstPayload.batchId,
        toDbVersion: firstPayload.toDbVersion,
      });
    } finally {
      dateNowSpy?.mockRestore();
      bufferedAmountSpy?.mockRestore();
      try {
        peer?.ws.close();
      } catch {
        // ignore
      }
      await host.dispose();
      cleanup();
    }
  });

  it("admits one bounded changeset after the active-chat soft defer ages out", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const state = { dbVersion: 0, changes: [makeChange(1, 0)] };
    const { host, logger } = createControlledChangesetHost(projectRoot, state);
    let peer: Awaited<ReturnType<typeof connectPeer>> | null = null;
    let bufferedAmountSpy: { mockRestore(): void } | null = null;
    let dateNowSpy: { mockRestore(): void } | null = null;
    try {
      const port = await host.waitUntilListening();
      peer = await connectPeer(port, host.getBootstrapToken(), "ios-chat-fairness", {
        capabilities: ["changesetAck"],
      });
      expect(peer.envelopes.find((envelope) => envelope.type === "hello_ok")?.payload).toMatchObject({
        connectionTransport: "direct",
      });
      peer.ws.send(encodeSyncEnvelope({
        type: "chat_subscribe",
        requestId: "chat-fairness-subscribe",
        payload: { sessionId: "session-1" },
      }));
      await waitForEnvelope(peer.envelopes, "chat_subscribe", "chat-fairness-subscribe");

      bufferedAmountSpy = vi
        .spyOn(WebSocket.prototype, "bufferedAmount", "get")
        .mockReturnValue(SYNC_HOST_CHAT_ACTIVE_BACKGROUND_BACKPRESSURE_BYTES);
      const realDateNow = Date.now.bind(Date);
      let clockOffsetMs = 0;
      dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => realDateNow() + clockOffsetMs);
      state.dbVersion = 1;

      await waitForValue(
        () => logger.debug.mock.calls.find(([event]) => event === "sync_host.changeset_priority_deferral_started"),
        "chat changeset deferral transition",
      );
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(peer.envelopes.some((envelope) => envelope.type === "changeset_batch")).toBe(false);

      clockOffsetMs += SYNC_HOST_PRIORITY_MAX_CHANGESET_DEFER_MS + 25;
      const batch = await waitForValue(
        () => peer?.envelopes.find((envelope) => envelope.type === "changeset_batch"),
        "fair changeset admission",
      );
      expect((batch.payload as SyncChangesetBatchPayload).changes).toHaveLength(1);
      expect(logger.debug.mock.calls.filter(([event]) => event === "sync_host.changeset_priority_deferral_started")).toHaveLength(1);
      expect(logger.debug).toHaveBeenCalledWith(
        "sync_host.changeset_priority_deferral_ended",
        expect.objectContaining({ reason: "batch_admitted" }),
      );
    } finally {
      dateNowSpy?.mockRestore();
      bufferedAmountSpy?.mockRestore();
      peer?.ws.close();
      await host.dispose();
      cleanup();
    }
  });

  it("keeps the 4 MiB hard gate even after the fairness deadline", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const state = { dbVersion: 0, changes: [makeChange(1, 0)] };
    const { host, logger } = createControlledChangesetHost(projectRoot, state);
    let peer: Awaited<ReturnType<typeof connectPeer>> | null = null;
    let bufferedAmountSpy: { mockRestore(): void } | null = null;
    let dateNowSpy: { mockRestore(): void } | null = null;
    let bufferedAmount = 4 * 1024 * 1024;
    try {
      const port = await host.waitUntilListening();
      peer = await connectPeer(port, host.getBootstrapToken(), "ios-chat-hard-gate", {
        capabilities: ["changesetAck"],
      });
      peer.ws.send(encodeSyncEnvelope({
        type: "chat_subscribe",
        requestId: "chat-hard-gate-subscribe",
        payload: { sessionId: "session-1" },
      }));
      await waitForEnvelope(peer.envelopes, "chat_subscribe", "chat-hard-gate-subscribe");

      bufferedAmountSpy = vi
        .spyOn(WebSocket.prototype, "bufferedAmount", "get")
        .mockImplementation(() => bufferedAmount);
      const realDateNow = Date.now.bind(Date);
      let clockOffsetMs = SYNC_HOST_PRIORITY_MAX_CHANGESET_DEFER_MS + 5_000;
      dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => realDateNow() + clockOffsetMs);
      state.dbVersion = 1;
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(peer.envelopes.some((envelope) => envelope.type === "changeset_batch")).toBe(false);
      expect(logger.debug.mock.calls.some(([event]) => event === "sync_host.changeset_priority_deferral_started")).toBe(false);

      bufferedAmount = SYNC_HOST_CHAT_ACTIVE_BACKGROUND_BACKPRESSURE_BYTES;
      await waitForValue(
        () => logger.debug.mock.calls.find(([event]) => event === "sync_host.changeset_priority_deferral_started"),
        "soft deferral after hard pressure clears",
      );
      clockOffsetMs += SYNC_HOST_PRIORITY_MAX_CHANGESET_DEFER_MS + 25;
      await waitForValue(
        () => peer?.envelopes.find((envelope) => envelope.type === "changeset_batch"),
        "changeset after hard pressure clears",
      );
    } finally {
      dateNowSpy?.mockRestore();
      bufferedAmountSpy?.mockRestore();
      peer?.ws.close();
      await host.dispose();
      cleanup();
    }
  });

  it("rewindows an exhausted batch without closing or advancing, ignores its late ACK, then resets", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const state = {
      dbVersion: 0,
      changes: Array.from({ length: 600 }, (_, index) => makeChange(index + 1, index)),
    };
    const { host, logger } = createControlledChangesetHost(projectRoot, state);
    let peer: Awaited<ReturnType<typeof connectPeer>> | null = null;
    let dateNowSpy: { mockRestore(): void } | null = null;
    try {
      const port = await host.waitUntilListening();
      peer = await connectPeer(port, host.getBootstrapToken(), "ios-ack-recovery", {
        capabilities: ["changesetAck"],
      });
      const realDateNow = Date.now.bind(Date);
      let clockOffsetMs = 0;
      dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => realDateNow() + clockOffsetMs);
      state.dbVersion = 600;

      const firstBatch = await waitForValue(
        () => peer?.envelopes.find((envelope) => envelope.type === "changeset_batch"),
        "initial recovery batch",
      );
      const firstPayload = firstBatch.payload as SyncChangesetBatchPayload;
      expect(firstPayload.fromDbVersion).toBe(0);
      expect(firstPayload.changes).toHaveLength(250);

      for (let attemptCount = 2; attemptCount <= 6; attemptCount += 1) {
        clockOffsetMs += 11_000;
        await waitForValue(
          () => peer?.envelopes.filter((envelope) =>
            envelope.type === "changeset_batch"
            && (envelope.payload as SyncChangesetBatchPayload).batchId === firstPayload.batchId
          )[attemptCount - 1],
          `changeset send attempt ${attemptCount}`,
        );
      }
      clockOffsetMs += 11_000;
      await waitForValue(
        () => logger.warn.mock.calls.find(([event]) => event === "sync_host.changeset_recovery_started"),
        "host changeset recovery",
      );
      expect(peer.ws.readyState).toBe(WebSocket.OPEN);
      expect(peer.closeEvents).toEqual([]);

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(peer.envelopes.filter((envelope) =>
        envelope.type === "changeset_batch"
        && (envelope.payload as SyncChangesetBatchPayload).batchId !== firstPayload.batchId
      )).toHaveLength(0);

      clockOffsetMs += 500;
      const recoveredBatch = await waitForValue(
        () => peer?.envelopes.find((envelope) =>
          envelope.type === "changeset_batch"
          && (envelope.payload as SyncChangesetBatchPayload).batchId !== firstPayload.batchId),
        "rewindowed changeset batch",
      );
      const recoveredPayload = recoveredBatch.payload as SyncChangesetBatchPayload;
      expect(recoveredPayload.batchId).not.toBe(firstPayload.batchId);
      expect(recoveredPayload.fromDbVersion).toBe(0);
      expect(recoveredPayload.changes).toHaveLength(125);

      peer.ws.send(encodeSyncEnvelope({
        type: "changeset_ack",
        requestId: firstPayload.batchId,
        payload: {
          batchId: firstPayload.batchId,
          fromDbVersion: firstPayload.fromDbVersion,
          toDbVersion: firstPayload.toDbVersion,
          appliedDbVersion: firstPayload.toDbVersion,
          appliedCount: firstPayload.changes.length,
          ok: true,
        } satisfies SyncChangesetAckPayload,
      }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(peer.envelopes.filter((envelope) => envelope.type === "changeset_batch")).toHaveLength(7);

      peer.ws.send(encodeSyncEnvelope({
        type: "changeset_ack",
        requestId: recoveredPayload.batchId,
        payload: {
          batchId: recoveredPayload.batchId,
          fromDbVersion: recoveredPayload.fromDbVersion,
          toDbVersion: recoveredPayload.toDbVersion,
          appliedDbVersion: recoveredPayload.toDbVersion,
          appliedCount: recoveredPayload.changes.length,
          ok: true,
        } satisfies SyncChangesetAckPayload,
      }));
      const resetBatch = await waitForValue(
        () => peer?.envelopes.find((envelope) =>
          envelope.type === "changeset_batch"
          && ![firstPayload.batchId, recoveredPayload.batchId]
            .includes((envelope.payload as SyncChangesetBatchPayload).batchId)),
        "normal-window batch after recovery ACK",
      );
      const resetPayload = resetBatch.payload as SyncChangesetBatchPayload;
      expect(resetPayload.fromDbVersion).toBe(recoveredPayload.toDbVersion);
      expect(resetPayload.changes).toHaveLength(250);
      expect(logger.debug).toHaveBeenCalledWith(
        "sync_host.changeset_recovery_reset",
        expect.objectContaining({ previousRecoveryLevel: 1 }),
      );
    } finally {
      dateNowSpy?.mockRestore();
      peer?.ws.close();
      await host.dispose();
      cleanup();
    }
  }, 15_000);
});

describe("mobile command result ledger", () => {
  beforeEach(() => {
    publishMock.mockReset();
    spawnMock.mockReset();
    bonjourDestroyMock.mockReset();
    bonjourConstructorMock.mockReset();
    spawnMock.mockImplementation(() => ({ kill: vi.fn(), once: vi.fn(), unref: vi.fn() }));
  });

  it("persists chat.send results so restart replays do not duplicate messages", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const sendMessage = vi.fn(async () => {});
    let firstHost: ReturnType<typeof createSyncHostService> | null = null;
    let secondHost: ReturnType<typeof createSyncHostService> | null = null;
    let firstClient: Awaited<ReturnType<typeof connectPeer>> | null = null;
    let secondClient: Awaited<ReturnType<typeof connectPeer>> | null = null;
    const commandId = "cmd-chat-send-1";

    const makeHost = () => {
      const base = createHostArgs(projectRoot, []);
      return createSyncHostService({
        ...base,
        projectId: "project-1",
        deviceRegistryService: {
          ...base.deviceRegistryService,
          upsertPeerMetadata: vi.fn(),
        },
        agentChatService: {
          sendMessage,
          subscribeToEvents: vi.fn(() => vi.fn()),
        },
      } as unknown as Parameters<typeof createSyncHostService>[0]);
    };
    const sendChatCommand = (client: Awaited<ReturnType<typeof connectPeer>>, requestId: string): void => {
      client.ws.send(encodeSyncEnvelope({
        type: "command",
        requestId,
        projectId: "project-1",
        payload: {
          commandId,
          action: "chat.send",
          projectId: "project-1",
          args: {
            sessionId: "session-1",
            text: "hello from iOS",
          },
        },
      }));
    };

    try {
      firstHost = makeHost();
      const firstPort = await firstHost.waitUntilListening();
      const token = firstHost.getBootstrapToken();
      firstClient = await connectPeer(firstPort, token, "ios-chat-1");
      sendChatCommand(firstClient, "send-1");
      await waitForEnvelope(firstClient.envelopes, "command_ack", "send-1");
      const firstResult = await waitForEnvelope(firstClient.envelopes, "command_result", "send-1");
      expect(firstResult.payload).toMatchObject({
        commandId,
        ok: true,
        result: { ok: true },
      });
      expect(sendMessage).toHaveBeenCalledTimes(1);

      firstClient.ws.close();
      await firstHost.dispose();
      firstHost = null;

      secondHost = makeHost();
      const secondPort = await secondHost.waitUntilListening();
      secondClient = await connectPeer(secondPort, token, "ios-chat-1");
      sendChatCommand(secondClient, "send-2");
      await waitForEnvelope(secondClient.envelopes, "command_ack", "send-2");
      const replayResult = await waitForEnvelope(secondClient.envelopes, "command_result", "send-2");
      expect(replayResult.payload).toMatchObject({
        commandId,
        ok: true,
        result: { ok: true },
      });
      expect(sendMessage).toHaveBeenCalledTimes(1);
    } finally {
      try {
        firstClient?.ws.close();
        secondClient?.ws.close();
      } catch {
        // ignore
      }
      await firstHost?.dispose();
      await secondHost?.dispose();
      cleanup();
    }
  });
});

describe("paired-client product analytics consent", () => {
  beforeEach(() => {
    publishMock.mockReset();
    spawnMock.mockReset();
    bonjourDestroyMock.mockReset();
    bonjourConstructorMock.mockReset();
    spawnMock.mockImplementation(() => ({ kill: vi.fn(), once: vi.fn(), unref: vi.fn() }));
  });

  it("binds analytics identity to the peer and permanently suppresses opted-out usage rows from export", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const base = createHostArgs(projectRoot, []);
    const dbRun = vi.fn();
    const execute = vi.fn(async (payload: { action: string; args?: Record<string, unknown> }) => {
      if (payload.action === "analytics.capture") return { accepted: true, reason: "accepted" };
      if (payload.action === "analytics.getStatus") return { configured: true, effective: true };
      if (payload.action === "analytics.setClientEnabled") return { configured: true, effective: true };
      return { ok: true };
    });
    const analyticsDescriptor = (action: string): SyncRemoteCommandDescriptor => ({
      action: action as SyncRemoteCommandDescriptor["action"],
      scope: "runtime",
      policy: { viewerAllowed: true },
    });
    const descriptors: SyncRemoteCommandDescriptor[] = [
      analyticsDescriptor("analytics.capture"),
      analyticsDescriptor("analytics.getStatus"),
      analyticsDescriptor("analytics.setClientEnabled"),
      {
        action: "lanes.create",
        scope: "project",
        policy: { viewerAllowed: true, queueable: true },
      },
    ];
    const remoteCommandService = {
      execute,
      getDescriptor: (action: string) => descriptors.find((descriptor) => descriptor.action === action) ?? null,
      getDescriptors: () => descriptors,
      getSupportedActions: () => descriptors.map((descriptor) => descriptor.action),
    };
    const host = createSyncHostService({
      ...base,
      projectId: "project-1",
      db: {
        ...base.db,
        run: dbRun,
      },
      discoveryEnabled: false,
      remoteCommandService,
      deviceRegistryService: {
        ...base.deviceRegistryService,
        upsertPeerMetadata: vi.fn(),
      },
      productAnalyticsService: {
        getStatus: () => ({ effective: true }),
      },
    } as unknown as Parameters<typeof createSyncHostService>[0]);
    let peer: Awaited<ReturnType<typeof connectPeer>> | null = null;

    const sendCommand = async (
      action: SyncRemoteCommandDescriptor["action"],
      args: Record<string, unknown>,
      requestId: string,
      requestedProjectId = "project-1",
    ): Promise<ParsedSyncEnvelope> => {
      peer!.ws.send(encodeSyncEnvelope({
        type: "command",
        requestId,
        projectId: requestedProjectId,
        payload: {
          commandId: requestId,
          action,
          projectId: requestedProjectId,
          args,
        },
      }));
      await waitForEnvelope(peer!.envelopes, "command_ack", requestId);
      return waitForEnvelope(peer!.envelopes, "command_result", requestId);
    };

    try {
      const port = await host.waitUntilListening();
      peer = await connectPeer(port, host.getBootstrapToken(), "browser-analytics", {
        platform: "macOS",
        deviceType: "browser",
      });

      const preConsentCapture = await sendCommand("analytics.capture", {
        event: "ade_project_opened",
        surface: "desktop",
        projectId: "client-spoofed-project",
        properties: { source: "navigation" },
      }, "analytics-before-consent");
      expect(preConsentCapture.payload).toMatchObject({
        ok: true,
        result: { accepted: false, reason: "disabled" },
      });
      expect(execute).not.toHaveBeenCalled();

      await expect(sendCommand("lanes.create", { name: "reconnect-race" }, "mutation-before-consent"))
        .resolves.toMatchObject({ payload: { ok: true, result: { ok: true } } });
      const preConsentUsageInsert = dbRun.mock.calls.find(([sql]) => String(sql).includes("insert into usage_events"));
      expect(preConsentUsageInsert?.[1]).toEqual([
        expect.any(String),
        "project-1",
        "web",
        "lanes.create",
        "lanes",
        null,
        expect.any(String),
        "suppressed:analytics_inactive",
      ]);

      await expect(sendCommand("analytics.setClientEnabled", { enabled: true }, "analytics-initial-consent"))
        .resolves.toMatchObject({ payload: { ok: true } });
      execute.mockClear();
      dbRun.mockClear();

      const canonicalCapture = await sendCommand("analytics.capture", {
        event: "ade_project_opened",
        surface: "desktop",
        projectId: "client-spoofed-project",
        dedupeKey: "client-controlled-dedupe",
        properties: { source: "navigation" },
      }, "analytics-canonical");
      expect(canonicalCapture.payload).toMatchObject({
        ok: true,
        result: { accepted: true, reason: "accepted" },
      });
      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "analytics.capture",
          projectId: "project-1",
          args: expect.objectContaining({
            event: "ade_project_opened",
            surface: "web",
            projectId: "project-1",
            dedupeKey: "web_project_opened:project-1",
          }),
        }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );

      execute.mockClear();
      const foreignProjectCapture = await sendCommand("analytics.capture", {
        event: "ade_screen_viewed",
        surface: "desktop",
        projectId: "client-spoofed-project",
        properties: { screen: "work" },
      }, "analytics-foreign-project", "forged-project-id");
      expect(foreignProjectCapture.payload).toMatchObject({
        ok: false,
        error: {
          code: "project_not_open",
          message: expect.stringContaining("hosting a different project"),
        },
      });
      expect(execute).not.toHaveBeenCalled();

      await expect(sendCommand("analytics.setClientEnabled", { enabled: false }, "analytics-disable"))
        .resolves.toMatchObject({ payload: { ok: true } });
      execute.mockClear();
      dbRun.mockClear();

      const disabledCapture = await sendCommand("analytics.capture", {
        event: "ade_feature_used",
        surface: "desktop",
        projectId: "client-spoofed-project",
        properties: { feature: "lanes", action: "lanes.create", outcome: "success" },
      }, "analytics-disabled-capture");
      expect(disabledCapture.payload).toMatchObject({
        ok: true,
        result: { accepted: false, reason: "disabled" },
      });
      expect(execute).not.toHaveBeenCalled();

      await expect(sendCommand("lanes.create", { name: "private-lane" }, "mutation-while-disabled"))
        .resolves.toMatchObject({ payload: { ok: true, result: { ok: true } } });
      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({ action: "lanes.create" }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      const suppressedUsageInsert = dbRun.mock.calls.find(([sql]) => String(sql).includes("insert into usage_events"));
      expect(suppressedUsageInsert?.[1]).toEqual([
        expect.any(String),
        "project-1",
        "web",
        "lanes.create",
        "lanes",
        null,
        expect.any(String),
        "suppressed:analytics_inactive",
      ]);

      await expect(sendCommand("analytics.setClientEnabled", { enabled: true }, "analytics-enable"))
        .resolves.toMatchObject({ payload: { ok: true } });
      dbRun.mockClear();

      await expect(sendCommand("lanes.create", { name: "tracked-lane" }, "mutation-after-enable"))
        .resolves.toMatchObject({ payload: { ok: true, result: { ok: true } } });
      const usageInsert = dbRun.mock.calls.find(([sql]) => String(sql).includes("insert into usage_events"));
      expect(usageInsert?.[1]).toEqual([
        expect.any(String),
        "project-1",
        "web",
        "lanes.create",
        "lanes",
        null,
        expect.any(String),
        null,
      ]);

      const malformedConsent = await sendCommand(
        "analytics.setClientEnabled",
        { enabled: "false" },
        "analytics-malformed-consent",
      );
      expect(malformedConsent.payload).toMatchObject({
        ok: false,
        error: {
          code: "command_failed",
          message: "analytics.setClientEnabled requires a boolean enabled value.",
        },
      });
    } finally {
      try {
        peer?.ws.close();
      } catch {
        // ignore
      }
      await host.dispose();
      cleanup();
    }
  });
});

describe("inbound changeset_batch guards", () => {
  beforeEach(() => {
    publishMock.mockReset();
    spawnMock.mockReset();
    bonjourDestroyMock.mockReset();
    bonjourConstructorMock.mockReset();
    spawnMock.mockImplementation(() => ({ kill: vi.fn(), once: vi.fn(), unref: vi.fn() }));
  });

  function makePeerChange(table: string, dbVersion: number, seq: number, val = `value-${seq}`): CrsqlChangeRow {
    return {
      table,
      pk: `${table}-pk-${seq}`,
      cid: "value",
      val,
      col_version: dbVersion,
      db_version: dbVersion,
      site_id: "peer-site-1",
      cl: 1,
      seq,
    };
  }

  function createGuardHost(projectRoot: string, applyChanges: ReturnType<typeof vi.fn>) {
    const base = createHostArgs(projectRoot, []);
    return createSyncHostService({
      ...base,
      projectId: "project-1",
      db: {
        sync: {
          getSiteId: () => "site-host-guard",
          getDbVersion: () => 0,
          exportChangesSince: () => [],
          applyChanges,
          discardUnpublishedChangesForTables: () => {},
        },
      },
      deviceRegistryService: {
        ...base.deviceRegistryService,
        upsertPeerMetadata: vi.fn(),
      },
    } as unknown as Parameters<typeof createSyncHostService>[0]);
  }

  it("rejects an oversized inbound batch with changeset_too_large and does not apply it (M6)", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const applyChanges = vi.fn(() => ({ appliedCount: 0 }));
    const host = createGuardHost(projectRoot, applyChanges);
    let peer: Awaited<ReturnType<typeof connectPeer>> | null = null;
    try {
      const port = await host.waitUntilListening();
      peer = await connectPeer(port, host.getBootstrapToken(), "ios-oversized");

      // 10_001 rows is one past MAX_INBOUND_CHANGESET_ROWS (250 * 40).
      const tooMany = Array.from({ length: 10_001 }, (_, seq) => makePeerChange("kv", 1, seq));
      const requestId = "batch-too-large";
      peer.ws.send(encodeSyncEnvelope({
        type: "changeset_batch",
        requestId,
        payload: { batchId: requestId, fromDbVersion: 0, toDbVersion: 1, changes: tooMany },
      }));

      const ack = await waitForEnvelope(peer.envelopes, "changeset_ack", requestId);
      const ackPayload = ack.payload as { ok?: boolean; appliedCount?: number; error?: { code?: string } };
      expect(ackPayload.ok).toBe(false);
      expect(ackPayload.error?.code).toBe("changeset_too_large");
      expect(ackPayload.appliedCount).toBe(0);
      expect(applyChanges).not.toHaveBeenCalled();
    } finally {
      try {
        peer?.ws.close();
      } catch {
        // ignore
      }
      await host.dispose();
      cleanup();
    }
  });

  it("applies an at/under-cap inbound batch (M6)", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const applyChanges = vi.fn((changes: CrsqlChangeRow[]) => ({ appliedCount: changes.length }));
    const host = createGuardHost(projectRoot, applyChanges);
    let peer: Awaited<ReturnType<typeof connectPeer>> | null = null;
    try {
      const port = await host.waitUntilListening();
      peer = await connectPeer(port, host.getBootstrapToken(), "ios-undercap");

      const okBatch = Array.from({ length: 5 }, (_, seq) => makePeerChange("kv", 1, seq));
      const requestId = "batch-under-cap";
      peer.ws.send(encodeSyncEnvelope({
        type: "changeset_batch",
        requestId,
        payload: { batchId: requestId, fromDbVersion: 0, toDbVersion: 1, changes: okBatch },
      }));

      const ack = await waitForEnvelope(peer.envelopes, "changeset_ack", requestId);
      const ackPayload = ack.payload as { ok?: boolean; appliedCount?: number };
      expect(ackPayload.ok).toBe(true);
      expect(ackPayload.appliedCount).toBe(5);
      expect(applyChanges).toHaveBeenCalledTimes(1);
      expect(applyChanges.mock.calls[0]?.[0]).toHaveLength(5);
    } finally {
      try {
        peer?.ws.close();
      } catch {
        // ignore
      }
      await host.dispose();
      cleanup();
    }
  });

  it("strips a peer's sync_cluster_state row so brain ownership cannot be seized (M7)", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const applyChanges = vi.fn((changes: CrsqlChangeRow[]) => ({ appliedCount: changes.length }));
    const host = createGuardHost(projectRoot, applyChanges);
    let peer: Awaited<ReturnType<typeof connectPeer>> | null = null;
    try {
      const port = await host.waitUntilListening();
      peer = await connectPeer(port, host.getBootstrapToken(), "ios-seizer");

      // The peer tries to author a winning sync_cluster_state row that would
      // flip brain_device_id to itself, alongside a benign kv row.
      const brainSeizure = makePeerChange("sync_cluster_state", 1, 0, "ios-seizer-device");
      brainSeizure.cid = "brain_device_id";
      brainSeizure.pk = "default-cluster";
      const benign = makePeerChange("kv", 2, 1);
      const requestId = "batch-seizure";
      peer.ws.send(encodeSyncEnvelope({
        type: "changeset_batch",
        requestId,
        payload: { batchId: requestId, fromDbVersion: 0, toDbVersion: 2, changes: [brainSeizure, benign] },
      }));

      const ack = await waitForEnvelope(peer.envelopes, "changeset_ack", requestId);
      const ackPayload = ack.payload as { ok?: boolean; appliedCount?: number };
      expect(ackPayload.ok).toBe(true);
      // Only the benign kv row reaches applyChanges; the brain row is filtered out.
      expect(applyChanges).toHaveBeenCalledTimes(1);
      const appliedRows = applyChanges.mock.calls[0]?.[0] as CrsqlChangeRow[];
      expect(appliedRows).toHaveLength(1);
      expect(appliedRows.every((row) => row.table !== "sync_cluster_state")).toBe(true);
      expect(ackPayload.appliedCount).toBe(1);
    } finally {
      try {
        peer?.ws.close();
      } catch {
        // ignore
      }
      await host.dispose();
      cleanup();
    }
  });
});

describe("sync host handoff over a shared listener", () => {
  beforeEach(() => {
    publishMock.mockReset();
    spawnMock.mockReset();
    bonjourDestroyMock.mockReset();
    bonjourConstructorMock.mockReset();
    spawnMock.mockImplementation(() => ({ kill: vi.fn(), once: vi.fn(), unref: vi.fn() }));
  });

  function makeHostChange(dbVersion: number, seq: number): CrsqlChangeRow {
    return {
      table: "kv",
      pk: `key-${seq}`,
      cid: "value",
      val: `value-${seq}`,
      col_version: dbVersion,
      db_version: dbVersion,
      site_id: "site-host-origin",
      cl: 1,
      seq,
    };
  }

  it("carries terminal input receipts across host handoff so a lost ACK retry cannot rewrite", async () => {
    const rootA = createTempProjectRoot();
    const rootB = createTempProjectRoot();
    const tokenPath = path.join(rootA.projectRoot, "shared-terminal-bootstrap-token");
    const listener = createSharedSyncListener({ bindHost: "127.0.0.1" });
    const writeBySessionId = vi.fn().mockReturnValue(true);
    const makeTerminalArgs = (projectRoot: string, sessionAvailable: boolean) => {
      const base = createHandoffHostArgs(projectRoot, tokenPath, {
        siteId: `site-${path.basename(projectRoot)}`,
        dbVersion: 0,
        changes: [],
      });
      const transcriptPath = path.join(projectRoot, "terminal.log");
      fs.writeFileSync(transcriptPath, "", "utf8");
      const session = {
        id: "session-1",
        laneId: "lane-1",
        transcriptPath,
        status: "running",
        runtimeState: "running",
      };
      return {
        ...base,
        projectId: "project-1",
        sharedListener: listener,
        sessionService: {
          list: () => sessionAvailable ? [session] : [],
          get: (id: string) => sessionAvailable && id === session.id ? session : null,
          readTranscriptTail: async () => "",
        },
        ptyService: {
          create: vi.fn(),
          readTranscriptTail: vi.fn(async () => ""),
          readTranscriptSnapshot: vi.fn(async () => ({ data: "", startOffset: 0, endOffset: 0 })),
          readTranscriptRange: vi.fn(async () => null),
          getTranscriptWindow: vi.fn(() => ({ startOffset: 0, endOffset: 0, retainedBytes: 0 })),
          writeBySessionId,
          resizeBySessionId: vi.fn().mockReturnValue(true),
          restoreDesktopSizeBySessionId: vi.fn().mockReturnValue(true),
          hasLivePty: vi.fn().mockReturnValue(sessionAvailable),
          enrichSessions: (rows: unknown[]) => rows,
        },
      };
    };
    let client: WebSocket | null = null;
    let hostB: ReturnType<typeof createSyncHostService> | null = null;
    try {
      const port = await listener.ensureListening([0]);
      const hostA = createSyncHostService(
        makeTerminalArgs(rootA.projectRoot, true) as unknown as Parameters<typeof createSyncHostService>[0],
      );
      await hostA.waitUntilListening();
      client = new WebSocket(`ws://127.0.0.1:${port}`);
      const { envelopes } = trackClientEnvelopes(client);
      await new Promise<void>((resolve, reject) => {
        client!.once("open", resolve);
        client!.once("error", reject);
      });
      sendHello(client, hostA.getBootstrapToken());
      await waitForValue(() => envelopes.find((entry) => entry.type === "hello_ok"), "terminal handoff hello");
      client.send(encodeSyncEnvelope({
        type: "terminal_subscribe",
        requestId: "handoff-subscribe",
        projectId: "project-1",
        payload: { sessionId: "session-1" },
      }));
      await waitForEnvelope(envelopes, "terminal_snapshot", "handoff-subscribe");
      const inputPayload = { sessionId: "session-1", inputId: "handoff-input", data: "x" };
      client.send(encodeSyncEnvelope({
        type: "terminal_input",
        requestId: "handoff-input-first",
        projectId: "project-1",
        payload: inputPayload,
      }));
      await expect(waitForEnvelope(
        envelopes,
        "terminal_input_ack",
        "handoff-input-first",
      )).resolves.toMatchObject({ payload: { ok: true, duplicate: false } });
      expect(writeBySessionId).toHaveBeenCalledTimes(1);

      await hostA.dispose();
      hostB = createSyncHostService(
        makeTerminalArgs(rootB.projectRoot, false) as unknown as Parameters<typeof createSyncHostService>[0],
      );
      await hostB.waitUntilListening();
      client.send(encodeSyncEnvelope({
        type: "terminal_input",
        requestId: "handoff-input-retry",
        projectId: "project-1",
        payload: inputPayload,
      }));
      await expect(waitForEnvelope(
        envelopes,
        "terminal_input_ack",
        "handoff-input-retry",
      )).resolves.toMatchObject({ payload: { ok: true, duplicate: true } });
      expect(writeBySessionId).toHaveBeenCalledTimes(1);
    } finally {
      try { client?.close(); } catch { /* ignore */ }
      await hostB?.dispose();
      await listener.close();
      rootA.cleanup();
      rootB.cleanup();
    }
  });

  it("keeps an authenticated peer connected across a host service swap and streams the new host's changesets", async () => {
    const rootA = createTempProjectRoot();
    const rootB = createTempProjectRoot();
    const tokenPath = path.join(rootA.projectRoot, "shared-bootstrap-token");
    const listener = createSharedSyncListener({ bindHost: "127.0.0.1" });
    const capture = vi.fn(() => ({ accepted: true, reason: "accepted" as const }));
    const productAnalyticsService = {
      capture,
      getStatus: () => ({ configured: true, enabled: true, effective: true }),
      flush: vi.fn(async () => true),
    };
    let client: WebSocket | null = null;
    let hostB: ReturnType<typeof createSyncHostService> | null = null;
    try {
      const port = await listener.ensureListening([0]);
      const hostA = createSyncHostService({
        ...createHandoffHostArgs(rootA.projectRoot, tokenPath, {
          siteId: "site-a",
          dbVersion: 0,
          changes: [],
        }),
        sharedListener: listener,
        productAnalyticsService,
      } as unknown as Parameters<typeof createSyncHostService>[0]);
      expect(await hostA.waitUntilListening()).toBe(port);

      client = new WebSocket(`ws://127.0.0.1:${port}`);
      const { envelopes, closeEvents } = trackClientEnvelopes(client);
      await new Promise<void>((resolve, reject) => {
        client!.once("open", () => resolve());
        client!.once("error", reject);
      });
      sendHello(client, hostA.getBootstrapToken());
      await waitForValue(
        () => envelopes.find((envelope) => envelope.type === "hello_ok"),
        "hello_ok from host A",
      );
      expect(hostA.getPeerStates()).toHaveLength(1);
      client.send(encodeSyncEnvelope({
        type: "command",
        requestId: "analytics-consent-before-handoff",
        projectId: null,
        payload: {
          commandId: "analytics-consent-before-handoff",
          action: "analytics.setClientEnabled",
          projectId: null,
          args: { enabled: true },
        },
      }));
      await waitForEnvelope(envelopes, "command_result", "analytics-consent-before-handoff");

      // Project switch: host A dies, host B (a different project DB) takes
      // over the shared listener and must adopt the live socket.
      await hostA.dispose();
      const envelopeCountAfterDispose = envelopes.length;
      hostB = createSyncHostService({
        ...createHandoffHostArgs(rootB.projectRoot, tokenPath, {
          siteId: "site-b",
          dbVersion: 2,
          changes: [makeHostChange(1, 0), makeHostChange(2, 1)],
        }),
        sharedListener: listener,
        productAnalyticsService,
      } as unknown as Parameters<typeof createSyncHostService>[0]);
      expect(await hostB.waitUntilListening()).toBe(port);

      const changesetBatch = await waitForValue(
        () => envelopes.slice(envelopeCountAfterDispose).find((envelope) => envelope.type === "changeset_batch"),
        "changeset_batch from host B",
      );
      const payload = changesetBatch.payload as { changes?: CrsqlChangeRow[] };
      expect(payload.changes).toHaveLength(2);
      expect(payload.changes?.every((change) => change.site_id === "site-host-origin")).toBe(true);
      // The adopting host re-announces context so the phone notices the
      // hosted project changed without re-helloing.
      expect(envelopes.slice(envelopeCountAfterDispose).some((envelope) => envelope.type === "brain_status")).toBe(true);
      expect(envelopes.slice(envelopeCountAfterDispose).some((envelope) => envelope.type === "project_catalog")).toBe(true);
      // The whole point: the socket never closed during the swap.
      expect(closeEvents).toEqual([]);
      expect(client.readyState).toBe(WebSocket.OPEN);
      const adoptedPeer = hostB.getPeerStates();
      expect(adoptedPeer).toHaveLength(1);
      expect(adoptedPeer[0]?.deviceId).toBe("ios-device-1");

      client.send(encodeSyncEnvelope({
        type: "command",
        requestId: "analytics-capture-after-handoff",
        projectId: null,
        payload: {
          commandId: "analytics-capture-after-handoff",
          action: "analytics.capture",
          projectId: null,
          args: {
            event: "ade_screen_viewed",
            surface: "desktop",
            properties: { screen: "work" },
          },
        },
      }));
      await expect(waitForEnvelope(
        envelopes,
        "command_result",
        "analytics-capture-after-handoff",
      )).resolves.toMatchObject({
        payload: { ok: true, result: { accepted: true, reason: "accepted" } },
      });
      expect(capture).toHaveBeenCalledWith(expect.objectContaining({
        event: "ade_screen_viewed",
        surface: "mobile",
      }));
    } finally {
      try {
        client?.close();
      } catch {
        // ignore
      }
      await hostB?.dispose();
      await listener.close();
      rootA.cleanup();
      rootB.cleanup();
    }
  });

  it("preserves an invalidation browser's cursor across a same-database handoff", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const tokenPath = path.join(projectRoot, "shared-browser-bootstrap-token");
    const listener = createSharedSyncListener({ bindHost: "127.0.0.1" });
    const db = {
      siteId: "site-shared-browser-db",
      dbVersion: 1,
      changes: [makeHostChange(1, 0)],
    };
    let browser: Awaited<ReturnType<typeof connectPeer>> | null = null;
    let hostA: ReturnType<typeof createSyncHostService> | null = null;
    let hostB: ReturnType<typeof createSyncHostService> | null = null;

    try {
      const port = await listener.ensureListening([0]);
      hostA = createSyncHostService({
        ...createHandoffHostArgs(projectRoot, tokenPath, db),
        sharedListener: listener,
        pollIntervalMs: 25,
      } as unknown as Parameters<typeof createSyncHostService>[0]);
      await hostA.waitUntilListening();
      browser = await connectPeer(port, hostA.getBootstrapToken(), "browser-handoff-peer", {
        platform: "macOS",
        deviceType: "browser",
        capabilities: [
          SYNC_INVALIDATION_ONLY_V1_CAPABILITY,
          SYNC_COMPACT_INVALIDATION_V1_CAPABILITY,
        ],
      });

      expect(hostA.getPeerStates()).toEqual([
        expect.objectContaining({
          deviceId: "browser-handoff-peer",
          syncLag: 0,
        }),
      ]);
      expect(browser.envelopes.some((envelope) =>
        envelope.type === "changeset_batch" || envelope.type === "invalidation_batch"
      )).toBe(false);

      await hostA.dispose();
      hostA = null;
      const envelopeCountAfterDeposit = browser.envelopes.length;

      // This write lands after the old owner deposits the live socket but
      // before the new owner adopts it. The deposited cursor is the only safe
      // boundary for a same-DB invalidation-only browser.
      db.dbVersion = 2;
      db.changes.push(makeHostChange(2, 1));
      hostB = createSyncHostService({
        ...createHandoffHostArgs(projectRoot, tokenPath, db),
        sharedListener: listener,
        pollIntervalMs: 25,
      } as unknown as Parameters<typeof createSyncHostService>[0]);
      await hostB.waitUntilListening();

      const postHandoffBatch = await waitForValue(
        () => browser?.envelopes
          .slice(envelopeCountAfterDeposit)
          .find((envelope) => envelope.type === "invalidation_batch"),
        "same-DB post-handoff browser invalidation",
      );
      expect(postHandoffBatch.payload as SyncInvalidationBatchPayload).toEqual({
        fromDbVersion: 1,
        toDbVersion: 2,
        tables: ["kv"],
        fullRefresh: false,
      });
      expect(browser.closeEvents).toEqual([]);
      expect(browser.ws.readyState).toBe(WebSocket.OPEN);
      expect(hostB.getPeerStates()).toEqual([
        expect.objectContaining({
          deviceId: "browser-handoff-peer",
        }),
      ]);
    } finally {
      browser?.ws.close();
      await hostA?.dispose();
      await hostB?.dispose();
      await listener.close();
      cleanup();
    }
  });

  it("keeps personal and project chat subscriptions across handoff without restoring foreign quick looks", async () => {
    const rootA = createTempProjectRoot();
    const rootB = createTempProjectRoot();
    const tokenPath = path.join(rootA.projectRoot, "shared-bootstrap-token");
    const listener = createSharedSyncListener({ bindHost: "127.0.0.1" });
    const personalTranscriptPath = path.join(rootA.projectRoot, "personal.chat.jsonl");
    const projectTranscriptPath = path.join(rootA.projectRoot, "project.chat.jsonl");
    const foreignTranscriptPath = path.join(rootA.projectRoot, "foreign.chat.jsonl");
    const collidingLocalTranscriptPath = path.join(rootB.projectRoot, "foreign.chat.jsonl");
    for (const transcriptPath of [
      personalTranscriptPath,
      projectTranscriptPath,
      foreignTranscriptPath,
      collidingLocalTranscriptPath,
    ]) {
      fs.writeFileSync(transcriptPath, "", "utf8");
    }
    const personalChatScope = {
      call: vi.fn(),
      streamEvents: vi.fn(),
      transcriptPath: vi.fn(async (sessionId: string) =>
        sessionId === "personal-chat" ? personalTranscriptPath : null
      ),
      isTurnActive: vi.fn(async () => false),
    };
    let client: WebSocket | null = null;
    let hostA: ReturnType<typeof createSyncHostService> | null = null;
    let hostB: ReturnType<typeof createSyncHostService> | null = null;
    try {
      const port = await listener.ensureListening([0]);
      const hostAArgs = createHandoffHostArgs(rootA.projectRoot, tokenPath, {
        siteId: "site-a",
        dbVersion: 0,
        changes: [],
      });
      hostA = createSyncHostService({
        ...hostAArgs,
        projectId: "project-a",
        pollIntervalMs: 100,
        sharedListener: listener,
        personalChatScope,
        sessionService: {
          ...hostAArgs.sessionService,
          get: (sessionId: string) => sessionId === "project-chat"
            ? { id: sessionId, transcriptPath: projectTranscriptPath }
            : null,
        },
        foreignChatProvider: {
          resolveTranscriptPath: ({ projectId, sessionId }: { projectId?: string | null; sessionId: string }) =>
            projectId === "foreign-project" && sessionId === "foreign-chat"
              ? foreignTranscriptPath
              : null,
        },
      } as unknown as Parameters<typeof createSyncHostService>[0]);
      await hostA.waitUntilListening();

      client = new WebSocket(`ws://127.0.0.1:${port}`);
      const { envelopes, closeEvents } = trackClientEnvelopes(client);
      await new Promise<void>((resolve, reject) => {
        client!.once("open", () => resolve());
        client!.once("error", reject);
      });
      sendHello(client, hostA.getBootstrapToken());
      await waitForValue(
        () => envelopes.find((envelope) => envelope.type === "hello_ok"),
        "hello_ok from host A",
      );

      client.send(encodeSyncEnvelope({
        type: "chat_subscribe",
        requestId: "personal-subscribe",
        payload: { sessionId: "personal-chat", chatScope: "personal" },
      }));
      client.send(encodeSyncEnvelope({
        type: "chat_subscribe",
        requestId: "project-subscribe",
        payload: { sessionId: "project-chat" },
      }));
      client.send(encodeSyncEnvelope({
        type: "chat_subscribe",
        requestId: "foreign-subscribe",
        payload: { sessionId: "foreign-chat", projectId: "foreign-project" },
      }));
      await Promise.all([
        waitForEnvelope(envelopes, "chat_subscribe", "personal-subscribe"),
        waitForEnvelope(envelopes, "chat_subscribe", "project-subscribe"),
        waitForEnvelope(envelopes, "chat_subscribe", "foreign-subscribe"),
      ]);

      const beforeHandoffEvent: AgentChatEventEnvelope = {
        sessionId: "personal-chat",
        timestamp: "2026-07-09T11:59:00.000Z",
        sequence: 40,
        event: { type: "text", text: "personal update before handoff" },
      };
      fs.appendFileSync(personalTranscriptPath, `${JSON.stringify(beforeHandoffEvent)}\n`, "utf8");
      const beforeHandoffStreamed = await waitForValue(
        () => envelopes.find((envelope) => {
          if (envelope.type !== "chat_event") return false;
          const payload = envelope.payload as AgentChatEventEnvelope & { event: { text?: string } };
          return payload.sessionId === "personal-chat"
            && payload.event.text === "personal update before handoff";
        }),
        "personal chat event before handoff",
      );
      expect(beforeHandoffStreamed.payload).toMatchObject({ seq: 40 });

      await hostA.dispose();
      hostA = null;
      const envelopeCountAfterDispose = envelopes.length;
      const hostBArgs = createHandoffHostArgs(rootB.projectRoot, tokenPath, {
        siteId: "site-b",
        dbVersion: 0,
        changes: [],
      });
      hostB = createSyncHostService({
        ...hostBArgs,
        projectId: "project-b",
        pollIntervalMs: 100,
        sharedListener: listener,
        personalChatScope,
        sessionService: {
          ...hostBArgs.sessionService,
          get: (sessionId: string) => {
            if (sessionId === "project-chat") return { id: sessionId, transcriptPath: projectTranscriptPath };
            if (sessionId === "foreign-chat") return { id: sessionId, transcriptPath: collidingLocalTranscriptPath };
            return null;
          },
        },
      } as unknown as Parameters<typeof createSyncHostService>[0]);
      await hostB.waitUntilListening();

      const handedOffEnvelopes = () => envelopes.slice(envelopeCountAfterDispose);
      await waitForValue(
        () => handedOffEnvelopes().find((envelope) =>
          envelope.type === "chat_subscribe"
          && (envelope.payload as { sessionId?: string }).sessionId === "personal-chat"
        ),
        "personal chat handoff subscription",
      );
      await waitForValue(
        () => handedOffEnvelopes().find((envelope) =>
          envelope.type === "chat_subscribe"
          && (envelope.payload as { sessionId?: string }).sessionId === "project-chat"
        ),
        "project chat handoff subscription",
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(handedOffEnvelopes().some((envelope) =>
        envelope.type === "chat_subscribe"
        && (envelope.payload as { sessionId?: string }).sessionId === "foreign-chat"
      )).toBe(false);

      const personalEvent: AgentChatEventEnvelope = {
        sessionId: "personal-chat",
        timestamp: "2026-07-09T12:00:00.000Z",
        // Simulate a rehydrated legacy source that restarted its own counter.
        // The sync host's carried high-water still owns the wire identity.
        sequence: 1,
        event: { type: "text", text: "personal update after handoff" },
      };
      fs.appendFileSync(personalTranscriptPath, `${JSON.stringify(personalEvent)}\n`, "utf8");
      const streamed = await waitForValue(
        () => handedOffEnvelopes().find((envelope) =>
          envelope.type === "chat_event"
          && (envelope.payload as AgentChatEventEnvelope).sessionId === "personal-chat"
        ),
        "personal chat event after handoff",
      );
      expect(streamed.payload).toMatchObject({
        sessionId: "personal-chat",
        seq: 41,
        event: { type: "text", text: "personal update after handoff" },
      });
      expect(closeEvents).toEqual([]);
    } finally {
      try {
        client?.close();
      } catch {
        // ignore
      }
      await hostA?.dispose();
      await hostB?.dispose();
      await listener.close();
      rootA.cleanup();
      rootB.cleanup();
    }
  });

  it("parks a connection that arrives while no host owns the listener and replays its hello to the next host", async () => {
    const root = createTempProjectRoot();
    const tokenPath = path.join(root.projectRoot, "shared-bootstrap-token");
    const listener = createSharedSyncListener({ bindHost: "127.0.0.1" });
    let client: WebSocket | null = null;
    let host: ReturnType<typeof createSyncHostService> | null = null;
    try {
      const port = await listener.ensureListening([0]);
      // No host service attached yet: the socket is parked and its frames buffered.
      client = new WebSocket(`ws://127.0.0.1:${port}`);
      const { envelopes, closeEvents } = trackClientEnvelopes(client);
      await new Promise<void>((resolve, reject) => {
        client!.once("open", () => resolve());
        client!.once("error", reject);
      });
      const hostArgs = createHandoffHostArgs(root.projectRoot, tokenPath, {
        siteId: "site-a",
        dbVersion: 0,
        changes: [],
      });
      // The bootstrap token file is created by the host; pre-create it via a
      // throwaway self-owned host so the parked hello can carry a valid token.
      const tokenSeedHost = createSyncHostService({
        ...hostArgs,
        port: 0,
      } as unknown as Parameters<typeof createSyncHostService>[0]);
      const token = tokenSeedHost.getBootstrapToken();
      await tokenSeedHost.dispose();
      sendHello(client, token);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(envelopes).toEqual([]);

      host = createSyncHostService({
        ...hostArgs,
        sharedListener: listener,
      } as unknown as Parameters<typeof createSyncHostService>[0]);
      await host.waitUntilListening();
      await waitForValue(
        () => envelopes.find((envelope) => envelope.type === "hello_ok"),
        "hello_ok replayed after adoption",
      );
      expect(closeEvents).toEqual([]);
    } finally {
      try {
        client?.close();
      } catch {
        // ignore
      }
      await host?.dispose();
      await listener.close();
      root.cleanup();
    }
  });

  it("parks new connections during handler handoff instead of dispatching them to the fallback handler", async () => {
    const listener = createSharedSyncListener({ bindHost: "127.0.0.1", parkedPeerGraceMs: 500 });
    const fallbackHandler = vi.fn((connection: { ws: WebSocket }) => {
      connection.ws.close(4010, "Fallback claimed socket");
    });
    const primaryHandler = vi.fn((connection: { ws: WebSocket }) => {
      connection.ws.close(4011, "Primary claimed socket");
    });
    let client: WebSocket | null = null;

    try {
      const port = await listener.ensureListening([0]);
      const detachPrimary = listener.setConnectionHandler(primaryHandler);
      listener.setFallbackConnectionHandler(fallbackHandler);
      detachPrimary();

      client = new WebSocket(`ws://127.0.0.1:${port}`);
      const { closeEvents } = trackClientEnvelopes(client);
      await new Promise<void>((resolve, reject) => {
        client!.once("open", () => resolve());
        client!.once("error", reject);
      });
      client.send("hello-during-handoff");
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(primaryHandler).not.toHaveBeenCalled();
      expect(fallbackHandler).not.toHaveBeenCalled();
      const parkedPeers = listener.takePeers();
      expect(parkedPeers).toHaveLength(1);
      expect(parkedPeers[0]?.bufferedMessages).toHaveLength(1);
      expect(wsDataToText(parkedPeers[0]!.bufferedMessages![0]!.data)).toBe("hello-during-handoff");
      expect(closeEvents).toEqual([]);
    } finally {
      try {
        client?.close();
      } catch {
        // ignore
      }
      await listener.close();
    }
  });

  it("closes parked peers with 4002 when no host adopts them in time", async () => {
    const listener = createSharedSyncListener({ bindHost: "127.0.0.1", parkedPeerGraceMs: 150 });
    let client: WebSocket | null = null;
    try {
      const port = await listener.ensureListening([0]);
      expect(await listener.ensureListening([0])).toBe(port);
      client = new WebSocket(`ws://127.0.0.1:${port}`);
      const { closeEvents } = trackClientEnvelopes(client);
      await new Promise<void>((resolve, reject) => {
        client!.once("open", () => resolve());
        client!.once("error", reject);
      });
      const closeEvent = await waitForValue(
        () => closeEvents[0],
        "grace-period close",
      );
      expect(closeEvent.code).toBe(4002);
      expect(closeEvent.reason).toBe("Sync host changed projects");
    } finally {
      try {
        client?.close();
      } catch {
        // ignore
      }
      await listener.close();
    }
  });

  it("closes parked peers when buffered handoff frames exceed the byte budget", async () => {
    const listener = createSharedSyncListener({ bindHost: "127.0.0.1", parkedPeerGraceMs: 500 });
    const logger = createDiscoveryLogger();
    const loggedListener = createSharedSyncListener({
      logger,
      bindHost: "127.0.0.1",
      parkedPeerGraceMs: 500,
    });
    let client: WebSocket | null = null;
    try {
      await listener.close();
      const port = await loggedListener.ensureListening([0]);
      client = new WebSocket(`ws://127.0.0.1:${port}`);
      const { closeEvents } = trackClientEnvelopes(client);
      await new Promise<void>((resolve, reject) => {
        client!.once("open", () => resolve());
        client!.once("error", reject);
      });
      client.send(Buffer.alloc(600 * 1024, "x"));

      const closeEvent = await waitForValue(
        () => closeEvents[0],
        "parked byte-budget close",
      );
      expect(closeEvent.code).toBe(4002);
      expect(closeEvent.reason).toBe("Sync host handoff buffer exceeded");
      expect(logger.warn).toHaveBeenCalledWith(
        "sync_listener.parked_peer_buffer_overflow",
        expect.objectContaining({ nextMessageBytes: 600 * 1024 }),
      );
    } finally {
      try {
        client?.close();
      } catch {
        // ignore
      }
      await loggedListener.close();
    }
  });
});

describe("shared listener waitUntilListening ADE-validation gate", () => {
  beforeEach(() => {
    publishMock.mockReset();
    spawnMock.mockReset();
    bonjourDestroyMock.mockReset();
    bonjourConstructorMock.mockReset();
    spawnMock.mockImplementation(() => ({ kill: vi.fn(), once: vi.fn(), unref: vi.fn() }));
    bonjourConstructorMock.mockImplementation(() => ({
      publish: publishMock,
      destroy: bonjourDestroyMock,
    }));
    publishMock.mockImplementation(() => ({ on: vi.fn(), stop: vi.fn() }));
  });

  it("force re-probes a shared listener at handoff and blocks discovery for a post-bind shadow", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    let probeOk = true;
    const loopbackProbe = vi.fn(async (
      port: number,
      expectedNonce: string,
    ): Promise<SyncLoopbackProbeResult> => probeOk
      ? {
          ok: true,
          port,
          statusCode: 426,
          statusMessage: "Upgrade Required",
          markerValue: expectedNonce,
          checkedAt: new Date().toISOString(),
          reason: null,
        }
      : {
          ok: false,
          port,
          statusCode: 426,
          statusMessage: "Upgrade Required",
          markerValue: "post-bind-shadow",
          checkedAt: new Date().toISOString(),
          reason: "post-bind shadow presented a different loopback identity",
        });
    const listener = createSharedSyncListener({
      bindHost: "127.0.0.1",
      loopbackProbe,
    });
    const boundPort = await listener.ensureListening([0]);
    const bindProbeCalls = loopbackProbe.mock.calls.length;
    probeOk = false;
    const host = createSyncHostService({
      ...createHostArgs(projectRoot, [createDiscoveryProject({ id: "project-1" })]),
      sharedListener: listener,
    } as unknown as Parameters<typeof createSyncHostService>[0]);

    try {
      await expect(host.waitUntilListening()).rejects.toThrow(/post-bind shadow/);
      expect(loopbackProbe.mock.calls.length).toBeGreaterThan(bindProbeCalls);
      expect(loopbackProbe).toHaveBeenLastCalledWith(
        boundPort,
        listener.getExpectedLoopbackNonce(),
      );
      expect(listener.getLoopbackValidationStatus()).toMatchObject({
        port: boundPort,
        loopbackAdeValidated: false,
        reason: expect.stringMatching(/post-bind shadow/),
      });
      expect(host.getLoopbackValidationStatus()).toMatchObject({
        port: boundPort,
        loopbackAdeValidated: false,
        reason: expect.stringMatching(/post-bind shadow/),
      });
      expect(publishMock).not.toHaveBeenCalled();
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      await host.dispose();
      await listener.close();
      cleanup();
    }
  });

  it("throws before discovery when the shared listener loopback is not ADE-validated", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const listener = createSharedSyncListener({ bindHost: "127.0.0.1" });
    const boundPort = await listener.ensureListening([0]);
    // The brain-level listener bound, but its loopback probe never confirmed ADE.
    vi.spyOn(listener, "getLoopbackValidationStatus").mockReturnValue({
      port: boundPort,
      loopbackAdeValidated: false,
      lastFailureAt: new Date().toISOString(),
      reason: `127.0.0.1:${boundPort} did not answer as ADE.`,
      lastSuccessAt: null,
    });
    const host = createSyncHostService({
      ...createHostArgs(projectRoot, [createDiscoveryProject({ id: "project-1" })]),
      sharedListener: listener,
    } as unknown as Parameters<typeof createSyncHostService>[0]);

    try {
      await expect(host.waitUntilListening()).rejects.toThrow(/was not ADE-validated/);
      // The host must refuse to advertise an unvalidated shared listener.
      expect(publishMock).not.toHaveBeenCalled();
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      await host.dispose();
      await listener.close();
      cleanup();
    }
  });

  it("throws before discovery when the shared listener validated a different port", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const listener = createSharedSyncListener({ bindHost: "127.0.0.1" });
    const boundPort = await listener.ensureListening([0]);
    // Loopback was validated, but for a stale port that no longer matches the
    // listener's live bind — the host must reject rather than publish it.
    vi.spyOn(listener, "getLoopbackValidationStatus").mockReturnValue({
      port: boundPort + 1,
      loopbackAdeValidated: true,
      lastFailureAt: null,
      reason: null,
      lastSuccessAt: new Date().toISOString(),
    });
    const host = createSyncHostService({
      ...createHostArgs(projectRoot, [createDiscoveryProject({ id: "project-1" })]),
      sharedListener: listener,
    } as unknown as Parameters<typeof createSyncHostService>[0]);

    try {
      await expect(host.waitUntilListening()).rejects.toThrow(/was not ADE-validated/);
      expect(publishMock).not.toHaveBeenCalled();
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      await host.dispose();
      await listener.close();
      cleanup();
    }
  });
});

describe("sync host reliability guards", () => {
  beforeEach(() => {
    publishMock.mockReset();
    spawnMock.mockReset();
    bonjourDestroyMock.mockReset();
    bonjourConstructorMock.mockReset();
    spawnMock.mockImplementation(() => ({ kill: vi.fn(), once: vi.fn(), unref: vi.fn() }));
  });

  function createReliabilityHost(
    projectRoot: string,
    overrides: Partial<Parameters<typeof createSyncHostService>[0]> = {},
  ) {
    const project = createDiscoveryProject({
      id: "project-1",
      rootPath: projectRoot,
      isOpen: true,
    });
    const base = createHostArgs(projectRoot, [project]);
    return createSyncHostService({
      ...base,
      projectId: "project-1",
      db: {
        sync: {
          getSiteId: () => "site-host-reliability",
          getDbVersion: () => 0,
          exportChangesSince: () => [],
          applyChanges: () => ({ appliedCount: 0 }),
          discardUnpublishedChangesForTables: () => {},
        },
      },
      deviceRegistryService: {
        ...base.deviceRegistryService,
        upsertPeerMetadata: vi.fn(),
      },
      ...overrides,
    } as unknown as Parameters<typeof createSyncHostService>[0]);
  }

  // The relay readiness self-probe bridges into the sync host and disconnects
  // without ever speaking the protocol, on every poll. Logging that at info
  // made routine probe traffic indistinguishable at a glance from a peer that
  // tried to authenticate and was rejected.
  it("logs a peer that closed without sending a frame at debug", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const logger = createDiscoveryLogger();
    const host = createReliabilityHost(projectRoot, { logger });
    try {
      const port = await host.waitUntilListening();
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
      });
      ws.close(4000, "self probe complete");

      await vi.waitFor(() => expect(logger.debug).toHaveBeenCalledWith(
        "sync_host.peer_closed_without_frames",
        expect.objectContaining({
          authenticated: false,
          reason: "self probe complete",
        }),
      ));
      expect(logger.info).not.toHaveBeenCalledWith(
        "sync_host.peer_closed",
        expect.anything(),
      );
    } finally {
      await host.dispose();
      cleanup();
    }
  });

  it("serializes project switch handling without deadlocking later peer messages", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const project = createDiscoveryProject({
      id: "project-1",
      rootPath: projectRoot,
      isOpen: true,
    });
    const prepareProjectConnection = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { ok: true, project, connection: null };
    });
    const completeProjectConnection = vi.fn(async () => {});
    const host = createReliabilityHost(projectRoot, {
      projectCatalogProvider: {
        listProjects: vi.fn(async () => ({ projects: [project] })),
        prepareProjectConnection,
        completeProjectConnection,
      },
    });
    let peer: Awaited<ReturnType<typeof connectPeer>> | null = null;
    try {
      const port = await host.waitUntilListening();
      peer = await connectPeer(port, host.getBootstrapToken(), "ios-project-switch");

      peer.ws.send(encodeSyncEnvelope({
        type: "project_switch_request",
        requestId: "switch-serialized",
        payload: { projectId: "project-1" },
      }));
      peer.ws.send(encodeSyncEnvelope({
        type: "project_catalog_request",
        requestId: "catalog-after-switch",
        payload: {},
      }));

      const switchResult = await waitForEnvelope(peer.envelopes, "project_switch_result", "switch-serialized");
      const catalog = await waitForEnvelope(peer.envelopes, "project_catalog", "catalog-after-switch");
      expect(switchResult.payload).toMatchObject({ ok: true });
      expect((catalog.payload as SyncProjectCatalogPayload).projects.map((entry) => entry.id)).toEqual(["project-1"]);
      expect(completeProjectConnection).toHaveBeenCalledTimes(1);
    } finally {
      try {
        peer?.ws.close();
      } catch {
        // ignore
      }
      await host.dispose();
      cleanup();
    }
  });

  it("completes a prepared project switch even when result delivery fails", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const project = createDiscoveryProject({
      id: "project-1",
      rootPath: projectRoot,
      isOpen: true,
    });
    const completeProjectConnection = vi.fn(async () => {});
    const host = createReliabilityHost(projectRoot, {
      projectCatalogProvider: {
        listProjects: vi.fn(async () => ({ projects: [project] })),
        prepareProjectConnection: vi.fn(async () => ({ ok: true, project, connection: null })),
        completeProjectConnection,
      },
    });
    let peer: Awaited<ReturnType<typeof connectPeer>> | null = null;
    let bufferedAmountSpy: { mockRestore(): void } | null = null;
    try {
      const port = await host.waitUntilListening();
      peer = await connectPeer(port, host.getBootstrapToken(), "ios-project-switch-stall");
      bufferedAmountSpy = vi
        .spyOn(WebSocket.prototype, "bufferedAmount", "get")
        .mockReturnValue(17 * 1024 * 1024);

      peer.ws.send(encodeSyncEnvelope({
        type: "project_switch_request",
        requestId: "switch-stalled",
        payload: { projectId: "project-1" },
      }));

      await waitForValue(
        () => completeProjectConnection.mock.calls[0],
        "project switch completion after send failure",
      );
      expect(completeProjectConnection).toHaveBeenCalledWith(
        { projectId: "project-1" },
        expect.objectContaining({ ok: true }),
      );
    } finally {
      bufferedAmountSpy?.mockRestore();
      try {
        peer?.ws.close();
      } catch {
        // ignore
      }
      await host.dispose();
      cleanup();
    }
  });

  it("closes peers instead of queueing required sends beyond the byte budget", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const host = createReliabilityHost(projectRoot);
    let peer: Awaited<ReturnType<typeof connectPeer>> | null = null;
    let bufferedAmountSpy: { mockRestore(): void } | null = null;
    try {
      const port = await host.waitUntilListening();
      peer = await connectPeer(port, host.getBootstrapToken(), "ios-required-backpressure");
      bufferedAmountSpy = vi
        .spyOn(WebSocket.prototype, "bufferedAmount", "get")
        .mockReturnValue(17 * 1024 * 1024);

      peer.ws.send(encodeSyncEnvelope({
        type: "file_request",
        requestId: "required-backpressure",
        payload: { action: "listWorkspaces", args: {} },
      }));

      const closeEvent = await waitForValue(
        () => peer?.closeEvents[0],
        "required-send backpressure close",
      );
      expect(closeEvent.code).toBe(4001);
      expect(closeEvent.reason).toBe("Required sync response backpressured");
    } finally {
      bufferedAmountSpy?.mockRestore();
      try {
        peer?.ws.close();
      } catch {
        // ignore
      }
      await host.dispose();
      cleanup();
    }
	  });

  it("closes peers instead of dropping project catalog chunks under backpressure", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const host = createReliabilityHost(projectRoot);
    let peer: Awaited<ReturnType<typeof connectPeer>> | null = null;
    let bufferedAmountSpy: { mockRestore(): void } | null = null;
    try {
      const port = await host.waitUntilListening();
      peer = await connectPeer(port, host.getBootstrapToken(), "ios-catalog-backpressure");
      bufferedAmountSpy = vi
        .spyOn(WebSocket.prototype, "bufferedAmount", "get")
        .mockReturnValue(17 * 1024 * 1024);

      peer.ws.send(encodeSyncEnvelope({
        type: "project_catalog_request",
        requestId: "catalog-backpressure",
        payload: {},
      }));

      const closeEvent = await waitForValue(
        () => peer?.closeEvents[0],
        "project catalog required-send backpressure close",
      );
      expect(closeEvent.code).toBe(4001);
      expect(closeEvent.reason).toBe("Required sync response backpressured");
    } finally {
      bufferedAmountSpy?.mockRestore();
      try {
        peer?.ws.close();
      } catch {
        // ignore
      }
      await host.dispose();
      cleanup();
    }
  });

  it("processes heartbeat pongs while a long command is still queued", async () => {
    vi.useFakeTimers();
    const { projectRoot, cleanup } = createTempProjectRoot();
    const sendMessage = vi.fn((): Promise<void> => new Promise<void>(() => {}));
    const host = createReliabilityHost(projectRoot, {
      heartbeatIntervalMs: 5_000,
      agentChatService: {
        sendMessage,
        subscribeToEvents: vi.fn(() => vi.fn()),
      } as unknown as Parameters<typeof createSyncHostService>[0]["agentChatService"],
    });
    let peer: ReturnType<typeof trackClientEnvelopes> & { ws: WebSocket } | null = null;
    const waitForTrackedEnvelope = (
      tracked: ReturnType<typeof trackClientEnvelopes>,
      predicate: (envelope: ParsedSyncEnvelope) => boolean,
      _label: string,
    ): Promise<ParsedSyncEnvelope> => {
      const existing = tracked.envelopes.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => {
        const cleanupListener = () => {
          peer?.ws.off("message", onMessage);
        };
        const onMessage = () => {
          const match = tracked.envelopes.find(predicate);
          if (!match) return;
          cleanupListener();
          resolve(match);
        };
        peer?.ws.on("message", onMessage);
      });
    };
    try {
      const port = await host.waitUntilListening();
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      const tracked = trackClientEnvelopes(ws);
      peer = { ws, ...tracked };
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
      });
      const helloOk = waitForTrackedEnvelope(tracked, (envelope) => envelope.type === "hello_ok", "hello_ok");
      ws.send(encodeSyncEnvelope({
        type: "hello",
        payload: {
          peer: {
            deviceId: "desktop-heartbeat",
            deviceName: "Desktop heartbeat",
            platform: "macOS",
            deviceType: "desktop",
            siteId: "desktop-heartbeat-site",
            dbVersion: 0,
          },
          auth: { kind: "bootstrap", token: host.getBootstrapToken() },
        },
      }));
      await helloOk;

      const commandAck = waitForTrackedEnvelope(
        tracked,
        (envelope) => envelope.type === "command_ack" && envelope.requestId === "long-command",
        "long command ack",
      );
      ws.send(encodeSyncEnvelope({
        type: "command",
        requestId: "long-command",
        projectId: "project-1",
        payload: {
          commandId: "long-command",
          action: "chat.send",
          projectId: "project-1",
          args: {
            sessionId: "session-1",
            text: "hello",
          },
        },
      }));
      await commandAck;

      const ping = waitForTrackedEnvelope(
        tracked,
        (envelope) => envelope.type === "heartbeat" && (envelope.payload as { kind?: string } | null)?.kind === "ping",
        "heartbeat ping",
      );
      await vi.advanceTimersByTimeAsync(5_000);
      const pingEnvelope = await ping;
      ws.send(encodeSyncEnvelope({
        type: "heartbeat",
        payload: {
          kind: "pong",
          sentAt: (pingEnvelope.payload as { sentAt?: string }).sentAt,
        },
      }));

      await vi.advanceTimersByTimeAsync(10_000);
      await Promise.resolve();
      expect(tracked.closeEvents).toEqual([]);
      expect(sendMessage).toHaveBeenCalledTimes(1);
    } finally {
      try {
        peer?.ws.close();
      } catch {
        // ignore
      }
      await host.dispose();
      cleanup();
      vi.useRealTimers();
    }
  });

  it("closes a timed-out command peer while preserving exactly-once completion for a replacement", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const logger = createDiscoveryLogger();
    let releaseSendMessage!: () => void;
    const sendMessageGate = new Promise<void>((resolve) => { releaseSendMessage = resolve; });
    const sendMessage = vi.fn(async () => { await sendMessageGate; });
    const host = createReliabilityHost(projectRoot, {
      logger,
      messageTimeoutMs: 100,
      agentChatService: {
        sendMessage,
        subscribeToEvents: vi.fn(() => vi.fn()),
      } as unknown as Parameters<typeof createSyncHostService>[0]["agentChatService"],
    });
    let peer: Awaited<ReturnType<typeof connectPeer>> | null = null;
    let replacement: Awaited<ReturnType<typeof connectPeer>> | null = null;
    const sendCommand = (client: Awaited<ReturnType<typeof connectPeer>>, requestId: string): void => {
      client.ws.send(encodeSyncEnvelope({
        type: "command",
        requestId,
        projectId: "project-1",
        payload: {
          commandId: "hung-command",
          action: "chat.send",
          projectId: "project-1",
          args: {
            sessionId: "session-1",
            text: "hello",
          },
        },
      }));
    };
    try {
      const port = await host.waitUntilListening();
      peer = await connectPeer(port, host.getBootstrapToken(), "desktop-timeout");

      sendCommand(peer, "hung-command");
      await waitForEnvelope(peer.envelopes, "command_ack", "hung-command");

      peer.ws.send(encodeSyncEnvelope({
        type: "project_catalog_request",
        requestId: "catalog-after-timeout",
        payload: {},
      }));

      await waitForValue(() => peer?.closeEvents[0], "mutating message timeout close");
      expect(peer.envelopes.some((envelope) => envelope.requestId === "catalog-after-timeout")).toBe(false);
      await waitForValue(
        () => logger.warn.mock.calls.find(([event]) => event === "sync_host.message_failed") ?? null,
        "message timeout warning",
      );
      expect(logger.warn).toHaveBeenCalledWith("sync_host.message_failed", expect.objectContaining({
        error: expect.stringContaining("Timed out handling sync message command"),
        messageType: "command",
        peerDeviceId: "desktop-timeout",
        requestId: "hung-command",
      }));

      replacement = await connectPeer(port, host.getBootstrapToken(), "desktop-timeout");
      sendCommand(replacement, "hung-command-retry");
      await waitForEnvelope(replacement.envelopes, "command_ack", "hung-command-retry");
      expect(sendMessage).toHaveBeenCalledTimes(1);
      releaseSendMessage();
      await expect(waitForEnvelope(
        replacement.envelopes,
        "command_result",
        "hung-command-retry",
      )).resolves.toMatchObject({
        payload: {
          commandId: "hung-command",
          ok: true,
          result: { ok: true },
        },
      });

      sendCommand(replacement, "hung-command-replay");
      await waitForEnvelope(replacement.envelopes, "command_ack", "hung-command-replay");
      await expect(waitForEnvelope(
        replacement.envelopes,
        "command_result",
        "hung-command-replay",
      )).resolves.toMatchObject({ payload: { commandId: "hung-command", ok: true } });
      expect(sendMessage).toHaveBeenCalledTimes(1);
    } finally {
      releaseSendMessage();
      try {
        peer?.ws.close();
        replacement?.ws.close();
      } catch {
        // ignore
      }
      await host.dispose();
      cleanup();
    }
  });

  it("aborts an opt-in remote command executor when the message timeout fires", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const logger = createDiscoveryLogger();
    let markAborted!: () => void;
    const aborted = new Promise<void>((resolve) => { markAborted = resolve; });
    const execute = vi.fn((
      _payload: SyncCommandPayload,
      context?: { signal?: AbortSignal },
    ): Promise<unknown> => new Promise((_resolve, reject) => {
      const onAbort = () => {
        markAborted();
        reject(context?.signal?.reason ?? new Error("aborted"));
      };
      if (context?.signal?.aborted) onAbort();
      else context?.signal?.addEventListener("abort", onAbort, { once: true });
    }));
    const host = createReliabilityHost(projectRoot, {
      logger,
      messageTimeoutMs: 100,
      remoteCommandExecutor: { execute },
    });
    let peer: Awaited<ReturnType<typeof connectPeer>> | null = null;
    try {
      peer = await connectPeer(
        await host.waitUntilListening(),
        host.getBootstrapToken(),
        "ios-command-timeout-abort",
      );
      peer.ws.send(encodeSyncEnvelope({
        type: "command",
        requestId: "timeout-abort",
        projectId: "project-2",
        payload: {
          commandId: "timeout-abort",
          action: "lanes.list",
          projectId: "project-2",
          args: {},
        },
      }));
      await waitForEnvelope(peer.envelopes, "command_ack", "timeout-abort");
      await aborted;
      expect(execute.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      expect(logger.warn).toHaveBeenCalledWith("sync_host.command_timed_out", {
        action: "lanes.list",
        durationMs: expect.any(Number),
        peerKind: "mobile",
        timedOut: true,
      });
    } finally {
      peer?.ws.close();
      await host.dispose();
      cleanup();
    }
  });

  it("aborts an opt-in remote command executor when its peer closes", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    let markAborted!: () => void;
    const aborted = new Promise<void>((resolve) => { markAborted = resolve; });
    const execute = vi.fn((
      _payload: SyncCommandPayload,
      context?: { signal?: AbortSignal },
    ): Promise<unknown> => new Promise((_resolve, reject) => {
      const onAbort = () => {
        markAborted();
        reject(context?.signal?.reason ?? new Error("aborted"));
      };
      if (context?.signal?.aborted) onAbort();
      else context?.signal?.addEventListener("abort", onAbort, { once: true });
    }));
    const host = createReliabilityHost(projectRoot, {
      messageTimeoutMs: 5_000,
      remoteCommandExecutor: { execute },
    });
    let peer: Awaited<ReturnType<typeof connectPeer>> | null = null;
    try {
      peer = await connectPeer(
        await host.waitUntilListening(),
        host.getBootstrapToken(),
        "ios-command-close-abort",
      );
      peer.ws.send(encodeSyncEnvelope({
        type: "command",
        requestId: "close-abort",
        projectId: "project-2",
        payload: {
          commandId: "close-abort",
          action: "lanes.list",
          projectId: "project-2",
          args: {},
        },
      }));
      await waitForEnvelope(peer.envelopes, "command_ack", "close-abort");
      peer.ws.close();
      await aborted;
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      peer?.ws.close();
      await host.dispose();
      cleanup();
    }
  });

  it("warns when a completed command exceeds the slow-command threshold", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const logger = createDiscoveryLogger();
    const execute = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { ok: true };
    });
    const host = createReliabilityHost(projectRoot, {
      logger,
      slowCommandThresholdMs: 10,
      remoteCommandExecutor: { execute },
    });
    let peer: Awaited<ReturnType<typeof connectPeer>> | null = null;
    try {
      peer = await connectPeer(
        await host.waitUntilListening(),
        host.getBootstrapToken(),
        "desktop-slow-command",
        { platform: "macOS", deviceType: "desktop" },
      );
      peer.ws.send(encodeSyncEnvelope({
        type: "command",
        requestId: "slow-command",
        projectId: "project-2",
        payload: {
          commandId: "slow-command",
          action: "lanes.list",
          projectId: "project-2",
          args: {},
        },
      }));
      await waitForEnvelope(peer.envelopes, "command_result", "slow-command");
      expect(logger.warn).toHaveBeenCalledWith("sync_host.command_slow", {
        action: "lanes.list",
        durationMs: expect.any(Number),
        peerKind: "desktop",
      });
      const slowFields = logger.warn.mock.calls.find(
        ([event]) => event === "sync_host.command_slow",
      )?.[1];
      expect(slowFields?.durationMs).toBeGreaterThanOrEqual(10);
      expect(slowFields).not.toHaveProperty("args");
      expect(slowFields).not.toHaveProperty("payload");
    } finally {
      peer?.ws.close();
      await host.dispose();
      cleanup();
    }
  });

  it("serves artifacts stored under the ade-artifact scheme the broker writes", async () => {
    // Stored URIs are `ade-artifact://project/<relative>`. Without stripping
    // the scheme the phone resolved a path starting with "project/" and every
    // artifact read failed, even for captures that render fine on desktop.
    const { projectRoot, cleanup } = createTempProjectRoot();
    const artifactPath = path.join(projectRoot, ".ade", "artifacts", "computer-use", "shot.png");
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const host = createReliabilityHost(projectRoot);
    let peer: Awaited<ReturnType<typeof connectPeer>> | null = null;
    try {
      const port = await host.waitUntilListening();
      peer = await connectPeer(port, host.getBootstrapToken(), "ios-artifact-scheme");
      peer.ws.send(encodeSyncEnvelope({
        type: "file_request",
        requestId: "artifact-scheme",
        payload: {
          action: "readArtifact",
          args: { uri: "ade-artifact://project/.ade/artifacts/computer-use/shot.png" },
        },
      }));

      const response = await waitForEnvelope(peer.envelopes, "file_response", "artifact-scheme");
      expect(response.payload).toMatchObject({ ok: true, action: "readArtifact" });
    } finally {
      try {
        peer?.ws.close();
      } catch {
        // ignore
      }
      await host.dispose();
      cleanup();
    }
  });

  it("rejects oversized artifact reads with a clear file response", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const artifactPath = path.join(projectRoot, ".ade", "artifacts", "large.bin");
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, Buffer.alloc(8 * 1024 * 1024 + 1));
    const host = createReliabilityHost(projectRoot);
    let peer: Awaited<ReturnType<typeof connectPeer>> | null = null;
    try {
      const port = await host.waitUntilListening();
      peer = await connectPeer(port, host.getBootstrapToken(), "ios-artifact-cap");
      peer.ws.send(encodeSyncEnvelope({
        type: "file_request",
        requestId: "artifact-large",
        payload: {
          action: "readArtifact",
          args: { path: artifactPath },
        },
      }));

      const response = await waitForEnvelope(peer.envelopes, "file_response", "artifact-large");
      expect(response.payload).toMatchObject({
        ok: false,
        action: "readArtifact",
        error: {
          code: "file_request_failed",
        },
      });
      expect((response.payload as { error?: { message?: string } }).error?.message).toMatch(/too large to sync/i);
    } finally {
      try {
        peer?.ws.close();
      } catch {
        // ignore
      }
      await host.dispose();
      cleanup();
    }
  });
});

describe("chat_subscribe snapshots", () => {
  beforeEach(() => {
    publishMock.mockReset();
    spawnMock.mockReset();
    bonjourDestroyMock.mockReset();
    bonjourConstructorMock.mockReset();
    spawnMock.mockImplementation(() => ({ kill: vi.fn(), once: vi.fn(), unref: vi.fn() }));
  });

  it("passes the peer byte cap to chat history and does not replay snapshot events from the transcript pump", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const transcriptPath = path.join(projectRoot, "transcripts", "chat-1.chat.jsonl");
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    fs.writeFileSync(transcriptPath, "", "utf8");
    const event: AgentChatEventEnvelope = {
      sessionId: "chat-1",
      timestamp: "2026-04-23T10:00:00.000Z",
      sequence: 1,
      event: { type: "text", text: "in-flight text" },
    };
    const laterEvent: AgentChatEventEnvelope = {
      sessionId: "chat-1",
      timestamp: "2026-04-23T10:00:01.000Z",
      sequence: 2,
      event: { type: "text", text: "later transcript text" },
    };
    const session = {
      id: "chat-1",
      laneId: "lane-1",
      transcriptPath,
      status: "running",
      runtimeState: "running",
      lastOutputPreview: "",
    };
    const getChatEventHistory = vi.fn().mockReturnValue({
      sessionId: "chat-1",
      events: [event],
      truncated: false,
      transcriptTruncated: false,
      windowTruncated: false,
      sessionFound: true,
    });
    const base = createHostArgs(projectRoot, []);
    const host = createSyncHostService({
      ...base,
      pollIntervalMs: 100,
      projectId: "project-1",
      db: {
        sync: {
          getSiteId: () => "site-host-chat-subscribe",
          getDbVersion: () => 0,
          exportChangesSince: () => [],
          applyChanges: () => ({ appliedCount: 0 }),
          discardUnpublishedChangesForTables: () => {},
        },
      },
      deviceRegistryService: {
        ...base.deviceRegistryService,
        upsertPeerMetadata: vi.fn(),
      },
      sessionService: {
        list: () => [session],
        get: (id: string) => (id === "chat-1" ? session : null),
        readTranscriptTail: async () => "",
      },
      agentChatService: {
        subscribeToEvents: vi.fn().mockReturnValue(() => {}),
        getChatEventHistory,
        getSessionSummary: vi.fn().mockResolvedValue({ status: "active" }),
      },
    } as unknown as Parameters<typeof createSyncHostService>[0]);
    let peer: Awaited<ReturnType<typeof connectPeer>> | null = null;

    try {
      const port = await host.waitUntilListening();
      peer = await connectPeer(port, host.getBootstrapToken(), "ios-chat-subscribe");
      peer.ws.send(encodeSyncEnvelope({
        type: "chat_subscribe",
        requestId: "chat-subscribe-1",
        payload: { sessionId: "chat-1", maxBytes: 4_096 },
      }));

      const ack = await waitForEnvelope(peer.envelopes, "chat_subscribe", "chat-subscribe-1");
      expect(getChatEventHistory).toHaveBeenCalledWith("chat-1", {
        maxEvents: CHAT_EVENT_REPLAY_MAX_EVENTS,
        maxBytes: 4_096,
        signal: expect.any(AbortSignal),
      });
      expect((ack.payload as { events?: AgentChatEventEnvelope[] }).events).toEqual([event]);
      expect(ack.payload).toMatchObject({ turnActive: true });

      fs.appendFileSync(transcriptPath, `${JSON.stringify(event)}\n${JSON.stringify(laterEvent)}\n`, "utf8");
      const delivered = await waitForValue(
        () => peer?.envelopes.find((envelope) => envelope.type === "chat_event"),
        "later chat event",
      );
      expect(delivered.payload).toMatchObject({
        sessionId: "chat-1",
        event: { type: "text", text: "later transcript text" },
      });
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(peer.envelopes.filter((envelope) => envelope.type === "chat_event")).toHaveLength(1);
    } finally {
      try {
        peer?.ws.close();
      } catch {
        // ignore
      }
      await host.dispose();
      cleanup();
    }
  });

  it("advertises the snapshot cursor and pages the subscribed chat without another runtime route", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const transcriptPath = path.join(projectRoot, "transcripts", "chat-page.chat.jsonl");
    const foreignTranscriptPath = path.join(projectRoot, "transcripts", "foreign-chat-page.chat.jsonl");
    const missingForeignTranscriptPath = path.join(projectRoot, "transcripts", "missing-foreign-chat.chat.jsonl");
    const foreignRootA = path.join(projectRoot, "registered-foreign-a");
    const foreignRootB = path.join(projectRoot, "registered-foreign-b");
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    fs.writeFileSync(transcriptPath, "", "utf8");
    const session = {
      id: "chat-page",
      laneId: "lane-1",
      transcriptPath,
      status: "exited",
      runtimeState: "exited",
      lastOutputPreview: "",
    };
    const olderEvent: AgentChatEventEnvelope = {
      sessionId: session.id,
      timestamp: "2026-07-28T10:00:00.000Z",
      sequence: 1,
      event: { type: "user_message", text: "older prompt" },
    };
    const foreignEvent: AgentChatEventEnvelope = {
      sessionId: session.id,
      timestamp: "2026-07-28T10:01:00.000Z",
      sequence: 1,
      event: { type: "user_message", text: "foreign project prompt" },
    };
    fs.writeFileSync(foreignTranscriptPath, `${JSON.stringify(foreignEvent)}\n`, "utf8");
    const getChatEventHistoryPage = vi.fn().mockResolvedValue({
      sessionId: session.id,
      events: [olderEvent],
      startOffset: 2_048,
      hasMore: true,
      sessionFound: true,
    });
    const base = createHostArgs(projectRoot, []);
    const host = createSyncHostService({
      ...base,
      projectId: "project-1",
      projectIdAliases: ["project-1-alias"],
      pollIntervalMs: 100,
      db: {
        sync: {
          getSiteId: () => "site-host-chat-page",
          getDbVersion: () => 0,
          exportChangesSince: () => [],
          applyChanges: () => ({ appliedCount: 0 }),
          discardUnpublishedChangesForTables: () => {},
        },
      },
      deviceRegistryService: {
        ...base.deviceRegistryService,
        upsertPeerMetadata: vi.fn(),
      },
      sessionService: {
        list: () => [session],
        get: (id: string) => id === session.id ? session : null,
        readTranscriptTail: async () => "",
      },
      agentChatService: {
        subscribeToEvents: vi.fn().mockReturnValue(() => {}),
        getChatEventHistory: vi.fn().mockResolvedValue({
          sessionId: session.id,
          events: [],
          truncated: true,
          transcriptTruncated: true,
          windowTruncated: false,
          sessionFound: true,
          hasOlderHistory: true,
          tailStartOffset: 4_096,
        }),
        getChatEventHistoryPage,
        getSessionSummary: vi.fn().mockResolvedValue({ status: "idle" }),
      },
      foreignChatProvider: {
        resolveTranscriptPath: vi.fn((scope: {
          projectId?: string | null;
          projectRootPath?: string | null;
          sessionId: string;
        }) => {
          const requestedProjectId = scope.projectId?.trim() || null;
          const requestedRoot = scope.projectRootPath?.trim()
            ? path.resolve(scope.projectRootPath)
            : null;
          if (
            scope.sessionId === session.id
            && (requestedProjectId != null || requestedRoot != null)
            && (requestedProjectId == null || requestedProjectId === "foreign-project-a")
            && (requestedRoot == null || requestedRoot === path.resolve(foreignRootA))
          ) {
            return foreignTranscriptPath;
          }
          if (
            scope.sessionId === "missing-foreign-chat"
            && scope.projectId === "foreign-project-missing"
          ) {
            return missingForeignTranscriptPath;
          }
          return null;
        }),
      },
    } as unknown as Parameters<typeof createSyncHostService>[0]);
    let peer: Awaited<ReturnType<typeof connectPeer>> | null = null;

    try {
      const port = await host.waitUntilListening();
      peer = await connectPeer(port, host.getBootstrapToken(), "ios-chat-page");
      peer.ws.send(encodeSyncEnvelope({
        type: "chat_subscribe",
        requestId: "chat-page-subscribe",
        projectId: "project-1",
        payload: {
          sessionId: session.id,
          projectId: "project-1",
          maxBytes: 256 * 1_024,
        },
      }));
      const snapshot = await waitForEnvelope(
        peer.envelopes,
        "chat_subscribe",
        "chat-page-subscribe",
      );
      expect(snapshot.payload).toMatchObject({
        sessionId: session.id,
        cursorKind: "byte",
        tailStartOffset: 4_096,
        hasOlderHistory: true,
      });

      peer.ws.send(encodeSyncEnvelope({
        type: "chat_history",
        requestId: "chat-page-history",
        projectId: "project-1",
        payload: {
          sessionId: session.id,
          projectId: "project-1",
          beforeOffset: 4_096,
          maxBytes: 256 * 1_024,
        },
      }));
      const page = await waitForEnvelope(
        peer.envelopes,
        "chat_history",
        "chat-page-history",
      );
      expect(page.payload).toEqual({
        sessionId: session.id,
        events: [olderEvent],
        startOffset: 2_048,
        hasMore: true,
        sessionFound: true,
      });
      expect(getChatEventHistoryPage).toHaveBeenCalledWith(session.id, {
        beforeOffset: 4_096,
        maxBytes: 256 * 1_024,
        signal: expect.any(AbortSignal),
      });

      peer.ws.send(encodeSyncEnvelope({
        type: "chat_history",
        requestId: "chat-page-history-host-root",
        projectId: "project-1",
        payload: {
          sessionId: session.id,
          projectRootPath: projectRoot,
          beforeOffset: 2_048,
        },
      }));
      const rootScopedPage = await waitForEnvelope(
        peer.envelopes,
        "chat_history",
        "chat-page-history-host-root",
      );
      expect(rootScopedPage.payload).toMatchObject({
        sessionId: session.id,
        startOffset: 2_048,
        sessionFound: true,
      });
      expect(getChatEventHistoryPage).toHaveBeenCalledTimes(2);

      peer.ws.send(encodeSyncEnvelope({
        type: "chat_history",
        requestId: "chat-page-history-conflicting-host-scope",
        projectId: "project-1",
        payload: {
          sessionId: session.id,
          projectId: "project-1",
          projectRootPath: foreignRootB,
          beforeOffset: 2_048,
        },
      }));
      const conflictingHostScope = await waitForEnvelope(
        peer.envelopes,
        "chat_history",
        "chat-page-history-conflicting-host-scope",
      );
      expect(conflictingHostScope.payload).toMatchObject({
        sessionId: session.id,
        startOffset: 2_048,
        sessionFound: false,
        unavailable: true,
      });
      expect(getChatEventHistoryPage).toHaveBeenCalledTimes(2);

      peer.ws.send(encodeSyncEnvelope({
        type: "chat_unsubscribe",
        projectId: "project-1",
        payload: {
          sessionId: session.id,
          projectId: "foreign-project",
        },
      }));
      peer.ws.send(encodeSyncEnvelope({
        type: "chat_history",
        requestId: "chat-page-wrong-scope",
        projectId: "project-1",
        payload: {
          sessionId: session.id,
          projectId: "foreign-project",
          beforeOffset: 2_048,
        },
      }));
      const refused = await waitForEnvelope(
        peer.envelopes,
        "chat_history",
        "chat-page-wrong-scope",
      );
      expect(refused.payload).toMatchObject({
        sessionId: session.id,
        startOffset: 2_048,
        sessionFound: false,
        unavailable: true,
      });
      expect(getChatEventHistoryPage).toHaveBeenCalledTimes(2);

      peer.ws.send(encodeSyncEnvelope({
        type: "chat_history",
        requestId: "chat-page-history-after-mismatched-unsubscribe",
        projectId: "project-1",
        payload: {
          sessionId: session.id,
          projectId: "project-1",
          beforeOffset: 2_048,
        },
      }));
      const pageAfterMismatchedUnsubscribe = await waitForEnvelope(
        peer.envelopes,
        "chat_history",
        "chat-page-history-after-mismatched-unsubscribe",
      );
      expect(pageAfterMismatchedUnsubscribe.payload).toMatchObject({
        sessionId: session.id,
        startOffset: 2_048,
        sessionFound: true,
      });
      expect(getChatEventHistoryPage).toHaveBeenCalledTimes(3);

      peer.ws.send(encodeSyncEnvelope({
        type: "chat_subscribe",
        requestId: "foreign-chat-page-subscribe",
        projectId: "project-1",
        payload: {
          sessionId: session.id,
          projectId: "foreign-project-a",
        },
      }));
      const foreignSnapshot = await waitForEnvelope(
        peer.envelopes,
        "chat_subscribe",
        "foreign-chat-page-subscribe",
      );
      expect(foreignSnapshot.payload).toMatchObject({
        sessionId: session.id,
        events: [foreignEvent],
      });

      const foreignTranscriptSize = Buffer.byteLength(`${JSON.stringify(foreignEvent)}\n`, "utf8");
      peer.ws.send(encodeSyncEnvelope({
        type: "chat_history",
        requestId: "foreign-chat-page-wrong-root",
        projectId: "project-1",
        payload: {
          sessionId: session.id,
          projectId: "foreign-project-a",
          projectRootPath: foreignRootB,
          beforeOffset: foreignTranscriptSize,
        },
      }));
      const wrongForeignRoot = await waitForEnvelope(
        peer.envelopes,
        "chat_history",
        "foreign-chat-page-wrong-root",
      );
      expect(wrongForeignRoot.payload).toMatchObject({
        sessionId: session.id,
        startOffset: foreignTranscriptSize,
        sessionFound: false,
        unavailable: true,
      });

      peer.ws.send(encodeSyncEnvelope({
        type: "chat_unsubscribe",
        projectId: "project-1",
        payload: {
          sessionId: session.id,
          projectId: "foreign-project-b",
          projectRootPath: foreignRootA,
        },
      }));
      peer.ws.send(encodeSyncEnvelope({
        type: "chat_history",
        requestId: "foreign-chat-page-after-mismatched-unsubscribe",
        projectId: "project-1",
        payload: {
          sessionId: session.id,
          projectRootPath: `${foreignRootA}/.`,
          beforeOffset: foreignTranscriptSize,
        },
      }));
      const exactForeignPage = await waitForEnvelope(
        peer.envelopes,
        "chat_history",
        "foreign-chat-page-after-mismatched-unsubscribe",
      );
      expect(exactForeignPage.payload).toMatchObject({
        sessionId: session.id,
        events: [foreignEvent],
        startOffset: 0,
        sessionFound: true,
      });

      peer.ws.send(encodeSyncEnvelope({
        type: "chat_unsubscribe",
        projectId: "project-1",
        payload: { sessionId: session.id },
      }));
      peer.ws.send(encodeSyncEnvelope({
        type: "chat_history",
        requestId: "foreign-chat-page-after-legacy-unsubscribe",
        projectId: "project-1",
        payload: {
          sessionId: session.id,
          projectId: "foreign-project-a",
          projectRootPath: foreignRootA,
          beforeOffset: foreignTranscriptSize,
        },
      }));
      const afterLegacyUnsubscribe = await waitForEnvelope(
        peer.envelopes,
        "chat_history",
        "foreign-chat-page-after-legacy-unsubscribe",
      );
      expect(afterLegacyUnsubscribe.payload).toMatchObject({
        sessionId: session.id,
        sessionFound: false,
        unavailable: true,
      });

      peer.ws.send(encodeSyncEnvelope({
        type: "chat_subscribe",
        requestId: "rejected-foreign-chat-subscribe",
        projectId: "project-1",
        payload: {
          sessionId: session.id,
          projectId: "unregistered-foreign-project",
        },
      }));
      const rejectedForeignSnapshot = await waitForEnvelope(
        peer.envelopes,
        "chat_subscribe",
        "rejected-foreign-chat-subscribe",
      );
      expect(rejectedForeignSnapshot.payload).toMatchObject({
        sessionId: session.id,
        events: [],
      });
      peer.ws.send(encodeSyncEnvelope({
        type: "chat_history",
        requestId: "rejected-foreign-chat-history",
        projectId: "project-1",
        payload: {
          sessionId: session.id,
          projectId: "unregistered-foreign-project",
          beforeOffset: foreignTranscriptSize,
        },
      }));
      const rejectedForeignHistory = await waitForEnvelope(
        peer.envelopes,
        "chat_history",
        "rejected-foreign-chat-history",
      );
      expect(rejectedForeignHistory.payload).toMatchObject({
        sessionId: session.id,
        sessionFound: false,
        unavailable: true,
      });

      peer.ws.send(encodeSyncEnvelope({
        type: "chat_subscribe",
        requestId: "missing-foreign-chat-subscribe",
        projectId: "project-1-alias",
        payload: {
          sessionId: "missing-foreign-chat",
          projectId: "foreign-project-missing",
        },
      }));
      const missingForeignSnapshot = await waitForEnvelope(
        peer.envelopes,
        "chat_subscribe",
        "missing-foreign-chat-subscribe",
      );
      expect(missingForeignSnapshot.payload).toMatchObject({
        sessionId: "missing-foreign-chat",
        events: [],
        truncated: false,
        tailStartOffset: 0,
        hasOlderHistory: false,
      });

      const appearedEvent: AgentChatEventEnvelope = {
        sessionId: "missing-foreign-chat",
        timestamp: "2026-07-28T10:02:00.000Z",
        sequence: 1,
        event: { type: "text", text: "transcript appeared after subscribe" },
      };
      fs.writeFileSync(missingForeignTranscriptPath, `${JSON.stringify(appearedEvent)}\n`, "utf8");
      const appearedEventEnvelope = await waitForValue(
        () => peer?.envelopes.find((entry) =>
          entry.type === "chat_event"
          && (entry.payload as AgentChatEventEnvelope).sessionId === "missing-foreign-chat"
        ),
        "foreign transcript event after the file appears",
      );
      expect(appearedEventEnvelope.payload).toMatchObject(appearedEvent);
    } finally {
      peer?.ws.close();
      await host.dispose();
      cleanup();
    }
  });

  it("holds live pumping behind a slow snapshot and replays only concurrent appends after the ack", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const transcriptPath = path.join(projectRoot, "transcripts", "slow-snapshot.chat.jsonl");
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    const snapshotEvent: AgentChatEventEnvelope = {
      sessionId: "slow-snapshot",
      timestamp: "2026-07-24T09:10:00.000Z",
      sequence: 1,
      event: { type: "text", text: "snapshot history" },
    };
    const concurrentEvent: AgentChatEventEnvelope = {
      sessionId: "slow-snapshot",
      timestamp: "2026-07-24T09:10:01.000Z",
      sequence: 2,
      event: { type: "text", text: "appended during hydration" },
    };
    fs.writeFileSync(transcriptPath, `${JSON.stringify(snapshotEvent)}\n`, "utf8");
    const session = {
      id: snapshotEvent.sessionId,
      laneId: "lane-1",
      transcriptPath,
      status: "running",
      runtimeState: "running",
      lastOutputPreview: "",
    };
    let markSnapshotStarted = () => {};
    const snapshotStarted = new Promise<void>((resolve) => {
      markSnapshotStarted = resolve;
    });
    let releaseSnapshot = () => {};
    const snapshotGate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    const base = createHostArgs(projectRoot, []);
    const host = createSyncHostService({
      ...base,
      pollIntervalMs: 25,
      projectId: "project-1",
      db: {
        sync: {
          getSiteId: () => "site-host-slow-snapshot",
          getDbVersion: () => 0,
          exportChangesSince: () => [],
          applyChanges: () => ({ appliedCount: 0 }),
          discardUnpublishedChangesForTables: () => {},
        },
      },
      deviceRegistryService: {
        ...base.deviceRegistryService,
        upsertPeerMetadata: vi.fn(),
      },
      sessionService: {
        list: () => [session],
        get: (id: string) => id === session.id ? session : null,
        readTranscriptTail: async () => "",
      },
      agentChatService: {
        subscribeToEvents: vi.fn().mockReturnValue(() => {}),
        getChatEventHistory: vi.fn(async () => {
          markSnapshotStarted();
          await snapshotGate;
          return {
            sessionId: session.id,
            events: [snapshotEvent],
            truncated: false,
            transcriptTruncated: false,
            windowTruncated: false,
            sessionFound: true,
          };
        }),
        getSessionSummary: vi.fn().mockResolvedValue({ status: "active" }),
      },
    } as unknown as Parameters<typeof createSyncHostService>[0]);
    let peer: Awaited<ReturnType<typeof connectPeer>> | null = null;

    try {
      const port = await host.waitUntilListening();
      peer = await connectPeer(port, host.getBootstrapToken(), "slow-snapshot-peer");
      peer.ws.send(encodeSyncEnvelope({
        type: "chat_subscribe",
        requestId: "slow-snapshot-subscribe",
        payload: { sessionId: session.id },
      }));
      await snapshotStarted;
      fs.appendFileSync(transcriptPath, `${JSON.stringify(concurrentEvent)}\n`, "utf8");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(peer.envelopes.some((entry) => entry.type === "chat_event")).toBe(false);
      expect(peer.envelopes.some((entry) =>
        entry.type === "chat_subscribe" && entry.requestId === "slow-snapshot-subscribe"
      )).toBe(false);

      releaseSnapshot();
      await waitForEnvelope(peer.envelopes, "chat_subscribe", "slow-snapshot-subscribe");
      const delivered = await waitForValue(
        () => peer?.envelopes.find((entry) => entry.type === "chat_event"),
        "concurrent post-snapshot chat event",
      );
      expect(delivered.payload).toMatchObject({
        sessionId: session.id,
        event: { type: "text", text: "appended during hydration" },
      });
      expect(peer.envelopes.filter((entry) => entry.type === "chat_event")).toHaveLength(1);
    } finally {
      releaseSnapshot();
      peer?.ws.close();
      await host.dispose();
      cleanup();
    }
  });

  it("restores an existing live subscription when a refresh snapshot fails", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const transcriptPath = path.join(projectRoot, "transcripts", "refresh-failure.chat.jsonl");
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    const initialEvent: AgentChatEventEnvelope = {
      sessionId: "refresh-failure",
      timestamp: "2026-07-24T09:20:00.000Z",
      sequence: 1,
      event: { type: "text", text: "initial snapshot" },
    };
    const laterEvent: AgentChatEventEnvelope = {
      sessionId: "refresh-failure",
      timestamp: "2026-07-24T09:20:01.000Z",
      sequence: 2,
      event: { type: "text", text: "still live after failed refresh" },
    };
    fs.writeFileSync(transcriptPath, `${JSON.stringify(initialEvent)}\n`, "utf8");
    const session = {
      id: initialEvent.sessionId,
      laneId: "lane-1",
      transcriptPath,
      status: "running",
      runtimeState: "running",
      lastOutputPreview: "",
    };
    const getChatEventHistory = vi.fn()
      .mockResolvedValueOnce({
        sessionId: session.id,
        events: [initialEvent],
        truncated: false,
        transcriptTruncated: false,
        windowTruncated: false,
        sessionFound: true,
      })
      .mockRejectedValueOnce(new Error("compressed_history_read_superseded"));
    const base = createHostArgs(projectRoot, []);
    const host = createSyncHostService({
      ...base,
      pollIntervalMs: 25,
      projectId: "project-1",
      db: {
        sync: {
          getSiteId: () => "site-host-refresh-failure",
          getDbVersion: () => 0,
          exportChangesSince: () => [],
          applyChanges: () => ({ appliedCount: 0 }),
          discardUnpublishedChangesForTables: () => {},
        },
      },
      deviceRegistryService: {
        ...base.deviceRegistryService,
        upsertPeerMetadata: vi.fn(),
      },
      sessionService: {
        list: () => [session],
        get: (id: string) => id === session.id ? session : null,
        readTranscriptTail: async () => "",
      },
      agentChatService: {
        subscribeToEvents: vi.fn().mockReturnValue(() => {}),
        getChatEventHistory,
        getSessionSummary: vi.fn().mockResolvedValue({ status: "active" }),
      },
    } as unknown as Parameters<typeof createSyncHostService>[0]);
    let peer: Awaited<ReturnType<typeof connectPeer>> | null = null;

    try {
      const port = await host.waitUntilListening();
      peer = await connectPeer(port, host.getBootstrapToken(), "refresh-failure-peer");
      peer.ws.send(encodeSyncEnvelope({
        type: "chat_subscribe",
        requestId: "refresh-initial",
        payload: { sessionId: session.id },
      }));
      await waitForEnvelope(peer.envelopes, "chat_subscribe", "refresh-initial");

      peer.ws.send(encodeSyncEnvelope({
        type: "chat_subscribe",
        requestId: "refresh-rejected",
        payload: { sessionId: session.id },
      }));
      await waitForValue(
        () => getChatEventHistory.mock.calls.length >= 2,
        "failed refresh snapshot attempt",
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
      fs.appendFileSync(transcriptPath, `${JSON.stringify(laterEvent)}\n`, "utf8");

      const delivered = await waitForValue(
        () => peer?.envelopes.find((entry) =>
          entry.type === "chat_event"
          && (entry.payload as AgentChatEventEnvelope).sequence === laterEvent.sequence),
        "live event after rejected refresh",
      );
      expect(delivered.payload).toMatchObject({
        sessionId: session.id,
        event: { type: "text", text: "still live after failed refresh" },
      });
    } finally {
      peer?.ws.close();
      await host.dispose();
      cleanup();
    }
  });

  it("starts the transcript pump at the logical end of a compressed snapshot", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const transcriptPath = path.join(projectRoot, "transcripts", "compressed-chat.chat.jsonl");
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    const snapshotEvent: AgentChatEventEnvelope = {
      sessionId: "compressed-chat",
      timestamp: "2026-07-24T09:00:00.000Z",
      sequence: 1,
      event: { type: "text", text: "already included in the snapshot" },
    };
    const nextEvent: AgentChatEventEnvelope = {
      sessionId: "compressed-chat",
      timestamp: "2026-07-24T09:00:01.000Z",
      sequence: 2,
      event: { type: "text", text: "new after reinflate" },
    };
    const snapshotLine = `${JSON.stringify(snapshotEvent)}\n`;
    fs.writeFileSync(`${transcriptPath}.gz`, gzipSync(snapshotLine));
    const session = {
      id: "compressed-chat",
      laneId: "lane-1",
      transcriptPath,
      status: "running",
      runtimeState: "running",
      lastOutputPreview: "",
    };
    const base = createHostArgs(projectRoot, []);
    const host = createSyncHostService({
      ...base,
      pollIntervalMs: 25,
      projectId: "project-1",
      db: {
        sync: {
          getSiteId: () => "site-host-compressed-chat",
          getDbVersion: () => 0,
          exportChangesSince: () => [],
          applyChanges: () => ({ appliedCount: 0 }),
          discardUnpublishedChangesForTables: () => {},
        },
      },
      deviceRegistryService: {
        ...base.deviceRegistryService,
        upsertPeerMetadata: vi.fn(),
      },
      sessionService: {
        list: () => [session],
        get: (id: string) => id === session.id ? session : null,
        readTranscriptTail: async () => "",
      },
      agentChatService: {
        subscribeToEvents: vi.fn().mockReturnValue(() => {}),
        getChatEventHistory: vi.fn().mockResolvedValue({
          sessionId: session.id,
          events: [snapshotEvent],
          truncated: false,
          transcriptTruncated: false,
          windowTruncated: false,
          sessionFound: true,
        }),
        getSessionSummary: vi.fn().mockResolvedValue({ status: "active" }),
      },
    } as unknown as Parameters<typeof createSyncHostService>[0]);
    let peer: Awaited<ReturnType<typeof connectPeer>> | null = null;

    try {
      const port = await host.waitUntilListening();
      peer = await connectPeer(port, host.getBootstrapToken(), "compressed-chat-peer");
      peer.ws.send(encodeSyncEnvelope({
        type: "chat_subscribe",
        requestId: "compressed-chat-subscribe",
        payload: { sessionId: session.id },
      }));
      await waitForEnvelope(peer.envelopes, "chat_subscribe", "compressed-chat-subscribe");

      fs.writeFileSync(
        transcriptPath,
        `${snapshotLine}${JSON.stringify(nextEvent)}\n`,
        "utf8",
      );
      const delivered = await waitForValue(
        () => peer?.envelopes.find((envelope) => envelope.type === "chat_event"),
        "post-reinflate chat event",
      );

      expect(delivered.payload).toMatchObject({
        sessionId: session.id,
        event: { type: "text", text: "new after reinflate" },
      });
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(peer.envelopes.filter((envelope) => envelope.type === "chat_event")).toHaveLength(1);
    } finally {
      peer?.ws.close();
      await host.dispose();
      cleanup();
    }
  });

  it("bounds transcript deltas at complete JSONL boundaries and recovers partial and oversized records", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const transcriptPath = path.join(projectRoot, "transcripts", "bounded-chat.chat.jsonl");
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    fs.writeFileSync(transcriptPath, "", "utf8");
    const session = {
      id: "bounded-chat",
      laneId: "lane-1",
      transcriptPath,
      status: "running",
      runtimeState: "running",
      lastOutputPreview: "",
    };
    const logger = createDiscoveryLogger();
    const base = createHostArgs(projectRoot, []);
    const host = createSyncHostService({
      ...base,
      logger,
      pollIntervalMs: 100,
      projectId: "project-1",
      db: {
        sync: {
          getSiteId: () => "site-host-bounded-chat",
          getDbVersion: () => 0,
          exportChangesSince: () => [],
          applyChanges: () => ({ appliedCount: 0 }),
          discardUnpublishedChangesForTables: () => {},
        },
      },
      deviceRegistryService: {
        ...base.deviceRegistryService,
        upsertPeerMetadata: vi.fn(),
      },
      sessionService: {
        list: () => [session],
        get: (id: string) => id === session.id ? session : null,
        readTranscriptTail: async () => "",
      },
      agentChatService: {
        subscribeToEvents: vi.fn().mockReturnValue(() => {}),
        getChatEventHistory: vi.fn().mockReturnValue({
          sessionId: session.id,
          events: [],
          truncated: false,
          transcriptTruncated: false,
          windowTruncated: false,
          sessionFound: true,
        }),
        getSessionSummary: vi.fn().mockResolvedValue({ status: "active" }),
      },
    } as unknown as Parameters<typeof createSyncHostService>[0]);
    let peer: Awaited<ReturnType<typeof connectPeer>> | null = null;
    let openSpy: { mockRestore(): void } | null = null;
    let releaseSecondRead = () => {};

    const event = (sequence: number, text: string): AgentChatEventEnvelope => ({
      sessionId: session.id,
      timestamp: new Date(Date.UTC(2026, 6, 22, 11, 0, sequence)).toISOString(),
      sequence,
      event: { type: "text", text },
    });
    const line = (entry: AgentChatEventEnvelope): Buffer =>
      Buffer.from(`${JSON.stringify(entry)}\n`, "utf8");
    const deliveredSequences = (): number[] => (peer?.envelopes ?? [])
      .filter((entry) => entry.type === "chat_event")
      .map((entry) => Number((entry.payload as AgentChatEventEnvelope).sequence));

    try {
      const port = await host.waitUntilListening();
      peer = await connectPeer(port, host.getBootstrapToken(), "bounded-chat-peer");
      peer.ws.send(encodeSyncEnvelope({
        type: "chat_subscribe",
        requestId: "bounded-chat-subscribe",
        projectId: "project-1",
        payload: { sessionId: session.id },
      }));
      await waitForEnvelope(peer.envelopes, "chat_subscribe", "bounded-chat-subscribe");

      const largeText = "🙂".repeat(18_000);
      const completeLines = [line(event(1, largeText)), line(event(2, largeText)), line(event(3, largeText))];
      expect(completeLines[0].length).toBeLessThan(SYNC_HOST_CHAT_TRANSCRIPT_DELTA_MAX_BYTES);
      expect(completeLines[0].length + completeLines[1].length).toBeGreaterThan(
        SYNC_HOST_CHAT_TRANSCRIPT_DELTA_MAX_BYTES,
      );
      const partialLine = line(event(4, "split-🙂-record"));
      const emojiOffset = partialLine.indexOf(Buffer.from("🙂", "utf8"));
      expect(emojiOffset).toBeGreaterThan(0);
      const splitOffset = emojiOffset + 2;

      const realOpen = fs.promises.open.bind(fs.promises);
      let openCount = 0;
      let markSecondReadStarted = () => {};
      const secondReadStarted = new Promise<void>((resolve) => {
        markSecondReadStarted = resolve;
      });
      let markPartialRetryStarted = () => {};
      const partialRetryStarted = new Promise<void>((resolve) => {
        markPartialRetryStarted = resolve;
      });
      const secondReadGate = new Promise<void>((resolve) => {
        releaseSecondRead = resolve;
      });
      openSpy = vi.spyOn(fs.promises, "open").mockImplementation((async (
        ...openArgs: Parameters<typeof fs.promises.open>
      ) => {
        if (String(openArgs[0]) === transcriptPath) {
          openCount += 1;
          if (openCount === 2) {
            markSecondReadStarted();
            await secondReadGate;
          } else if (openCount === 4) {
            markPartialRetryStarted();
          }
        }
        return realOpen(...openArgs);
      }) as typeof fs.promises.open);

      fs.writeFileSync(
        transcriptPath,
        Buffer.concat([...completeLines, partialLine.subarray(0, splitOffset)]),
      );
      await secondReadStarted;
      await waitForValue(
        () => deliveredSequences().length === 1 ? true : null,
        "first bounded transcript chunk",
      );
      expect(deliveredSequences()).toEqual([1]);

      releaseSecondRead();
      await partialRetryStarted;
      await waitForValue(
        () => deliveredSequences().length === 3 ? true : null,
        "three complete bounded transcript records",
      );
      expect(deliveredSequences()).toEqual([1, 2, 3]);
      fs.appendFileSync(transcriptPath, partialLine.subarray(splitOffset));
      await waitForValue(
        () => deliveredSequences().includes(4) ? true : null,
        "UTF-8 split transcript record recovery",
      );

      const oversized = line(event(
        5,
        "x".repeat(SYNC_HOST_CHAT_TRANSCRIPT_MAX_RECORD_BYTES + 1_024),
      ));
      const recovered = line(event(6, "record after explicit oversized recovery"));
      fs.appendFileSync(transcriptPath, Buffer.concat([oversized, recovered]));
      await waitForValue(
        () => deliveredSequences().includes(6) ? true : null,
        "record after oversized transcript recovery",
      );
      expect(deliveredSequences()).toEqual([1, 2, 3, 4, 6]);
      expect(logger.warn).toHaveBeenCalledWith(
        "sync_host.chat_transcript_record_too_large",
        expect.objectContaining({
          peerDeviceId: "bounded-chat-peer",
          sessionId: session.id,
          recordBytes: oversized.length,
          maxRecordBytes: SYNC_HOST_CHAT_TRANSCRIPT_MAX_RECORD_BYTES,
        }),
      );
    } finally {
      releaseSecondRead();
      openSpy?.mockRestore();
      peer?.ws.close();
      await host.dispose();
      cleanup();
    }
  });

  it("replays a chat event whose optional live send was backpressured", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const transcriptPath = path.join(projectRoot, "transcripts", "chat-replay.chat.jsonl");
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    fs.writeFileSync(transcriptPath, "", "utf8");
    const session = {
      id: "chat-replay",
      laneId: "lane-1",
      transcriptPath,
      status: "running",
      runtimeState: "running",
      lastOutputPreview: "",
    };
    const chatEventEmitter: { current?: (event: AgentChatEventEnvelope) => void } = {};
    const base = createHostArgs(projectRoot, []);
    const host = createSyncHostService({
      ...base,
      pollIntervalMs: 60_000,
      projectId: "project-1",
      db: {
        sync: {
          getSiteId: () => "site-host-chat-replay",
          getDbVersion: () => 0,
          exportChangesSince: () => [],
          applyChanges: () => ({ appliedCount: 0 }),
          discardUnpublishedChangesForTables: () => {},
        },
      },
      deviceRegistryService: {
        ...base.deviceRegistryService,
        upsertPeerMetadata: vi.fn(),
      },
      sessionService: {
        list: () => [session],
        get: (id: string) => (id === "chat-replay" ? session : null),
        readTranscriptTail: async () => "",
      },
      agentChatService: {
        subscribeToEvents: vi.fn((callback: (event: AgentChatEventEnvelope) => void) => {
          chatEventEmitter.current = callback;
          return () => {};
        }),
        getChatEventHistory: vi.fn().mockReturnValue({
          sessionId: "chat-replay",
          events: [],
          truncated: false,
          transcriptTruncated: false,
          windowTruncated: false,
          sessionFound: true,
        }),
        getSessionSummary: vi.fn().mockResolvedValue({ status: "active" }),
      },
    } as unknown as Parameters<typeof createSyncHostService>[0]);
    let peer: Awaited<ReturnType<typeof connectPeer>> | null = null;
    let bufferedAmountSpy: { mockRestore(): void } | null = null;

    try {
      const port = await host.waitUntilListening();
      peer = await connectPeer(port, host.getBootstrapToken(), "ios-chat-replay");
      peer.ws.send(encodeSyncEnvelope({
        type: "chat_subscribe",
        requestId: "chat-subscribe-initial",
        payload: { sessionId: "chat-replay" },
      }));
      await waitForEnvelope(peer.envelopes, "chat_subscribe", "chat-subscribe-initial");

      const firstEvent: AgentChatEventEnvelope = {
        sessionId: "chat-replay",
        timestamp: "2026-04-23T10:00:00.000Z",
        sequence: 1,
        event: { type: "text", text: "first live text" },
      };
      chatEventEmitter.current?.(firstEvent);
      await waitForValue(
        () => peer?.envelopes.find((envelope) =>
          envelope.type === "chat_event"
          && (envelope.payload as { event?: { text?: string } }).event?.text === "first live text"
        ),
        "first live chat event",
      );

      const secondEvent: AgentChatEventEnvelope = {
        sessionId: "chat-replay",
        timestamp: "2026-04-23T10:00:01.000Z",
        sequence: 2,
        event: { type: "text", text: "second replay text" },
      };
      bufferedAmountSpy = vi
        .spyOn(WebSocket.prototype, "bufferedAmount", "get")
        // `broadcastChatEvent` first checks peer backpressure, then `send`
        // checks the raw socket. Recreate the race where the peer looked
        // writable but the optional chat_event send itself was dropped.
        .mockReturnValueOnce(0)
        .mockReturnValue(4 * 1024 * 1024);
      chatEventEmitter.current?.(secondEvent);
      bufferedAmountSpy.mockRestore();
      bufferedAmountSpy = null;
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(peer.envelopes.filter((envelope) => envelope.type === "chat_event")).toHaveLength(1);

      peer.ws.send(encodeSyncEnvelope({
        type: "chat_subscribe",
        requestId: "chat-subscribe-resume",
        payload: { sessionId: "chat-replay", sinceSeq: 1 },
      }));
      await waitForEnvelope(peer.envelopes, "chat_subscribe", "chat-subscribe-resume");
      const replayed = await waitForValue(
        () => peer?.envelopes.find((envelope) =>
          envelope.type === "chat_event"
          && (envelope.payload as { event?: { text?: string } }).event?.text === "second replay text"
        ),
        "replayed backpressured chat event",
      );
      expect(replayed.payload).toMatchObject({ seq: 2 });
    } finally {
      bufferedAmountSpy?.mockRestore();
      try {
        peer?.ws.close();
      } catch {
        // ignore
      }
      await host.dispose();
      cleanup();
    }
  });

  it("retries transcript-pump chat events after a backpressured optional send", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const transcriptPath = path.join(projectRoot, "transcripts", "chat-pump.chat.jsonl");
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    fs.writeFileSync(transcriptPath, "", "utf8");
    const session = {
      id: "chat-pump",
      laneId: "lane-1",
      transcriptPath,
      status: "running",
      runtimeState: "running",
      lastOutputPreview: "",
    };
    const base = createHostArgs(projectRoot, []);
    const host = createSyncHostService({
      ...base,
      pollIntervalMs: 25,
      projectId: "project-1",
      db: {
        sync: {
          getSiteId: () => "site-host-chat-pump",
          getDbVersion: () => 0,
          exportChangesSince: () => [],
          applyChanges: () => ({ appliedCount: 0 }),
          discardUnpublishedChangesForTables: () => {},
        },
      },
      deviceRegistryService: {
        ...base.deviceRegistryService,
        upsertPeerMetadata: vi.fn(),
      },
      sessionService: {
        list: () => [session],
        get: (id: string) => (id === "chat-pump" ? session : null),
        readTranscriptTail: async () => "",
      },
      agentChatService: {
        subscribeToEvents: vi.fn().mockReturnValue(() => {}),
        getChatEventHistory: vi.fn().mockReturnValue({
          sessionId: "chat-pump",
          events: [],
          truncated: false,
          transcriptTruncated: false,
          windowTruncated: false,
          sessionFound: true,
        }),
        getSessionSummary: vi.fn().mockResolvedValue({ status: "active" }),
      },
    } as unknown as Parameters<typeof createSyncHostService>[0]);
    let peer: Awaited<ReturnType<typeof connectPeer>> | null = null;
    let bufferedAmountSpy: { mockRestore(): void } | null = null;

    try {
      const port = await host.waitUntilListening();
      peer = await connectPeer(port, host.getBootstrapToken(), "ios-chat-pump");
      peer.ws.send(encodeSyncEnvelope({
        type: "chat_subscribe",
        requestId: "chat-pump-subscribe",
        payload: { sessionId: "chat-pump" },
      }));
      await waitForEnvelope(peer.envelopes, "chat_subscribe", "chat-pump-subscribe");

      const pumpedEvent: AgentChatEventEnvelope = {
        sessionId: "chat-pump",
        timestamp: "2026-04-23T10:00:02.000Z",
        sequence: 1,
        event: { type: "text", text: "pump retry text" },
      };
      fs.appendFileSync(transcriptPath, `${JSON.stringify(pumpedEvent)}\n`, "utf8");

      let bufferedAmountReads = 0;
      bufferedAmountSpy = vi
        .spyOn(WebSocket.prototype, "bufferedAmount", "get")
        .mockImplementation(() => {
          bufferedAmountReads += 1;
          return bufferedAmountReads === 1 ? 0 : 4 * 1024 * 1024;
        });
      await waitForValue(
        () => bufferedAmountReads >= 2 ? true : undefined,
        "backpressured transcript chat event send",
      );
      bufferedAmountSpy.mockRestore();
      bufferedAmountSpy = null;

      const delivered = await waitForValue(
        () => peer?.envelopes.find((envelope) =>
          envelope.type === "chat_event"
          && (envelope.payload as { event?: { text?: string } }).event?.text === "pump retry text"
        ),
        "retried transcript chat event",
      );
      expect(delivered.payload).toMatchObject({ seq: 1 });
    } finally {
      bufferedAmountSpy?.mockRestore();
      try {
        peer?.ws.close();
      } catch {
        // ignore
      }
      await host.dispose();
      cleanup();
    }
  });
});


describe("chat event replay buffer (resumable chat streams)", () => {
  const sessionId = "session-replay";

  function chatEnvelope(sequence: number, text = `event-${sequence}`, session = sessionId): AgentChatEventEnvelope {
    return {
      sessionId: session,
      timestamp: new Date(1_700_000_000_000 + sequence * 1_000).toISOString(),
      sequence,
      event: { type: "text", text } as AgentChatEventEnvelope["event"],
    };
  }

  it("assigns monotonically increasing seqs and dedupes by delivery key", () => {
    const buffer = createChatEventReplayBuffer();
    const first = chatEnvelope(1);
    expect(recordChatEventInReplayBuffer(buffer, first)).toBe(1);
    expect(recordChatEventInReplayBuffer(buffer, chatEnvelope(2))).toBe(2);
    // Same logical event observed again (live broadcast + transcript pump)
    // must resolve to the seq already assigned, not mint a new one.
    expect(recordChatEventInReplayBuffer(buffer, first)).toBe(1);
    expect(buffer.latestSeq).toBe(2);
    expect(buffer.entries.map((entry) => entry.seq)).toEqual([1, 2]);
  });

  it("continues above a rehydrated host high-water without reusing a session seq", () => {
    const beforeHydration = createChatEventReplayBuffer();
    expect(recordChatEventInReplayBuffer(beforeHydration, chatEnvelope(40))).toBe(40);

    const afterHydration = createChatEventReplayBuffer(beforeHydration.latestSeq);
    // Even a legacy/reset source envelope cannot make the new host reuse 40.
    const resetSourceEvent = chatEnvelope(1, "first event after host hydration");
    expect(recordChatEventInReplayBuffer(afterHydration, resetSourceEvent)).toBe(41);
    expect(new Set([
      `${sessionId}:${beforeHydration.entries[0]!.seq}`,
      `${sessionId}:${afterHydration.entries[0]!.seq}`,
    ]).size).toBe(2);
    expect(afterHydration.latestSeq).toBe(41);
  });

  it("keeps legacy event envelopes compatible while using durable sequence floors when present", () => {
    const legacy = chatEnvelope(1) as AgentChatEventEnvelope & { sequence?: number };
    delete legacy.sequence;
    const legacyBuffer = createChatEventReplayBuffer();
    expect(recordChatEventInReplayBuffer(legacyBuffer, legacy)).toBe(1);

    const modernBuffer = createChatEventReplayBuffer();
    expect(recordChatEventInReplayBuffer(modernBuffer, chatEnvelope(73))).toBe(73);
    expect(modernBuffer.entries[0]?.event).not.toHaveProperty("seq");
  });

  it("falls back to snapshot for a fresh subscribe without sinceSeq", () => {
    const buffer = createChatEventReplayBuffer();
    recordChatEventInReplayBuffer(buffer, chatEnvelope(1));
    expect(planChatEventResume(buffer, undefined)).toEqual({ mode: "snapshot" });
    expect(planChatEventResume(buffer, null)).toEqual({ mode: "snapshot" });
    expect(planChatEventResume(buffer, "3")).toEqual({ mode: "snapshot" });
    expect(planChatEventResume(buffer, -1)).toEqual({ mode: "snapshot" });
    expect(planChatEventResume(buffer, 1.5)).toEqual({ mode: "snapshot" });
    // No buffer for the session at all (e.g. host restart) → snapshot.
    expect(planChatEventResume(undefined, 3)).toEqual({ mode: "snapshot" });
  });

  it("replays exactly the missed events when the buffer covers the gap", () => {
    const buffer = createChatEventReplayBuffer();
    for (let index = 1; index <= 6; index += 1) {
      recordChatEventInReplayBuffer(buffer, chatEnvelope(index));
    }
    const plan = planChatEventResume(buffer, 3);
    expect(plan.mode).toBe("replay");
    if (plan.mode !== "replay") throw new Error("expected replay");
    expect(plan.entries.map((entry) => entry.seq)).toEqual([4, 5, 6]);
    // sinceSeq of 0 resumes from the very beginning while the buffer is intact.
    const fromStart = planChatEventResume(buffer, 0);
    if (fromStart.mode !== "replay") throw new Error("expected replay");
    expect(fromStart.entries.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("replays nothing when the client is already current", () => {
    const buffer = createChatEventReplayBuffer();
    recordChatEventInReplayBuffer(buffer, chatEnvelope(1));
    recordChatEventInReplayBuffer(buffer, chatEnvelope(2));
    expect(planChatEventResume(buffer, 2)).toEqual({ mode: "replay", entries: [] });
  });

  it("falls back to snapshot when the gap predates the ring buffer", () => {
    const buffer = createChatEventReplayBuffer();
    for (let index = 1; index <= CHAT_EVENT_REPLAY_MAX_EVENTS + 10; index += 1) {
      recordChatEventInReplayBuffer(buffer, chatEnvelope(index));
    }
    expect(buffer.entries.length).toBe(CHAT_EVENT_REPLAY_MAX_EVENTS);
    const oldestBuffered = buffer.entries[0]!.seq;
    // Client last saw an event that has been evicted → cannot prove
    // continuity → snapshot.
    expect(planChatEventResume(buffer, oldestBuffered - 2)).toEqual({ mode: "snapshot" });
    // But the boundary case (sinceSeq + 1 is still buffered) replays fine.
    const boundary = planChatEventResume(buffer, oldestBuffered - 1);
    expect(boundary.mode).toBe("replay");
    if (boundary.mode !== "replay") throw new Error("expected replay");
    expect(boundary.entries[0]!.seq).toBe(oldestBuffered);
    expect(boundary.entries.at(-1)!.seq).toBe(buffer.latestSeq);
  });

  it("falls back to snapshot when sinceSeq is from a newer epoch than the buffer", () => {
    const buffer = createChatEventReplayBuffer();
    recordChatEventInReplayBuffer(buffer, chatEnvelope(1));
    // e.g. host restarted and reset its counter; the client's watermark is
    // ahead of everything the host has ever assigned.
    expect(planChatEventResume(buffer, 42)).toEqual({ mode: "snapshot" });
  });

  it("evicts oldest events when the byte budget is exceeded", () => {
    const buffer = createChatEventReplayBuffer();
    const bigText = "x".repeat(900_000);
    recordChatEventInReplayBuffer(buffer, chatEnvelope(1, bigText));
    recordChatEventInReplayBuffer(buffer, chatEnvelope(2, bigText));
    recordChatEventInReplayBuffer(buffer, chatEnvelope(3, bigText));
    expect(buffer.totalBytes).toBeLessThanOrEqual(CHAT_EVENT_REPLAY_MAX_BYTES);
    expect(buffer.entries[0]!.seq).toBeGreaterThan(1);
    expect(buffer.latestSeq).toBe(3);
    // The evicted event forces a snapshot for clients that far behind…
    expect(planChatEventResume(buffer, 0)).toEqual({ mode: "snapshot" });
    // …while recent clients still resume.
    const plan = planChatEventResume(buffer, buffer.entries[0]!.seq);
    expect(plan.mode).toBe("replay");
  });

  it("compacts oversized inline images in sync envelopes without mutating desktop events", () => {
    const imageDataUrl = `data:image/png;base64,${"A".repeat(80 * 1024)}`;
    const generated: AgentChatEventEnvelope = {
      sessionId,
      timestamp: "2026-07-09T00:00:00.000Z",
      sequence: 1,
      event: {
        type: "codex_image_generation",
        itemId: "generated-image",
        result: imageDataUrl,
        savedPath: imageDataUrl,
        status: "completed",
      },
    };
    const viewed: AgentChatEventEnvelope = {
      sessionId,
      timestamp: "2026-07-09T00:00:01.000Z",
      sequence: 2,
      event: {
        type: "codex_image_view",
        itemId: "viewed-image",
        url: imageDataUrl,
        path: imageDataUrl,
        status: "completed",
      },
    };

    const compactedGenerated = compactChatEventEnvelopeForSync(generated);
    const compactedViewed = compactChatEventEnvelopeForSync(viewed);

    expect(compactedGenerated.event).toMatchObject({
      type: "codex_image_generation",
      result: null,
      savedPath: null,
      resultOriginalBytes: Buffer.byteLength(imageDataUrl, "utf8"),
      resultOmittedBytes: Buffer.byteLength(imageDataUrl, "utf8"),
    });
    expect(compactedViewed.event).toMatchObject({
      type: "codex_image_view",
      url: null,
      path: null,
      urlOriginalBytes: Buffer.byteLength(imageDataUrl, "utf8"),
      urlOmittedBytes: Buffer.byteLength(imageDataUrl, "utf8"),
    });
    expect(generated.event).toMatchObject({ result: imageDataUrl, savedPath: imageDataUrl });
    expect(viewed.event).toMatchObject({ url: imageDataUrl, path: imageDataUrl });
    expect(JSON.stringify(compactedGenerated)).not.toContain("A".repeat(1024));
    expect(JSON.stringify(compactedViewed)).not.toContain("A".repeat(1024));
  });

  it("redacts nested tool-result images while preserving small and ordinary values", () => {
    const largeImage = `data:image/png;base64,${"C".repeat(80 * 1024)}`;
    const smallImage = "data:image/png;base64,AAAA";
    const result = {
      output: {
        images: [largeImage, smallImage],
        message: "generated two previews",
      },
      count: 2,
    };
    const desktopEnvelope: AgentChatEventEnvelope = {
      sessionId,
      timestamp: "2026-07-09T00:00:02.000Z",
      sequence: 3,
      event: {
        type: "tool_result",
        tool: "mcp__images__generate",
        itemId: "tool-result-image",
        result,
        status: "completed",
      },
    };

    const compacted = compactChatEventEnvelopeForSync(desktopEnvelope);
    expect(compacted.event).toMatchObject({
      type: "tool_result",
      result: {
        output: {
          images: [
            `[ADE] Inline image data omitted from mobile chat sync (${Buffer.byteLength(largeImage, "utf8")} bytes).`,
            smallImage,
          ],
          message: "generated two previews",
        },
        count: 2,
      },
      resultOriginalBytes: Buffer.byteLength(JSON.stringify(result), "utf8"),
      resultOmittedBytes: Buffer.byteLength(largeImage, "utf8"),
    });
    expect(desktopEnvelope.event).toMatchObject({ result });
    expect((desktopEnvelope.event as { result: unknown }).result).toBe(result);
    expect(JSON.stringify(compacted)).not.toContain("C".repeat(1024));

    const smallOnly: AgentChatEventEnvelope = {
      ...desktopEnvelope,
      sequence: 4,
      event: {
        type: "tool_result",
        tool: "mcp__images__generate",
        itemId: "tool-result-small-image",
        result: { image: smallImage, message: "keep me" },
        status: "completed",
      },
    };
    expect(compactChatEventEnvelopeForSync(smallOnly)).toBe(smallOnly);
  });

  it("retains only compacted image envelopes in the mobile replay ring", () => {
    const buffer = createChatEventReplayBuffer();
    const imageDataUrl = `data:image/png;base64,${"B".repeat(900_000)}`;
    const desktopEnvelope: AgentChatEventEnvelope = {
      sessionId,
      timestamp: "2026-07-09T00:00:00.000Z",
      sequence: 1,
      event: {
        type: "codex_image_generation",
        itemId: "droid-image",
        result: imageDataUrl,
        status: "completed",
      },
    };

    expect(recordChatEventInReplayBuffer(buffer, desktopEnvelope)).toBe(1);
    expect(buffer.entries).toHaveLength(1);
    expect(buffer.totalBytes).toBeLessThan(2_000);
    expect(buffer.entries[0]!.event.event).toMatchObject({
      type: "codex_image_generation",
      result: null,
      resultOriginalBytes: Buffer.byteLength(imageDataUrl, "utf8"),
      resultOmittedBytes: Buffer.byteLength(imageDataUrl, "utf8"),
    });
    expect(desktopEnvelope.event).toMatchObject({ result: imageDataUrl });
  });

  it("retains only redacted nested tool results in the mobile replay ring", () => {
    const buffer = createChatEventReplayBuffer();
    const imageDataUrl = `data:image/jpeg;base64,${"D".repeat(900_000)}`;
    const result = { response: { content: [{ type: "image", data: imageDataUrl }] } };
    const desktopEnvelope: AgentChatEventEnvelope = {
      sessionId,
      timestamp: "2026-07-09T00:00:03.000Z",
      sequence: 1,
      event: {
        type: "tool_result",
        tool: "mcp__computer__screenshot",
        itemId: "nested-image-tool-result",
        result,
        status: "completed",
      },
    };

    expect(recordChatEventInReplayBuffer(buffer, desktopEnvelope)).toBe(1);
    expect(buffer.entries).toHaveLength(1);
    expect(buffer.totalBytes).toBeLessThan(2_000);
    expect(buffer.entries[0]!.event.event).toMatchObject({
      type: "tool_result",
      resultOmittedBytes: Buffer.byteLength(imageDataUrl, "utf8"),
    });
    expect(JSON.stringify(buffer.entries[0]!.event)).not.toContain("D".repeat(1024));
    expect((desktopEnvelope.event as { result: unknown }).result).toBe(result);
    expect(JSON.stringify(desktopEnvelope)).toContain("D".repeat(1024));
  });
});

describe("terminal byte-offset streaming, history paging, and resize ownership", () => {
  // 5000 ASCII bytes so byte offsets equal string indices in assertions.
  const TRANSCRIPT_CONTENT = "0123456789".repeat(500);

  beforeEach(() => {
    publishMock.mockReset();
    spawnMock.mockReset();
    bonjourDestroyMock.mockReset();
    bonjourConstructorMock.mockReset();
    spawnMock.mockImplementation(() => ({ kill: vi.fn(), once: vi.fn(), unref: vi.fn() }));
  });

  function createTerminalHost(projectRoot: string) {
    const transcriptPath = path.join(projectRoot, "transcripts", "session-1.log");
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    fs.writeFileSync(transcriptPath, TRANSCRIPT_CONTENT);
    const session = {
      id: "session-1",
      laneId: "lane-1",
      transcriptPath,
      status: "running",
      runtimeState: "running",
      lastOutputPreview: "preview",
    };
    const readTranscriptTail = vi.fn(async () => "tail-snapshot");
    const readTranscriptSnapshot = vi.fn(async (args: { sessionId: string; maxBytes: number }) => {
      const endOffset = Buffer.byteLength(TRANSCRIPT_CONTENT, "utf8");
      const startOffset = Math.max(0, endOffset - args.maxBytes);
      return {
        data: TRANSCRIPT_CONTENT.slice(startOffset),
        startOffset,
        endOffset,
      };
    });
    const readTranscriptRange = vi.fn(async (args: { sessionId: string; startOffset: number; endOffset: number }) => ({
      data: TRANSCRIPT_CONTENT.slice(args.startOffset, args.endOffset),
      startOffset: args.startOffset,
      endOffset: args.endOffset,
    }));
    const getTranscriptWindow = vi.fn(() => ({
      startOffset: 0,
      endOffset: Buffer.byteLength(TRANSCRIPT_CONTENT, "utf8"),
      retainedBytes: Buffer.byteLength(TRANSCRIPT_CONTENT, "utf8"),
    }));
    const resizeBySessionId = vi.fn().mockReturnValue(true);
    const restoreDesktopSizeBySessionId = vi.fn().mockReturnValue(true);
    const hasLivePty = vi.fn().mockReturnValue(true);
    const writeBySessionId = vi.fn().mockReturnValue(true);
    let sessionAvailable = true;
    const base = createHostArgs(projectRoot, []);
    const host = createSyncHostService({
      ...base,
      projectId: "project-1",
      db: {
        sync: {
          getSiteId: () => "site-host-terminal",
          getDbVersion: () => 0,
          exportChangesSince: () => [],
          applyChanges: () => ({ appliedCount: 0 }),
          discardUnpublishedChangesForTables: () => {},
        },
      },
      deviceRegistryService: {
        ...base.deviceRegistryService,
        upsertPeerMetadata: vi.fn(),
      },
      sessionService: {
        list: () => [session],
        get: (id: string) => (sessionAvailable && id === "session-1" ? session : null),
        readTranscriptTail: async () => "",
      },
      ptyService: {
        create: vi.fn(),
        readTranscriptTail,
        readTranscriptSnapshot,
        readTranscriptRange,
        getTranscriptWindow,
        writeBySessionId,
        resizeBySessionId,
        restoreDesktopSizeBySessionId,
        hasLivePty,
        enrichSessions: (rows: unknown[]) => rows,
      },
    } as unknown as Parameters<typeof createSyncHostService>[0]);
    return {
      host,
      readTranscriptTail,
      readTranscriptSnapshot,
      readTranscriptRange,
      getTranscriptWindow,
      writeBySessionId,
      resizeBySessionId,
      restoreDesktopSizeBySessionId,
      hasLivePty,
      setSessionAvailable: (available: boolean) => { sessionAvailable = available; },
    };
  }

  async function connectTerminalPeer(port: number, token: string, deviceId: string) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const tracked = trackClientEnvelopes(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    ws.send(encodeSyncEnvelope({
      type: "hello",
      payload: {
        peer: {
          deviceId,
          deviceName: deviceId,
          platform: "iOS",
          deviceType: "phone",
          siteId: `${deviceId}-site`,
          dbVersion: 0,
        },
        auth: { kind: "bootstrap", token },
      },
    }));
    await waitForValue(
      () => tracked.envelopes.find((envelope) => envelope.type === "hello_ok"),
      `hello_ok for ${deviceId}`,
    );
    return { ws, ...tracked };
  }

  function nextResponse(envelopes: ParsedSyncEnvelope[], type: string, requestId: string) {
    return waitForValue(
      () => envelopes.find((envelope) => envelope.type === type && envelope.requestId === requestId),
      `${type} response ${requestId}`,
    );
  }

  it("answers terminal_subscribe with a delta when sinceOffset fits the budget, else a tail snapshot with offsets", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const { host, readTranscriptTail, readTranscriptSnapshot, readTranscriptRange } = createTerminalHost(projectRoot);
    let client: Awaited<ReturnType<typeof connectTerminalPeer>> | null = null;
    try {
      const port = await host.waitUntilListening();
      client = await connectTerminalPeer(port, host.getBootstrapToken(), "ios-terminal-1");

      client.ws.send(encodeSyncEnvelope({
        type: "terminal_subscribe",
        requestId: "sub-delta",
        payload: { sessionId: "session-1", maxBytes: 32_000, sinceOffset: 4_988 },
      }));
      const delta = await nextResponse(client.envelopes, "terminal_snapshot", "sub-delta");
      expect(delta.payload).toMatchObject({
        sessionId: "session-1",
        transcript: TRANSCRIPT_CONTENT.slice(4_988),
        delta: true,
        startOffset: 4_988,
        endOffset: 5_000,
      });
      expect(readTranscriptSnapshot).toHaveBeenCalledWith({
        sessionId: "session-1",
        maxBytes: 32_000,
        alignStartToSafeBoundary: true,
      });
      expect(readTranscriptRange).not.toHaveBeenCalled();
      expect(readTranscriptTail).not.toHaveBeenCalled();

      // Gap larger than the budget → full tail snapshot (delta omitted).
      client.ws.send(encodeSyncEnvelope({
        type: "terminal_subscribe",
        requestId: "sub-full",
        payload: { sessionId: "session-1", maxBytes: 1_024, sinceOffset: 0 },
      }));
      const full = await nextResponse(client.envelopes, "terminal_snapshot", "sub-full");
      expect(full.payload).toMatchObject({
        sessionId: "session-1",
        transcript: TRANSCRIPT_CONTENT.slice(5_000 - 1_024),
        startOffset: 5_000 - 1_024,
        endOffset: 5_000,
      });
      expect((full.payload as { delta?: boolean }).delta).toBeUndefined();
      expect(readTranscriptTail).not.toHaveBeenCalled();

      // sinceOffset beyond the transcript end (host restarted with a fresh
      // file, client watermark stale) → full snapshot, not a delta.
      client.ws.send(encodeSyncEnvelope({
        type: "terminal_subscribe",
        requestId: "sub-stale",
        payload: { sessionId: "session-1", maxBytes: 32_000, sinceOffset: 9_999 },
      }));
      const stale = await nextResponse(client.envelopes, "terminal_snapshot", "sub-stale");
      expect((stale.payload as { delta?: boolean }).delta).toBeUndefined();
      expect((stale.payload as { transcript: string }).transcript).toBe(TRANSCRIPT_CONTENT);

      readTranscriptSnapshot.mockResolvedValueOnce({
        data: `${TRANSCRIPT_CONTENT}buffered`,
        startOffset: 0,
        endOffset: 5_008,
      });
      client.ws.send(encodeSyncEnvelope({
        type: "terminal_subscribe",
        requestId: "sub-buffered",
        payload: { sessionId: "session-1", maxBytes: 1_024, sinceOffset: 0 },
      }));
      const buffered = await nextResponse(client.envelopes, "terminal_snapshot", "sub-buffered");
      expect(buffered.payload).toMatchObject({
        sessionId: "session-1",
        transcript: `${TRANSCRIPT_CONTENT}buffered`,
        startOffset: 0,
        endOffset: 5_008,
      });
    } finally {
      try {
        client?.ws.close();
      } catch {
        // ignore
      }
      await host.dispose();
      cleanup();
    }
  });

  it("replaces with a tail snapshot when sinceOffset already equals the transcript end", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const { host, readTranscriptTail, readTranscriptSnapshot, readTranscriptRange } = createTerminalHost(projectRoot);
    let client: Awaited<ReturnType<typeof connectTerminalPeer>> | null = null;
    try {
      const port = await host.waitUntilListening();
      client = await connectTerminalPeer(port, host.getBootstrapToken(), "ios-terminal-current-offset");
      client.ws.send(encodeSyncEnvelope({
        type: "terminal_subscribe",
        requestId: "sub-current-offset",
        payload: { sessionId: "session-1", maxBytes: 32_000, sinceOffset: 5_000 },
      }));

      const snapshot = await nextResponse(client.envelopes, "terminal_snapshot", "sub-current-offset");
      expect(snapshot.payload).toMatchObject({
        sessionId: "session-1",
        transcript: TRANSCRIPT_CONTENT,
        startOffset: 0,
        endOffset: 5_000,
      });
      expect((snapshot.payload as { delta?: boolean }).delta).toBeUndefined();
      expect(readTranscriptRange).not.toHaveBeenCalled();
      expect(readTranscriptSnapshot).toHaveBeenCalledWith({
        sessionId: "session-1",
        maxBytes: 32_000,
        alignStartToSafeBoundary: true,
      });
      expect(readTranscriptTail).not.toHaveBeenCalled();
    } finally {
      client?.ws.close();
      await host.dispose();
      cleanup();
    }
  });

  it("sends a deferred terminal snapshot before newer data and exit events", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const { host, readTranscriptSnapshot } = createTerminalHost(projectRoot);
    let resolveSnapshot!: (snapshot: { data: string; startOffset: number; endOffset: number }) => void;
    readTranscriptSnapshot.mockImplementationOnce(() => new Promise<{
      data: string;
      startOffset: number;
      endOffset: number;
    }>((resolve) => {
      resolveSnapshot = resolve;
    }));
    let client: Awaited<ReturnType<typeof connectTerminalPeer>> | null = null;
    try {
      client = await connectTerminalPeer(
        await host.waitUntilListening(),
        host.getBootstrapToken(),
        "ios-terminal-snapshot-order",
      );
      client.ws.send(encodeSyncEnvelope({
        type: "terminal_subscribe",
        requestId: "ordered-subscribe",
        payload: { sessionId: "session-1", maxBytes: 32_000 },
      }));
      await waitForValue(
        () => readTranscriptSnapshot.mock.calls.length > 0 ? true : null,
        "deferred terminal snapshot capture",
      );

      host.handlePtyData({
        sessionId: "session-1",
        ptyId: "pty-1",
        data: "new",
        offset: 5_003,
      });
      host.handlePtyExit({ sessionId: "session-1", ptyId: "pty-1", exitCode: 0 });
      expect(client.envelopes.some((envelope) => (
        envelope.type === "terminal_snapshot" || envelope.type === "terminal_data" || envelope.type === "terminal_exit"
      ))).toBe(false);

      resolveSnapshot({ data: TRANSCRIPT_CONTENT, startOffset: 0, endOffset: 5_000 });
      await nextResponse(client.envelopes, "terminal_snapshot", "ordered-subscribe");
      await waitForValue(
        () => client!.envelopes.find((envelope) => envelope.type === "terminal_exit"),
        "queued terminal exit",
      );
      const streamed = client.envelopes.filter((envelope) => (
        envelope.type === "terminal_snapshot" || envelope.type === "terminal_data" || envelope.type === "terminal_exit"
      ));
      expect(streamed.map((envelope) => envelope.type)).toEqual([
        "terminal_snapshot",
        "terminal_data",
        "terminal_exit",
      ]);
      expect(streamed[1]!.payload).toMatchObject({ data: "new", offset: 5_003 });
    } finally {
      try { client?.ws.close(); } catch { /* ignore */ }
      await host.dispose();
      cleanup();
    }
  });

  it("does not replay terminal data already covered by a deferred snapshot", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const { host, readTranscriptSnapshot } = createTerminalHost(projectRoot);
    let resolveSnapshot!: (snapshot: { data: string; startOffset: number; endOffset: number }) => void;
    readTranscriptSnapshot.mockImplementationOnce(() => new Promise<{
      data: string;
      startOffset: number;
      endOffset: number;
    }>((resolve) => {
      resolveSnapshot = resolve;
    }));
    let client: Awaited<ReturnType<typeof connectTerminalPeer>> | null = null;
    try {
      client = await connectTerminalPeer(
        await host.waitUntilListening(),
        host.getBootstrapToken(),
        "ios-terminal-snapshot-dedupe",
      );
      client.ws.send(encodeSyncEnvelope({
        type: "terminal_subscribe",
        requestId: "covered-subscribe",
        payload: { sessionId: "session-1", maxBytes: 32_000 },
      }));
      await waitForValue(
        () => readTranscriptSnapshot.mock.calls.length > 0 ? true : null,
        "covered terminal snapshot capture",
      );
      host.handlePtyData({
        sessionId: "session-1",
        ptyId: "pty-1",
        data: "!",
        offset: 5_001,
      });
      resolveSnapshot({ data: `${TRANSCRIPT_CONTENT}!`, startOffset: 0, endOffset: 5_001 });

      const snapshot = await nextResponse(client.envelopes, "terminal_snapshot", "covered-subscribe");
      expect(snapshot.payload).toMatchObject({ transcript: `${TRANSCRIPT_CONTENT}!`, endOffset: 5_001 });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(client.envelopes.filter((envelope) => envelope.type === "terminal_data")).toEqual([]);
    } finally {
      try { client?.ws.close(); } catch { /* ignore */ }
      await host.dispose();
      cleanup();
    }
  });

  it("trims a UTF-8-safe overlap before flushing data queued behind a snapshot", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const { host, readTranscriptSnapshot } = createTerminalHost(projectRoot);
    let resolveSnapshot!: (snapshot: { data: string; startOffset: number; endOffset: number }) => void;
    readTranscriptSnapshot.mockImplementationOnce(() => new Promise<{
      data: string;
      startOffset: number;
      endOffset: number;
    }>((resolve) => {
      resolveSnapshot = resolve;
    }));
    let client: Awaited<ReturnType<typeof connectTerminalPeer>> | null = null;
    try {
      client = await connectTerminalPeer(
        await host.waitUntilListening(),
        host.getBootstrapToken(),
        "ios-terminal-snapshot-utf8-overlap",
      );
      client.ws.send(encodeSyncEnvelope({
        type: "terminal_subscribe",
        requestId: "utf8-overlap-subscribe",
        payload: { sessionId: "session-1", maxBytes: 32_000 },
      }));
      await waitForValue(
        () => readTranscriptSnapshot.mock.calls.length > 0 ? true : null,
        "UTF-8 overlap snapshot capture",
      );
      host.handlePtyData({
        sessionId: "session-1",
        ptyId: "pty-1",
        data: "🙂!",
        offset: 5_005,
      });
      resolveSnapshot({ data: `${TRANSCRIPT_CONTENT}🙂`, startOffset: 0, endOffset: 5_004 });

      await nextResponse(client.envelopes, "terminal_snapshot", "utf8-overlap-subscribe");
      const streamed = await waitForValue(
        () => client!.envelopes.find((envelope) => envelope.type === "terminal_data"),
        "trimmed terminal data",
      );
      expect(streamed.payload).toMatchObject({ data: "!", offset: 5_005 });
    } finally {
      try { client?.ws.close(); } catch { /* ignore */ }
      await host.dispose();
      cleanup();
    }
  });

  it("recaptures before flushing offsetless data queued during a terminal snapshot", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const { host, readTranscriptSnapshot } = createTerminalHost(projectRoot);
    let resolveFirstSnapshot!: (snapshot: { data: string; startOffset: number; endOffset: number }) => void;
    readTranscriptSnapshot
      .mockImplementationOnce(() => new Promise<{
        data: string;
        startOffset: number;
        endOffset: number;
      }>((resolve) => {
        resolveFirstSnapshot = resolve;
      }))
      .mockResolvedValueOnce({ data: TRANSCRIPT_CONTENT, startOffset: 0, endOffset: 5_000 });
    let client: Awaited<ReturnType<typeof connectTerminalPeer>> | null = null;
    try {
      client = await connectTerminalPeer(
        await host.waitUntilListening(),
        host.getBootstrapToken(),
        "ios-terminal-snapshot-offsetless",
      );
      client.ws.send(encodeSyncEnvelope({
        type: "terminal_subscribe",
        requestId: "offsetless-subscribe",
        payload: { sessionId: "session-1", maxBytes: 32_000, sinceOffset: 4_990 },
      }));
      await waitForValue(
        () => readTranscriptSnapshot.mock.calls.length > 0 ? true : null,
        "offsetless terminal snapshot capture",
      );
      host.handlePtyData({
        sessionId: "session-1",
        ptyId: "pty-1",
        data: "untracked",
        offset: null,
      });
      resolveFirstSnapshot({ data: TRANSCRIPT_CONTENT, startOffset: 0, endOffset: 5_000 });

      const snapshot = await nextResponse(client.envelopes, "terminal_snapshot", "offsetless-subscribe");
      await waitForValue(
        () => client!.envelopes.find((envelope) => envelope.type === "terminal_data"),
        "queued offsetless terminal data",
      );
      expect(readTranscriptSnapshot).toHaveBeenCalledTimes(2);
      expect((snapshot.payload as { delta?: boolean }).delta).toBeUndefined();
      const streamed = client.envelopes.filter((envelope) => (
        envelope.type === "terminal_snapshot" || envelope.type === "terminal_data"
      ));
      expect(streamed.map((envelope) => envelope.type)).toEqual(["terminal_snapshot", "terminal_data"]);
      expect(streamed[1]!.payload).toMatchObject({ data: "untracked", offset: null });
    } finally {
      try { client?.ws.close(); } catch { /* ignore */ }
      await host.dispose();
      cleanup();
    }
  });

  it("recaptures an authoritative tail instead of retaining an oversized queued chunk", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const { host, readTranscriptSnapshot } = createTerminalHost(projectRoot);
    const oversizedChunk = "x".repeat(2_000_001);
    const oversizedEndOffset = 5_000 + Buffer.byteLength(oversizedChunk, "utf8");
    let resolveFirstSnapshot!: (snapshot: { data: string; startOffset: number; endOffset: number }) => void;
    readTranscriptSnapshot
      .mockImplementationOnce(() => new Promise<{
        data: string;
        startOffset: number;
        endOffset: number;
      }>((resolve) => {
        resolveFirstSnapshot = resolve;
      }))
      .mockResolvedValueOnce({
        data: oversizedChunk.slice(-2_000_000),
        startOffset: oversizedEndOffset - 2_000_000,
        endOffset: oversizedEndOffset,
      });
    let client: Awaited<ReturnType<typeof connectTerminalPeer>> | null = null;
    try {
      client = await connectTerminalPeer(
        await host.waitUntilListening(),
        host.getBootstrapToken(),
        "ios-terminal-snapshot-overflow",
      );
      client.ws.send(encodeSyncEnvelope({
        type: "terminal_subscribe",
        requestId: "overflow-subscribe",
        payload: { sessionId: "session-1", maxBytes: 2_000_000 },
      }));
      await waitForValue(
        () => readTranscriptSnapshot.mock.calls.length > 0 ? true : null,
        "overflow terminal snapshot capture",
      );
      host.handlePtyData({
        sessionId: "session-1",
        ptyId: "pty-1",
        data: oversizedChunk,
        offset: oversizedEndOffset,
      });
      resolveFirstSnapshot({ data: TRANSCRIPT_CONTENT, startOffset: 0, endOffset: 5_000 });

      const snapshot = await nextResponse(client.envelopes, "terminal_snapshot", "overflow-subscribe");
      expect(readTranscriptSnapshot).toHaveBeenCalledTimes(2);
      expect(snapshot.payload).toMatchObject({
        startOffset: oversizedEndOffset - 2_000_000,
        endOffset: oversizedEndOffset,
      });
      expect(client.envelopes.filter((envelope) => envelope.type === "terminal_data")).toEqual([]);
      expect(client.ws.readyState).toBe(WebSocket.OPEN);
    } finally {
      try { client?.ws.close(); } catch { /* ignore */ }
      await host.dispose();
      cleanup();
    }
  });

  it("keeps subscribe deltas and history paging inside a rolled logical window", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const {
      host,
      readTranscriptSnapshot,
      readTranscriptRange,
      getTranscriptWindow,
    } = createTerminalHost(projectRoot);
    const logicalBase = 10_000;
    const logicalEnd = logicalBase + Buffer.byteLength(TRANSCRIPT_CONTENT, "utf8");
    getTranscriptWindow.mockReturnValue({
      startOffset: logicalBase,
      endOffset: logicalEnd,
      retainedBytes: logicalEnd - logicalBase,
    });
    readTranscriptSnapshot.mockResolvedValue({
      data: TRANSCRIPT_CONTENT,
      startOffset: logicalBase,
      endOffset: logicalEnd,
    });
    readTranscriptRange.mockImplementation(async (args: {
      sessionId: string;
      startOffset: number;
      endOffset: number;
    }) => {
      const clampedStartOffset = Math.max(logicalBase, Math.min(args.startOffset, logicalEnd));
      const endOffset = Math.max(clampedStartOffset, Math.min(args.endOffset, logicalEnd));
      // Model the real UTF-8/screen-safe range reader moving a retained-base
      // request forward to the first safe terminal boundary.
      const startOffset = clampedStartOffset === logicalBase && endOffset > logicalBase
        ? Math.min(logicalBase + 8, endOffset)
        : clampedStartOffset;
      return {
        data: TRANSCRIPT_CONTENT.slice(startOffset - logicalBase, endOffset - logicalBase),
        startOffset,
        endOffset,
      };
    });
    let client: Awaited<ReturnType<typeof connectTerminalPeer>> | null = null;
    try {
      client = await connectTerminalPeer(
        await host.waitUntilListening(),
        host.getBootstrapToken(),
        "ios-terminal-rolled-window",
      );

      // A watermark older than the retained base cannot be resumed. Replace
      // with the authoritative retained suffix and its logical offsets.
      client.ws.send(encodeSyncEnvelope({
        type: "terminal_subscribe",
        requestId: "rolled-stale-subscribe",
        payload: { sessionId: "session-1", maxBytes: 32_000, sinceOffset: 5_000 },
      }));
      await expect(nextResponse(
        client.envelopes,
        "terminal_snapshot",
        "rolled-stale-subscribe",
      )).resolves.toMatchObject({
        payload: {
          transcript: TRANSCRIPT_CONTENT,
          startOffset: logicalBase,
          endOffset: logicalEnd,
        },
      });

      client.ws.send(encodeSyncEnvelope({
        type: "terminal_subscribe",
        requestId: "rolled-delta-subscribe",
        payload: { sessionId: "session-1", maxBytes: 32_000, sinceOffset: logicalEnd - 12 },
      }));
      await expect(nextResponse(
        client.envelopes,
        "terminal_snapshot",
        "rolled-delta-subscribe",
      )).resolves.toMatchObject({
        payload: {
          transcript: TRANSCRIPT_CONTENT.slice(-12),
          startOffset: logicalEnd - 12,
          endOffset: logicalEnd,
          delta: true,
        },
      });

      client.ws.send(encodeSyncEnvelope({
        type: "terminal_history",
        requestId: "rolled-history",
        payload: { sessionId: "session-1", beforeOffset: logicalEnd, maxBytes: 4_096 },
      }));
      const history = await nextResponse(client.envelopes, "terminal_history", "rolled-history");
      expect(readTranscriptRange).toHaveBeenLastCalledWith({
        sessionId: "session-1",
        startOffset: logicalEnd - 4_096,
        endOffset: logicalEnd,
        alignStartToSafeBoundary: true,
      });
      expect(history.payload).toMatchObject({
        startOffset: logicalEnd - 4_096,
        endOffset: logicalEnd,
        atStart: false,
      });

      client.ws.send(encodeSyncEnvelope({
        type: "terminal_history",
        requestId: "rolled-history-start",
        payload: { sessionId: "session-1", beforeOffset: logicalBase },
      }));
      await expect(nextResponse(
        client.envelopes,
        "terminal_history",
        "rolled-history-start",
      )).resolves.toMatchObject({
        payload: {
          data: "",
          startOffset: logicalBase,
          endOffset: logicalBase,
          atStart: true,
        },
      });

      client.ws.send(encodeSyncEnvelope({
        type: "terminal_history",
        requestId: "rolled-history-aligned-start",
        payload: { sessionId: "session-1", beforeOffset: logicalBase + 128, maxBytes: 4_096 },
      }));
      await expect(nextResponse(
        client.envelopes,
        "terminal_history",
        "rolled-history-aligned-start",
      )).resolves.toMatchObject({
        payload: {
          startOffset: logicalBase + 8,
          endOffset: logicalBase + 128,
          atStart: true,
        },
      });
    } finally {
      try { client?.ws.close(); } catch { /* ignore */ }
      await host.dispose();
      cleanup();
    }
  });

  it("serves terminal_history pages to subscribed peers and refuses unsubscribed ones", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const { host, readTranscriptRange } = createTerminalHost(projectRoot);
    let client: Awaited<ReturnType<typeof connectTerminalPeer>> | null = null;
    try {
      const port = await host.waitUntilListening();
      client = await connectTerminalPeer(port, host.getBootstrapToken(), "ios-terminal-2");

      client.ws.send(encodeSyncEnvelope({
        type: "terminal_history",
        requestId: "hist-wrong-project",
        projectId: "project-2",
        payload: { sessionId: "session-1", beforeOffset: 4_000 },
      }));
      const wrongProject = await nextResponse(client.envelopes, "terminal_history", "hist-wrong-project");
      expect(wrongProject.payload).toEqual({
        sessionId: "session-1",
        data: "",
        startOffset: 4_000,
        endOffset: 4_000,
        atStart: true,
      });
      expect(readTranscriptRange).not.toHaveBeenCalled();

      // Not subscribed yet: same access gate as terminal_input.
      client.ws.send(encodeSyncEnvelope({
        type: "terminal_history",
        requestId: "hist-refused",
        payload: { sessionId: "session-1", beforeOffset: 4_000 },
      }));
      const refused = await nextResponse(client.envelopes, "terminal_history", "hist-refused");
      expect(refused.payload).toEqual({
        sessionId: "session-1",
        data: "",
        startOffset: 4_000,
        endOffset: 4_000,
        atStart: true,
      });
      expect(readTranscriptRange).not.toHaveBeenCalled();

      client.ws.send(encodeSyncEnvelope({
        type: "terminal_subscribe",
        requestId: "sub-1",
        payload: { sessionId: "session-1", maxBytes: 32_000 },
      }));
      await nextResponse(client.envelopes, "terminal_snapshot", "sub-1");

      client.ws.send(encodeSyncEnvelope({
        type: "terminal_history",
        requestId: "hist-1",
        payload: { sessionId: "session-1", beforeOffset: 5_000, maxBytes: 4_096 },
      }));
      const page = await nextResponse(client.envelopes, "terminal_history", "hist-1");
      expect(readTranscriptRange).toHaveBeenCalledWith({
        sessionId: "session-1",
        startOffset: 5_000 - 4_096,
        endOffset: 5_000,
        alignStartToSafeBoundary: true,
      });
      expect(page.payload).toEqual({
        sessionId: "session-1",
        data: TRANSCRIPT_CONTENT.slice(904),
        startOffset: 904,
        endOffset: 5_000,
        atStart: false,
      });

      // beforeOffset inside the first page → page starts at 0 and atStart=true.
      client.ws.send(encodeSyncEnvelope({
        type: "terminal_history",
        requestId: "hist-first",
        payload: { sessionId: "session-1", beforeOffset: 800, maxBytes: 4_096 },
      }));
      const firstPage = await nextResponse(client.envelopes, "terminal_history", "hist-first");
      expect(firstPage.payload).toEqual({
        sessionId: "session-1",
        data: TRANSCRIPT_CONTENT.slice(0, 800),
        startOffset: 0,
        endOffset: 800,
        atStart: true,
      });

      // beforeOffset past EOF clamps to the flushed transcript size.
      client.ws.send(encodeSyncEnvelope({
        type: "terminal_history",
        requestId: "hist-clamped",
        payload: { sessionId: "session-1", beforeOffset: 999_999, maxBytes: 4_096 },
      }));
      const clamped = await nextResponse(client.envelopes, "terminal_history", "hist-clamped");
      expect(clamped.payload).toMatchObject({ startOffset: 904, endOffset: 5_000, atStart: false });
    } finally {
      try {
        client?.ws.close();
      } catch {
        // ignore
      }
      await host.dispose();
      cleanup();
    }
  });

  it("ACKs terminal input success, duplicates, collisions, and every typed rejection", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const {
      host,
      writeBySessionId,
      hasLivePty,
      setSessionAvailable,
    } = createTerminalHost(projectRoot);
    let client: Awaited<ReturnType<typeof connectTerminalPeer>> | null = null;
    const ack = (requestId: string) => waitForEnvelope(
      client!.envelopes,
      "terminal_input_ack",
      requestId,
    );
    const sendInput = (
      requestId: string,
      inputId: string | undefined,
      data = "x",
      projectId: string | null = "project-1",
    ): void => {
      client!.ws.send(encodeSyncEnvelope({
        type: "terminal_input",
        requestId,
        projectId,
        payload: {
          sessionId: "session-1",
          data,
          ...(inputId !== undefined ? { inputId } : {}),
        },
      }));
    };
    try {
      client = await connectTerminalPeer(
        await host.waitUntilListening(),
        host.getBootstrapToken(),
        "ios-terminal-input-contract",
      );

      sendInput("invalid-id", " ");
      await expect(ack("invalid-id")).resolves.toMatchObject({
        payload: {
          ok: false,
          duplicate: false,
          error: { code: "invalid_input_id", retryable: false },
        },
      });

      sendInput("not-subscribed", "input-not-subscribed");
      await expect(ack("not-subscribed")).resolves.toMatchObject({
        payload: {
          inputId: "input-not-subscribed",
          ok: false,
          error: { code: "not_subscribed", retryable: true },
        },
      });

      client.ws.send(encodeSyncEnvelope({
        type: "terminal_subscribe",
        requestId: "input-subscribe",
        payload: { sessionId: "session-1", maxBytes: 32_000 },
      }));
      await nextResponse(client.envelopes, "terminal_snapshot", "input-subscribe");

      sendInput("wrong-project", "input-wrong-project", "x", "project-2");
      await expect(ack("wrong-project")).resolves.toMatchObject({
        payload: {
          ok: false,
          error: { code: "project_mismatch", retryable: false },
        },
      });

      setSessionAvailable(false);
      sendInput("missing-session", "input-missing-session");
      await expect(ack("missing-session")).resolves.toMatchObject({
        payload: {
          ok: false,
          error: { code: "project_mismatch", retryable: false },
        },
      });
      setSessionAvailable(true);

      hasLivePty.mockReturnValue(false);
      sendInput("dead-session", "input-dead-session");
      await expect(ack("dead-session")).resolves.toMatchObject({
        payload: {
          ok: false,
          error: { code: "session_not_live", retryable: false },
        },
      });
      hasLivePty.mockReturnValue(true);

      writeBySessionId.mockReturnValueOnce(false);
      sendInput("exit-race", "input-exit-race");
      await expect(ack("exit-race")).resolves.toMatchObject({
        payload: {
          ok: false,
          error: { code: "session_not_live", retryable: false },
        },
      });

      sendInput("written", "input-written", "hello");
      await expect(ack("written")).resolves.toMatchObject({
        payload: {
          sessionId: "session-1",
          inputId: "input-written",
          ok: true,
          duplicate: false,
        },
      });
      // Receipt identity is immutable and wins over mutable session state: a
      // lost success ACK retried after the PTY exits is still a duplicate.
      setSessionAvailable(false);
      sendInput("duplicate", "input-written", "hello");
      await expect(ack("duplicate")).resolves.toMatchObject({
        payload: { ok: true, duplicate: true },
      });
      setSessionAvailable(true);
      sendInput("collision", "input-written", "different");
      await expect(ack("collision")).resolves.toMatchObject({
        payload: {
          ok: false,
          duplicate: false,
          error: { code: "input_id_conflict", retryable: false },
        },
      });

      // Old clients remain write-only: no inputId means no ACK requirement.
      sendInput("legacy-input", undefined, "legacy");
      sendInput("legacy-fence", "input-fence", "fence");
      await ack("legacy-fence");
      expect(client.envelopes.some((envelope) =>
        envelope.type === "terminal_input_ack" && envelope.requestId === "legacy-input"
      )).toBe(false);
      expect(writeBySessionId.mock.calls).toEqual([
        ["session-1", "x"],
        ["session-1", "hello"],
        ["session-1", "legacy"],
        ["session-1", "fence"],
      ]);
    } finally {
      try { client?.ws.close(); } catch { /* ignore */ }
      await host.dispose();
      cleanup();
    }
  });

  it("does not starve terminal writes and ACKs behind a slow queued history command", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const { host, readTranscriptRange, writeBySessionId } = createTerminalHost(projectRoot);
    let client: Awaited<ReturnType<typeof connectTerminalPeer>> | null = null;
    let releaseHistory!: () => void;
    let historyStarted!: () => void;
    const started = new Promise<void>((resolve) => { historyStarted = resolve; });
    const released = new Promise<void>((resolve) => { releaseHistory = resolve; });
    try {
      client = await connectTerminalPeer(
        await host.waitUntilListening(),
        host.getBootstrapToken(),
        "ios-terminal-fast-input",
      );
      client.ws.send(encodeSyncEnvelope({
        type: "terminal_subscribe",
        requestId: "fast-input-subscribe",
        payload: { sessionId: "session-1", maxBytes: 32_000 },
      }));
      await nextResponse(client.envelopes, "terminal_snapshot", "fast-input-subscribe");

      readTranscriptRange.mockImplementationOnce(async () => {
        historyStarted();
        await released;
        return { data: "history", startOffset: 0, endOffset: 7 };
      });
      client.ws.send(encodeSyncEnvelope({
        type: "terminal_history",
        requestId: "slow-history",
        payload: { sessionId: "session-1", beforeOffset: 100 },
      }));
      await started;
      client.ws.send(encodeSyncEnvelope({
        type: "terminal_input",
        requestId: "fast-input",
        payload: { sessionId: "session-1", data: "x", inputId: "fast-input-id" },
      }));

      await expect(waitForEnvelope(
        client.envelopes,
        "terminal_input_ack",
        "fast-input",
      )).resolves.toMatchObject({ payload: { ok: true, duplicate: false } });
      expect(writeBySessionId).toHaveBeenCalledWith("session-1", "x");
      expect(client.envelopes.some((envelope) => envelope.requestId === "slow-history")).toBe(false);
      releaseHistory();
      await nextResponse(client.envelopes, "terminal_history", "slow-history");
    } finally {
      releaseHistory();
      try { client?.ws.close(); } catch { /* ignore */ }
      await host.dispose();
      cleanup();
    }
  });

  it("ACKs an exact retry on a replacement socket without a second PTY write", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const { host, writeBySessionId, hasLivePty } = createTerminalHost(projectRoot);
    let first: Awaited<ReturnType<typeof connectTerminalPeer>> | null = null;
    let replacement: Awaited<ReturnType<typeof connectTerminalPeer>> | null = null;
    const input = { sessionId: "session-1", inputId: "cross-socket-input", data: "x" };
    try {
      const port = await host.waitUntilListening();
      first = await connectTerminalPeer(port, host.getBootstrapToken(), "ios-cross-socket-input");
      first.ws.send(encodeSyncEnvelope({
        type: "terminal_subscribe",
        requestId: "cross-socket-sub-1",
        payload: { sessionId: "session-1" },
      }));
      await nextResponse(first.envelopes, "terminal_snapshot", "cross-socket-sub-1");
      first.ws.send(encodeSyncEnvelope({
        type: "terminal_input",
        requestId: "cross-socket-first",
        payload: input,
      }));
      await expect(waitForEnvelope(
        first.envelopes,
        "terminal_input_ack",
        "cross-socket-first",
      )).resolves.toMatchObject({ payload: { ok: true, duplicate: false } });
      first.ws.close();
      await waitForValue(() => first?.closeEvents[0], "first terminal socket close");

      replacement = await connectTerminalPeer(port, host.getBootstrapToken(), "ios-cross-socket-input");
      hasLivePty.mockReturnValue(false);
      replacement.ws.send(encodeSyncEnvelope({
        type: "terminal_input",
        requestId: "cross-socket-retry",
        payload: input,
      }));
      await expect(waitForEnvelope(
        replacement.envelopes,
        "terminal_input_ack",
        "cross-socket-retry",
      )).resolves.toMatchObject({ payload: { ok: true, duplicate: true } });
      expect(writeBySessionId).toHaveBeenCalledTimes(1);
    } finally {
      try { first?.ws.close(); } catch { /* ignore */ }
      try { replacement?.ws.close(); } catch { /* ignore */ }
      await host.dispose();
      cleanup();
    }
  });

  it("retains eligible dedupe receipts instead of evicting them at the bound", () => {
    let now = 10_000;
    const ledger = createTerminalInputDedupeLedger({
      maxEntries: 2,
      retryWindowMs: 1_000,
      now: () => now,
    });
    expect(ledger.remember("device", "session", "a", "a".repeat(64))).toBe("recorded");
    expect(ledger.remember("device", "session", "b", "b".repeat(64))).toBe("recorded");
    expect(ledger.remember("device", "session", "c", "c".repeat(64))).toBe("capacity");
    expect(ledger.fingerprint("device", "session", "a")).toBe("a".repeat(64));
    now += 1_001;
    expect(ledger.remember("device", "session", "c", "c".repeat(64))).toBe("recorded");
    expect(ledger.size).toBe(1);
  });

  it("restores the desktop terminal size only after the last subscribed peer detaches", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const { host, resizeBySessionId, restoreDesktopSizeBySessionId } = createTerminalHost(projectRoot);
    let clientA: Awaited<ReturnType<typeof connectTerminalPeer>> | null = null;
    let clientB: Awaited<ReturnType<typeof connectTerminalPeer>> | null = null;
    try {
      const port = await host.waitUntilListening();
      clientA = await connectTerminalPeer(port, host.getBootstrapToken(), "ios-terminal-a");
      clientB = await connectTerminalPeer(port, host.getBootstrapToken(), "ios-terminal-b");

      clientA.ws.send(encodeSyncEnvelope({
        type: "terminal_subscribe",
        requestId: "sub-a",
        payload: { sessionId: "session-1", maxBytes: 32_000 },
      }));
      await nextResponse(clientA.envelopes, "terminal_snapshot", "sub-a");
      clientB.ws.send(encodeSyncEnvelope({
        type: "terminal_subscribe",
        requestId: "sub-b",
        payload: { sessionId: "session-1", maxBytes: 32_000 },
      }));
      await nextResponse(clientB.envelopes, "terminal_snapshot", "sub-b");

      clientA.ws.send(encodeSyncEnvelope({
        type: "terminal_resize",
        payload: { sessionId: "session-1", cols: 61.7, rows: 21.2 },
      }));
      await waitForValue(
        () => (resizeBySessionId.mock.calls.length > 0 ? resizeBySessionId.mock.calls[0] : null),
        "mobile resize forwarded",
      );
      expect(resizeBySessionId).toHaveBeenCalledWith("session-1", 61, 21, { source: "mobile" });

      // Peer A detaches while peer B still watches: no restore. The follow-up
      // history request (refused because A just unsubscribed) fences ordering.
      clientA.ws.send(encodeSyncEnvelope({
        type: "terminal_unsubscribe",
        payload: { sessionId: "session-1" },
      }));
      clientA.ws.send(encodeSyncEnvelope({
        type: "terminal_history",
        requestId: "fence-a",
        payload: { sessionId: "session-1", beforeOffset: 100 },
      }));
      const fence = await nextResponse(clientA.envelopes, "terminal_history", "fence-a");
      expect((fence.payload as { atStart: boolean }).atStart).toBe(true);
      expect(restoreDesktopSizeBySessionId).not.toHaveBeenCalled();

      // Last watcher disconnects → snap back to the desktop size.
      clientB.ws.close();
      await waitForValue(
        () => (restoreDesktopSizeBySessionId.mock.calls.length > 0 ? restoreDesktopSizeBySessionId.mock.calls[0] : null),
        "desktop size restore after last peer detached",
      );
      expect(restoreDesktopSizeBySessionId).toHaveBeenCalledTimes(1);
      expect(restoreDesktopSizeBySessionId).toHaveBeenCalledWith("session-1");
    } finally {
      try {
        clientA?.ws.close();
      } catch {
        // ignore
      }
      try {
        clientB?.ws.close();
      } catch {
        // ignore
      }
      await host.dispose();
      cleanup();
    }
  });

  it("marks terminal snapshots live:false when no PTY backs the session", async () => {
    // A brain restart orphans "running" sessions; the phone needs the truth
    // up front so it shows the resume bar instead of accepting keystrokes.
    const { projectRoot, cleanup } = createTempProjectRoot();
    const { host, hasLivePty } = createTerminalHost(projectRoot);
    hasLivePty.mockReturnValue(false);
    let client: Awaited<ReturnType<typeof connectTerminalPeer>> | null = null;
    try {
      const port = await host.waitUntilListening();
      client = await connectTerminalPeer(port, host.getBootstrapToken(), "ios-terminal-live");
      client.ws.send(encodeSyncEnvelope({
        type: "terminal_subscribe",
        requestId: "sub-dead",
        payload: { sessionId: "session-1", maxBytes: 32_000 },
      }));
      const snapshot = await nextResponse(client.envelopes, "terminal_snapshot", "sub-dead");
      expect((snapshot.payload as { live?: boolean }).live).toBe(false);

      hasLivePty.mockReturnValue(true);
      client.ws.send(encodeSyncEnvelope({
        type: "terminal_subscribe",
        requestId: "sub-live",
        payload: { sessionId: "session-1", maxBytes: 32_000 },
      }));
      const liveSnapshot = await nextResponse(client.envelopes, "terminal_snapshot", "sub-live");
      expect((liveSnapshot.payload as { live?: boolean }).live).toBe(true);
    } finally {
      try {
        client?.ws.close();
      } catch {
        // ignore
      }
      await host.dispose();
      cleanup();
    }
  });
});

describe("createSyncHostService all-projects roster", () => {
  beforeEach(() => {
    publishMock.mockReset();
    spawnMock.mockReset();
    bonjourDestroyMock.mockReset();
    bonjourConstructorMock.mockReset();
    spawnMock.mockImplementation(() => ({ kill: vi.fn(), once: vi.fn(), unref: vi.fn() }));
  });

  function rosterProject(projectId: string, runningCount: number) {
    return {
      projectId,
      rootPath: `/tmp/${projectId}`,
      displayName: projectId,
      booted: false,
      runningCount,
      attentionCount: 0,
      lanes: [],
      chats: [],
    };
  }

  function createRosterHost(
    projectRoot: string,
    rosterState: { projects: ReturnType<typeof rosterProject>[] },
    options: { withRosterProvider?: boolean } = {},
  ) {
    const base = createHostArgs(projectRoot, []);
    const args = {
      ...base,
      projectId: "project-host",
      db: {
        sync: {
          getSiteId: () => "site-host-roster",
          getDbVersion: () => 0,
          exportChangesSince: () => [],
          applyChanges: () => ({ appliedCount: 0 }),
          discardUnpublishedChangesForTables: () => {},
        },
      },
      deviceRegistryService: {
        ...base.deviceRegistryService,
        upsertPeerMetadata: vi.fn(),
      },
      projectCatalogProvider: {
        listProjects: vi.fn(async () => ({ projects: [] })),
        prepareProjectConnection: vi.fn(),
        forgetProject: vi.fn(async () => ({ ok: true })),
      },
      ...(options.withRosterProvider === false
        ? {}
        : { rosterProvider: { buildSnapshot: async () => rosterState.projects } }),
    } as unknown as Parameters<typeof createSyncHostService>[0];
    return createSyncHostService(args);
  }

  it("answers roster_subscribe with a seq:1 snapshot and bumps per-peer seq on re-subscribe", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const rosterState = { projects: [rosterProject("project-a", 1), rosterProject("project-b", 0)] };
    const host = createRosterHost(projectRoot, rosterState);
    let peer: Awaited<ReturnType<typeof connectPeer>> | null = null;
    try {
      const port = await host.waitUntilListening();
      peer = await connectPeer(port, host.getBootstrapToken(), "ios-roster-1");

      peer.ws.send(encodeSyncEnvelope({ type: "roster_subscribe", requestId: "roster-1", payload: {} }));
      const snapshot = await waitForEnvelope(peer.envelopes, "roster_snapshot", "roster-1");
      expect(snapshot.payload).toMatchObject({ seq: 1 });
      expect((snapshot.payload as { projects: unknown[] }).projects).toHaveLength(2);

      peer.ws.send(encodeSyncEnvelope({ type: "roster_subscribe", requestId: "roster-2", payload: {} }));
      const second = await waitForEnvelope(peer.envelopes, "roster_snapshot", "roster-2");
      expect(second.payload).toMatchObject({ seq: 2 });
    } finally {
      try {
        peer?.ws.close();
      } catch {
        // ignore
      }
      await host.dispose();
      cleanup();
    }
  });

  it("pushes a coalesced roster_delta carrying only the changed project", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const rosterState = { projects: [rosterProject("project-a", 1), rosterProject("project-b", 0)] };
    const host = createRosterHost(projectRoot, rosterState);
    let peer: Awaited<ReturnType<typeof connectPeer>> | null = null;
    try {
      const port = await host.waitUntilListening();
      peer = await connectPeer(port, host.getBootstrapToken(), "ios-roster-2");

      peer.ws.send(encodeSyncEnvelope({ type: "roster_subscribe", requestId: "roster-1", payload: {} }));
      await waitForEnvelope(peer.envelopes, "roster_snapshot", "roster-1");

      // Mutate one project, then dirty the roster via a project-catalog change.
      rosterState.projects = [rosterProject("project-a", 5), rosterProject("project-b", 0)];
      peer.ws.send(encodeSyncEnvelope({
        type: "project_forget_request",
        requestId: "forget-1",
        payload: { projectId: "project-x" },
      }));

      const delta = await waitForValue(
        () => peer?.envelopes.find((envelope) => envelope.type === "roster_delta"),
        "roster_delta after dirty",
      );
      expect(delta.payload).toMatchObject({ seq: 2 });
      const changed = (delta.payload as { changed?: Array<{ projectId: string; runningCount: number }> }).changed ?? [];
      expect(changed).toHaveLength(1);
      expect(changed[0]).toMatchObject({ projectId: "project-a", runningCount: 5 });
      expect((delta.payload as { removed?: string[] }).removed).toBeUndefined();
    } finally {
      try {
        peer?.ws.close();
      } catch {
        // ignore
      }
      await host.dispose();
      cleanup();
    }
  });

  it("stays silent on roster_subscribe when no roster provider is wired (older host)", async () => {
    const { projectRoot, cleanup } = createTempProjectRoot();
    const rosterState = { projects: [] as ReturnType<typeof rosterProject>[] };
    const host = createRosterHost(projectRoot, rosterState, { withRosterProvider: false });
    let peer: Awaited<ReturnType<typeof connectPeer>> | null = null;
    try {
      const port = await host.waitUntilListening();
      peer = await connectPeer(port, host.getBootstrapToken(), "ios-roster-3");

      peer.ws.send(encodeSyncEnvelope({ type: "roster_subscribe", requestId: "roster-1", payload: {} }));
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(peer.envelopes.some((envelope) => envelope.type === "roster_snapshot")).toBe(false);
      expect(peer.envelopes.some((envelope) => envelope.type === "roster_delta")).toBe(false);
    } finally {
      try {
        peer?.ws.close();
      } catch {
        // ignore
      }
      await host.dispose();
      cleanup();
    }
  });
});
