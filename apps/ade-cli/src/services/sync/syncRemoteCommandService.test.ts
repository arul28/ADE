import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SyncCommandPayload, SyncPairingConnectInfo, SyncWebPairingInfo } from "../../../../desktop/src/shared/types";
import { parsePairingQrText } from "../../../../desktop/src/shared/pairingQr";
import { deriveDeterministicLaneNameFromPrompt } from "../../../../desktop/src/shared/laneNameFallback";
import { MOBILE_SYNC_OPTIONAL_REMOTE_COMMAND_ACTIONS } from "../../../../desktop/src/shared/syncMobileCompatibility";
import { createSyncRemoteCommandService } from "./syncRemoteCommandService";

function makePayload(
  action: string,
  args: Record<string, unknown> = {},
): SyncCommandPayload {
  return { commandId: "cmd-1", action, args };
}

function createService(options?: {
  agentChatService?: Record<string, unknown>;
  aiIntegrationService?: Record<string, unknown>;
  conflictService?: Record<string, unknown>;
  diffService?: Record<string, unknown>;
  externalSessionsService?: Record<string, unknown>;
  gitService?: Record<string, unknown>;
  githubService?: Record<string, unknown>;
  laneService?: Record<string, unknown>;
  operationService?: Record<string, unknown>;
  prService?: Record<string, unknown>;
  prSummaryService?: Record<string, unknown>;
  projectRoot?: string;
  ptyService?: Record<string, unknown>;
  sessionDeltaService?: Record<string, unknown>;
  sessionService?: Record<string, unknown>;
  projectConfigService?: Record<string, unknown>;
  db?: Record<string, unknown>;
  syncPinStore?: Record<string, unknown>;
  getPairingConnectInfo?: () => SyncPairingConnectInfo | null;
  issueRuntimeHostPairingGrant?: () => string;
  isCloudRelayEnabled?: () => boolean;
  linearCredentialService?: Record<string, unknown>;
  linearOAuthService?: Record<string, unknown>;
  laneEnvironmentService?: Record<string, unknown>;
  portAllocationService?: Record<string, unknown>;
  getLinearIssueTracker?: () => Record<string, unknown> | null;
  usageTrackingService?: Record<string, unknown>;
  productAnalyticsService?: Record<string, unknown>;
  pushPublisherService?: Record<string, unknown>;
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
    setSessionRuntimeState: vi.fn(),
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
    laneService: options?.laneService ?? {},
    prService: options?.prService ?? {},
    ...(options?.prSummaryService ? { prSummaryService: options.prSummaryService } : {}),
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
    ...(options?.aiIntegrationService ? { aiIntegrationService: options.aiIntegrationService } : {}),
    ...(options?.externalSessionsService ? { externalSessionsService: options.externalSessionsService } : {}),
    ...(options?.syncPinStore ? { syncPinStore: options.syncPinStore } : {}),
    ...(options?.getPairingConnectInfo ? { getPairingConnectInfo: options.getPairingConnectInfo } : {}),
    ...(options?.issueRuntimeHostPairingGrant
      ? { issueRuntimeHostPairingGrant: options.issueRuntimeHostPairingGrant }
      : {}),
    ...(options?.isCloudRelayEnabled ? { isCloudRelayEnabled: options.isCloudRelayEnabled } : {}),
    ...(options?.linearCredentialService ? { linearCredentialService: options.linearCredentialService } : {}),
    ...(options?.linearOAuthService ? { linearOAuthService: options.linearOAuthService } : {}),
    ...(options?.laneEnvironmentService ? { laneEnvironmentService: options.laneEnvironmentService } : {}),
    ...(options?.portAllocationService ? { portAllocationService: options.portAllocationService } : {}),
    ...(options?.getLinearIssueTracker ? { getLinearIssueTracker: options.getLinearIssueTracker } : {}),
    ...(options?.usageTrackingService ? { usageTrackingService: options.usageTrackingService } : {}),
    ...(options?.productAnalyticsService ? { productAnalyticsService: options.productAnalyticsService } : {}),
    ...(options?.pushPublisherService ? { pushPublisherService: options.pushPublisherService } : {}),
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
  it("serves machine Attention to paired viewers without project context", async () => {
    const snapshot = {
      contractVersion: 1,
      scope: "machine",
      streamId: "machine:host-1",
      revision: 7,
      generatedAt: "2026-07-29T12:00:00.000Z",
      items: [],
      tombstones: [],
    };
    const getMachineAttentionSnapshot = vi.fn().mockResolvedValue(snapshot);
    const acknowledgeMachineAttention = vi.fn().mockResolvedValue(undefined);
    const { service } = createService({
      pushPublisherService: {
        getMachineAttentionSnapshot,
        acknowledgeMachineAttention,
      },
    });

    expect(service.getDescriptor("attention.getMachineSnapshot")).toEqual({
      action: "attention.getMachineSnapshot",
      scope: "runtime",
      policy: { viewerAllowed: true },
    });
    await expect(
      service.execute(makePayload("attention.getMachineSnapshot")),
    ).resolves.toEqual(snapshot);
    expect(getMachineAttentionSnapshot).toHaveBeenCalledTimes(1);

    expect(service.getDescriptor("attention.acknowledgeMachine")).toEqual({
      action: "attention.acknowledgeMachine",
      scope: "runtime",
      policy: { viewerAllowed: true, queueable: false },
    });
    await expect(service.execute(makePayload("attention.acknowledgeMachine", {
      itemIds: [" item-1 ", "", 42],
      sourceRevisions: { "item-1": 7 },
      expectedAccountOwnerId: "account-a",
      seenAt: "2026-07-29T12:01:00.000Z",
    }))).resolves.toEqual({ ok: true });
    expect(acknowledgeMachineAttention).toHaveBeenCalledWith({
      itemIds: ["item-1"],
      sourceRevisions: { "item-1": 7 },
      expectedAccountOwnerId: "account-a",
      seenAt: "2026-07-29T12:01:00.000Z",
    });

    await expect(service.execute(makePayload("attention.acknowledgeMachine", {
      itemIds: ["item-1"],
      sourceRevisions: {},
      expectedAccountOwnerId: "account-a",
    }))).rejects.toThrow("requires the source revision for every item");
    await expect(service.execute(makePayload("attention.acknowledgeMachine", {
      itemIds: ["item-1"],
      sourceRevisions: { "item-1": 7 },
    }))).rejects.toThrow("requires the machine snapshot account owner");
    await expect(service.execute(makePayload("attention.acknowledgeMachine", {
      itemIds: ["item-1"],
      sourceRevisions: { "item-1": 7 },
      expectedAccountOwnerId: null,
      dismissedAt: "2026-07-29T12:02:00.000Z",
    }))).resolves.toEqual({ ok: true });
    expect(acknowledgeMachineAttention).toHaveBeenLastCalledWith({
      itemIds: ["item-1"],
      sourceRevisions: { "item-1": 7 },
      expectedAccountOwnerId: null,
      dismissedAt: "2026-07-29T12:02:00.000Z",
    });
  });

  it("forwards explicit push-to-start clears and rejects set-plus-clear conflicts", async () => {
    const handleDeviceRegistered = vi.fn().mockResolvedValue({ ok: true });
    const { service } = createService({
      pushPublisherService: { handleDeviceRegistered },
    });

    await service.execute(makePayload("push.registerDevice", {
      deviceId: "phone-1",
      bundleId: "com.ade.ios",
      apsEnvironment: "sandbox",
      clearPushToStartToken: true,
    }));
    expect(handleDeviceRegistered).toHaveBeenCalledWith(expect.objectContaining({
      deviceId: "phone-1",
      pushToStartToken: null,
      clearPushToStartToken: true,
    }));

    await expect(service.execute(makePayload("push.registerDevice", {
      deviceId: "phone-1",
      bundleId: "com.ade.ios",
      apsEnvironment: "sandbox",
      pushToStartToken: "ab",
      clearPushToStartToken: true,
    }))).rejects.toThrow("cannot set and clear pushToStartToken together.");
  });

  it("preserves the exact remote-command set that observes execution aborts", () => {
    const { service } = createService();

    expect(new Set(service.getAbortObservingActions())).toEqual(new Set([
      "chat.resolveSmartLinkPreview",
      "chat.getChatEventHistory",
      "chat.getTranscript",
      "chat.getSubagentTranscript",
      "chat.listSubagents",
      "chat.getMainTranscript",
      "chat.getChatEventHistoryPage",
      "agentChat.getEventHistoryPage",
      "github.getStatus",
      "github.getRemoteStatus",
      "ai.getStatus",
      "prs.list",
      "prs.listOpenForRepo",
      "prs.getForLane",
      "prs.refresh",
      "prs.getDetail",
      "prs.getAiSummary",
      "prs.getIntegrationResolutionState",
      "prs.listProposals",
      "prs.getMergeContext",
      "prs.getMergeContexts",
      "prs.listWithConflicts",
      "prs.listSnapshots",
      "prs.getStatus",
      "prs.getChecks",
      "prs.getReviews",
      "prs.getComments",
      "prs.getFiles",
      "prs.getGitHubSnapshot",
      "prs.listGithubStacks",
      "prs.getReviewThreads",
      "prs.getActionRuns",
      "prs.getActivity",
      "prs.getDeployments",
      "prs.getWorkflowGraph",
      "prs.getCheckLog",
      "prs.getDetailByGithub",
      "prs.getFilesByGithub",
      "prs.getCommitsByGithub",
      "prs.getActionRunsByGithub",
      "prs.getActivityByGithub",
      "prs.getStatusByGithub",
      "prs.getChecksByGithub",
      "prs.getReviewsByGithub",
      "prs.getCommentsByGithub",
      "prs.getReviewThreadsByGithub",
      "prs.getMobileGithubDetail",
      "prs.preflightCreateLaneFromPrBranch",
      "prs.listIntegrationWorkflows",
      "prs.getMobileSnapshot",
    ]));
  });

  it("caps ai.getStatus probes at 30 seconds", async () => {
    vi.useFakeTimers();
    const getStatus = vi.fn(() => new Promise<never>(() => {}));
    const { service } = createService({
      aiIntegrationService: {
        getStatus,
        getDailyUsageBatch: vi.fn(() => new Map()),
        getFeatureFlag: vi.fn(() => false),
        getDailyBudgetLimit: vi.fn(() => null),
      },
    });
    try {
      const result = expect(
        service.execute(makePayload("ai.getStatus", { force: true })),
      ).rejects.toThrow("ai.getStatus timed out after 30000ms");
      await vi.advanceTimersByTimeAsync(30_000);
      await result;
      expect(getStatus).toHaveBeenCalledWith({
        force: true,
        refreshOpenCodeInventory: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops waiting for transcript pulls when the execution signal aborts", async () => {
    const getChatTranscriptPage = vi.fn(() => new Promise<never>(() => {}));
    const { service } = createService({
      agentChatService: { getChatTranscriptPage },
    });
    const controller = new AbortController();
    const pending = service.execute(
      makePayload("chat.getTranscript", { sessionId: "chat-1", cursorKind: "byte" }),
      { signal: controller.signal },
    );
    controller.abort(new Error("peer closed"));
    await expect(pending).rejects.toThrow("peer closed");
    expect(getChatTranscriptPage).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "chat-1",
      signal: controller.signal,
    }));
  });

  it("serializes stable byte cursors from bounded transcript pages", async () => {
    const getChatTranscriptPage = vi.fn().mockResolvedValue({
      sessionId: "chat-1",
      entries: [{ role: "user", text: "older", timestamp: "2026-07-24T10:00:00.000Z" }],
      truncated: true,
      totalEntries: 1,
      nextCursor: 320_000,
      cursorKind: "byte",
    });
    const { service } = createService({
      agentChatService: { getChatTranscriptPage },
    });

    await expect(service.execute(makePayload("chat.getTranscript", {
      sessionId: "chat-1",
      cursor: "400000",
      cursorKind: "byte",
      limit: 20,
      maxChars: 50_000,
    }))).resolves.toMatchObject({
      nextCursor: "320000",
      cursorKind: "byte",
    });
    expect(getChatTranscriptPage).toHaveBeenCalledWith({
      sessionId: "chat-1",
      beforeOffset: 400_000,
      limit: 20,
      maxChars: 50_000,
    });
  });

  it("keeps dense index cursors for clients that do not opt into byte paging", async () => {
    const getChatTranscript = vi.fn().mockResolvedValue({
      sessionId: "chat-1",
      entries: [{ role: "user", text: "tail", timestamp: "2026-07-24T10:00:00.000Z" }],
      truncated: true,
      totalEntries: 5,
    });
    const getChatTranscriptPage = vi.fn();
    const { service } = createService({
      agentChatService: { getChatTranscript, getChatTranscriptPage },
    });

    await expect(service.execute(makePayload("chat.getTranscript", {
      sessionId: "chat-1",
      limit: 20,
      maxChars: 50_000,
    }))).resolves.toMatchObject({
      totalEntries: 5,
      nextCursor: "4",
    });
    expect(getChatTranscriptPage).not.toHaveBeenCalled();
  });

  it("propagates abort signals into personal transcript history reads", async () => {
    const call = vi.fn(() => new Promise<never>(() => {}));
    const { service } = createService({
      personalChatScope: { call },
    });
    const controller = new AbortController();
    const pending = service.execute(
      makePayload("personalChats.getEventHistory", { sessionId: "personal-1" }),
      { signal: controller.signal },
    );
    controller.abort(new Error("viewer changed chats"));

    await expect(pending).rejects.toThrow("viewer changed chats");
    expect(call).toHaveBeenCalledWith(
      "getEventHistory",
      { sessionId: "personal-1" },
      controller.signal,
    );
  });

  it("forwards bounded GitHub history pagination for mobile PR lists", async () => {
    const getGithubSnapshot = vi.fn().mockResolvedValue({ repoPullRequests: [] });
    const { service } = createService({ prService: { getGithubSnapshot } });

    await service.execute(makePayload("prs.getGitHubSnapshot", {
      includeExternalClosed: true,
      historyPageLimit: 4.8,
      revalidate: false,
      includeStateCounts: true,
    }));

    expect(getGithubSnapshot).toHaveBeenCalledWith({
      force: false,
      includeExternalClosed: true,
      historyPageLimit: 4,
      revalidate: false,
      includeStateCounts: true,
    });
  });

  it("routes GitHub stack reads and mutations with typed repository arguments", async () => {
    const listGithubStacks = vi.fn().mockReturnValue([]);
    const createGithubStack = vi.fn().mockResolvedValue({ number: 12 });
    const unstackGithubStack = vi.fn().mockResolvedValue(null);
    const { service } = createService({
      prService: {
        listGithubStacks,
        createGithubStack,
        unstackGithubStack,
      },
    });

    await service.execute(makePayload("prs.listGithubStacks", {
      repoOwner: "arul28",
      repoName: "ADE",
    }));
    await service.execute(makePayload("prs.createGithubStack", {
      repoOwner: "arul28",
      repoName: "ADE",
      pullRequests: [964, 965],
    }));
    await service.execute(makePayload("prs.unstackGithubStack", {
      stackNumber: 12,
    }));

    expect(listGithubStacks).toHaveBeenCalledWith({
      repo: { owner: "arul28", name: "ADE" },
    });
    expect(createGithubStack).toHaveBeenCalledWith({
      repo: { owner: "arul28", name: "ADE" },
      pullRequests: [964, 965],
    });
    expect(unstackGithubStack).toHaveBeenCalledWith({ stackNumber: 12 });
  });

  it("serves unmapped PR detail through one coordinate-based mobile command", async () => {
    const detail = { snapshot: { detail: null, checks: [] }, reviewThreads: [], actionRuns: [], activity: [] };
    const getMobileGithubDetail = vi.fn().mockResolvedValue(detail);
    const { service } = createService({ prService: { getMobileGithubDetail } });

    await expect(service.execute(makePayload("prs.getMobileGithubDetail", {
      repoOwner: "arul28",
      repoName: "ADE",
      githubPrNumber: 849,
    }))).resolves.toEqual(detail);
    expect(getMobileGithubDetail).toHaveBeenCalledWith({
      repoOwner: "arul28",
      repoName: "ADE",
      githubPrNumber: 849,
    });
  });

  it("advertises the complete paired-client analytics command contract", async () => {
    const flush = vi.fn(async () => true);
    const { service } = createService({ productAnalyticsService: { flush } });

    expect(
      service.getDescriptors().filter((descriptor) => descriptor.action.startsWith("analytics.")),
    ).toEqual([
      {
        action: "analytics.capture",
        scope: "runtime",
        policy: { viewerAllowed: true },
      },
      {
        action: "analytics.flush",
        scope: "runtime",
        policy: { viewerAllowed: true },
      },
      {
        action: "analytics.getStatus",
        scope: "runtime",
        policy: { viewerAllowed: true },
      },
      {
        action: "analytics.setClientEnabled",
        scope: "runtime",
        policy: { viewerAllowed: true },
      },
    ]);
    await expect(service.execute(makePayload("analytics.flush"))).resolves.toBe(true);
    expect(flush).toHaveBeenCalledTimes(1);
  });

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

  it("registers CTO-gated Linear credential commands and refreshes status after each mutation", async () => {
    let token: string | null = null;
    let authMode: "manual" | "oauth" | null = null;
    let tokenExpiresAt: string | null = null;
    const linearCredentialService = {
      getStatus: vi.fn(() => ({
        tokenStored: token != null,
        authMode,
        tokenExpiresAt,
        oauthConfigured: true,
      })),
      setToken: vi.fn((nextToken: string) => {
        token = nextToken;
        authMode = "manual";
        tokenExpiresAt = null;
      }),
      setOAuthToken: vi.fn((next: { accessToken: string; expiresAt?: string | null }) => {
        token = next.accessToken;
        authMode = "oauth";
        tokenExpiresAt = next.expiresAt ?? null;
      }),
      clearToken: vi.fn(() => {
        token = null;
        authMode = null;
        tokenExpiresAt = null;
      }),
    };
    const getConnectionStatus = vi.fn(async () => token === "invalid-token"
      ? {
          connected: false,
          viewerId: null,
          viewerName: null,
          organizationId: null,
          organizationName: null,
          organizationUrlKey: null,
          organizationLogoUrl: null,
          message: "Linear rejected the API key.",
        }
      : {
          connected: true,
          viewerId: "viewer-1",
          viewerName: "Ada",
          organizationId: "org-1",
          organizationName: "Acme",
          organizationUrlKey: "acme",
          organizationLogoUrl: "https://example.com/acme.png",
          message: null,
        });
    const startExternalSession = vi.fn(async () => ({
      sessionId: "linear-oauth-mobile-1",
      authorizeUrl: "https://linear.app/oauth/authorize?state=state-1",
      expiresAt: "2026-07-18T12:05:00.000Z",
    }));
    const completeExternalSession = vi.fn(async () => {
      linearCredentialService.setOAuthToken({
        accessToken: "oauth-access-token",
        expiresAt: "2026-07-18T14:00:00.000Z",
      });
      return { ok: true as const };
    });
    const { service } = createService({
      linearCredentialService,
      linearOAuthService: { startExternalSession, completeExternalSession },
      getLinearIssueTracker: () => ({ getConnectionStatus }),
    });
    // The interactive OAuth pair stays open to paired viewers; the two direct
    // credential-store writers are host-local only (C12-sec).
    const viewerMutationActions = [
      "cto.startLinearMobileOAuth",
      "cto.completeLinearMobileOAuth",
    ] as const;
    const credentialWriteActions = [
      "cto.setLinearToken",
      "cto.clearLinearToken",
    ] as const;

    for (const action of viewerMutationActions) {
      expect(service.getDescriptor(action)).toEqual({
        action,
        scope: "project",
        policy: { viewerAllowed: true },
      });
    }
    for (const action of credentialWriteActions) {
      expect(service.getDescriptor(action)).toEqual({
        action,
        scope: "project",
        policy: { viewerAllowed: false },
      });
    }

    await expect(service.execute(makePayload("cto.startLinearMobileOAuth"))).resolves.toEqual({
      sessionId: "linear-oauth-mobile-1",
      authorizeUrl: "https://linear.app/oauth/authorize?state=state-1",
      expiresAt: "2026-07-18T12:05:00.000Z",
    });
    expect(startExternalSession).toHaveBeenCalledWith({
      redirectUri: "https://ade-github-webhook-relay.arulsharma1028.workers.dev/linear/oauth/callback",
    });

    await expect(service.execute(makePayload("cto.completeLinearMobileOAuth", {
      sessionId: "linear-oauth-mobile-1",
      code: "authorization-code",
      state: "state-1",
    }))).resolves.toMatchObject({
      tokenStored: true,
      connected: true,
      authMode: "oauth",
      viewerName: "Ada",
      organizationName: "Acme",
    });
    expect(completeExternalSession).toHaveBeenCalledWith({
      sessionId: "linear-oauth-mobile-1",
      code: "authorization-code",
      state: "state-1",
    });

    await expect(service.execute(makePayload("cto.setLinearToken", {
      token: "manual-token",
    }))).resolves.toMatchObject({
      tokenStored: true,
      connected: true,
      authMode: "manual",
    });
    expect(linearCredentialService.setToken).toHaveBeenLastCalledWith("manual-token");

    await expect(service.execute(makePayload("cto.setLinearToken", {
      token: "invalid-token",
    }))).resolves.toMatchObject({
      tokenStored: true,
      connected: false,
      authMode: "manual",
      message: "Linear rejected the API key.",
    });

    await expect(service.execute(makePayload("cto.clearLinearToken"))).resolves.toMatchObject({
      tokenStored: false,
      connected: false,
      authMode: null,
      message: "Linear token not configured.",
    });
    expect(linearCredentialService.clearToken).toHaveBeenCalledTimes(1);
  });

  it("keeps the existing Linear connection when a mobile OAuth reconnect fails", async () => {
    // Regression for the /quality F4 finding: an already-connected user taps
    // Reconnect and the fresh exchange fails (state mismatch / transient). The
    // stored token is untouched, so the command must report the ACTUAL status
    // (still connected) with the failure reason attached — never a false
    // disconnected status that wipes the connected UI.
    const linearCredentialService = {
      getStatus: vi.fn(() => ({
        tokenStored: true,
        authMode: "oauth" as const,
        tokenExpiresAt: "2026-07-18T14:00:00.000Z",
        oauthConfigured: true,
      })),
      setToken: vi.fn(),
      setOAuthToken: vi.fn(),
      clearToken: vi.fn(),
    };
    const getConnectionStatus = vi.fn(async () => ({
      connected: true,
      viewerId: "viewer-1",
      viewerName: "Ada",
      organizationId: "org-1",
      organizationName: "Acme",
      organizationUrlKey: "acme",
      organizationLogoUrl: "https://example.com/acme.png",
      message: null,
    }));
    const startExternalSession = vi.fn(async () => ({
      sessionId: "linear-oauth-mobile-2",
      authorizeUrl: "https://linear.app/oauth/authorize?state=state-2",
      expiresAt: "2026-07-18T12:05:00.000Z",
    }));
    const completeExternalSession = vi.fn(async () => ({
      ok: false as const,
      message: "Linear OAuth state did not match the active sign-in. Start a new sign-in and try again.",
    }));
    const { service } = createService({
      linearCredentialService,
      linearOAuthService: { startExternalSession, completeExternalSession },
      getLinearIssueTracker: () => ({ getConnectionStatus }),
    });

    const result = await service.execute(makePayload("cto.completeLinearMobileOAuth", {
      sessionId: "linear-oauth-mobile-2",
      code: "authorization-code",
      state: "stale-state",
    }));

    expect(result).toMatchObject({
      tokenStored: true,
      connected: true,
      authMode: "oauth",
      viewerName: "Ada",
      organizationName: "Acme",
      message: "Linear OAuth state did not match the active sign-in. Start a new sign-in and try again.",
    });
    expect(linearCredentialService.clearToken).not.toHaveBeenCalled();
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
    expect(service.getDescriptor("personalChats.cancelScheduledWork")).toEqual({
      action: "personalChats.cancelScheduledWork",
      scope: "runtime",
      policy: { viewerAllowed: true, queueable: false },
    });
    expect(service.getDescriptor("personalChats.createScheduledWork")).toEqual({
      action: "personalChats.createScheduledWork",
      scope: "runtime",
      policy: { viewerAllowed: false, queueable: false },
    });
    expect(service.getDescriptor("personalChats.setScheduledWorkPaused")).toEqual({
      action: "personalChats.setScheduledWorkPaused",
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
    await expect(service.execute(makePayload("personalChats.cancelScheduledWork", {
      sessionId: "personal-1",
      scheduleId: "cron-1",
    }))).resolves.toEqual({
      action: "cancelScheduledWork",
      args: { sessionId: "personal-1", scheduleId: "cron-1" },
    });
    expect(personalChatScope.call).toHaveBeenCalledWith("cancelScheduledWork", {
      sessionId: "personal-1",
      scheduleId: "cron-1",
    });
    await expect(service.execute(makePayload("personalChats.createScheduledWork", {
      sessionId: "personal-1",
      cron: "*/20 * * * *",
      prompt: "Check PR CI",
    }))).resolves.toEqual({
      action: "createScheduledWork",
      args: { sessionId: "personal-1", cron: "*/20 * * * *", prompt: "Check PR CI" },
    });
    expect(personalChatScope.call).toHaveBeenCalledWith("createScheduledWork", {
      sessionId: "personal-1",
      cron: "*/20 * * * *",
      prompt: "Check PR CI",
    });
    await expect(service.execute(makePayload("personalChats.setScheduledWorkPaused", {
      sessionId: "personal-1",
      paused: true,
    }))).resolves.toEqual({
      action: "setScheduledWorkPaused",
      args: { sessionId: "personal-1", paused: true },
    });
    expect(personalChatScope.call).toHaveBeenCalledWith("setScheduledWorkPaused", {
      sessionId: "personal-1",
      paused: true,
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
    // Host-local only: the payload carries the raw pairing PIN.
    expect(service.getDescriptor("sync.getWebPairingInfo")).toEqual({
      action: "sync.getWebPairingInfo",
      scope: "runtime",
      policy: { viewerAllowed: false },
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

  it("routes queue-aware interruption and cancelled-queue recovery", async () => {
    const interrupt = vi.fn(async ({ mode = "stop_and_clear" }) => ({
      mode,
      cancelledQueuedCount: mode === "stop_and_clear" ? 2 : 0,
      ...(mode === "stop_and_clear"
        ? { recoveryId: "recovery-1", recoveryExpiresAt: "2026-07-27T12:00:08.000Z" }
        : {}),
    }));
    const restoreCancelledQueue = vi.fn(async () => ({
      restored: true,
      restoredCount: 2,
    }));
    const { service } = createService({
      agentChatService: { interrupt, restoreCancelledQueue },
    });

    await expect(service.execute(makePayload("chat.interruptWithQueueMode", {
      sessionId: "chat-1",
      mode: "stop_only",
    }))).resolves.toEqual({
      ok: true,
      mode: "stop_only",
      cancelledQueuedCount: 0,
    });
    expect(interrupt).toHaveBeenCalledWith({
      sessionId: "chat-1",
      mode: "stop_only",
    });

    await expect(service.execute(makePayload("chat.restoreCancelledQueue", {
      sessionId: "chat-1",
      recoveryId: "recovery-1",
    }))).resolves.toEqual({
      ok: true,
      restored: true,
      restoredCount: 2,
    });
    expect(restoreCancelledQueue).toHaveBeenCalledWith({
      sessionId: "chat-1",
      recoveryId: "recovery-1",
    });

    await expect(service.execute(makePayload("chat.interrupt", {
      sessionId: "chat-1",
      mode: "discard_everything",
    }))).rejects.toThrow(/stop_and_clear.*stop_only/);
    await expect(service.execute(makePayload("chat.restoreCancelledQueue", {
      sessionId: "chat-1",
    }))).rejects.toThrow(/requires recoveryId/);
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(restoreCancelledQueue).toHaveBeenCalledTimes(1);
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

  it("routes provider-neutral recovery and durable unprocessed-message actions", async () => {
    const recoverTurn = vi.fn(async (args) => ({
      action: args.action,
      turnId: args.turnId,
      status: args.action === "nudge" ? "nudged" : "waiting",
    }));
    const resolveUnprocessedMessage = vi.fn(async (args) => ({
      steerId: args.steerId,
      action: args.action,
      status: "completed",
    }));
    const { service } = createService({
      agentChatService: { recoverTurn, resolveUnprocessedMessage },
    });

    expect(service.getDescriptor("chat.recoverTurn")).toEqual({
      action: "chat.recoverTurn",
      scope: "project",
      policy: { viewerAllowed: true, queueable: false },
    });
    expect(service.getDescriptor("chat.resolveUnprocessedMessage")).toEqual({
      action: "chat.resolveUnprocessedMessage",
      scope: "project",
      policy: { viewerAllowed: true, queueable: false },
    });

    await service.execute(makePayload("chat.recoverTurn", {
      sessionId: "chat-1",
      turnId: "turn-1",
      action: "nudge",
    }));
    await service.execute(makePayload("chat.resolveUnprocessedMessage", {
      sessionId: "chat-1",
      steerId: "steer-1",
      action: "run_next",
    }));

    expect(recoverTurn).toHaveBeenCalledWith({
      sessionId: "chat-1",
      turnId: "turn-1",
      action: "nudge",
    });
    expect(resolveUnprocessedMessage).toHaveBeenCalledWith({
      sessionId: "chat-1",
      steerId: "steer-1",
      action: "run_next",
    });
  });

  it("routes scheduled-work cancellation through the non-queueable mobile command", async () => {
    const cancelScheduledWork = vi.fn(async ({ sessionId, scheduleId }: {
      sessionId: string;
      scheduleId: string;
    }) => ({
      schedule: { id: scheduleId, sessionId, status: "cancelled" },
      providerCancellationRequested: true,
      providerCancellationConfirmed: true,
    }));
    const { service } = createService({ agentChatService: { cancelScheduledWork } });

    expect(service.getDescriptor("chat.cancelScheduledWork")).toEqual({
      action: "chat.cancelScheduledWork",
      scope: "project",
      policy: { viewerAllowed: true, queueable: false },
    });
    await expect(service.execute(makePayload("chat.cancelScheduledWork", {
      sessionId: "chat-1",
      scheduleId: "cron-1",
    }))).resolves.toMatchObject({
      schedule: { id: "cron-1", sessionId: "chat-1", status: "cancelled" },
      providerCancellationConfirmed: true,
    });
    expect(cancelScheduledWork).toHaveBeenCalledWith({
      sessionId: "chat-1",
      scheduleId: "cron-1",
    });

    await expect(service.execute(makePayload("chat.cancelScheduledWork", {
      sessionId: "chat-1",
    }))).rejects.toThrow("chat.cancelScheduledWork requires scheduleId.");
    expect(cancelScheduledWork).toHaveBeenCalledTimes(1);
  });

  it("keeps scheduled-work creation owner-only while allowing mobile pause control", async () => {
    const createScheduledWork = vi.fn(async (args: Record<string, unknown>) => ({ item: args }));
    const listScheduledWork = vi.fn(async (args: Record<string, unknown>) => [{ id: "cron-1", ...args }]);
    const setScheduledWorkPaused = vi.fn(async (args: { sessionId: string; paused: boolean }) => ({
      ...args,
      nextWakeAt: null,
    }));
    const { service } = createService({
      agentChatService: { createScheduledWork, listScheduledWork, setScheduledWorkPaused },
    });

    expect(service.getDescriptor("chat.createScheduledWork")).toEqual({
      action: "chat.createScheduledWork",
      scope: "project",
      policy: { viewerAllowed: false, queueable: false },
    });
    expect(service.getDescriptor("chat.listScheduledWork")).toEqual({
      action: "chat.listScheduledWork",
      scope: "project",
      policy: { viewerAllowed: true, queueable: false },
    });
    expect(service.getDescriptor("chat.setScheduledWorkPaused")).toEqual({
      action: "chat.setScheduledWorkPaused",
      scope: "project",
      policy: { viewerAllowed: true, queueable: false },
    });
    await service.execute(makePayload("chat.createScheduledWork", {
      sessionId: "chat-1",
      cron: "0 * * * *",
      prompt: "Check CI.",
      recurring: false,
      reason: "CI watcher",
    }));
    expect(createScheduledWork).toHaveBeenCalledWith({
      sessionId: "chat-1",
      cron: "0 * * * *",
      prompt: "Check CI.",
      recurring: false,
      reason: "CI watcher",
    });
    await service.execute(makePayload("chat.createScheduledWork", {
      sessionId: "chat-1",
      delaySeconds: 720,
      prompt: "Check CI again.",
    }));
    expect(createScheduledWork).toHaveBeenLastCalledWith({
      sessionId: "chat-1",
      delaySeconds: 720,
      prompt: "Check CI again.",
      recurring: false,
    });
    await service.execute(makePayload("chat.createScheduledWork", {
      sessionId: "chat-1",
      runAt: "2026-07-23T01:05:00-04:00",
      prompt: "Check CI at the requested time.",
    }));
    expect(createScheduledWork).toHaveBeenLastCalledWith({
      sessionId: "chat-1",
      runAt: "2026-07-23T01:05:00-04:00",
      prompt: "Check CI at the requested time.",
      recurring: false,
    });
    await expect(service.execute(makePayload("chat.createScheduledWork", {
      sessionId: "chat-1",
      runAt: "2026-07-23T01:05:00-04:00",
      prompt: "Invalid recurring run time.",
      recurring: true,
    }))).rejects.toThrow(/runAt schedules cannot recur/i);
    await expect(service.execute(makePayload("chat.createScheduledWork", {
      sessionId: "chat-1",
      delaySeconds: "720",
      prompt: "Invalid delay.",
    }))).rejects.toThrow(/delaySeconds must be a number/i);
    await expect(service.execute(makePayload("chat.createScheduledWork", {
      sessionId: "chat-1",
      cron: 15,
      delaySeconds: 720,
      prompt: "Invalid cron.",
    }))).rejects.toThrow(/cron must be a non-empty string/i);
    await expect(service.execute(makePayload("chat.createScheduledWork", {
      sessionId: "chat-1",
      runAt: { iso: "2026-07-23T01:00:00Z" },
      delaySeconds: 720,
      prompt: "Invalid run time.",
    }))).rejects.toThrow(/runAt must be a non-empty string/i);
    await expect(service.execute(makePayload("chat.createScheduledWork", {
      sessionId: "chat-1",
      cron: "   ",
      delaySeconds: 720,
      prompt: "Blank cron.",
    }))).rejects.toThrow(/cron must be a non-empty string/i);
    expect(createScheduledWork).toHaveBeenCalledTimes(3);
    await expect(service.execute(makePayload("chat.listScheduledWork", {
      sessionId: "chat-1",
    }))).resolves.toEqual([{ id: "cron-1", sessionId: "chat-1" }]);
    expect(listScheduledWork).toHaveBeenCalledWith({ sessionId: "chat-1" });
    await service.execute(makePayload("chat.setScheduledWorkPaused", {
      sessionId: "chat-1",
      paused: true,
    }));
    expect(setScheduledWorkPaused).toHaveBeenCalledWith({ sessionId: "chat-1", paused: true });
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

  it("rejects unsupported provider-neutral recovery and message-resolution actions", async () => {
    const recoverTurn = vi.fn();
    const resolveUnprocessedMessage = vi.fn();
    const { service } = createService({
      agentChatService: { recoverTurn, resolveUnprocessedMessage },
    });

    await expect(service.execute(makePayload("chat.recoverTurn", {
      sessionId: "chat-1",
      turnId: "turn-1",
      action: "replace",
    }))).rejects.toThrow("unsupported action 'replace'");
    await expect(service.execute(makePayload("chat.resolveUnprocessedMessage", {
      sessionId: "chat-1",
      steerId: "steer-1",
      action: "retry",
    }))).rejects.toThrow("unsupported action 'retry'");
    expect(recoverTurn).not.toHaveBeenCalled();
    expect(resolveUnprocessedMessage).not.toHaveBeenCalled();
  });

  it("preserves Claude priority steering and guarded queue cancellation", async () => {
    const steerUserMessage = vi.fn().mockResolvedValue({ steerId: "steer-1", queued: false });
    const cancelSteer = vi.fn().mockResolvedValue(undefined);
    const { service } = createService({ agentChatService: { steerUserMessage, cancelSteer } });

    await expect(service.execute(makePayload("chat.steer", {
      sessionId: "chat-1",
      text: "Redirect the active turn.",
      dispatchMode: "interrupt",
    }))).resolves.toEqual({ ok: true, steerId: "steer-1", queued: false });
    expect(steerUserMessage).toHaveBeenCalledWith({
      sessionId: "chat-1",
      text: "Redirect the active turn.",
      dispatchMode: "interrupt",
    });

    await expect(service.execute(makePayload("chat.cancelSteer", {
      sessionId: "chat-1",
      steerId: "steer-1",
      requireQueued: true,
    }))).resolves.toEqual({ ok: true });
    expect(cancelSteer).toHaveBeenCalledWith({
      sessionId: "chat-1",
      steerId: "steer-1",
      requireQueued: true,
    });

    await expect(service.execute(makePayload("chat.steer", {
      sessionId: "chat-1",
      text: "Invalid mode.",
      dispatchMode: "later",
    }))).rejects.toThrow("chat.steer dispatchMode must be 'inline' or 'interrupt'.");
    await expect(service.execute(makePayload("chat.cancelSteer", {
      sessionId: "chat-1",
      steerId: "steer-1",
      requireQueued: "yes",
    }))).rejects.toThrow("chat.cancelSteer requireQueued must be a boolean.");
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
      maxBytes: 131_072,
    }));

    expect(getChatEventHistory).toHaveBeenCalledWith("chat-1", {
      maxEvents: 128,
      maxBytes: 131_072,
    });
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
      status: "active",
      currentTurnStartedAt: "2026-07-31T12:00:00.000Z",
      awaitingInput: true,
      pendingInputItemId: "provider-question-1",
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
      runtimeState: "waiting-input",
      chatIdleSinceAt: null,
      pendingInputItemId: "provider-question-1",
      attentionSource: "provider_structured",
      currentTurnStartedAt: "2026-07-31T12:00:00.000Z",
      orchestrationRunId: "run-1",
      orchestrationRole: "worker",
      orchestrationTag: "impl",
    }));

    getSessionSummary.mockResolvedValueOnce({
      sessionId: "session-1",
      status: "active",
      awaitingInput: false,
    });
    ptyService.enrichSessions.mockReturnValueOnce([{
      ...enrichedSession,
      pendingInputItemId: "provider-question-1",
      attentionSource: "provider_structured",
    }]);
    const resumed = await service.execute(makePayload("work.getSession", { sessionId: "session-1" }));
    expect(resumed).toEqual(expect.objectContaining({
      runtimeState: "running",
      pendingInputItemId: null,
      attentionSource: null,
    }));
  });

  it("delegates PR merge contexts to the injected service", async () => {
    const getMergeContexts = vi.fn().mockResolvedValue({ "pr-1": { prId: "pr-1", mergeable: true } });
    const { service } = createService({
      prService: { getMergeContexts },
    });

    const contexts = await service.execute(makePayload("prs.getMergeContexts", { prIds: ["pr-1"] }));

    expect(service.getDescriptor("prs.getMergeContexts")).toEqual({
      action: "prs.getMergeContexts",
      scope: "project",
      policy: { viewerAllowed: true },
    });
    expect(getMergeContexts).toHaveBeenCalledWith(["pr-1"]);
    expect(contexts).toEqual({ "pr-1": { prId: "pr-1", mergeable: true } });
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
    await expect(service.execute(makePayload("chat.resolveSmartLinkPreview"))).rejects.toThrow(
      "chat.resolveSmartLinkPreview requires url.",
    );

    expect(activeForChat).not.toHaveBeenCalled();
    expect(postReviewComment).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("keeps provider credentials out of remote projectConfig reads and writes", async () => {
    const onDisk = () => ({
      shared: { version: 1, providers: { legacy: { apiKey: "shared-secret" } } },
      local: { version: 1, ai: { defaultProvider: "openai", apiKeys: { openai: "sk-real" } } },
      effective: { version: 1, ai: { apiKeys: { openai: "sk-real" } }, providers: { legacy: {} } },
      trust: {},
      validation: {},
      paths: { sharedPath: "/p/.ade/config.yaml", localPath: "/p/.ade/config.local.yaml" },
    });
    const get = vi.fn(onDisk);
    const save = vi.fn(onDisk);
    const { service } = createService({ projectConfigService: { get, save } });

    const read = await service.execute(makePayload("projectConfig.get")) as Record<string, any>;
    expect(read.local.ai).toEqual({ defaultProvider: "openai" });
    expect(read.effective.ai).toEqual({});
    expect(read.shared.providers).toBeUndefined();
    expect(read.effective.providers).toBeUndefined();
    expect(read.paths).toEqual(onDisk().paths);

    // A viewer round-tripping that redacted read must neither erase the host's
    // keys nor smuggle its own in.
    await service.execute(makePayload("projectConfig.save", {
      candidate: {
        shared: { version: 1, providers: { legacy: { apiKey: "injected" } } },
        local: { version: 1, ai: { defaultProvider: "anthropic", apiKeys: { openai: "sk-attacker" } } },
      },
    }));

    expect(save).toHaveBeenCalledWith({
      shared: { version: 1, providers: { legacy: { apiKey: "shared-secret" } } },
      local: { version: 1, ai: { defaultProvider: "anthropic", apiKeys: { openai: "sk-real" } } },
    });
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
      "chat.resolveSmartLinkPreview",
      "chat.createScheduledWork",
      "chat.listScheduledWork",
      "chat.cancelScheduledWork",
      "chat.setScheduledWorkPaused",
      "chat.getParallelLaunchState",
      "chat.setParallelLaunchState",
      "chat.handoff",
      "chat.prepareCrossMachineHandoff",
      "chat.validateCrossMachineSource",
      "chat.preflightCrossMachineDestination",
      "chat.fastForwardCrossMachineHandoffLane",
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
    expect(service.getDescriptor("chat.resolveSmartLinkPreview")).toEqual({
      action: "chat.resolveSmartLinkPreview",
      scope: "project",
      policy: { viewerAllowed: true },
    });
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
    const fastForwardCrossMachineHandoffLane = vi.fn().mockResolvedValue({
      ok: true,
      head: capsule.source.headSha,
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
        fastForwardCrossMachineHandoffLane,
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
    await expect(service.execute(makePayload("chat.fastForwardCrossMachineHandoffLane", {
      laneId: " lane-2 ",
      expectedHead: ` ${capsule.source.headSha} `,
    }))).resolves.toEqual({ ok: true, head: capsule.source.headSha });
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
    expect(fastForwardCrossMachineHandoffLane).toHaveBeenCalledWith({
      laneId: "lane-2",
      expectedHead: capsule.source.headSha,
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

  it("forwards fork mode and sourceProvider through the cross-machine handoff bridge", async () => {
    const prepareCrossMachineHandoff = vi.fn().mockResolvedValue({
      capsule: { handoffId: "handoff-1" },
      capsuleFingerprint: "fingerprint-1",
      usedFallbackSummary: false,
      sanitizedSensitiveContext: false,
    });
    const preflightCrossMachineDestination = vi.fn().mockResolvedValue({
      providerAuthorized: true,
      modelAvailable: true,
      remoteBranchHeadSha: "a".repeat(40),
      existingLaneId: null,
      blockingErrors: [],
      warnings: [],
      forkHandoffSupport: { supported: true },
    });
    const { service } = createService({
      agentChatService: { prepareCrossMachineHandoff, preflightCrossMachineDestination },
    });

    await service.execute(makePayload("chat.prepareCrossMachineHandoff", {
      sourceSessionId: "session-1",
      handoffId: "handoff-1",
      targetModelId: "openai/gpt-5.5",
      mode: "fork",
    }));
    expect(prepareCrossMachineHandoff).toHaveBeenCalledWith(expect.objectContaining({ mode: "fork" }));

    await service.execute(makePayload("chat.preflightCrossMachineDestination", {
      targetModelId: "openai/gpt-5.5",
      sourceBranchRef: "feature/handoff",
      sourceHeadSha: "a".repeat(40),
      mode: "fork",
      sourceProvider: "claude",
    }));
    expect(preflightCrossMachineDestination).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "fork", sourceProvider: "claude" }),
    );

    await expect(service.execute(makePayload("chat.preflightCrossMachineDestination", {
      targetModelId: "openai/gpt-5.5",
      sourceBranchRef: "feature/handoff",
      sourceHeadSha: "a".repeat(40),
      mode: "resume",
    }))).rejects.toThrow("mode must be brief or fork");
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

describe("session lifecycle remote commands", () => {
  function createLifecycleService(options?: {
    pushPublisherService?: Record<string, unknown>;
    session?: Record<string, unknown>;
  }) {
    const sessionService = {
      settleSession: vi.fn(() => true),
      unsettleSession: vi.fn(() => true),
      settleSessions: vi.fn(() => ["session-1"]),
      unsettleSessions: vi.fn(),
      snoozeSession: vi.fn(() => true),
      snoozeSessions: vi.fn(() => ["session-1"]),
      wakeSession: vi.fn(() => true),
      wakeSessions: vi.fn(() => ["session-1"]),
      setSettleOverride: vi.fn(() => true),
      clearWokeMarker: vi.fn(() => true),
      get: vi.fn(() => options?.session ?? ({ id: "session-1", toolType: "codex-chat" })),
    };
    const { service } = createService({
      sessionService,
      ...(options?.pushPublisherService ? { pushPublisherService: options.pushPublisherService } : {}),
    });
    return { service, sessionService };
  }

  it("settles and unsettles a session for clients with no local DB", async () => {
    const { service, sessionService } = createLifecycleService();
    await expect(service.execute(makePayload("session.settleSession", {
      sessionId: "session-1",
      outcome: "PR #841 merged",
    }))).resolves.toEqual({ ok: true, sessionId: "session-1" });
    expect(sessionService.settleSession).toHaveBeenCalledWith("session-1", { outcome: "PR #841 merged" });

    await expect(service.execute(makePayload("session.unsettleSession", { sessionId: "session-1" })))
      .resolves.toEqual({ ok: true, sessionId: "session-1" });
    expect(sessionService.unsettleSession).toHaveBeenCalledWith("session-1");
  });

  it("resolves push attention when dismissing an explicit CLI ask", async () => {
    const handleSessionSettled = vi.fn();
    const { service, sessionService } = createLifecycleService({
      pushPublisherService: { handleSessionSettled },
      session: {
        id: "session-1",
        toolType: "codex",
        attentionRequestedAt: "2026-07-29T21:00:00.000Z",
      },
    });

    await expect(service.execute(makePayload("session.settleSession", {
      sessionId: "session-1",
      dismissPendingInput: true,
    }))).resolves.toEqual({ ok: true, sessionId: "session-1" });

    expect(handleSessionSettled).not.toHaveBeenCalled();
    expect(sessionService.settleSession).toHaveBeenCalledWith("session-1", {});
  });

  it("leaves settlement push projection to the central session listener", async () => {
    const handleSessionSettled = vi.fn();
    const { service } = createLifecycleService({
      pushPublisherService: { handleSessionSettled },
    });

    await service.execute(makePayload("session.settleSession", { sessionId: "session-1" }));
    await service.execute(makePayload("session.settleSessions", { sessionIds: ["session-1"] }));

    expect(handleSessionSettled).not.toHaveBeenCalled();
  });

  it("normalizes the snooze deadline and rejects unparseable ones", async () => {
    const { service, sessionService } = createLifecycleService();
    const futureIso = new Date(Date.now() + 60 * 60_000).toISOString();
    await expect(service.execute(makePayload("session.snoozeSession", {
      sessionId: "session-1",
      untilIso: futureIso,
    }))).resolves.toEqual({
      ok: true,
      sessionId: "session-1",
      snoozedUntil: futureIso,
    });
    expect(sessionService.snoozeSession).toHaveBeenCalledWith("session-1", futureIso);

    await expect(service.execute(makePayload("session.snoozeSession", { sessionId: "session-1" })))
      .rejects.toThrow(/untilIso/);
    await expect(service.execute(makePayload("session.snoozeSession", {
      sessionId: "session-1",
      untilIso: "tomorrow",
    }))).rejects.toThrow(/ISO-8601/);
    await expect(service.execute(makePayload("session.snoozeSessions", {
      sessionIds: [],
      untilIso: futureIso,
    }))).rejects.toThrow(/at least one session id/);
  });

  it("rejects snooze deadlines that are already in the past", async () => {
    // Snoozed-ness is derived (`snoozedUntil > now`), so accepting a past
    // deadline would write the row and change nothing — the client would report
    // "Snoozed" over a row that never left the list. Both the single and the
    // bulk action must refuse, and neither may reach sessionService.
    const { service, sessionService } = createLifecycleService();
    const pastIso = new Date(Date.now() - 60_000).toISOString();
    await expect(service.execute(makePayload("session.snoozeSession", {
      sessionId: "session-1",
      untilIso: pastIso,
    }))).rejects.toThrow(/untilIso to be in the future/);
    await expect(service.execute(makePayload("session.snoozeSessions", {
      sessionIds: ["session-1"],
      snoozedUntil: pastIso,
    }))).rejects.toThrow(/untilIso to be in the future/);
    expect(sessionService.snoozeSession).not.toHaveBeenCalled();
    expect(sessionService.snoozeSessions).not.toHaveBeenCalled();
  });

  it("defaults the wake reason to manual and validates the union", async () => {
    const { service, sessionService } = createLifecycleService();
    await expect(service.execute(makePayload("session.wakeSession", { sessionId: "session-1" })))
      .resolves.toEqual({ ok: true, sessionId: "session-1", reason: "manual" });
    expect(sessionService.wakeSession).toHaveBeenCalledWith("session-1", "manual");

    await expect(service.execute(makePayload("session.wakeSessions", {
      sessionIds: ["session-1"],
      reason: "turn_complete",
    }))).resolves.toEqual(["session-1"]);
    expect(sessionService.wakeSessions).toHaveBeenCalledWith(["session-1"], "turn_complete");

    await expect(service.execute(makePayload("session.wakeSession", {
      sessionId: "session-1",
      reason: "vibes",
    }))).rejects.toThrow(/reason must be one of/);
  });

  it("guards the settle override union and clears the woke marker", async () => {
    const { service, sessionService } = createLifecycleService();
    await expect(service.execute(makePayload("session.setSettleOverride", {
      sessionId: "session-1",
      override: "active",
    }))).resolves.toEqual({ ok: true, sessionId: "session-1", settleOverride: "active" });
    expect(sessionService.setSettleOverride).toHaveBeenCalledWith("session-1", "active");

    await expect(service.execute(makePayload("session.setSettleOverride", {
      sessionId: "session-1",
      override: null,
    }))).resolves.toEqual({ ok: true, sessionId: "session-1", settleOverride: null });

    await expect(service.execute(makePayload("session.setSettleOverride", {
      sessionId: "session-1",
      override: "snoozed",
    }))).rejects.toThrow(/'settled', 'active', or null/);

    await expect(service.execute(makePayload("session.clearWokeMarker", { sessionId: "session-1" })))
      .resolves.toEqual({ ok: true, sessionId: "session-1" });
    expect(sessionService.clearWokeMarker).toHaveBeenCalledWith("session-1");
  });
});

describe("lanes branch drift remote commands", () => {
  it("reads and resolves branch drift over sync", async () => {
    const getBranchDrift = vi.fn(async () => ({
      expectedBranchRef: "ade/feature",
      headBranchRef: "hotfix-auth",
    }));
    const resolveBranchDrift = vi.fn(async () => ({ resolution: "keep-head" }));
    const { service: driftService } = createService({
      laneService: { getBranchDrift, resolveBranchDrift },
    });

    await expect(driftService.execute(makePayload("lanes.getBranchDrift", { laneId: "lane-1" })))
      .resolves.toEqual({ expectedBranchRef: "ade/feature", headBranchRef: "hotfix-auth" });
    await expect(driftService.execute(makePayload("lanes.getBranchDrift", {})))
      .rejects.toThrow(/laneId/);

    await expect(driftService.execute(makePayload("lanes.resolveBranchDrift", {
      laneId: "lane-1",
      resolution: "keep-head",
      expectedHeadBranchRef: "hotfix-auth",
    }))).resolves.toEqual({ resolution: "keep-head" });
    expect(resolveBranchDrift).toHaveBeenCalledWith({
      laneId: "lane-1",
      resolution: "keep-head",
      expectedHeadBranchRef: "hotfix-auth",
    });

    await expect(driftService.execute(makePayload("lanes.resolveBranchDrift", {
      laneId: "lane-1",
      resolution: "rebase",
    }))).rejects.toThrow(/'switch-back' or 'keep-head'/);
  });
});

describe("mobile lifecycle command contract", () => {
  it("advertises the phone's lifecycle actions and accepts its null-free clear sentinel", async () => {
    const setSettleOverride = vi.fn(() => true);
    const { service } = createService({
      sessionService: {
        settleSessions: vi.fn(() => ["session-1"]),
        unsettleSessions: vi.fn(),
        setSettleOverride,
        snoozeSession: vi.fn(() => true),
        wakeSession: vi.fn(() => true),
        clearWokeMarker: vi.fn(() => true),
      },
    });

    // iOS gates its lifecycle UI on these appearing in hello_ok's descriptor
    // list, so a missing registration silently hides the whole feature.
    for (const action of MOBILE_SYNC_OPTIONAL_REMOTE_COMMAND_ACTIONS) {
      if (!action.startsWith("session.")) continue;
      expect(service.getDescriptor(action)).toEqual({
        action,
        scope: "project",
        policy: { viewerAllowed: true, queueable: true },
      });
    }

    // The phone cannot put a JSON null in its [String: Any] arg dict, so it
    // sends the "clear" sentinel instead.
    await expect(service.execute(makePayload("session.setSettleOverride", {
      sessionId: "session-1",
      override: "clear",
    }))).resolves.toEqual({ ok: true, sessionId: "session-1", settleOverride: null });
    expect(setSettleOverride).toHaveBeenCalledWith("session-1", null);
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

    expect(result).toEqual({ name: "refactor-auth-flow", hostApplied: false });
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

  it("forwards the launched chat model alongside the naming model", async () => {
    const suggestLaneNameFromPrompt = vi.fn().mockResolvedValue("refactor-auth-flow");
    const { service } = createService({ agentChatService: { suggestLaneNameFromPrompt } });

    await service.execute(makePayload("lanes.suggestName", {
      laneId: "lane-1",
      prompt: "please refactor the auth flow",
      modelId: "anthropic/claude-haiku-4-5",
      chatModelId: "openai/gpt-5.6-sol",
    }));

    // The host naming fallback chain needs the launched model to escape a
    // naming provider that is broken at the provider level; dropping it here
    // would strand every remote client on the naming model alone.
    expect(suggestLaneNameFromPrompt).toHaveBeenCalledWith({
      laneId: "lane-1",
      prompt: "please refactor the auth flow",
      modelId: "anthropic/claude-haiku-4-5",
      chatModelId: "openai/gpt-5.6-sol",
    });
  });

  it("forwards temporary branch and attachments to the combined host identity generator", async () => {
    const generateAutoLaneIdentity = vi.fn().mockResolvedValue({
      laneTitle: "Claude OAuth Login",
      branchFragment: "claude-oauth-login",
      source: "ai",
      laneRenameOutcome: "renamed",
      branchRenameOutcome: "renamed",
      branchRef: "refs/heads/ade/claude-oauth-login",
    });
    const { service } = createService({ agentChatService: { generateAutoLaneIdentity } });

    const result = await service.execute(makePayload("lanes.suggestName", {
      laneId: "lane-1",
      prompt: "This login button hangs after OAuth redirects",
      modelId: "anthropic/claude-haiku-4-5",
      fallbackName: "Claude Auth Login",
      temporaryBranch: "ade/1a2b3c4d",
      attachments: [
        { path: "/tmp/login.png", type: "image" },
        { path: "/tmp/context.txt", type: "file" },
        { path: "", type: "image" },
        { path: "/tmp/ignored.bin", type: "unsupported" },
      ],
    }));

    expect(result).toEqual({ name: "Claude OAuth Login", hostApplied: true });
    expect(generateAutoLaneIdentity).toHaveBeenCalledWith({
      laneId: "lane-1",
      prompt: "This login button hangs after OAuth redirects",
      modelId: "anthropic/claude-haiku-4-5",
      fallbackName: "Claude Auth Login",
      temporaryBranch: "ade/1a2b3c4d",
      attachments: [
        { path: "/tmp/login.png", type: "image" },
        { path: "/tmp/context.txt", type: "file" },
      ],
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

    expect(result).toEqual({ name: "build the dashboard", hostApplied: false });
  });

  it("rejects when prompt is missing", async () => {
    const { service } = createService();

    await expect(
      service.execute(makePayload("lanes.suggestName", { laneId: "lane-1", modelId: "m" })),
    ).rejects.toThrow("lanes.suggestName requires prompt.");
  });
});

describe("lanes.unarchive", () => {
  it("recreates the lane environment while preserving the mobile response", async () => {
    const lane = {
      id: "lane-1",
      name: "Lane one",
      laneType: "worktree",
      worktreePath: "/repo/.ade/worktrees/lane-1",
    };
    const unarchive = vi.fn().mockResolvedValue({
      lane,
      worktreeRecreated: true,
    });
    const list = vi.fn().mockResolvedValue([lane]);
    const envInitConfig = { dependencies: ["npm install"] };
    const lease = {
      laneId: "lane-1",
      rangeStart: 4100,
      rangeEnd: 4199,
      status: "active",
    };
    const getLease = vi.fn().mockReturnValue(null);
    const acquire = vi.fn().mockReturnValue(lease);
    const getEffective = vi.fn().mockReturnValue({
      laneEnvInit: null,
      laneOverlayPolicies: [],
    });
    const resolveEnvInitConfig = vi.fn().mockReturnValue(envInitConfig);
    const initLaneEnvironment = vi.fn().mockResolvedValue({ state: "ready" });
    const { service } = createService({
      laneService: { unarchive, list },
      projectConfigService: {
        getEffective,
      },
      laneEnvironmentService: {
        resolveEnvInitConfig,
        initLaneEnvironment,
      },
      portAllocationService: {
        getLease,
        acquire,
      },
    });

    await expect(
      service.execute(makePayload("lanes.unarchive", { laneId: "lane-1" })),
    ).resolves.toEqual({ ok: true });
    expect(unarchive).toHaveBeenCalledWith({ laneId: "lane-1" });
    expect(list).toHaveBeenCalledWith({ includeArchived: false, includeStatus: false });
    expect(acquire).toHaveBeenCalledWith("lane-1");
    expect(acquire.mock.invocationCallOrder[0]).toBeLessThan(getEffective.mock.invocationCallOrder[0]!);
    expect(acquire.mock.invocationCallOrder[0]).toBeLessThan(resolveEnvInitConfig.mock.invocationCallOrder[0]!);
    const overrides = { portRange: { start: 4100, end: 4199 } };
    expect(resolveEnvInitConfig).toHaveBeenCalledWith(null, overrides);
    expect(initLaneEnvironment).toHaveBeenCalledWith(lane, envInitConfig, overrides);
  });
});

describe("lanes.refreshSnapshots conditional responses", () => {
  function createLaneListService(options?: {
    sessions?: Record<string, unknown>[];
    chats?: Record<string, unknown>[];
  }) {
    const lanes = [{ id: "lane-1", name: "Lane one", status: { dirty: false, ahead: 0, behind: 0 } }];
    const laneService = {
      refreshSnapshots: vi.fn().mockResolvedValue({ refreshedCount: 1, lanes }),
      listStateSnapshots: vi.fn().mockReturnValue([]),
    };
    const sessionService = { list: vi.fn().mockReturnValue(options?.sessions ?? []) };
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() };
    const service = createSyncRemoteCommandService({
      laneService,
      prService: {},
      ptyService: {},
      sessionService,
      ...(options?.chats
        ? { agentChatService: { listSessions: vi.fn().mockResolvedValue(options.chats) } }
        : {}),
      fileService: {},
      logger,
    } as any);
    return { service, laneService };
  }

  it("prioritizes provider-blocked chat attention over another running session", async () => {
    const { service } = createLaneListService({
      sessions: [
        {
          id: "cli-1",
          laneId: "lane-1",
          status: "running",
          runtimeState: "running",
          toolType: "codex",
          lastOutputPreview: "Working",
        },
        {
          id: "chat-1",
          laneId: "lane-1",
          status: "running",
          runtimeState: "idle",
          toolType: "codex-chat",
          lastOutputPreview: "Question restored",
        },
      ],
      chats: [{
        sessionId: "chat-1",
        laneId: "lane-1",
        status: "active",
        awaitingInput: true,
        pendingInputItemId: null,
      }],
    });

    const result = await service.execute(makePayload("lanes.refreshSnapshots")) as {
      snapshots: Array<{ runtime: { bucket: string; runningCount: number; awaitingInputCount: number } }>;
    };

    expect(result.snapshots[0]?.runtime).toMatchObject({
      bucket: "awaiting-input",
      runningCount: 1,
      awaitingInputCount: 1,
    });
  });

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

describe("web-reachable settings and lane-risk commands", () => {
  it("lets paired devices run the AI settings write and refreshes scheduled work", async () => {
    // `viewerAllowed: false` is refused for EVERY paired device, not just
    // viewers ("not available to paired controller devices" in syncHostService),
    // so registering these that way left AI settings silently unsaveable from
    // the web client — the bug this command exists to fix.
    const save = vi.fn();
    const refreshScheduledWork = vi.fn();
    const { service } = createService({
      projectConfigService: {
        get: vi.fn().mockReturnValue({ shared: { ai: { defaultModel: "old-model" } }, local: {} }),
        save,
      },
      agentChatService: { refreshScheduledWork },
    });

    expect(service.getPolicy("ai.updateConfig")?.viewerAllowed).toBe(true);
    expect(service.getPolicy("ai.deleteApiKey")?.viewerAllowed).toBe(true);

    await service.execute(makePayload("ai.updateConfig", { defaultModel: "new-model" }));

    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![0].shared.ai).toEqual(
      expect.objectContaining({ defaultModel: "new-model" }),
    );
    // The desktop IPC handler does this too; omitting it leaves scheduled runs
    // on the previous AI configuration.
    expect(refreshScheduledWork).toHaveBeenCalledTimes(1);
  });

  it("answers lane delete/reclaim risk from the brain instead of an all-clear default", async () => {
    // With no handler the web client fell back to dirty:false /
    // hasUnpushedCommits:false and under-reported what a delete would destroy.
    const getDeleteRisk = vi.fn().mockResolvedValue({
      laneId: "lane-1",
      dirty: true,
      hasUnpushedCommits: true,
      unpushedCommitCount: 3,
    });
    const getReclaimRisk = vi.fn().mockResolvedValue({ laneId: "lane-1", dirty: true });
    const { service } = createService({ laneService: { getDeleteRisk, getReclaimRisk } });

    const risk = await service.execute(makePayload("lanes.getDeleteRisk", { laneId: "lane-1" }));

    expect(getDeleteRisk).toHaveBeenCalledWith("lane-1");
    expect(risk).toEqual(expect.objectContaining({ dirty: true, unpushedCommitCount: 3 }));
    await expect(service.execute(makePayload("lanes.getReclaimRisk", { laneId: "lane-1" })))
      .resolves.toEqual(expect.objectContaining({ dirty: true }));
  });

  it("rejects a CLI launch whose payload is missing the fields the launcher needs", async () => {
    const { service } = createService({});

    await expect(service.execute(makePayload("chat.launchCli", { provider: "claude" })))
      .rejects.toThrow(/laneId/);
    await expect(service.execute(makePayload("chat.launchCli", { laneId: "lane-1", provider: "claude" })))
      .rejects.toThrow(/kickoffPrompt/);
  });
});
