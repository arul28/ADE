import { describe, expect, it } from "vitest";
import type {
  SyncMobileProjectSummary,
  SyncPeerMetadata,
  SyncRemoteCommandDescriptor,
} from "../../../../desktop/src/shared/types";
import { buildSyncHostHelloOkPayload, resolveSyncHostInboundProjectScope } from "./syncHostService";

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
      remoteCommandSupportedActions: [remoteCommand.action],
      remoteCommandDescriptors: [remoteCommand],
      localCommandDescriptors: [localPresenceCommand],
      compressionThresholdBytes: 100_000,
    });

    expect(payload.peer).toBe(peer);
    expect(payload.brain).toBe(brain);
    expect(payload.serverDbVersion).toBe(7);
    expect(payload.projects).toEqual([project]);
    expect(payload.features.projectCatalog).toEqual({ enabled: true });
    expect(payload.features.fileAccess).toBe(true);
    expect(payload.features.terminalStreaming).toBe(true);
    expect(payload.features.chatStreaming).toEqual({ enabled: true });
    expect(payload.features.commandRouting).toEqual({
      mode: "allowlisted",
      supportedActions: [remoteCommand.action, localPresenceCommand.action],
      actions: [remoteCommand, localPresenceCommand],
    });
  });
});
