import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SyncCommandPayload, SyncPairingConnectInfo, SyncWebPairingInfo } from "../../../../desktop/src/shared/types";
import { parsePairingQrText } from "../../../../desktop/src/shared/pairingQr";
import { deriveDeterministicLaneNameFromPrompt } from "../../../../desktop/src/shared/laneNameFallback";
import { createSyncRemoteCommandService } from "./syncRemoteCommandService";

function makePayload(
  action: string,
  args: Record<string, unknown> = {},
): SyncCommandPayload {
  return { commandId: "cmd-1", action, args };
}

function createService(options?: {
  agentChatService?: Record<string, unknown>;
  conflictService?: Record<string, unknown>;
  diffService?: Record<string, unknown>;
  externalSessionsService?: Record<string, unknown>;
  gitService?: Record<string, unknown>;
  githubService?: Record<string, unknown>;
  operationService?: Record<string, unknown>;
  prService?: Record<string, unknown>;
  prSummaryService?: Record<string, unknown>;
  projectRoot?: string;
  queueLandingService?: Record<string, unknown>;
  ptyService?: Record<string, unknown>;
  sessionDeltaService?: Record<string, unknown>;
  sessionService?: Record<string, unknown>;
  projectConfigService?: Record<string, unknown>;
  db?: Record<string, unknown>;
  syncPinStore?: Record<string, unknown>;
  getPairingConnectInfo?: () => SyncPairingConnectInfo | null;
  issueRuntimeHostPairingGrant?: () => string;
  isCloudRelayEnabled?: () => boolean;
  usageTrackingService?: Record<string, unknown>;
  personalChatScope?: {
    call: ReturnType<typeof vi.fn>;
    streamEvents?: ReturnType<typeof vi.fn>;
  };
}) {
  const ptyService = {
    resumeSession: vi.fn().mockResolvedValue({
      sessionId: "session-1",
      ptyId: "pty-1",
      session: { id: "session-1", status: "running" },
    }),
    ensureResumeTargets: vi.fn().mockResolvedValue(undefined),
    enrichSessions: vi.fn((sessions: unknown[]) => sessions),
    getRuntimeState: vi.fn(() => "idle"),
    listTerminals: vi.fn().mockReturnValue([]),
    activeForChat: vi.fn().mockReturnValue(null),
    ...options?.ptyService,
  };
  const sessionService = {
    list: vi.fn().mockReturnValue([]),
    get: vi.fn().mockReturnValue(null),
    updateMeta: vi.fn(),
    ...options?.sessionService,
  };
  const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() };
  const service = createSyncRemoteCommandService({
    ...(options?.db ? { db: options.db } : {}),
    ...(options?.projectRoot ? { projectRoot: options.projectRoot } : {}),
    laneService: {},
    prService: options?.prService ?? {},
    ...(options?.prSummaryService ? { prSummaryService: options.prSummaryService } : {}),
    ...(options?.queueLandingService ? { queueLandingService: options.queueLandingService } : {}),
    ptyService,
    sessionService,
    ...(options?.sessionDeltaService ? { sessionDeltaService: options.sessionDeltaService } : {}),
    fileService: {},
    ...(options?.gitService ? { gitService: options.gitService } : {}),
    ...(options?.githubService ? { githubService: options.githubService } : {}),
    ...(options?.diffService ? { diffService: options.diffService } : {}),
    ...(options?.conflictService ? { conflictService: options.conflictService } : {}),
    ...(options?.operationService ? { operationService: options.operationService } : {}),
    ...(options?.projectConfigService ? { projectConfigService: options.projectConfigService } : {}),
    ...(options?.agentChatService ? { agentChatService: options.agentChatService } : {}),
    ...(options?.externalSessionsService ? { externalSessionsService: options.externalSessionsService } : {}),
    ...(options?.syncPinStore ? { syncPinStore: options.syncPinStore } : {}),
    ...(options?.getPairingConnectInfo ? { getPairingConnectInfo: options.getPairingConnectInfo } : {}),
    ...(options?.issueRuntimeHostPairingGrant
      ? { issueRuntimeHostPairingGrant: options.issueRuntimeHostPairingGrant }
      : {}),
    ...(options?.isCloudRelayEnabled ? { isCloudRelayEnabled: options.isCloudRelayEnabled } : {}),
    ...(options?.usageTrackingService ? { usageTrackingService: options.usageTrackingService } : {}),
    ...(options?.personalChatScope ? { personalChatScope: options.personalChatScope } : {}),
    logger,
  } as any);
  return { service, ptyService, sessionService, externalSessionsService: options?.externalSessionsService, logger };
}

function makePairingConnectInfo(
  addressCandidates: SyncPairingConnectInfo["addressCandidates"] = [{ host: "10.0.0.2", kind: "lan" }],
): SyncPairingConnectInfo {
  return {
    hostIdentity: {
      deviceId: "host-device",
      siteId: "host-site",
      name: "Arul's Mac Studio",
      platform: "macOS",
      deviceType: "desktop",
    },
    port: 8787,
    addressCandidates,
  };
}

describe("createSyncRemoteCommandService", () => {
  it("serves the cross-client usage snapshot to paired mobile and web clients", async () => {
    const getAdeUsageStats = vi.fn().mockResolvedValue({ generatedAt: "2026-07-09T12:00:00.000Z", daily: [] });
    const quotaSnapshot = { windows: [], lastPolledAt: "2026-07-09T12:00:00.000Z", errors: [] };
    const getUsageSnapshot = vi.fn(() => quotaSnapshot);
    const forceRefresh = vi.fn(async () => ({ ...quotaSnapshot, lastPolledAt: "2026-07-09T12:01:00.000Z" }));
    const { service } = createService({ usageTrackingService: { getAdeUsageStats, getUsageSnapshot, forceRefresh } });

    expect(service.getDescriptor("usage.getAdeStats")).toEqual({
      action: "usage.getAdeStats",
      scope: "project",
      policy: { viewerAllowed: true },
    });
    await expect(service.execute(makePayload("usage.getAdeStats", { preset: "year" }))).resolves.toEqual({
      generatedAt: "2026-07-09T12:00:00.000Z",
      daily: [],
    });
    expect(getAdeUsageStats).toHaveBeenCalledWith({ preset: "year" });
    await expect(service.execute(makePayload("usage.getAdeStats", { preset: "decade" }))).rejects.toThrow(
      "usage.getAdeStats preset must be today, 7d, 30d, year, or all.",
    );
    expect(service.getDescriptor("usage.getQuotaSnapshot")).toEqual({
      action: "usage.getQuotaSnapshot",
      scope: "runtime",
      policy: { viewerAllowed: true },
    });
    expect(service.getDescriptor("usage.refreshQuota")).toEqual({
      action: "usage.refreshQuota",
      scope: "runtime",
      policy: { viewerAllowed: true },
    });
    await expect(service.execute(makePayload("usage.getQuotaSnapshot"))).resolves.toEqual(quotaSnapshot);
    await expect(service.execute(makePayload("usage.refreshQuota"))).resolves.toMatchObject({
      lastPolledAt: "2026-07-09T12:01:00.000Z",
    });
    expect(getUsageSnapshot).toHaveBeenCalledTimes(1);
    expect(forceRefresh).toHaveBeenCalledWith({ allowInteractiveAuth: false });

    getAdeUsageStats.mockClear();
    await service.execute(makePayload("usage.getAdeStats", { preset: "7d", scope: "project" }));
    expect(getAdeUsageStats).toHaveBeenCalledWith({ preset: "7d", scope: "project" });
    await expect(service.execute(makePayload("usage.getAdeStats", { scope: "galaxy" }))).rejects.toThrow(
      "usage.getAdeStats scope must be machine or project.",
    );
    getAdeUsageStats.mockClear();
    await service.execute(makePayload("usage.getAdeStats", {
      since: "2026-07-01T00:00:00.000Z",
      until: "2026-07-08T00:00:00.000Z",
    }));
    expect(getAdeUsageStats).toHaveBeenCalledWith({
      since: "2026-07-01T00:00:00.000Z",
      until: "2026-07-08T00:00:00.000Z",
    });
    await expect(service.execute(makePayload("usage.getAdeStats", { since: "not-a-date" }))).rejects.toThrow(
      "usage.getAdeStats since must be an ISO timestamp.",
    );
    await expect(service.execute(makePayload("usage.getAdeStats", { until: "not-a-date" }))).rejects.toThrow(
      "usage.getAdeStats until must be an ISO timestamp.",
    );
  });

  it("advertises and executes machine personal chats as runtime commands", async () => {
    const personalChatScope = {
      call: vi.fn(async (action: string, args: unknown) => ({
        action,
        result: { action, args },
      })),
      streamEvents: vi.fn(async () => ({ events: [], nextCursor: 0 })),
    };
    const { service } = createService({ personalChatScope });

    expect(service.getDescriptor("personalChats.create")).toEqual({
      action: "personalChats.create",
      scope: "runtime",
      policy: { viewerAllowed: true, queueable: false },
    });
    expect(service.getDescriptor("personalChats.cancelDispatchedSteer")).toEqual({
      action: "personalChats.cancelDispatchedSteer",
      scope: "runtime",
      policy: { viewerAllowed: true, queueable: false },
    });
    expect(service.getDescriptor("personalChats.streamEvents")).toEqual({
      action: "personalChats.streamEvents",
      scope: "runtime",
      policy: { viewerAllowed: true, queueable: false },
    });
    expect(service.getDescriptor("personalChats.terminalCreate")).toEqual({
      action: "personalChats.terminalCreate",
      scope: "runtime",
      policy: { viewerAllowed: true, queueable: false },
    });
    await expect(service.execute(makePayload("personalChats.send", {
      sessionId: "personal-1",
      text: "hello",
    }))).resolves.toEqual({
      action: "send",
      args: { sessionId: "personal-1", text: "hello" },
    });
    expect(personalChatScope.call).toHaveBeenCalledWith("send", {
      sessionId: "personal-1",
      text: "hello",
    });
  });

  it("registers sync.getWebPairingInfo and returns the configured browser pairing info", async () => {
    const syncPinStore = {
      getPin: vi.fn(() => "428193"),
      hasPin: vi.fn(() => true),
    };
    const { service } = createService({
      syncPinStore,
      getPairingConnectInfo: () => makePairingConnectInfo([
        { host: "10.0.0.2", kind: "lan" },
        { host: "wss://relay.example/connect/machine", kind: "relay" },
      ]),
      isCloudRelayEnabled: () => true,
    });

    expect(service.getSupportedActions()).toContain("sync.getWebPairingInfo");
    expect(service.getDescriptor("sync.getWebPairingInfo")).toEqual({
      action: "sync.getWebPairingInfo",
      scope: "runtime",
      policy: { viewerAllowed: true },
    });

    const result = await service.execute(makePayload("sync.getWebPairingInfo")) as SyncWebPairingInfo;

    expect(result.pairingUrl).toContain("https://app.ade-app.dev/pair#");
    expect(result).toEqual({
      pairingUrl: result.pairingUrl,
      code: "428193",
      pinConfigured: true,
      machineName: "Arul's Mac Studio",
      relayEnabled: true,
      hasRelayCandidate: true,
    });
    expect(syncPinStore.hasPin).toHaveBeenCalled();
    expect(syncPinStore.getPin).toHaveBeenCalled();
  });

  it("returns null code and pinConfigured false when sync.getWebPairingInfo has no PIN", async () => {
    const { service } = createService({
      syncPinStore: {
        getPin: vi.fn(() => null),
        hasPin: vi.fn(() => false),
      },
      getPairingConnectInfo: () => makePairingConnectInfo(),
      isCloudRelayEnabled: () => false,
    });

    const result = await service.execute(makePayload("sync.getWebPairingInfo")) as SyncWebPairingInfo;

    expect(result.pairingUrl).toContain("https://app.ade-app.dev/pair#");
    expect(result).toEqual({
      pairingUrl: result.pairingUrl,
      code: null,
      pinConfigured: false,
      machineName: "Arul's Mac Studio",
      relayEnabled: false,
      hasRelayCandidate: false,
    });
  });

  it("issues a desktop-only server grant in sync.getDesktopPairingInfo", async () => {
    const issueRuntimeHostPairingGrant = vi.fn(() => "runtime-grant-1");
    const { service } = createService({
      syncPinStore: {
        getPin: vi.fn(() => "428193"),
        hasPin: vi.fn(() => true),
      },
      getPairingConnectInfo: () => makePairingConnectInfo(),
      issueRuntimeHostPairingGrant,
    });

    expect(service.getDescriptor("sync.getDesktopPairingInfo")).toEqual({
      action: "sync.getDesktopPairingInfo",
      scope: "runtime",
      policy: { viewerAllowed: false },
    });
    const result = await service.execute(
      makePayload("sync.getDesktopPairingInfo"),
    ) as SyncWebPairingInfo;

    expect(result.pairingUrl).toContain("https://app.ade-app.dev/pair#");
    expect(issueRuntimeHostPairingGrant).toHaveBeenCalledTimes(1);
    expect(parsePairingQrText(result.pairingUrl)?.runtimeHostGrant).toBe("runtime-grant-1");
  });

  it("returns configured hidden web pairing info when only the PIN hash is available", async () => {
    const syncPinStore = {
      getPin: vi.fn(() => null),
      hasPin: vi.fn(() => true),
    };
    const { service } = createService({
      syncPinStore,
      getPairingConnectInfo: () => makePairingConnectInfo(),
      isCloudRelayEnabled: () => false,
    });

    const result = await service.execute(makePayload("sync.getWebPairingInfo")) as SyncWebPairingInfo;

    expect(result.pairingUrl).toContain("https://app.ade-app.dev/pair#");
    expect(result).toEqual({
      pairingUrl: result.pairingUrl,
      code: null,
      pinConfigured: true,
      machineName: "Arul's Mac Studio",
      relayEnabled: false,
      hasRelayCandidate: false,
    });
    expect(syncPinStore.hasPin).toHaveBeenCalled();
    expect(syncPinStore.getPin).toHaveBeenCalled();
  });

  it("routes work.resumeCliSession through the durable PTY resume path", async () => {
    const { service, ptyService } = createService();

    expect(service.getDescriptor("work.resumeCliSession")).toEqual({
      action: "work.resumeCliSession",
      scope: "project",
      policy: { viewerAllowed: true, queueable: true },
    });

    const result = await service.execute(makePayload("work.resumeCliSession", {
      sessionId: "session-1",
      cols: 999,
      rows: 1,
    }));

    expect(ptyService.resumeSession).toHaveBeenCalledWith({
      sessionId: "session-1",
      cols: 400,
      rows: 4,
    });
    expect(result).toEqual({
      sessionId: "session-1",
      ptyId: "pty-1",
      session: { id: "session-1", status: "running" },
    });
  });

  it("rejects work.resumeCliSession without a session id", async () => {
    const { service, ptyService } = createService();

    await expect(service.execute(makePayload("work.resumeCliSession"))).rejects.toThrow(
      "work.resumeCliSession requires sessionId.",
    );
    expect(ptyService.resumeSession).not.toHaveBeenCalled();
  });

  it("routes all Codex recovery actions through the mobile sync command", async () => {
    const recoverCodexTurn = vi.fn(async (args) => ({
      action: args.action,
      turnId: args.turnId,
      status: args.action === "wait" ? "waiting" : "retrying",
    }));
    const { service } = createService({ agentChatService: { recoverCodexTurn } });

    expect(service.getDescriptor("chat.recoverCodexTurn")).toEqual({
      action: "chat.recoverCodexTurn",
      scope: "project",
      policy: { viewerAllowed: true, queueable: false },
    });

    for (const action of [
      "wait",
      "steer",
      "interrupt_retry_same_thread",
      "restart_resume_thread",
    ]) {
      await service.execute(makePayload("chat.recoverCodexTurn", {
        sessionId: "chat-1",
        turnId: "turn-1",
        action,
      }));
    }

    expect(recoverCodexTurn.mock.calls.map(([args]) => args)).toEqual([
      { sessionId: "chat-1", turnId: "turn-1", action: "wait" },
      { sessionId: "chat-1", turnId: "turn-1", action: "steer" },
      { sessionId: "chat-1", turnId: "turn-1", action: "interrupt_retry_same_thread" },
      { sessionId: "chat-1", turnId: "turn-1", action: "restart_resume_thread" },
    ]);
  });

  it("rejects unsupported Codex recovery actions before invoking chat", async () => {
    const recoverCodexTurn = vi.fn();
    const { service } = createService({ agentChatService: { recoverCodexTurn } });

    await expect(service.execute(makePayload("chat.recoverCodexTurn", {
      sessionId: "chat-1",
      turnId: "turn-1",
      action: "replace",
    }))).rejects.toThrow("unsupported action 'replace'");
    expect(recoverCodexTurn).not.toHaveBeenCalled();
  });

  it("omits non-finite work.resumeCliSession dimensions", async () => {
    const { service, ptyService } = createService();

    await service.execute(makePayload("work.resumeCliSession", {
      sessionId: "session-1",
      cols: Number.NaN,
      rows: Number.POSITIVE_INFINITY,
    }));

    expect(ptyService.resumeSession).toHaveBeenCalledWith({
      sessionId: "session-1",
    });
  });

  it("routes work.listExternalSessions to the external session service", async () => {
    const list = vi.fn().mockResolvedValue([{
      provider: "codex",
      id: "thread-1",
      cwd: "/repo",
      title: "Fix tests",
      preview: "Working on it",
      createdAt: 10,
      updatedAt: 20,
      messageCount: 3,
      alreadyImported: false,
      possiblyActive: true,
      cwdMatchesRequestedLane: true,
      capabilities: {
        resumeInPlace: true,
        resumeInDifferentCwd: true,
        fork: true,
        forkIntoDifferentCwd: true,
        importToChat: true,
      },
    }]);
    const { service } = createService({
      externalSessionsService: { list, importExternalSession: vi.fn() },
    });

    expect(service.getDescriptor("work.listExternalSessions")).toEqual({
      action: "work.listExternalSessions",
      scope: "project",
      policy: { viewerAllowed: true },
    });

    const result = await service.execute(makePayload("work.listExternalSessions", {
      providers: ["codex"],
      laneId: "lane-1",
      cwd: "/repo",
      scope: "all",
      limit: 999,
    }));

    expect(list).toHaveBeenCalledWith({
      providers: ["codex"],
      laneId: "lane-1",
      cwd: "/repo",
      scope: "all",
      limit: 100,
    });
    expect(result).toEqual([{
      provider: "codex",
      id: "thread-1",
      cwd: "/repo",
      title: "Fix tests",
      preview: "Working on it",
      createdAt: 10,
      updatedAt: 20,
      messageCount: 3,
      alreadyImported: false,
      possiblyActive: true,
      cwdMatchesRequestedLane: true,
      capabilities: {
        resumeInPlace: true,
        resumeInDifferentCwd: true,
        fork: true,
        forkIntoDifferentCwd: true,
        importToChat: true,
      },
    }]);
  });

  it("exposes work.listExternalSessions as a viewer-allowed descriptor and passes scope through", async () => {
    // Paired-device access is gated once, by policy.viewerAllowed at the sync host
    // (see syncHostService), not by a client-declared role at this layer.
    const list = vi.fn().mockResolvedValue([]);
    const { service } = createService({
      externalSessionsService: { list, importExternalSession: vi.fn() },
    });

    expect(service.getDescriptor("work.listExternalSessions")).toEqual({
      action: "work.listExternalSessions",
      scope: "project",
      policy: { viewerAllowed: true },
    });

    await expect(service.execute(makePayload("work.listExternalSessions", {
      scope: "all",
    }))).resolves.toEqual([]);
    expect(list).toHaveBeenCalledWith({ scope: "all" });
  });

  it("rejects invalid work.listExternalSessions filters", async () => {
    const list = vi.fn();
    const { service } = createService({
      externalSessionsService: { list, importExternalSession: vi.fn() },
    });

    await expect(service.execute(makePayload("work.listExternalSessions", {
      providers: ["bogus"],
    }))).rejects.toThrow("work.listExternalSessions requires a valid provider.");
    await expect(service.execute(makePayload("work.listExternalSessions", {
      scope: "workspace",
    }))).rejects.toThrow("work.listExternalSessions scope must be project or all.");
    await expect(service.execute(makePayload("work.listExternalSessions", {
      laneId: 42,
    }))).rejects.toThrow("work.listExternalSessions laneId must be a string.");
    await expect(service.execute(makePayload("work.listExternalSessions", {
      limit: Number.POSITIVE_INFINITY,
    }))).rejects.toThrow("work.listExternalSessions limit must be a finite number.");
    expect(list).not.toHaveBeenCalled();
  });

  it("routes work.importExternalSession to the external session service", async () => {
    const importExternalSession = vi.fn().mockResolvedValue({
      kind: "cli",
      sessionId: "session-1",
      ptyId: "pty-1",
      laneId: "lane-1",
      session: { id: "session-1", laneId: "lane-1", title: "Persisted CLI" },
    });
    const { service } = createService({
      externalSessionsService: { list: vi.fn(), importExternalSession },
    });

    expect(service.getDescriptor("work.importExternalSession")).toEqual({
      action: "work.importExternalSession",
      scope: "project",
      policy: { viewerAllowed: true, queueable: true },
    });

    const result = await service.execute(makePayload("work.importExternalSession", {
      provider: "codex",
      sessionId: "thread-1",
      laneId: "lane-1",
      target: "cli",
      mode: "resume",
      model: "gpt-5.3-codex",
      permissionMode: "default",
    }));

    expect(importExternalSession).toHaveBeenCalledWith({
      provider: "codex",
      sessionId: "thread-1",
      laneId: "lane-1",
      target: "cli",
      mode: "resume",
      model: "gpt-5.3-codex",
      permissionMode: "default",
    });
    expect(result).toEqual({
      kind: "cli",
      sessionId: "session-1",
      ptyId: "pty-1",
      laneId: "lane-1",
      session: { id: "session-1", laneId: "lane-1", title: "Persisted CLI" },
    });
  });

  it("routes chat work.importExternalSession results without CLI fields", async () => {
    const importExternalSession = vi.fn().mockResolvedValue({
      kind: "chat",
      chatSessionId: "chat-1",
      laneId: "lane-1",
      chatSummary: { sessionId: "chat-1", laneId: "lane-1", title: "Persisted chat" },
    });
    const { service } = createService({
      externalSessionsService: { list: vi.fn(), importExternalSession },
    });

    const result = await service.execute(makePayload("work.importExternalSession", {
      provider: "claude",
      sessionId: "thread-1",
      laneId: "lane-1",
      target: "chat",
      mode: "fork",
    }));

    expect(result).toEqual({
      kind: "chat",
      chatSessionId: "chat-1",
      laneId: "lane-1",
      chatSummary: { sessionId: "chat-1", laneId: "lane-1", title: "Persisted chat" },
    });
  });

  it("routes every supported provider import affordance without narrowing the provider contract", async () => {
    const imports = [
      { provider: "claude", target: "cli", mode: "resume" },
      { provider: "claude", target: "cli", mode: "fork" },
      { provider: "claude", target: "chat", mode: "resume" },
      { provider: "claude", target: "chat", mode: "fork" },
      { provider: "codex", target: "cli", mode: "resume" },
      { provider: "codex", target: "cli", mode: "fork" },
      { provider: "codex", target: "chat", mode: "resume" },
      { provider: "codex", target: "chat", mode: "fork" },
      { provider: "cursor", target: "cli", mode: "resume" },
      { provider: "droid", target: "cli", mode: "resume" },
      { provider: "droid", target: "cli", mode: "fork" },
      { provider: "opencode", target: "cli", mode: "resume" },
      { provider: "opencode", target: "cli", mode: "fork" },
    ] as const;
    const importExternalSession = vi.fn(async (args: (typeof imports)[number] & { sessionId: string; laneId: string }) => (
      args.target === "chat"
        ? {
            kind: "chat" as const,
            chatSessionId: `chat-${args.provider}-${args.mode}`,
            laneId: args.laneId,
            chatSummary: {
              sessionId: `chat-${args.provider}-${args.mode}`,
              laneId: args.laneId,
              title: "Ready chat",
            },
          }
        : {
            kind: "cli" as const,
            sessionId: `cli-${args.provider}-${args.mode}`,
            ptyId: `pty-${args.provider}-${args.mode}`,
            laneId: args.laneId,
            session: {
              id: `cli-${args.provider}-${args.mode}`,
              laneId: args.laneId,
              title: "Ready CLI",
            },
          }
    ));
    const { service } = createService({
      externalSessionsService: { list: vi.fn(), importExternalSession },
    });

    for (const entry of imports) {
      const result = await service.execute(makePayload("work.importExternalSession", {
        ...entry,
        sessionId: `external-${entry.provider}`,
        laneId: "lane-1",
      }));
      expect(result).toHaveProperty("kind", entry.target === "chat" ? "chat" : "cli");
      expect(result).toHaveProperty(entry.target === "chat" ? "chatSummary" : "session");
    }

    expect(importExternalSession.mock.calls.map(([args]) => args)).toEqual(
      imports.map((entry) => ({
        ...entry,
        sessionId: `external-${entry.provider}`,
        laneId: "lane-1",
      })),
    );
  });

  it("rejects invalid work.importExternalSession payloads", async () => {
    const importExternalSession = vi.fn();
    const { service } = createService({
      externalSessionsService: { list: vi.fn(), importExternalSession },
    });

    await expect(service.execute(makePayload("work.importExternalSession", {
      provider: "bogus",
      sessionId: "thread-1",
      laneId: "lane-1",
      target: "cli",
      mode: "resume",
    }))).rejects.toThrow("work.importExternalSession requires a valid provider.");
    await expect(service.execute(makePayload("work.importExternalSession", {
      provider: "codex",
      laneId: "lane-1",
      target: "cli",
      mode: "resume",
    }))).rejects.toThrow("work.importExternalSession requires sessionId.");
    await expect(service.execute(makePayload("work.importExternalSession", {
      provider: "codex",
      sessionId: "thread-1",
      target: "cli",
      mode: "resume",
    }))).rejects.toThrow("work.importExternalSession requires laneId.");
    await expect(service.execute(makePayload("work.importExternalSession", {
      provider: "codex",
      sessionId: "thread-1",
      laneId: "lane-1",
      target: "browser",
      mode: "resume",
    }))).rejects.toThrow("work.importExternalSession target must be cli or chat.");
    await expect(service.execute(makePayload("work.importExternalSession", {
      provider: "codex",
      sessionId: "thread-1",
      laneId: "lane-1",
      target: "cli",
      mode: "clone",
    }))).rejects.toThrow("work.importExternalSession mode must be resume or fork.");
    expect(importExternalSession).not.toHaveBeenCalled();
  });

  it("routes the canonical chat history page command to the chat service", async () => {
    const getChatEventHistoryPage = vi.fn().mockReturnValue({
      sessionId: "chat-1",
      events: [],
      startOffset: 128,
      hasMore: true,
      sessionFound: true,
    });
    const { service } = createService({
      agentChatService: { getChatEventHistoryPage },
    });

    expect(service.getDescriptor("chat.getChatEventHistoryPage")).toEqual({
      action: "chat.getChatEventHistoryPage",
      scope: "project",
      policy: { viewerAllowed: true },
    });

    const result = await service.execute(makePayload("chat.getChatEventHistoryPage", {
      sessionId: "chat-1",
      beforeOffset: 4096,
      maxBytes: 65_536,
    }));

    expect(getChatEventHistoryPage).toHaveBeenCalledWith("chat-1", {
      beforeOffset: 4096,
      maxBytes: 65_536,
    });
    expect(result).toEqual({
      sessionId: "chat-1",
      events: [],
      startOffset: 128,
      hasMore: true,
      sessionFound: true,
    });
  });

  it("routes the canonical chat history snapshot command to the chat service", async () => {
    const getChatEventHistory = vi.fn().mockReturnValue({
      sessionId: "chat-1",
      events: [],
      truncated: false,
      sessionFound: true,
      tailStartOffset: null,
    });
    const { service } = createService({
      agentChatService: { getChatEventHistory },
    });

    expect(service.getDescriptor("chat.getChatEventHistory")).toEqual({
      action: "chat.getChatEventHistory",
      scope: "project",
      policy: { viewerAllowed: true },
    });

    const result = await service.execute(makePayload("chat.getChatEventHistory", {
      sessionId: "chat-1",
      maxEvents: 128,
    }));

    expect(getChatEventHistory).toHaveBeenCalledWith("chat-1", { maxEvents: 128 });
    expect(result).toEqual({
      sessionId: "chat-1",
      events: [],
      truncated: false,
      sessionFound: true,
      tailStartOffset: null,
    });
  });

  it("routes subagent transcript fetches to the chat service", async () => {
    const getSubagentTranscript = vi.fn().mockResolvedValue([
      { type: "assistant", uuid: "msg-1", sessionId: "child-1", parentToolUseId: null, message: {}, text: "done" },
    ]);
    const { service } = createService({
      agentChatService: { getSubagentTranscript },
    });

    expect(service.getDescriptor("chat.getSubagentTranscript")).toEqual({
      action: "chat.getSubagentTranscript",
      scope: "project",
      policy: { viewerAllowed: true, queueable: false },
    });

    const result = await service.execute(makePayload("chat.getSubagentTranscript", {
      sessionId: "chat-1",
      agentId: "agent-1",
      taskId: "task-1",
      laneId: "lane-1",
      limit: 1,
      offset: 2,
    }));

    expect(getSubagentTranscript).toHaveBeenCalledWith({
      sessionId: "chat-1",
      agentId: "agent-1",
      taskId: "task-1",
      laneId: "lane-1",
      limit: 1,
      offset: 2,
    });
    expect(result).toEqual([
      { type: "assistant", uuid: "msg-1", sessionId: "child-1", parentToolUseId: null, message: {}, text: "done" },
    ]);
  });

  it("routes main transcript fetches to the chat service", async () => {
    const transcript = [
      { type: "assistant", uuid: "msg-1", sessionId: "sdk-1", parentToolUseId: null, message: {}, text: "main" },
    ];
    const getMainTranscript = vi.fn().mockResolvedValue(transcript);
    const { service } = createService({ agentChatService: { getMainTranscript } });

    expect(service.getDescriptor("chat.getMainTranscript")).toEqual({
      action: "chat.getMainTranscript",
      scope: "project",
      policy: { viewerAllowed: true, queueable: false },
    });
    await expect(service.execute(makePayload("chat.getMainTranscript", {
      sessionId: "chat-1",
      limit: 50,
      offset: 2,
    }))).resolves.toEqual(transcript);
    expect(getMainTranscript).toHaveBeenCalledWith({ sessionId: "chat-1", limit: 50, offset: 2 });
  });

  it("routes subagent roster fetches to the chat service", async () => {
    const listSubagents = vi.fn().mockReturnValue([
      { taskId: "agent-1", agentId: "agent-1", agentType: "Sagan", description: "Read files", status: "stopped" },
    ]);
    const { service } = createService({
      agentChatService: { listSubagents },
    });

    expect(service.getDescriptor("chat.listSubagents")).toEqual({
      action: "chat.listSubagents",
      scope: "project",
      policy: { viewerAllowed: true, queueable: false },
    });

    const result = await service.execute(makePayload("chat.listSubagents", {
      sessionId: "chat-1",
    }));

    expect(listSubagents).toHaveBeenCalledWith({ sessionId: "chat-1" });
    expect(result).toEqual([
      { taskId: "agent-1", agentId: "agent-1", agentType: "Sagan", description: "Read files", status: "stopped" },
    ]);
  });

  it("routes work.getSession through session enrichment and chat state projection", async () => {
    const session = { id: "session-1", status: "running", toolType: "codex-chat", ptyId: "pty-1" };
    const enrichedSession = { ...session, runtimeState: "running" };
    const getSessionSummary = vi.fn().mockResolvedValue({
      sessionId: "session-1",
      status: "idle",
      idleSinceAt: "2026-01-01T00:00:00.000Z",
      orchestrationRunId: "run-1",
      orchestrationRole: "worker",
      orchestrationTag: "impl",
    });
    const { service, ptyService, sessionService } = createService({
      sessionService: { get: vi.fn().mockReturnValue(session) },
      ptyService: { enrichSessions: vi.fn().mockReturnValue([enrichedSession]) },
      agentChatService: { getSessionSummary },
    });

    expect(service.getDescriptor("work.getSession")).toEqual({
      action: "work.getSession",
      scope: "project",
      policy: { viewerAllowed: true },
    });

    const result = await service.execute(makePayload("work.getSession", { sessionId: "session-1" }));

    expect(sessionService.get).toHaveBeenCalledWith("session-1");
    expect(ptyService.enrichSessions).toHaveBeenCalledWith([session]);
    expect(getSessionSummary).toHaveBeenCalledWith("session-1");
    expect(result).toEqual(expect.objectContaining({
      id: "session-1",
      runtimeState: "idle",
      chatIdleSinceAt: "2026-01-01T00:00:00.000Z",
      orchestrationRunId: "run-1",
      orchestrationRole: "worker",
      orchestrationTag: "impl",
    }));
  });

  it("delegates PR merge contexts and queue state to the injected services", async () => {
    const getMergeContexts = vi.fn().mockResolvedValue({ "pr-1": { prId: "pr-1", mergeable: true } });
    const getQueueStateByGroup = vi.fn().mockReturnValue({ groupId: "queue-1", entries: [] });
    const { service } = createService({
      prService: { getMergeContexts },
      queueLandingService: { getQueueStateByGroup },
    });

    const contexts = await service.execute(makePayload("prs.getMergeContexts", { prIds: ["pr-1"] }));
    const queueState = await service.execute(makePayload("prs.getQueueState", { groupId: "queue-1" }));

    expect(service.getDescriptor("prs.getMergeContexts")).toEqual({
      action: "prs.getMergeContexts",
      scope: "project",
      policy: { viewerAllowed: true },
    });
    expect(getMergeContexts).toHaveBeenCalledWith(["pr-1"]);
    expect(contexts).toEqual({ "pr-1": { prId: "pr-1", mergeable: true } });
    expect(getQueueStateByGroup).toHaveBeenCalledWith("queue-1");
    expect(queueState).toEqual({ groupId: "queue-1", entries: [] });
  });

  it("rejects missing required args for new remote-command parsers", async () => {
    const postReviewComment = vi.fn();
    const activeForChat = vi.fn();
    const save = vi.fn();
    const { service } = createService({
      prService: { postReviewComment },
      ptyService: { activeForChat },
      projectConfigService: { save },
    });

    await expect(service.execute(makePayload("work.getSession"))).rejects.toThrow("work.getSession requires sessionId.");
    await expect(service.execute(makePayload("terminal.activeForChat"))).rejects.toThrow("chatSessionId is required");
    await expect(
      service.execute(makePayload("prs.postReviewComment", { prId: "pr-1", threadId: "thread-1" })),
    ).rejects.toThrow("prs.postReviewComment requires body.");
    await expect(service.execute(makePayload("projectConfig.save"))).rejects.toThrow("projectConfig.save requires candidate.");

    expect(activeForChat).not.toHaveBeenCalled();
    expect(postReviewComment).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("saves browser-provided temporary image attachments inside the project .ade directory", async () => {
    const projectRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ade-sync-remote-"));
    const png = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    const { service } = createService({ projectRoot });

    try {
      const result = await service.execute(makePayload("chat.saveTempAttachment", {
        dataUrl: `data:image/png;base64,${png.toString("base64")}`,
        filename: "pasted.png",
      })) as { path: string; mimeType: string; previewDataUrl: string | null };

      expect(result.mimeType).toBe("image/png");
      expect(result.previewDataUrl).toBeNull();
      expect(result.path.startsWith(path.join(projectRoot, ".ade", "attachments"))).toBe(true);
      await expect(fs.promises.readFile(result.path)).resolves.toEqual(png);
    } finally {
      await fs.promises.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("rejects temporary attachments with mismatched MIME or oversized payloads", async () => {
    const projectRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ade-sync-remote-"));
    const png = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    const maxEncodedLength = Math.ceil((10 * 1024 * 1024) / 3) * 4;
    const { service } = createService({ projectRoot });

    try {
      await expect(service.execute(makePayload("chat.saveTempAttachment", {
        dataUrl: `data:image/jpeg;base64,${png.toString("base64")}`,
        filename: "wrong.jpg",
      }))).rejects.toThrow("MIME type does not match");
      await expect(service.execute(makePayload("chat.saveTempAttachment", {
        base64: "A".repeat(maxEncodedLength + 4),
        mime: "image/png",
        filename: "too-large.png",
      }))).rejects.toThrow("10 MB or smaller");
      await expect(fs.promises.readdir(path.join(projectRoot, ".ade", "attachments"))).rejects.toThrow();
    } finally {
      await fs.promises.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("advertises the requested web-parity remote actions", () => {
    const { service } = createService();

    expect(service.getSupportedActions()).toEqual(expect.arrayContaining([
      "work.getSession",
      "work.deleteSession",
      "work.getSessionDelta",
      "chat.getSlashCommands",
      "chat.getParallelLaunchState",
      "chat.setParallelLaunchState",
      "chat.handoff",
      "chat.prepareCrossMachineHandoff",
      "chat.validateCrossMachineSource",
      "chat.preflightCrossMachineDestination",
      "chat.acceptCrossMachineHandoff",
      "chat.markCrossMachineHandoff",
      "chat.getContextUsage",
      "chat.rewindFiles",
      "chat.getTurnFileDiff",
      "chat.saveTempAttachment",
      "chat.warmupModel",
      "chat.launch",
      "chat.getImageDataUrl",
      "lanes.listDeleteProgress",
      "git.getUserIdentity",
      "git.stashClear",
      "git.getFilePatch",
      "terminal.list",
      "terminal.activeForChat",
      "prs.postReviewComment",
      "prs.getAiSummary",
      "prs.regenerateAiSummary",
      "prs.getIntegrationResolutionState",
      "prs.delete",
      "prs.cleanupBranch",
      "prs.listOpenForRepo",
      "prs.listProposals",
      "prs.getQueueState",
      "prs.listQueueStates",
      "prs.getMergeContext",
      "prs.getMergeContexts",
      "prs.listWithConflicts",
      "prs.listSnapshots",
      "prs.aiResolutionGetSession",
      "prs.aiResolutionStart",
      "rebase.scanNeeds",
      "rebase.execute",
      "history.listOperations",
      "github.getStatus",
      "github.getRemoteStatus",
      "github.publishCurrentProject",
      "projectConfig.get",
      "projectConfig.save",
      "ai.getStatus",
      "orchestration.runCreate",
    ]));
    expect(service.getDescriptor("chat.saveTempAttachment")?.scope).toBe("project");
    expect(service.getDescriptor("rebase.execute")?.policy).toEqual({ viewerAllowed: true, queueable: true });
    expect(service.getDescriptor("prs.delete")?.policy).toEqual({ viewerAllowed: false, queueable: true });
    expect(service.getDescriptor("prs.cleanupBranch")?.policy).toEqual({ viewerAllowed: false, queueable: true });
  });

  it("routes chat.handoff with a trimmed handoff note", async () => {
    const handoffSession = vi.fn().mockResolvedValue({
      session: { id: "session-2" },
      usedFallbackSummary: false,
    });
    const { service } = createService({
      agentChatService: { handoffSession },
    });

    const result = await service.execute(makePayload("chat.handoff", {
      sourceSessionId: " session-1 ",
      targetModelId: " openai/gpt-5.5 ",
      handoffNote: "  Focus the first pass on the drawer regression.  ",
    }));

    expect(result).toEqual({
      session: { id: "session-2" },
      usedFallbackSummary: false,
    });
    expect(handoffSession).toHaveBeenCalledWith(expect.objectContaining({
      sourceSessionId: "session-1",
      targetModelId: "openai/gpt-5.5",
      handoffNote: "Focus the first pass on the drawer regression.",
    }));
  });

  it("routes every cross-machine chat handoff phase through the remote command bridge", async () => {
    const capsule = {
      version: 1 as const,
      handoffId: "handoff-1",
      createdAt: "2026-07-10T12:00:00.000Z",
      source: {
        machineName: "Source Mac",
        sessionId: "session-1",
        provider: "codex" as const,
        model: "gpt-5.5",
        title: "Cross-machine work",
        laneName: "handoff lane",
        branchRef: "feature/handoff",
        headSha: "a".repeat(40),
        originUrl: "https://github.com/acme/ade.git",
      },
      target: { targetModelId: "openai/gpt-5.5" as const },
      brief: "Continue the verified implementation.",
      artifacts: { fileChanges: [], commands: [], errors: [] },
      linearIssues: [],
      continuationPrompt: "Continue working from this handoff.",
    };
    const prepareCrossMachineHandoff = vi.fn().mockResolvedValue({
      capsule,
      capsuleFingerprint: "fingerprint-1",
      usedFallbackSummary: false,
      sanitizedSensitiveContext: false,
    });
    const validateCrossMachineSource = vi.fn().mockResolvedValue({ valid: true });
    const preflightCrossMachineDestination = vi.fn().mockResolvedValue({
      providerAuthorized: true,
      modelAvailable: true,
      remoteBranchHeadSha: capsule.source.headSha,
      existingLaneId: null,
      blockingErrors: [],
      warnings: [],
    });
    const acceptCrossMachineHandoff = vi.fn().mockResolvedValue({
      handoffId: capsule.handoffId,
      laneId: "lane-2",
      session: { id: "session-2" },
      reusedLane: false,
      reusedSession: false,
    });
    const markCrossMachineHandoff = vi.fn().mockResolvedValue({ marked: true });
    const { service } = createService({
      agentChatService: {
        prepareCrossMachineHandoff,
        validateCrossMachineSource,
        preflightCrossMachineDestination,
        acceptCrossMachineHandoff,
        markCrossMachineHandoff,
      },
    });

    await expect(service.execute(makePayload("chat.prepareCrossMachineHandoff", {
      sourceSessionId: " session-1 ",
      handoffId: " handoff-1 ",
      targetModelId: " openai/gpt-5.5 ",
      continuationPrompt: capsule.continuationPrompt,
      reasoningEffort: " high ",
      fastMode: true,
      untrustedExtraField: "must-not-pass-through",
    }))).resolves.toMatchObject({ capsuleFingerprint: "fingerprint-1" });
    expect(prepareCrossMachineHandoff).toHaveBeenCalledWith({
      sourceSessionId: "session-1",
      handoffId: "handoff-1",
      targetModelId: "openai/gpt-5.5",
      continuationPrompt: capsule.continuationPrompt,
      reasoningEffort: "high",
      fastMode: true,
    });
    await expect(service.execute(makePayload("chat.prepareCrossMachineHandoff", {
      sourceSessionId: "session-1",
      handoffId: "handoff-1",
      targetModelId: "openai/gpt-5.5",
      codexSandbox: "invalid-sandbox",
    }))).rejects.toThrow("codexSandbox is invalid");

    await expect(service.execute(makePayload("chat.validateCrossMachineSource", {
      sourceSessionId: capsule.source.sessionId,
      capsule,
      capsuleFingerprint: "fingerprint-1",
    }))).resolves.toEqual({ valid: true });
    await expect(service.execute(makePayload("chat.preflightCrossMachineDestination", {
      targetModelId: capsule.target.targetModelId,
      sourceBranchRef: capsule.source.branchRef,
      sourceHeadSha: capsule.source.headSha,
    }))).resolves.toMatchObject({ providerAuthorized: true, modelAvailable: true });
    await expect(service.execute(makePayload("chat.acceptCrossMachineHandoff", {
      capsule,
      capsuleFingerprint: "fingerprint-1",
    }))).resolves.toMatchObject({ laneId: "lane-2", session: { id: "session-2" } });
    await expect(service.execute(makePayload("chat.markCrossMachineHandoff", {
      sourceSessionId: capsule.source.sessionId,
      handoffId: capsule.handoffId,
      targetMachineName: "Destination Mac",
      targetLaneId: "lane-2",
      targetSessionId: "session-2",
    }))).resolves.toEqual({ marked: true });

    expect(validateCrossMachineSource).toHaveBeenCalledWith(expect.objectContaining({ capsule }));
    expect(preflightCrossMachineDestination).toHaveBeenCalledWith({
      targetModelId: capsule.target.targetModelId,
      sourceBranchRef: capsule.source.branchRef,
      sourceHeadSha: capsule.source.headSha,
    });
    expect(acceptCrossMachineHandoff).toHaveBeenCalledWith({
      capsule,
      capsuleFingerprint: "fingerprint-1",
    });
    expect(markCrossMachineHandoff).toHaveBeenCalledWith({
      sourceSessionId: capsule.source.sessionId,
      handoffId: capsule.handoffId,
      targetMachineName: "Destination Mac",
      targetLaneId: "lane-2",
      targetSessionId: "session-2",
    });
  });

  it("routes github.publishCurrentProject through the GitHub service with validated args", async () => {
    const publishCurrentProject = vi.fn().mockResolvedValue({
      state: "pushed",
      owner: "acme",
      name: "ade",
      fullName: "acme/ade",
      htmlUrl: "https://github.com/acme/ade",
    });
    const { service } = createService({
      githubService: { publishCurrentProject },
    });

    expect(service.getSupportedActions()).toContain("github.publishCurrentProject");
    expect(service.getDescriptor("github.publishCurrentProject")).toEqual({
      action: "github.publishCurrentProject",
      scope: "project",
      policy: { viewerAllowed: true },
    });

    await expect(service.execute(makePayload("github.publishCurrentProject", {
      owner: "acme",
    }))).rejects.toThrow("github.publishCurrentProject requires name.");
    expect(publishCurrentProject).not.toHaveBeenCalled();

    const result = await service.execute(makePayload("github.publishCurrentProject", {
      owner: " acme ",
      name: " ade ",
      description: " Local-first agent desk ",
    }));

    expect(result).toEqual({
      state: "pushed",
      owner: "acme",
      name: "ade",
      fullName: "acme/ade",
      htmlUrl: "https://github.com/acme/ade",
    });
    expect(publishCurrentProject).toHaveBeenCalledWith({
      owner: "acme",
      name: "ade",
      description: "Local-first agent desk",
      isPrivate: true,
    });
  });
});

describe("prs.land", () => {
  it("forwards bypass + editable commit message to prService.land", async () => {
    const land = vi.fn().mockResolvedValue({ prId: "pr-1", success: true });
    const { service } = createService({ prService: { land } });

    const result = await service.execute(makePayload("prs.land", {
      prId: "pr-1",
      method: "squash",
      bypassRules: true,
      commitTitle: "Land it",
      commitBody: "Body text",
      expectedHeadSha: "abc123",
    }));

    expect(land).toHaveBeenCalledWith({
      prId: "pr-1",
      method: "squash",
      bypassRules: true,
      commitTitle: "Land it",
      commitBody: "Body text",
      expectedHeadSha: "abc123",
    });
    expect(result).toEqual({ prId: "pr-1", success: true });
  });

  it("omits optional fields that are absent or blank", async () => {
    const land = vi.fn().mockResolvedValue({ prId: "pr-1", success: true });
    const { service } = createService({ prService: { land } });

    await service.execute(makePayload("prs.land", {
      prId: "pr-1",
      method: "merge",
      commitTitle: "   ",
    }));

    expect(land).toHaveBeenCalledWith({ prId: "pr-1", method: "merge" });
  });

  it("rejects an invalid method", async () => {
    const land = vi.fn();
    const { service } = createService({ prService: { land } });

    await expect(
      service.execute(makePayload("prs.land", { prId: "pr-1", method: "fast-forward" })),
    ).rejects.toThrow("prs.land requires method to be merge, squash, or rebase.");
    expect(land).not.toHaveBeenCalled();
  });
});

describe("prs.updateBranch", () => {
  it("forwards strategy + expected head sha to prService.updateBranch", async () => {
    const updateBranch = vi.fn().mockResolvedValue({ prId: "pr-1", success: true, hasConflicts: false });
    const { service } = createService({ prService: { updateBranch } });

    const result = await service.execute(makePayload("prs.updateBranch", {
      prId: "pr-1",
      strategy: "rebase",
      expectedHeadSha: "abc123",
    }));

    expect(updateBranch).toHaveBeenCalledWith({
      prId: "pr-1",
      strategy: "rebase",
      expectedHeadSha: "abc123",
    });
    expect(result).toEqual({ prId: "pr-1", success: true, hasConflicts: false });
  });

  it("rejects an invalid strategy", async () => {
    const updateBranch = vi.fn();
    const { service } = createService({ prService: { updateBranch } });

    await expect(
      service.execute(makePayload("prs.updateBranch", { prId: "pr-1", strategy: "squash" })),
    ).rejects.toThrow("prs.updateBranch requires strategy to be merge or rebase.");
    expect(updateBranch).not.toHaveBeenCalled();
  });
});

describe("lanes.suggestName", () => {
  it("exposes a non-queueable, viewer-allowed descriptor", () => {
    const { service } = createService();

    expect(service.getDescriptor("lanes.suggestName")).toEqual({
      action: "lanes.suggestName",
      scope: "project",
      policy: { viewerAllowed: true },
    });
  });

  it("returns the model-suggested name on success", async () => {
    const suggestLaneNameFromPrompt = vi.fn().mockResolvedValue("refactor-auth-flow");
    const { service, logger } = createService({ agentChatService: { suggestLaneNameFromPrompt } });

    const result = await service.execute(makePayload("lanes.suggestName", {
      laneId: "lane-1",
      prompt: "please refactor the auth flow",
      modelId: "anthropic/claude-haiku-4-5",
      fallbackName: "fallback-auth-flow",
    }));

    expect(result).toEqual({ name: "refactor-auth-flow" });
    expect(suggestLaneNameFromPrompt).toHaveBeenCalledWith({
      laneId: "lane-1",
      prompt: "please refactor the auth flow",
      modelId: "anthropic/claude-haiku-4-5",
      fallbackName: "fallback-auth-flow",
    });
    expect(logger.info).toHaveBeenCalledWith("sync.lanes_suggest_name_succeeded", {
      laneId: "lane-1",
      modelId: "anthropic/claude-haiku-4-5",
      name: "refactor-auth-flow",
    });
  });

  it("falls back to the client's deterministic name and logs when the naming service throws", async () => {
    const suggestLaneNameFromPrompt = vi.fn().mockRejectedValue(new Error("boom"));
    const { service, logger } = createService({ agentChatService: { suggestLaneNameFromPrompt } });

    const result = await service.execute(makePayload("lanes.suggestName", {
      laneId: "lane-1",
      prompt: "fix the flaky login test",
      modelId: "m",
      fallbackName: "fix the flaky login test",
    }));

    expect(result).toEqual({ name: "fix the flaky login test" });
    expect(logger.warn).toHaveBeenCalledWith(
      "sync.lanes_suggest_name_failed",
      expect.objectContaining({ laneId: "lane-1", modelId: "m" }),
    );
  });

  it("falls back when the naming service is unavailable, deriving from the prompt without a client fallback", async () => {
    const { service } = createService();

    const result = await service.execute(makePayload("lanes.suggestName", {
      laneId: "lane-1",
      prompt: "Please help me fix the login bug",
      modelId: "m",
    }));

    expect(result).toEqual({
      name: deriveDeterministicLaneNameFromPrompt("Please help me fix the login bug"),
    });
  });

  it("falls back when the naming service returns an empty string", async () => {
    const suggestLaneNameFromPrompt = vi.fn().mockResolvedValue("   ");
    const { service } = createService({ agentChatService: { suggestLaneNameFromPrompt } });

    const result = await service.execute(makePayload("lanes.suggestName", {
      laneId: "lane-1",
      prompt: "build the dashboard",
      modelId: "m",
      fallbackName: "build the dashboard",
    }));

    expect(result).toEqual({ name: "build the dashboard" });
  });

  it("rejects when prompt is missing", async () => {
    const { service } = createService();

    await expect(
      service.execute(makePayload("lanes.suggestName", { laneId: "lane-1", modelId: "m" })),
    ).rejects.toThrow("lanes.suggestName requires prompt.");
  });
});

describe("lanes.refreshSnapshots conditional responses", () => {
  function createLaneListService() {
    const lanes = [{ id: "lane-1", name: "Lane one", status: { dirty: false, ahead: 0, behind: 0 } }];
    const laneService = {
      refreshSnapshots: vi.fn().mockResolvedValue({ refreshedCount: 1, lanes }),
      listStateSnapshots: vi.fn().mockReturnValue([]),
    };
    const sessionService = { list: vi.fn().mockReturnValue([]) };
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() };
    const service = createSyncRemoteCommandService({
      laneService,
      prService: {},
      ptyService: {},
      sessionService,
      fileService: {},
      logger,
    } as any);
    return { service, laneService };
  }

  it("returns the full payload with a signature, then notModified for a matching ifNoneMatch", async () => {
    const { service } = createLaneListService();

    const first = (await service.execute(makePayload("lanes.refreshSnapshots"))) as {
      lanes: unknown[];
      snapshots: unknown[] | null;
      signature: string;
      notModified: boolean;
    };
    expect(first.notModified).toBe(false);
    expect(first.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(first.lanes).toHaveLength(1);
    expect(first.snapshots).toHaveLength(1);

    const second = (await service.execute(
      makePayload("lanes.refreshSnapshots", { ifNoneMatch: first.signature }),
    )) as { lanes: unknown[]; snapshots: unknown[] | null; signature: string; notModified: boolean };
    expect(second.notModified).toBe(true);
    expect(second.signature).toBe(first.signature);
    expect(second.lanes).toEqual([]);
    expect(second.snapshots).toBeNull();
  });

  it("returns the full payload again when ifNoneMatch is stale", async () => {
    const { service } = createLaneListService();

    const result = (await service.execute(
      makePayload("lanes.refreshSnapshots", { ifNoneMatch: "0".repeat(64) }),
    )) as { lanes: unknown[]; signature: string; notModified: boolean };
    expect(result.notModified).toBe(false);
    expect(result.lanes).toHaveLength(1);
    expect(result.signature).not.toBe("0".repeat(64));
  });
});

describe("lanes.create default base resolution", () => {
  function createLaneCreateService(options?: {
    newLaneBaseSource?: "remote" | "local";
    branches?: Array<{ name: string; isCurrent: boolean; isRemote: boolean; upstream: string | null }>;
  }) {
    const laneService = {
      create: vi.fn().mockResolvedValue({ id: "lane-new", name: "fresh" }),
      list: vi.fn().mockResolvedValue([
        { id: "lane-primary", laneType: "primary", baseRef: "main", branchRef: "main" },
      ]),
    };
    const gitService = {
      fetch: vi.fn().mockResolvedValue({ ok: true }),
      listBranches: vi.fn().mockResolvedValue(options?.branches ?? [
        { name: "main", isCurrent: true, isRemote: false, upstream: "origin/main" },
        { name: "origin/main", isCurrent: false, isRemote: true, upstream: null },
      ]),
    };
    const projectConfigService = {
      getEffective: vi.fn().mockReturnValue({ git: { newLaneBaseSource: options?.newLaneBaseSource ?? "remote" } }),
    };
    const service = createSyncRemoteCommandService({
      laneService,
      gitService,
      projectConfigService,
      prService: {},
      ptyService: {},
      sessionService: {},
      fileService: {},
      logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    } as any);
    return { service, laneService, gitService };
  }

  it("defaults a base-less create to the fetched remote-tracking ref", async () => {
    const { service, laneService, gitService } = createLaneCreateService();

    await service.execute(makePayload("lanes.create", { name: "fresh", description: "" }));

    expect(gitService.fetch).toHaveBeenCalledWith({ laneId: "lane-primary" });
    expect(laneService.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: "fresh", baseBranch: "origin/main" }),
    );
  });

  it("leaves an explicit baseBranch untouched and never fetches", async () => {
    const { service, laneService, gitService } = createLaneCreateService();

    await service.execute(makePayload("lanes.create", { name: "fresh", description: "", baseBranch: "develop" }));

    expect(gitService.fetch).not.toHaveBeenCalled();
    expect(laneService.create).toHaveBeenCalledWith(
      expect.objectContaining({ baseBranch: "develop" }),
    );
    expect(laneService.create.mock.calls[0]![0].baseBranch).toBe("develop");
  });

  it("respects newLaneBaseSource=local (no fetch, no injected base)", async () => {
    const { service, laneService, gitService } = createLaneCreateService({ newLaneBaseSource: "local" });

    await service.execute(makePayload("lanes.create", { name: "fresh", description: "" }));

    expect(gitService.fetch).not.toHaveBeenCalled();
    expect(laneService.create.mock.calls[0]![0].baseBranch).toBeUndefined();
  });

  it("keeps the local default when no remote-tracking ref exists", async () => {
    const { service, laneService } = createLaneCreateService({
      branches: [{ name: "main", isCurrent: true, isRemote: false, upstream: null }],
    });

    await service.execute(makePayload("lanes.create", { name: "fresh", description: "" }));

    expect(laneService.create.mock.calls[0]![0].baseBranch).toBeUndefined();
  });
});
