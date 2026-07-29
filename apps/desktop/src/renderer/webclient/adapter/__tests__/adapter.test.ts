import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ATTENTION_PREFERENCES,
  type AttentionItem,
  type ProjectInfo,
} from "../../../../shared/types";
import type {
  SyncChatEventPayload,
  SyncChatSubscribeSnapshotPayload,
  SyncFileBlob,
  SyncTerminalHistoryResponsePayload,
  SyncMobileProjectSummary,
  SyncRemoteCommandDescriptor,
  SyncTerminalDataPayload,
  SyncTerminalSnapshotPayload,
} from "../../../../shared/types/sync";
import { isSessionSnoozed } from "../../../../shared/sessionCanonicalState";
import { createAdeWebAdapter } from "../index";
import {
  SESSION_LIFECYCLE_DISCONNECTED_MESSAGE,
  SESSION_LIFECYCLE_UNSUPPORTED_MESSAGE,
} from "../sessionLifecycleSupport";
import type { AdeSyncClient, ChatHandlers, TerminalHandlers } from "../../sync";
import type { BrowserAccountClient, BrowserAccountSnapshot } from "../../account/client";
import { stableCacheKey } from "../infra/cacheKey";
import { createCoalescingReadCache } from "../infra/coalescingReadCache";
import { createProjectState } from "../infra/projectState";

const project: ProjectInfo = {
  rootPath: "/repo",
  displayName: "Repo",
  baseRef: "main",
};

function chatEvent(sessionId: string, seq: number, marker: string): SyncChatEventPayload {
  return {
    sessionId,
    seq,
    timestamp: `2026-07-20T00:00:${String(seq).padStart(2, "0")}.000Z`,
    event: { type: "status", status: "started", marker } as never,
  };
}

function transcriptChatEvent(sessionId: string, sequence: number, marker: string): SyncChatEventPayload {
  return {
    sessionId,
    sequence,
    timestamp: `2026-07-20T00:01:${String(sequence).padStart(2, "0")}.000Z`,
    event: { type: "status", status: "started", marker } as never,
  };
}

describe("createAdeWebAdapter", () => {
  let fake: FakeAdeSyncClient;

  beforeEach(() => {
    fake = new FakeAdeSyncClient();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("boots before and after a bound project", async () => {
    const adapter = createAdeWebAdapter(fake.asClient());

    await expect(adapter.ade.app.getProject()).resolves.toBeNull();
    await expect(adapter.ade.app.getWindowSession()).resolves.toMatchObject({
      windowId: null,
      project: null,
      binding: null,
    });

    adapter.bindProject(project, "project-1");

    await expect(adapter.ade.app.getProject()).resolves.toEqual(project);
    await expect(adapter.ade.app.getWindowSession()).resolves.toMatchObject({
      windowId: null,
      project,
      binding: null,
    });

    adapter.dispose();
  });

  it("keeps distinct argument values in distinct stable cache keys", () => {
    const sparse: unknown[] = [];
    sparse.length = 1;
    const distinct = [
      undefined,
      null,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      0,
      -0,
      {},
      { value: undefined },
      [],
      [undefined],
      sparse,
    ].map(stableCacheKey);

    expect(new Set(distinct).size).toBe(distinct.length);
    expect(stableCacheKey({ second: 2, first: 1 })).toBe(
      stableCacheKey({ first: 1, second: 2 }),
    );
  });

  it("evicts resolved read-cache entries at TTL without deleting replacements", async () => {
    vi.useFakeTimers();
    const cache = createCoalescingReadCache(10);
    const first = Promise.resolve("first");
    cache.set("expired", first);
    await first;

    await vi.advanceTimersByTimeAsync(11);
    const remainingKeys: string[] = [];
    cache.invalidate((key) => {
      remainingKeys.push(key);
      return false;
    });
    expect(remainingKeys).toEqual([]);

    const old = Promise.resolve("old");
    cache.set("replaced", old, { ttlMs: 10 });
    await old;
    await vi.advanceTimersByTimeAsync(5);
    const replacement = Promise.resolve("replacement");
    cache.set("replaced", replacement, { ttlMs: 100 });
    await replacement;
    await vi.advanceTimersByTimeAsync(6);
    expect(cache.get("replaced")).toBe(replacement);
  });

  it("does not fall back to a stale active project while a bound project is unresolved", () => {
    fake.activeProjectId = "project-old";
    const state = createProjectState(fake.asClient());
    const nextProject = { rootPath: "/repo-next", displayName: "Repo Next", baseRef: "main" };

    state.bindProject(nextProject);
    expect(state.getProjectId()).toBeNull();

    state.updateCatalog([{ ...fake.projects[0]!, id: "project-next", rootPath: "/repo-next" }]);
    expect(state.getProjectId()).toBe("project-next");

    state.bindProject(null);
    expect(state.getProjectId()).toBe("project-old");
    state.dispose();
  });

  it("keeps the routed host status distinct from ADE Web local status", async () => {
    const adapter = createAdeWebAdapter(fake.asClient());

    const routed = await adapter.ade.sync.getStatus();
    const local = await adapter.ade.sync.getLocalStatus();

    expect(routed.localDevice.deviceId).toBe("env-1");
    expect(local.localDevice).toMatchObject({
      deviceId: "ade-web",
      deviceType: "browser",
    });
    expect(local.localDevice.deviceId).not.toBe(routed.localDevice.deviceId);
    expect(local.currentBrain).toBeNull();
    expect(local.client.state).toBe("disconnected");
    adapter.dispose();
  });

  it("exposes a complete account status surface backed by the browser account client", async () => {
    const snapshot: BrowserAccountSnapshot = {
      state: "signed_in",
      userId: "user_3GYkAdapter",
      email: "adapter@example.test",
      name: "Adapter Owner",
      imageUrl: "https://images.example.test/adapter.png",
      expiresAt: "2026-07-18T00:00:00.000Z",
      machines: [],
      relayBaseUrls: ["wss://relay.example"],
      message: null,
    };
    let currentSnapshot: BrowserAccountSnapshot = snapshot;
    const accountClient = {
      getSnapshot: () => currentSnapshot,
      startSignIn: vi.fn(async () => "https://clerk.example/oauth/authorize"),
      signOut: vi.fn(async () => ({ ...snapshot, state: "signed_out" as const })),
      loadMachines: vi.fn(async () => snapshot),
      removeMachine: vi.fn(async (machineKey: string) => ({ ok: true as const, machineKey })),
    } as unknown as BrowserAccountClient;
    const adapter = createAdeWebAdapter(fake.asClient(), undefined, accountClient);

    expect(Object.keys(adapter.ade.account).sort()).toEqual([
      "cancelLogin",
      "getLocalMachineIdentity",
      "listMachines",
      "onPairMachineProgress",
      "pairMachine",
      "pollLogin",
      "removeMachine",
      "renameMachine",
      "signOut",
      "startLogin",
      "status",
    ]);

    await expect(adapter.ade.account.status()).resolves.toEqual({
      signedIn: true,
      userId: "user_3GYkAdapter",
      email: "adapter@example.test",
      name: "Adapter Owner",
      imageUrl: "https://images.example.test/adapter.png",
      expiresAt: "2026-07-18T00:00:00.000Z",
      provider: null,
      configured: true,
    });
    await expect(adapter.ade.account.listMachines()).resolves.toEqual({
      state: "ok",
      machines: [],
      message: null,
    });
    await expect(adapter.ade.account.getLocalMachineIdentity()).resolves.toEqual({
      machineKey: "",
      deviceId: "",
    });

    adapter.dispose();
  });

  it("reads account Attention directly and refreshes one rejected browser token", async () => {
    const snapshot: BrowserAccountSnapshot = {
      state: "signed_in",
      userId: "account-a",
      email: "owner@example.test",
      name: "Owner",
      imageUrl: null,
      expiresAt: "2026-07-30T00:00:00.000Z",
      machines: [],
      relayBaseUrls: ["wss://relay.example"],
      message: null,
    };
    let currentSnapshot: BrowserAccountSnapshot = snapshot;
    const getAccessToken = vi.fn(async (options?: { forceRefresh?: boolean }) =>
      options?.forceRefresh ? "fresh-token" : "cached-token");
    const accountClient = {
      getSnapshot: () => currentSnapshot,
      captureSessionLease: () => ({ userId: "account-a", generation: 1 }),
      isSessionLeaseCurrent: () => true,
      getAccessToken,
    } as unknown as BrowserAccountClient;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: false,
        error: "account token rejected",
      }), { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        contractVersion: 1,
        streamId: "account-stream",
        revision: 4,
        generatedAt: "2026-07-29T12:00:00.000Z",
        items: [],
        tombstones: [],
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const adapter = createAdeWebAdapter(fake.asClient(), undefined, accountClient);

    await expect(adapter.ade.attention.getSnapshot(3, "account-stream"))
      .resolves.toMatchObject({
        scope: "account",
        streamId: "account-stream",
        revision: 4,
        availability: { state: "ready" },
      });
    expect(getAccessToken).toHaveBeenNthCalledWith(1, { forceRefresh: false });
    expect(getAccessToken).toHaveBeenNthCalledWith(2, { forceRefresh: true });
    expect(fetchMock.mock.calls.map(([, init]) =>
      (init as RequestInit).headers)).toEqual([
      expect.objectContaining({ authorization: "Bearer cached-token" }),
      expect.objectContaining({ authorization: "Bearer fresh-token" }),
    ]);
    currentSnapshot = { ...snapshot, userId: "account-b" };
    await expect(adapter.ade.attention.acknowledge({
      itemIds: ["stale-account-a-item"],
      seenAt: "2026-07-29T12:01:00.000Z",
    })).rejects.toThrow(/account changed/i);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    adapter.dispose();
  });

  it("rejects malformed account Attention responses at the relay boundary", async () => {
    const snapshot: BrowserAccountSnapshot = {
      state: "signed_in",
      userId: "account-a",
      email: "owner@example.test",
      name: "Owner",
      imageUrl: null,
      expiresAt: "2026-07-30T00:00:00.000Z",
      machines: [],
      relayBaseUrls: ["wss://relay.example"],
      message: null,
    };
    let currentSnapshot: BrowserAccountSnapshot = snapshot;
    const accountClient = {
      getSnapshot: () => currentSnapshot,
      captureSessionLease: () => ({ userId: "account-a", generation: 1 }),
      isSessionLeaseCurrent: () => true,
      getAccessToken: vi.fn(async () => "account-token"),
    } as unknown as BrowserAccountClient;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      contractVersion: 1,
      streamId: "account-stream",
      revision: 4,
      generatedAt: "2026-07-29T12:00:00.000Z",
      items: [{ id: "missing-required-item-fields" }],
      tombstones: [],
    }), { status: 200 })));
    const adapter = createAdeWebAdapter(fake.asClient(), undefined, accountClient);

    await expect(adapter.ade.attention.getSnapshot()).rejects.toThrow(
      "ADE Attention returned an incompatible response. Update ADE and retry.",
    );
    adapter.dispose();
  });

  it("validates account Attention preferences before exposing them to the renderer", async () => {
    const snapshot: BrowserAccountSnapshot = {
      state: "signed_in",
      userId: "account-a",
      email: "owner@example.test",
      name: "Owner",
      imageUrl: null,
      expiresAt: "2026-07-30T00:00:00.000Z",
      machines: [],
      relayBaseUrls: ["wss://relay.example"],
      message: null,
    };
    let currentSnapshot: BrowserAccountSnapshot = snapshot;
    const accountClient = {
      getSnapshot: () => currentSnapshot,
      captureSessionLease: () => ({ userId: "account-a", generation: 1 }),
      isSessionLeaseCurrent: () => true,
      getAccessToken: vi.fn(async () => "account-token"),
    } as unknown as BrowserAccountClient;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        preferences: DEFAULT_ATTENTION_PREFERENCES,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        preferences: {
          ...DEFAULT_ATTENTION_PREFERENCES,
          account: { notificationsEnabled: "yes" },
        },
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const adapter = createAdeWebAdapter(fake.asClient(), undefined, accountClient);

    await expect(adapter.ade.attention.getPreferences("account-a"))
      .resolves.toEqual(DEFAULT_ATTENTION_PREFERENCES);
    await expect(adapter.ade.attention.getPreferences("account-a"))
      .rejects.toThrow(
        "Account Attention preferences were incompatible. Update ADE and retry.",
      );
    adapter.dispose();
  });

  it("loads real machine Attention from the paired host while signed out", async () => {
    const snapshot: BrowserAccountSnapshot = {
      state: "signed_out",
      userId: null,
      email: null,
      name: null,
      imageUrl: null,
      expiresAt: null,
      machines: [],
      relayBaseUrls: [],
      message: null,
    };
    let currentSnapshot: BrowserAccountSnapshot = snapshot;
    const accountClient = {
      getSnapshot: () => currentSnapshot,
    } as unknown as BrowserAccountClient;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    fake.activeProjectId = null;
    fake.descriptors = [
      {
        action: "attention.getMachineSnapshot",
        scope: "runtime",
        policy: { viewerAllowed: true },
      },
      {
        action: "attention.acknowledgeMachine",
        scope: "runtime",
        policy: { viewerAllowed: true, queueable: false },
      },
    ];
    fake.commandResults.set("attention.getMachineSnapshot", {
      contractVersion: 1,
      scope: "machine",
      accountOwnerId: null,
      streamId: "machine:host-1",
      revision: 5,
      generatedAt: "2026-07-29T12:00:00.000Z",
      machines: [{
        machineKey: "host-1",
        name: "Host",
        online: true,
        lastSeenAt: null,
      }],
      items: [{
        contractVersion: 1,
        id: "machine-agent-1",
        revision: 5,
        fingerprint: "machine-agent-1",
        kind: "agent",
        eventKind: "agent_running",
        phase: "running",
        machine: {
          machineKey: "host-1",
          name: "Host",
          online: true,
          lastSeenAt: null,
        },
        project: { projectId: "project-host", name: "Host Project" },
        title: "Agent is working",
        preview: "Implementing account Attention",
        privacyPreview: "Agent is working",
        destination: { kind: "session", sessionId: "session-host" },
        actions: [],
        occurredAt: "2026-07-29T11:59:00.000Z",
        updatedAt: "2026-07-29T12:00:00.000Z",
        seenAt: null,
        dismissedAt: null,
        expiresAt: null,
      }],
      tombstones: [],
    });
    const adapter = createAdeWebAdapter(fake.asClient(), undefined, accountClient);

    await expect(adapter.ade.attention.getSnapshot()).resolves.toMatchObject({
      scope: "machine",
      availability: { state: "signed_out", recovery: "sign_in" },
      streamId: "machine:host-1",
      revision: 5,
      items: [{ id: "machine-agent-1" }],
    });
    await adapter.ade.attention.acknowledge({
      itemIds: ["machine-agent-1"],
      sourceRevisions: { "machine-agent-1": 5 },
      expectedAccountOwnerId: null,
      seenAt: "2026-07-29T12:01:00.000Z",
    });
    currentSnapshot = {
      ...snapshot,
      state: "signed_in",
      userId: "account-b",
      email: "b@example.test",
    };
    await expect(adapter.ade.attention.acknowledge({
      itemIds: ["machine-agent-1"],
      sourceRevisions: { "machine-agent-1": 5 },
      expectedAccountOwnerId: null,
      seenAt: "2026-07-29T12:02:00.000Z",
    })).rejects.toThrow(/account changed/i);
    expect(fake.commandCalls).toEqual([
      {
        action: "attention.getMachineSnapshot",
        args: {},
        opts: { projectId: null, timeoutMs: undefined },
      },
      {
        action: "attention.acknowledgeMachine",
        args: {
          itemIds: ["machine-agent-1"],
          sourceRevisions: { "machine-agent-1": 5 },
          expectedAccountOwnerId: null,
          seenAt: "2026-07-29T12:01:00.000Z",
        },
        opts: { projectId: null, timeoutMs: undefined },
      },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
    adapter.dispose();
  });

  it("requires a host update instead of fabricating empty signed-out machine data", async () => {
    const snapshot: BrowserAccountSnapshot = {
      state: "signed_out",
      userId: null,
      email: null,
      name: null,
      imageUrl: null,
      expiresAt: null,
      machines: [],
      relayBaseUrls: [],
      message: null,
    };
    const accountClient = {
      getSnapshot: () => snapshot,
    } as unknown as BrowserAccountClient;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const adapter = createAdeWebAdapter(fake.asClient(), undefined, accountClient);

    await expect(adapter.ade.attention.getSnapshot()).resolves.toMatchObject({
      scope: "machine",
      availability: {
        state: "incompatible",
        recovery: "update_host",
        hostName: "Host",
      },
      items: [],
    });
    expect(fake.commandCalls).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    adapter.dispose();
  });

  it("rejects malformed signed-out machine Attention from the paired host", async () => {
    const snapshot: BrowserAccountSnapshot = {
      state: "signed_out",
      userId: null,
      email: null,
      name: null,
      imageUrl: null,
      expiresAt: null,
      machines: [],
      relayBaseUrls: [],
      message: null,
    };
    const accountClient = {
      getSnapshot: () => snapshot,
    } as unknown as BrowserAccountClient;
    fake.descriptors = [{
      action: "attention.getMachineSnapshot",
      scope: "runtime",
      policy: { viewerAllowed: true },
    }];
    fake.commandResults.set("attention.getMachineSnapshot", {
      contractVersion: 1,
      revision: 1,
      generatedAt: "2026-07-29T12:00:00.000Z",
      items: [{ id: "missing-required-item-fields" }],
      tombstones: [],
    });
    const adapter = createAdeWebAdapter(fake.asClient(), undefined, accountClient);

    await expect(adapter.ade.attention.getSnapshot()).rejects.toThrow(
      "ADE Attention returned an incompatible response. Update ADE and retry.",
    );
    adapter.dispose();
  });

  it("connects the owning account machine before opening an Attention destination", async () => {
    const ownerMachine = {
      machineKey: "account-machine-studio",
      deviceId: "host-studio",
      name: "Mac Studio",
      platform: "macOS",
      deviceType: "desktop",
      reachableEndpoints: [],
      lastSeenAt: Date.now(),
      online: true,
    };
    const snapshot: BrowserAccountSnapshot = {
      state: "signed_in",
      userId: "account-a",
      email: "owner@example.test",
      name: "Owner",
      imageUrl: null,
      expiresAt: "2026-07-30T00:00:00.000Z",
      machines: [ownerMachine],
      relayBaseUrls: ["wss://relay.example"],
      message: null,
    };
    const accountClient = {
      getSnapshot: () => snapshot,
      captureSessionLease: () => ({ userId: "account-a", generation: 1 }),
      isSessionLeaseCurrent: () => true,
      getAccessToken: vi.fn(async () => "account-token"),
      getRelayBaseUrls: () => snapshot.relayBaseUrls,
    } as unknown as BrowserAccountClient;
    fake.projects.push({
      ...fake.projects[0],
      id: "project-studio",
      displayName: "Studio Repo",
    });
    const adapter = createAdeWebAdapter(fake.asClient(), undefined, accountClient);
    const attentionItem: AttentionItem = {
      contractVersion: 1,
      id: "remote-item",
      revision: 1,
      fingerprint: "remote-item",
      kind: "agent",
      eventKind: "agent_running",
      phase: "running",
      machine: {
        machineKey: "runtime-studio",
        accountMachineKey: ownerMachine.machineKey,
        deviceId: ownerMachine.deviceId,
        name: ownerMachine.name,
        online: true,
        lastSeenAt: null,
      },
      project: { projectId: "project-studio", name: "Studio Repo" },
      title: "Remote work",
      preview: "Working",
      privacyPreview: "Agent is working",
      destination: { kind: "session", sessionId: "session-studio" },
      actions: [],
      occurredAt: "2026-07-29T12:00:00.000Z",
      updatedAt: "2026-07-29T12:00:00.000Z",
      seenAt: null,
      dismissedAt: null,
      expiresAt: null,
    };

    await expect(adapter.ade.attention.openItem(attentionItem)).resolves.toBeUndefined();

    expect(fake.accountPairCalls).toHaveLength(1);
    expect(fake.accountPairCalls[0]).toMatchObject({
      machine: { machineKey: "account-machine-studio", deviceId: "host-studio" },
      accountSessionLease: { userId: "account-a", generation: 1 },
    });
    expect(fake.hostDeviceId).toBe("host-studio");
    adapter.dispose();
  });

  it("routes commands through sync with project id stamping and descriptor fallbacks", async () => {
    fake.descriptors = descriptors([
      "lanes.list",
      "work.listSessions",
      "prs.list",
      "git.getChanges",
      "chat.getChatEventHistory",
    ]);
    fake.commandResults.set("lanes.list", [{ id: "lane-1" }]);
    fake.commandResults.set("work.listSessions", [{ id: "session-1", ptyId: "pty-1" }]);
    fake.commandResults.set("prs.list", [{ id: "pr-1" }]);
    fake.commandResults.set("git.getChanges", { files: [{ path: "a.ts" }] });
    fake.commandResults.set("chat.getChatEventHistory", {
      sessionId: "chat-1",
      events: [],
      truncated: false,
      sessionFound: true,
    });
    fake.fileResults.set("deletePath", fileBlob(""));

    const adapter = createAdeWebAdapter(fake.asClient());
    adapter.bindProject(project, "project-1");

    await expect(adapter.ade.lanes.list()).resolves.toEqual([{ id: "lane-1" }]);
    await expect(adapter.ade.sessions.list()).resolves.toEqual([{ id: "session-1", ptyId: "pty-1" }]);
    await expect(adapter.ade.prs.listAll()).resolves.toEqual([{ id: "pr-1" }]);
    await expect(adapter.ade.diff.getChanges({ laneId: "lane-1" } as never)).resolves.toEqual({
      files: [{ path: "a.ts" }],
    });
    await expect(adapter.ade.agentChat.getEventHistory({ sessionId: "chat-1" })).resolves.toMatchObject({
      sessionId: "chat-1",
      sessionFound: true,
    });
    await adapter.ade.files.delete({ workspaceId: "workspace", path: "old.txt" });
    await expect(adapter.ade.lanes.listDeleteProgress()).resolves.toEqual([]);

    expect(fake.commandCalls.map((call) => [call.action, call.opts.projectId])).toEqual([
      ["lanes.list", "project-1"],
      ["work.listSessions", "project-1"],
      ["prs.list", "project-1"],
      ["git.getChanges", "project-1"],
      ["chat.getChatEventHistory", "project-1"],
    ]);
    expect(fake.fileCalls).toEqual([
      {
        action: "deletePath",
        args: { workspaceId: "workspace", path: "old.txt" },
        opts: { projectId: "project-1", timeoutMs: undefined },
      },
    ]);

    adapter.dispose();
  });

  it("emits the restored lane from a successful web unarchive", async () => {
    fake.descriptors = descriptors(["lanes.unarchive"]);
    const lane = {
      id: "lane-restored",
      name: "Restored lane",
      branchRef: "feature/restored",
      color: "#5eead4",
    };
    fake.commandResults.set("lanes.unarchive", { lane, worktreeRecreated: true });
    const adapter = createAdeWebAdapter(fake.asClient());
    adapter.bindProject(project, "project-1");
    const lifecycleEvents: unknown[] = [];
    adapter.ade.lanes.onLifecycleEvent((event) => lifecycleEvents.push(event));

    await expect(adapter.ade.lanes.unarchive({ laneId: lane.id })).resolves.toEqual({
      lane,
      worktreeRecreated: true,
    });
    expect(lifecycleEvents).toEqual([{
      type: "lane-restored",
      laneId: lane.id,
      laneName: lane.name,
      color: lane.color,
      lane,
    }]);

    adapter.dispose();
  });

  it("emits an unarchived lane when web restore does not recreate its worktree", async () => {
    fake.descriptors = descriptors(["lanes.unarchive"]);
    const lane = {
      id: "lane-unarchived",
      name: "Unarchived lane",
      branchRef: "feature/unarchived",
      color: "#5eead4",
    };
    fake.commandResults.set("lanes.unarchive", { lane, worktreeRecreated: false });
    const adapter = createAdeWebAdapter(fake.asClient());
    adapter.bindProject(project, "project-1");
    const lifecycleEvents: unknown[] = [];
    adapter.ade.lanes.onLifecycleEvent((event) => lifecycleEvents.push(event));

    await adapter.ade.lanes.unarchive({ laneId: lane.id });

    expect(lifecycleEvents).toEqual([{
      type: "lane-unarchived",
      laneId: lane.id,
      laneName: lane.name,
      color: lane.color,
      lane,
    }]);

    adapter.dispose();
  });

  it("bounds initial web chat hydration while preserving paged scroll-back", async () => {
    fake.descriptors = descriptors(["chat.getChatEventHistory"]);
    fake.commandResults.set("chat.getChatEventHistory", {
      sessionId: "chat-long-running",
      events: [],
      truncated: true,
      sessionFound: true,
      tailStartOffset: 4096,
    });
    const adapter = createAdeWebAdapter(fake.asClient());
    adapter.bindProject(project, "project-1");

    await expect(adapter.ade.agentChat.getEventHistory({
      sessionId: "chat-long-running",
      maxEvents: 20_000,
    })).resolves.toMatchObject({
      sessionId: "chat-long-running",
      truncated: true,
      tailStartOffset: 4096,
    });

    expect(fake.chatSubscribeCalls).toEqual([{
      sessionId: "chat-long-running",
      opts: { maxBytes: 128 * 1024 },
    }]);
    expect(fake.commandCalls).toEqual([{
      action: "chat.getChatEventHistory",
      args: {
        sessionId: "chat-long-running",
        maxEvents: 512,
        maxBytes: 128 * 1024,
      },
      opts: { projectId: "project-1", timeoutMs: undefined },
    }]);

    adapter.dispose();
  });

  it("reports history as unreachable, not missing, when the host cannot serve it", async () => {
    // The fallback fires when the command cannot be reached/dispatched. A bare
    // `sessionFound: false` reads as authoritative and makes the renderer
    // tombstone or wipe a rendered transcript, so it must carry `unavailable`.
    const adapter = createAdeWebAdapter(fake.asClient());
    adapter.bindProject(project, "project-1");

    await expect(adapter.ade.agentChat.getEventHistory({ sessionId: "chat-1" })).resolves.toEqual({
      sessionId: "chat-1",
      events: [],
      truncated: false,
      sessionFound: false,
      unavailable: true,
    });

    adapter.dispose();
  });

  it("keeps an older-history cursor retryable when the host cannot page it", async () => {
    const adapter = createAdeWebAdapter(fake.asClient());
    adapter.bindProject(project, "project-1");

    await expect(adapter.ade.agentChat.getEventHistoryPage({
      sessionId: "chat-long-running",
      beforeOffset: 4096,
    })).rejects.toThrow("Chat history action 'chat.getChatEventHistoryPage' is unavailable");

    adapter.dispose();
  });

  it("bounds web transcript page reads before sending them to the host", async () => {
    fake.descriptors = descriptors(["chat.getChatEventHistoryPage"]);
    fake.commandResults.set("chat.getChatEventHistoryPage", {
      sessionId: "chat-long-running",
      events: [],
      startOffset: 1024,
      hasMore: true,
      sessionFound: true,
    });
    const adapter = createAdeWebAdapter(fake.asClient());
    adapter.bindProject(project, "project-1");

    await adapter.ade.agentChat.getEventHistoryPage({
      sessionId: "chat-long-running",
      beforeOffset: 4096,
      maxBytes: 2_000_000,
    });

    expect(fake.commandCalls.at(-1)).toMatchObject({
      action: "chat.getChatEventHistoryPage",
      args: {
        sessionId: "chat-long-running",
        beforeOffset: 4096,
        maxBytes: 256 * 1024,
      },
    });

    adapter.dispose();
  });

  it("uses the legacy history-page alias when that is all the connected host advertises", async () => {
    fake.descriptors = descriptors(["agentChat.getEventHistoryPage"]);
    fake.commandResults.set("agentChat.getEventHistoryPage", {
      sessionId: "chat-long-running",
      events: [],
      startOffset: 1024,
      hasMore: true,
      sessionFound: true,
    });
    const adapter = createAdeWebAdapter(fake.asClient());
    adapter.bindProject(project, "project-1");

    await adapter.ade.agentChat.getEventHistoryPage({
      sessionId: "chat-long-running",
      beforeOffset: 4096,
    });

    const call = fake.commandCalls.at(-1);
    expect(call?.action).toBe("agentChat.getEventHistoryPage");
    expect(call?.args).toMatchObject({
      sessionId: "chat-long-running",
      beforeOffset: 4096,
      maxBytes: 256 * 1024,
    });
    expect(fake.commandCalls).toContainEqual(expect.objectContaining({
      action: "agentChat.getEventHistoryPage",
    }));
    adapter.dispose();
  });

  it("keeps only the eight most recently used project chat subscriptions", async () => {
    fake.descriptors = descriptors(["chat.getChatEventHistory"]);
    const adapter = createAdeWebAdapter(fake.asClient());
    adapter.bindProject(project, "project-1");

    for (let index = 1; index <= 8; index += 1) {
      await adapter.ade.agentChat.getEventHistory({ sessionId: `chat-${index}` });
    }
    // Reusing chat-1 makes it the most recent entry without opening another
    // wire subscription, so chat-2 is the oldest when chat-9 is selected.
    await adapter.ade.agentChat.getEventHistory({ sessionId: "chat-1" });
    await adapter.ade.agentChat.getEventHistory({ sessionId: "chat-9" });

    expect(fake.chatSubscribeCalls.map((call) => call.sessionId)).toEqual([
      "chat-1",
      "chat-2",
      "chat-3",
      "chat-4",
      "chat-5",
      "chat-6",
      "chat-7",
      "chat-8",
      "chat-9",
    ]);
    expect(fake.chatUnsubscribeCalls).toEqual(["chat-2"]);

    adapter.dispose();
    expect(new Set(fake.chatUnsubscribeCalls)).toEqual(new Set([
      "chat-1",
      "chat-2",
      "chat-3",
      "chat-4",
      "chat-5",
      "chat-6",
      "chat-7",
      "chat-8",
      "chat-9",
    ]));
    expect(fake.chatUnsubscribeCalls).toHaveLength(9);
  });

  it("pins the visible project chat while more than eight background chats touch the LRU", async () => {
    fake.descriptors = descriptors(["chat.getChatEventHistory", "chat.getSummary"]);
    const adapter = createAdeWebAdapter(fake.asClient());
    adapter.bindProject(project, "project-1");
    const received: SyncChatEventPayload[] = [];
    adapter.ade.agentChat.onEvent((event) => received.push(event as SyncChatEventPayload));

    await adapter.ade.agentChat.getEventHistory({ sessionId: "chat-visible-oldest" });
    for (let index = 1; index <= 8; index += 1) {
      fake.commandResults.set("chat.getSummary", { sessionId: `chat-background-${index}` });
      await adapter.ade.agentChat.getSummary({ sessionId: `chat-background-${index}` });
    }

    expect(fake.chatUnsubscribeCalls).toEqual(["chat-background-1"]);
    expect(fake.chatUnsubscribeCalls).not.toContain("chat-visible-oldest");

    const done = {
      sessionId: "chat-visible-oldest",
      seq: 41,
      timestamp: "2026-07-20T00:02:00.000Z",
      event: {
        type: "done",
        turnId: "turn-visible",
        status: "completed",
        model: "gpt-5.6",
        modelId: "openai/gpt-5.6",
      },
    } as SyncChatEventPayload;
    fake.emitChat(done);

    expect(received).toEqual([done]);
    adapter.dispose();
  });

  it("moves the visible pin on selection change and evicts the old selection first", async () => {
    fake.descriptors = descriptors(["chat.getChatEventHistory", "chat.getSummary"]);
    const adapter = createAdeWebAdapter(fake.asClient());
    adapter.bindProject(project, "project-1");

    await adapter.ade.agentChat.getEventHistory({ sessionId: "chat-selection-old" });
    for (let index = 1; index <= 7; index += 1) {
      fake.commandResults.set("chat.getSummary", { sessionId: `chat-selection-background-${index}` });
      await adapter.ade.agentChat.getSummary({ sessionId: `chat-selection-background-${index}` });
    }
    await adapter.ade.agentChat.getEventHistory({ sessionId: "chat-selection-new" });

    expect(fake.chatUnsubscribeCalls).toEqual(["chat-selection-old"]);

    fake.commandResults.set("chat.getSummary", { sessionId: "chat-selection-background-8" });
    await adapter.ade.agentChat.getSummary({ sessionId: "chat-selection-background-8" });
    expect(fake.chatUnsubscribeCalls).toEqual([
      "chat-selection-old",
      "chat-selection-background-1",
    ]);
    expect(fake.chatUnsubscribeCalls).not.toContain("chat-selection-new");

    adapter.dispose();
  });

  it("drops every old-project stream and starts a fresh bounded pin after project handoff", async () => {
    fake.descriptors = descriptors(["chat.getChatEventHistory", "chat.getSummary"]);
    const adapter = createAdeWebAdapter(fake.asClient());
    adapter.bindProject(project, "project-1");

    await adapter.ade.agentChat.getEventHistory({ sessionId: "chat-project-one-visible" });
    for (let index = 1; index <= 7; index += 1) {
      fake.commandResults.set("chat.getSummary", { sessionId: `chat-project-one-${index}` });
      await adapter.ade.agentChat.getSummary({ sessionId: `chat-project-one-${index}` });
    }

    const projectTwo = { ...project, rootPath: "/repo-2", displayName: "Repo Two" };
    adapter.replaceProject(projectTwo, "project-2");
    expect(new Set(fake.chatUnsubscribeCalls)).toEqual(new Set([
      "chat-project-one-visible",
      "chat-project-one-1",
      "chat-project-one-2",
      "chat-project-one-3",
      "chat-project-one-4",
      "chat-project-one-5",
      "chat-project-one-6",
      "chat-project-one-7",
    ]));

    await adapter.ade.agentChat.getEventHistory({ sessionId: "chat-project-two-visible" });
    for (let index = 1; index <= 8; index += 1) {
      fake.commandResults.set("chat.getSummary", { sessionId: `chat-project-two-${index}` });
      await adapter.ade.agentChat.getSummary({ sessionId: `chat-project-two-${index}` });
    }

    expect(fake.chatUnsubscribeCalls).toContain("chat-project-two-1");
    expect(fake.chatUnsubscribeCalls).not.toContain("chat-project-two-visible");
    expect(fake.chatSubscribeCalls.at(-1)?.sessionId).toBe("chat-project-two-8");
    expect(fake.commandCalls.at(-1)?.opts.projectId).toBe("project-2");

    adapter.dispose();
  });

  it("does not subscribe every chat returned by a session-list read", async () => {
    fake.descriptors = descriptors([
      "chat.listSessions",
      "chat.getSummary",
      "chat.create",
      "chat.launch",
      "chat.send",
    ]);
    fake.commandResults.set("chat.listSessions", [
      { sessionId: "chat-background-1" },
      { sessionId: "chat-background-2" },
      { sessionId: "chat-background-3" },
    ]);
    fake.commandResults.set("chat.getSummary", { sessionId: "chat-selected" });
    fake.commandResults.set("chat.create", { sessionId: "chat-created" });
    fake.commandResults.set("chat.launch", { sessionId: "chat-launched" });
    const adapter = createAdeWebAdapter(fake.asClient());
    adapter.bindProject(project, "project-1");

    await adapter.ade.agentChat.list({ laneId: "lane-1" });
    expect(fake.chatSubscribeCalls).toEqual([]);

    await adapter.ade.agentChat.getSummary({ sessionId: "chat-selected" });
    await adapter.ade.agentChat.create({} as never);
    await adapter.ade.agentChat.launch({} as never);
    await adapter.ade.agentChat.send({ sessionId: "chat-sent", text: "Continue" });

    expect(fake.chatSubscribeCalls.map((call) => call.sessionId)).toEqual([
      "chat-selected",
      "chat-created",
      "chat-launched",
      "chat-sent",
    ]);

    adapter.dispose();
  });

  it("does not subscribe background chats after chat-table invalidation", async () => {
    vi.useFakeTimers();
    fake.descriptors = descriptors(["chat.listSessions"]);
    fake.commandResults.set("chat.listSessions", [
      { sessionId: "chat-background-1" },
      { sessionId: "chat-background-2" },
    ]);
    const adapter = createAdeWebAdapter(fake.asClient());
    adapter.bindProject(project, "project-1");

    fake.emitTables(["agent_chats"]);
    await vi.advanceTimersByTimeAsync(260);

    expect(fake.commandCalls).toEqual([]);
    expect(fake.chatSubscribeCalls).toEqual([]);

    adapter.dispose();
  });

  it("drains invalidations on a bounded cadence while writes stay continuous", async () => {
    vi.useFakeTimers();
    const adapter = createAdeWebAdapter(fake.asClient());
    adapter.bindProject(project, "project-1");
    const lifecycleEvents: unknown[] = [];
    adapter.ade.lanes.onLifecycleEvent((event) => lifecycleEvents.push(event));

    for (let index = 0; index < 8; index += 1) {
      fake.emitTables(["lanes"]);
      await vi.advanceTimersByTimeAsync(100);
    }

    expect(lifecycleEvents).toHaveLength(2);
    adapter.dispose();
  });

  it("replays reconnect snapshots without duplicating already-delivered chat events", async () => {
    fake.descriptors = descriptors(["chat.getSummary"]);
    fake.commandResults.set("chat.getSummary", { sessionId: "chat-restarted" });
    const adapter = createAdeWebAdapter(fake.asClient());
    adapter.bindProject(project, "project-1");
    await adapter.ade.agentChat.getSummary({ sessionId: "chat-restarted" });
    fake.commandResults.set("chat.getSummary", { sessionId: "chat-unrelated" });
    await adapter.ade.agentChat.getSummary({ sessionId: "chat-unrelated" });
    const received: SyncChatEventPayload[] = [];
    adapter.ade.agentChat.onEvent((event) => received.push(event as SyncChatEventPayload));

    const initialSnapshotEvent = transcriptChatEvent("chat-restarted", 1, "snapshot-source");
    fake.emitChatSnapshot("chat-restarted", {
      sessionId: "chat-restarted",
      capturedAt: "2026-07-20T00:00:00.000Z",
      truncated: false,
      resumed: false,
      events: [initialSnapshotEvent, { ...initialSnapshotEvent }],
    });
    fake.emitChat(chatEvent("chat-restarted", 1, "live-before-restart"));
    const unrelatedEvent = chatEvent("chat-unrelated", 1, "old-unrelated");
    fake.emitChat(unrelatedEvent);
    const liveAfterRestart = chatEvent("chat-restarted", 1, "live-after-restart");
    fake.emitChat(liveAfterRestart);
    fake.emitChat({ ...liveAfterRestart });
    fake.emitChatSnapshot("chat-restarted", {
      sessionId: "chat-restarted",
      capturedAt: "2026-07-20T00:00:01.000Z",
      truncated: false,
      resumed: false,
      events: [liveAfterRestart, transcriptChatEvent("chat-restarted", 1, "snapshot-after-restart")],
    });
    fake.emitChat({ ...unrelatedEvent });

    expect(received.map((payload) => [payload.sessionId, payload.event])).toEqual([
      ["chat-restarted", expect.objectContaining({ marker: "snapshot-source" })],
      ["chat-restarted", expect.objectContaining({ marker: "live-before-restart" })],
      ["chat-unrelated", expect.objectContaining({ marker: "old-unrelated" })],
      ["chat-restarted", expect.objectContaining({ marker: "live-after-restart" })],
      ["chat-restarted", expect.objectContaining({ marker: "snapshot-after-restart" })],
    ]);
    adapter.dispose();
  });

  it("keeps the last successful read through a transport outage without caching it as fresh", async () => {
    vi.useFakeTimers();
    fake.descriptors = descriptors(["lanes.list"]);
    fake.commandResults.set("lanes.list", [{ id: "lane-before-reconnect" }]);
    const adapter = createAdeWebAdapter(fake.asClient());
    adapter.bindProject(project, "project-1");

    await expect(adapter.ade.lanes.list()).resolves.toEqual([{ id: "lane-before-reconnect" }]);
    await vi.advanceTimersByTimeAsync(3_001);
    fake.commandErrors.set(
      "lanes.list",
      Object.assign(new Error("host unavailable"), { code: "host_unavailable" }),
    );
    await expect(adapter.ade.lanes.list()).resolves.toEqual([{ id: "lane-before-reconnect" }]);

    fake.commandErrors.delete("lanes.list");
    fake.commandResults.set("lanes.list", [{ id: "lane-after-reconnect" }]);
    await expect(adapter.ade.lanes.list()).resolves.toEqual([{ id: "lane-after-reconnect" }]);
    expect(fake.commandCalls.filter((call) => call.action === "lanes.list")).toHaveLength(3);

    adapter.dispose();
  });

  it("rejects disconnected chat mutations instead of fabricating success", async () => {
    fake.descriptors = descriptors(["chat.send"]);
    fake.commandErrors.set(
      "chat.send",
      Object.assign(new Error("connection lost"), { code: "connection_lost_outcome_unknown" }),
    );
    const adapter = createAdeWebAdapter(fake.asClient());
    adapter.bindProject(project, "project-1");

    await expect(adapter.ade.agentChat.send({
      sessionId: "chat-1",
      text: "keep this draft",
    })).rejects.toMatchObject({ code: "connection_lost_outcome_unknown" });
    expect(fake.commandCalls.map((call) => call.action)).toEqual(["chat.send"]);
    expect(fake.chatSubscribeCalls).toEqual([]);

    adapter.dispose();
  });

  it("returns queue-aware interrupt results and restores cancelled queue entries", async () => {
    fake.descriptors = descriptors([
      "chat.interrupt",
      "chat.restoreCancelledQueue",
    ]);
    fake.commandResults.set("chat.interrupt", {
      mode: "stop_and_clear",
      cancelledQueuedCount: 2,
      recoveryId: "recovery-1",
      recoveryExpiresAt: "2026-07-27T12:00:08.000Z",
    });
    fake.commandResults.set("chat.restoreCancelledQueue", {
      restored: true,
      restoredCount: 2,
    });
    const adapter = createAdeWebAdapter(fake.asClient());
    adapter.bindProject(project, "project-1");

    await expect(adapter.ade.agentChat.interrupt({
      sessionId: "chat-1",
      mode: "stop_and_clear",
    })).resolves.toEqual({
      mode: "stop_and_clear",
      cancelledQueuedCount: 2,
      recoveryId: "recovery-1",
      recoveryExpiresAt: "2026-07-27T12:00:08.000Z",
    });
    await expect(adapter.ade.agentChat.restoreCancelledQueue({
      sessionId: "chat-1",
      recoveryId: "recovery-1",
    })).resolves.toEqual({
      restored: true,
      restoredCount: 2,
    });
    expect(fake.commandCalls.map(({ action, args }) => ({ action, args }))).toEqual([
      {
        action: "chat.interrupt",
        args: { sessionId: "chat-1", mode: "stop_and_clear" },
      },
      {
        action: "chat.restoreCancelledQueue",
        args: { sessionId: "chat-1", recoveryId: "recovery-1" },
      },
    ]);

    adapter.dispose();
  });

  it("routes scheduled-work management through the web chat adapter", async () => {
    fake.descriptors = descriptors([
      "chat.createScheduledWork",
      "chat.listScheduledWork",
      "chat.cancelScheduledWork",
      "chat.setScheduledWorkPaused",
    ]);
    const scheduledItem = {
      id: "action:chat-1:job-1",
      sessionId: "chat-1",
      kind: "cron",
      status: "scheduled",
      title: "Check CI",
      prompt: "Check CI",
      createdAt: "2026-07-16T00:00:00.000Z",
      durable: true,
      cancellable: true,
    };
    fake.commandResults.set("chat.createScheduledWork", { item: scheduledItem });
    fake.commandResults.set("chat.listScheduledWork", [scheduledItem]);
    fake.commandResults.set("chat.cancelScheduledWork", {
      schedule: { ...scheduledItem, status: "cancelled" },
      providerCancellationRequested: false,
      providerCancellationConfirmed: true,
    });
    fake.commandResults.set("chat.setScheduledWorkPaused", {
      sessionId: "chat-1",
      paused: true,
      nextWakeAt: null,
    });

    const adapter = createAdeWebAdapter(fake.asClient());
    adapter.bindProject(project, "project-1");

    await expect(adapter.ade.agentChat.createScheduledWork({
      sessionId: "chat-1",
      cron: "*/20 * * * *",
      prompt: "Check CI",
    })).resolves.toEqual({ item: scheduledItem });
    await expect(adapter.ade.agentChat.listScheduledWork({ sessionId: "chat-1" })).resolves.toEqual([scheduledItem]);
    await expect(adapter.ade.agentChat.cancelScheduledWork({
      sessionId: "chat-1",
      scheduleId: scheduledItem.id,
    })).resolves.toMatchObject({ schedule: { status: "cancelled" } });
    await expect(adapter.ade.agentChat.setScheduledWorkPaused({
      sessionId: "chat-1",
      paused: true,
    })).resolves.toEqual({ sessionId: "chat-1", paused: true, nextWakeAt: null });

    expect(fake.commandCalls.map((call) => call.action)).toEqual([
      "chat.createScheduledWork",
      "chat.listScheduledWork",
      "chat.cancelScheduledWork",
      "chat.setScheduledWorkPaused",
    ]);
    adapter.dispose();
  });

  it("runs personal chats at machine scope and streams their subscribed events", async () => {
    fake.descriptors = [{
      action: "personalChats.list",
      scope: "runtime",
      policy: { viewerAllowed: true },
    }];
    fake.commandResults.set("personalChats.list", [{
      sessionId: "personal-1",
      provider: "codex",
      model: "gpt-5",
      status: "idle",
    }]);
    const adapter = createAdeWebAdapter(fake.asClient());

    await expect(adapter.ade.personalChats.call({
      action: "list",
      args: { includeArchived: false },
    })).resolves.toMatchObject({ action: "list", result: [{ sessionId: "personal-1" }] });
    expect(fake.commandCalls).toEqual([{
      action: "personalChats.list",
      args: { includeArchived: false },
      opts: { projectId: null, timeoutMs: undefined },
    }]);
    expect(fake.chatSubscribeCalls).toEqual([{
      sessionId: "personal-1",
      opts: { chatScope: "personal", maxBytes: 4 * 1024 * 1024 },
    }]);

    fake.emitChat({
      sessionId: "personal-1",
      seq: 1,
      timestamp: "2026-07-07T00:00:00.000Z",
      event: { type: "status", status: "started" } as never,
    });
    await expect(adapter.ade.personalChats.streamEvents({ cursor: 0 })).resolves.toMatchObject({
      nextCursor: 1,
      hasMore: false,
      events: [{ id: 1, payload: { sessionId: "personal-1", seq: 1 } }],
    });

    fake.descriptors.push({
      action: "personalChats.streamEvents",
      scope: "runtime",
      policy: { viewerAllowed: true },
    });
    fake.commandResults.set("personalChats.streamEvents", {
      events: [{
        id: 2,
        timestamp: "2026-07-07T00:00:01.000Z",
        category: "pty",
        payload: { type: "pty_data", event: { ptyId: "pty-1", data: "ready" } },
      }],
      nextCursor: 2,
      hasMore: false,
    });
    await expect(adapter.ade.personalChats.streamEvents({ cursor: 1 })).resolves.toMatchObject({
      nextCursor: 2,
      events: [{ category: "pty", payload: { type: "pty_data" } }],
    });
    expect(fake.commandCalls.at(-1)).toEqual({
      action: "personalChats.streamEvents",
      args: { cursor: 1 },
      opts: { projectId: null, timeoutMs: undefined },
    });

    adapter.dispose();
  });

  it("accepts a restarted personal-chat seq without duplicating a non-resumed snapshot replay", async () => {
    fake.descriptors = [{
      action: "personalChats.list",
      scope: "runtime",
      policy: { viewerAllowed: true },
    }];
    fake.commandResults.set("personalChats.list", [
      { sessionId: "personal-restarted" },
      { sessionId: "personal-unrelated" },
    ]);
    const adapter = createAdeWebAdapter(fake.asClient());
    await adapter.ade.personalChats.call({ action: "list", args: {} });

    const initialSnapshotEvent = transcriptChatEvent("personal-restarted", 1, "snapshot-source");
    fake.emitChatSnapshot("personal-restarted", {
      sessionId: "personal-restarted",
      capturedAt: "2026-07-20T00:00:00.000Z",
      truncated: false,
      resumed: false,
      events: [initialSnapshotEvent, { ...initialSnapshotEvent }],
    });
    fake.emitChat(chatEvent("personal-restarted", 1, "live-before-restart"));
    const unrelatedEvent = chatEvent("personal-unrelated", 1, "old-unrelated");
    fake.emitChat(unrelatedEvent);
    await expect(adapter.ade.personalChats.streamEvents({ cursor: 0 })).resolves.toMatchObject({
      nextCursor: 3,
      events: [
        { payload: { sessionId: "personal-restarted", event: { marker: "snapshot-source" } } },
        { payload: { sessionId: "personal-restarted", event: { marker: "live-before-restart" } } },
        { payload: { sessionId: "personal-unrelated", event: { marker: "old-unrelated" } } },
      ],
    });

    const liveAfterRestart = chatEvent("personal-restarted", 1, "live-after-restart");
    fake.emitChat(liveAfterRestart);
    fake.emitChat({ ...liveAfterRestart });
    fake.emitChatSnapshot("personal-restarted", {
      sessionId: "personal-restarted",
      capturedAt: "2026-07-20T00:00:01.000Z",
      truncated: false,
      resumed: false,
      events: [liveAfterRestart, transcriptChatEvent("personal-restarted", 1, "snapshot-after-restart")],
    });
    fake.emitChat({ ...unrelatedEvent });

    await expect(adapter.ade.personalChats.streamEvents({ cursor: 3 })).resolves.toMatchObject({
      nextCursor: 5,
      hasMore: false,
      events: [
        {
          payload: {
            sessionId: "personal-restarted",
            event: { marker: "live-after-restart" },
          },
        },
        {
          payload: {
            sessionId: "personal-restarted",
            event: { marker: "snapshot-after-restart" },
          },
        },
      ],
    });
    adapter.dispose();
  });

  it("captures web analytics at runtime scope with a durable browser-local opt-out", async () => {
    const stored = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => stored.set(key, value),
      },
    });
    fake.descriptors = ["analytics.capture", "analytics.getStatus", "analytics.setClientEnabled"].map((action) => ({
      action,
      scope: "runtime" as const,
      policy: { viewerAllowed: true },
    }));
    fake.commandResults.set("analytics.capture", { accepted: true, reason: "accepted" });
    const hostStatus = {
      configured: true,
      enabled: true,
      effective: true,
      host: "https://us.i.posthog.com",
      dailyBudget: 200,
      acceptedToday: 4,
      droppedToday: 1,
      day: "2026-07-13",
    };
    fake.commandResults.set("analytics.getStatus", hostStatus);
    fake.commandResults.set("analytics.setClientEnabled", hostStatus);
    const adapter = createAdeWebAdapter(fake.asClient());

    await expect(adapter.ade.analytics.getStatus()).resolves.toMatchObject({
      configured: true,
      enabled: false,
      effective: false,
      consentRequired: true,
    });
    await expect(adapter.ade.analytics.capture({
      event: "ade_screen_viewed",
      properties: { screen: "work" },
    })).resolves.toEqual({ accepted: false, reason: "disabled" });

    await expect(adapter.ade.analytics.setEnabled(true)).resolves.toMatchObject({
      configured: true,
      enabled: true,
      effective: true,
      consentRequired: false,
    });
    await expect(adapter.ade.analytics.capture({
      event: "ade_screen_viewed",
      properties: { screen: "work" },
    })).resolves.toEqual({ accepted: true, reason: "accepted" });
    expect(fake.commandCalls).toContainEqual({
      action: "analytics.setClientEnabled",
      args: { enabled: true },
      opts: { projectId: null, timeoutMs: 5_000 },
    });
    expect(fake.commandCalls).toContainEqual({
      action: "analytics.getStatus",
      args: {},
      opts: { projectId: null, timeoutMs: undefined },
    });
    expect(fake.commandCalls).toContainEqual({
      action: "analytics.capture",
      args: {
        event: "ade_screen_viewed",
        properties: { screen: "work" },
        surface: "web",
      },
      opts: { projectId: null, timeoutMs: undefined },
    });

    await expect(adapter.ade.analytics.setEnabled(false)).resolves.toMatchObject({
      enabled: false,
      effective: false,
    });
    await expect(adapter.ade.analytics.capture({
      event: "ade_screen_viewed",
      properties: { screen: "files" },
    })).resolves.toEqual({ accepted: false, reason: "disabled" });
    expect(fake.commandCalls).toContainEqual({
      action: "analytics.setClientEnabled",
      args: { enabled: false },
      opts: { projectId: null, timeoutMs: 5_000 },
    });
    expect(fake.commandCalls.filter((call) => call.action === "analytics.capture")).toHaveLength(1);
    adapter.dispose();

    const reloadedAdapter = createAdeWebAdapter(fake.asClient());
    await expect(reloadedAdapter.ade.analytics.getStatus()).resolves.toMatchObject({
      enabled: false,
      effective: false,
    });
    reloadedAdapter.dispose();
  });

  it("retries consent before disconnecting an opted-out browser fail-closed", async () => {
    fake.descriptors = descriptors(["analytics.setClientEnabled", "analytics.capture"]);
    fake.commandErrors.set("analytics.setClientEnabled", new Error("consent timeout"));
    const adapter = createAdeWebAdapter(fake.asClient());

    await expect(adapter.ade.analytics.setEnabled(false)).resolves.toMatchObject({
      enabled: false,
      effective: false,
    });
    expect(fake.commandCalls.filter((call) => call.action === "analytics.setClientEnabled")).toHaveLength(6);
    expect(fake.disconnectCalls).toBe(1);
    await expect(adapter.ade.analytics.capture({
      event: "ade_screen_viewed",
      properties: { screen: "work" },
    })).resolves.toEqual({ accepted: false, reason: "disabled" });
    expect(fake.commandCalls.some((call) => call.action === "analytics.capture")).toBe(false);
    adapter.dispose();
  });

  it("unwraps refreshed lane and PR envelopes to preserve renderer array contracts", async () => {
    fake.descriptors = descriptors(["lanes.refreshSnapshots", "prs.refresh"]);
    const laneSnapshot = { lane: { id: "lane-1" }, runtime: {}, rebaseSuggestion: null };
    const pr = { id: "pr-1", title: "Ship web client" };
    fake.commandResults.set("lanes.refreshSnapshots", {
      refreshedCount: 1,
      lanes: [{ id: "lane-1" }],
      snapshots: [laneSnapshot],
      signature: "sig",
    });
    fake.commandResults.set("prs.refresh", {
      refreshedCount: 1,
      prs: [pr],
      snapshots: [{ prId: "pr-1" }],
    });

    const adapter = createAdeWebAdapter(fake.asClient());
    adapter.bindProject(project, "project-1");

    await expect(adapter.ade.lanes.listSnapshots({ includeStatus: true })).resolves.toEqual([laneSnapshot]);
    await expect(adapter.ade.prs.refresh({ prIds: ["pr-1"] })).resolves.toEqual([pr]);

    expect(fake.commandCalls.map((call) => [call.action, call.args])).toEqual([
      ["lanes.refreshSnapshots", { includeStatus: true }],
      ["prs.refresh", { prIds: ["pr-1"] }],
    ]);

    adapter.dispose();
  });

  it("routes the manual lane PR sync and reconcile through their daemon actions", async () => {
    fake.descriptors = descriptors(["prs.syncLanePr", "prs.reconcileOnFocus"]);
    const pr = { id: "pr-1", laneId: "lane-1", title: "Ship web client" };
    fake.commandResults.set("prs.syncLanePr", pr);
    fake.commandResults.set("prs.reconcileOnFocus", { open: 1, healed: 0, closedSwept: false });

    const adapter = createAdeWebAdapter(fake.asClient());
    adapter.bindProject(project, "project-1");

    await expect(adapter.ade.prs.syncLanePr("lane-1")).resolves.toEqual(pr);
    await expect(adapter.ade.prs.reconcileNow()).resolves.toBeUndefined();

    // Single positional laneId marshals to a named `{ laneId }` record (matching
    // the `prs.getForLane` host handler); reconcile carries `{ force: true }`.
    expect(fake.commandCalls.map((call) => [call.action, call.args])).toEqual([
      ["prs.syncLanePr", { laneId: "lane-1" }],
      ["prs.reconcileOnFocus", { force: true }],
    ]);

    adapter.dispose();
  });

  it("returns the host's structured file results (not a blob-wrapped JSON string)", async () => {
    // Regression: the host answers file_request with a structured `result`
    // (workspaces array, tree array), and requestFile() resolves with it
    // directly. The adapter must return it as-is — treating every result as a
    // SyncFileBlob and JSON.parsing `.content` silently emptied the Files tab.
    const workspaces = [
      { id: "ws-1", kind: "primary", laneId: null, name: "repo", rootPath: "/repo", isReadOnlyByDefault: false },
    ];
    const tree = [
      { name: "src", path: "src", type: "directory", hasChildren: true },
      { name: "README.md", path: "README.md", type: "file" },
    ];
    fake.fileResults.set("listWorkspaces", workspaces);
    fake.fileResults.set("listTree", tree);

    const adapter = createAdeWebAdapter(fake.asClient());
    adapter.bindProject(project, "project-1");

    await expect(adapter.ade.files.listWorkspaces()).resolves.toEqual(workspaces);
    await expect(adapter.ade.files.listTree({ workspaceId: "ws-1" } as never)).resolves.toEqual(tree);
    // A host that has no data for the action still yields the typed fallback.
    await expect(adapter.ade.files.searchText({ workspaceId: "ws-1", query: "x" } as never)).resolves.toEqual([]);

    adapter.dispose();
  });

  it("scopes Files reads to the bound catalog project and coalesces hot tree reads", async () => {
    vi.useFakeTimers();
    fake.activeProjectId = "project-old";
    fake.projects = [
      {
        ...fake.projects[0]!,
        id: "project-old",
        rootPath: "/old-repo",
        displayName: "Old Repo",
        isOpen: false,
      },
      {
        ...fake.projects[0]!,
        id: "project-2",
        rootPath: "/repo-2",
        displayName: "Repo Two",
      },
    ];
    const boundProject = { rootPath: "/repo-2", displayName: "Repo Two", baseRef: "main" };
    const workspaces = [
      { id: "primary", kind: "primary", laneId: null, name: "repo-2", rootPath: "/repo-2", isReadOnlyByDefault: false },
    ];
    const tree = [{ name: "README.md", path: "README.md", type: "file" }];
    fake.fileResults.set("listWorkspaces", workspaces);
    fake.fileResults.set("listTree", tree);

    const adapter = createAdeWebAdapter(fake.asClient(), fake.projects);
    adapter.bindProject(boundProject, "project-2");

    await expect(adapter.ade.files.listWorkspaces()).resolves.toEqual(workspaces);
    await expect(Promise.all([
      adapter.ade.files.listTree({ workspaceId: "primary", depth: 1 } as never),
      adapter.ade.files.listTree({ depth: 1, workspaceId: "primary" } as never),
    ])).resolves.toEqual([tree, tree]);

    expect(fake.fileCalls).toEqual([
      { action: "listWorkspaces", args: {}, opts: { projectId: "project-2", timeoutMs: undefined } },
      { action: "listTree", args: { workspaceId: "primary", depth: 1 }, opts: { projectId: "project-2", timeoutMs: undefined } },
    ]);

    const fileEvents: Array<{ workspaceId: string }> = [];
    adapter.ade.files.onChange((event) => fileEvents.push(event));
    fake.emitTables(["files"]);
    await vi.advanceTimersByTimeAsync(260);
    expect(fileEvents).toEqual([expect.objectContaining({ workspaceId: "primary" })]);
    await adapter.ade.files.listTree({ workspaceId: "primary", depth: 1 } as never);
    expect(fake.fileCalls.filter((call) => call.action === "listTree")).toHaveLength(2);

    fake.fileErrors.set("listWorkspaces", new Error("wrong project scope"));
    fake.emitTables(["files"]);
    await vi.advanceTimersByTimeAsync(260);
    await expect(adapter.ade.files.listWorkspaces()).rejects.toThrow("wrong project scope");

    adapter.dispose();
  });

  it("atomically replaces the bound project and refreshes every mounted domain", async () => {
    fake.descriptors = descriptors(["lanes.list"]);
    fake.commandResults.set("lanes.list", [{ id: "lane-old" }]);
    const projectTwoSummary = {
      ...fake.projects[0]!,
      id: "project-2",
      rootPath: "/repo-2",
      displayName: "Repo Two",
    };
    fake.projects.push(projectTwoSummary);
    const projectTwo = { rootPath: "/repo-2", displayName: "Repo Two", baseRef: "main" };
    const adapter = createAdeWebAdapter(fake.asClient(), fake.projects);
    adapter.bindProject(project, "project-1");

    const projects: Array<ProjectInfo | null> = [];
    const laneEvents: unknown[] = [];
    const sessionEvents: unknown[] = [];
    const fileEvents: unknown[] = [];
    const rebaseEvents: unknown[] = [];
    adapter.ade.app.onProjectChanged((next) => projects.push(next));
    adapter.ade.lanes.onLifecycleEvent((event) => laneEvents.push(event));
    adapter.ade.sessions.onChanged((event) => sessionEvents.push(event));
    adapter.ade.files.onChange((event) => fileEvents.push(event));
    adapter.ade.rebase.onEvent((event) => rebaseEvents.push(event));

    await adapter.ade.lanes.list();
    fake.commandResults.set("lanes.list", [{ id: "lane-new" }]);
    adapter.replaceProject(projectTwo, "project-2");
    await expect(adapter.ade.app.getProject()).resolves.toEqual(projectTwo);
    await expect(adapter.ade.lanes.list()).resolves.toEqual([{ id: "lane-new" }]);

    expect(projects).toEqual([projectTwo]);
    expect(fake.commandCalls.filter((call) => call.action === "lanes.list")).toEqual([
      expect.objectContaining({ opts: expect.objectContaining({ projectId: "project-1" }) }),
      expect.objectContaining({ opts: expect.objectContaining({ projectId: "project-2" }) }),
    ]);
    expect(laneEvents).toHaveLength(1);
    expect(sessionEvents).toHaveLength(1);
    expect(fileEvents).toHaveLength(1);
    expect(rebaseEvents).toHaveLength(2);

    adapter.dispose();
  });

  it("keeps the current project binding when a remote project switch is rejected", async () => {
    fake.projects.push({
      ...fake.projects[0]!,
      id: "project-2",
      rootPath: "/repo-2",
      displayName: "Repo Two",
    });
    fake.projectSwitchResult = { ok: false, message: "Project host unavailable" };
    const adapter = createAdeWebAdapter(fake.asClient(), fake.projects);
    adapter.bindProject(project, "project-1");

    await expect(adapter.ade.project.openRepo({ rootPath: "/repo-2" })).rejects.toThrow(
      "Project host unavailable",
    );
    await expect(adapter.ade.project.openRepo()).resolves.toEqual(project);

    adapter.dispose();
  });

  it("hydrates PR list reads from one cached mobile snapshot and coalesces invalidations", async () => {
    vi.useFakeTimers();
    fake.descriptors = descriptors([
      "prs.getMobileSnapshot",
      "prs.getStatus",
      "prs.getChecks",
      "prs.getGitHubSnapshot",
      "prs.getMergeContexts",
      "prs.getMergeContext",
      "lanes.list",
      "github.getStatus",
    ]);
    const pr = {
      id: "pr-1",
      laneId: "lane-1",
      projectId: "project-1",
      repoOwner: "ade",
      repoName: "desktop",
      githubPrNumber: 42,
      githubUrl: "https://github.test/ade/desktop/pull/42",
      githubNodeId: null,
      title: "Fast hosted PRs",
      state: "open",
      baseBranch: "main",
      headBranch: "web-fast",
      checksStatus: "passing",
      reviewStatus: "approved",
      additions: 10,
      deletions: 2,
      mergeConflicts: false,
      behindBaseBy: 0,
      headSha: "abc123",
      lastSyncedAt: "2026-07-17T00:00:00.000Z",
      createdAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-17T00:00:00.000Z",
    };
    fake.commandResults.set("prs.getMobileSnapshot", {
      generatedAt: "2026-07-17T00:00:00.000Z",
      prs: [pr],
      stacks: [],
      capabilities: {},
      createCapabilities: { canCreateAny: false, defaultBaseBranch: "main", lanes: [] },
      workflowCards: [],
      live: true,
    });
    fake.commandResults.set("prs.getStatus", { prId: "pr-1", isMergeable: true });
    fake.commandResults.set("prs.getChecks", [{ id: "check-1", status: "completed" }]);
    fake.commandResults.set("prs.getGitHubSnapshot", { repoPullRequests: [{ linkedPrId: "pr-1" }] });
    fake.commandResults.set("prs.getMergeContexts", {
      "pr-1": {
        prId: "pr-1",
        groupId: null,
        groupType: null,
        sourceLaneIds: [],
        targetLaneId: null,
        integrationLaneId: null,
        members: [],
      },
    });
    fake.commandResults.set("lanes.list", [{ id: "lane-1" }]);

    const adapter = createAdeWebAdapter(fake.asClient(), fake.projects);
    adapter.bindProject(project, "project-1");

    const [list, lanePr, conflicts, statusA, statusB, checks, github, contextsA, contextsB, lanesA, lanesB] = await Promise.all([
      adapter.ade.prs.listAll(),
      adapter.ade.prs.getForLane("lane-1"),
      adapter.ade.prs.listWithConflicts({ includeConflictAnalysis: false }),
      adapter.ade.prs.getStatus("pr-1"),
      adapter.ade.prs.getStatus("pr-1"),
      adapter.ade.prs.getChecks("pr-1"),
      adapter.ade.prs.getGitHubSnapshot(),
      adapter.ade.prs.getMergeContexts(["pr-1"]),
      adapter.ade.prs.getMergeContexts(["pr-1"]),
      adapter.ade.lanes.list({ includeStatus: false }),
      adapter.ade.lanes.list({ includeStatus: false }),
    ]);

    expect(list).toEqual([pr]);
    expect(lanePr).toEqual(pr);
    expect(statusA).toEqual(statusB);
    expect(checks).toEqual([{ id: "check-1", status: "completed" }]);
    expect(conflicts).toEqual([{ ...pr, conflictAnalysis: null }]);
    expect(github).toMatchObject({ repoPullRequests: [{ linkedPrId: "pr-1" }] });
    expect(contextsA).toEqual(contextsB);
    expect(lanesA).toEqual(lanesB);
    expect(fake.commandCalls.filter((call) => call.action === "prs.getMobileSnapshot")).toHaveLength(1);
    expect(fake.commandCalls.filter((call) => call.action === "lanes.list")).toHaveLength(1);
    expect(fake.commandCalls.filter((call) => call.action === "prs.getStatus")).toHaveLength(1);
    expect(fake.commandCalls.filter((call) => call.action === "prs.getChecks")).toHaveLength(1);
    expect(fake.commandCalls.filter((call) => call.action === "prs.getGitHubSnapshot")).toHaveLength(1);
    expect(fake.commandCalls.filter((call) => call.action === "prs.getMergeContexts")).toHaveLength(1);
    expect(fake.commandCalls.filter((call) => call.action === "prs.getMergeContext")).toHaveLength(0);

    fake.emitTables(["pull_requests", "pull_request_snapshots", "github_pr_projections"]);
    fake.emitTables(["pull_requests"]);
    await vi.advanceTimersByTimeAsync(260);
    await adapter.ade.prs.listAll();

    expect(fake.commandCalls.filter((call) => call.action === "prs.getMobileSnapshot")).toHaveLength(2);
    expect(fake.commandCalls.filter((call) => call.action === "lanes.list")).toHaveLength(1);
    expect(fake.commandCalls.filter((call) => call.action === "github.getStatus")).toHaveLength(0);

    adapter.dispose();
  });

  it("does not run GitHub authentication work as a side effect of transport connect", async () => {
    fake.descriptors = descriptors(["github.getStatus"]);
    fake.commandResults.set("github.getStatus", { connected: true });
    const adapter = createAdeWebAdapter(fake.asClient(), fake.projects);
    adapter.bindProject(project, "project-1");

    fake.emitStatus();
    await Promise.resolve();

    expect(fake.commandCalls.filter((call) => call.action === "github.getStatus")).toHaveLength(0);
    adapter.dispose();
  });

  it("fans out table, chat, and terminal events and unsubscribes listeners", async () => {
    vi.useFakeTimers();
    fake.descriptors = descriptors(["work.listSessions"]);
    fake.commandResults.set("work.listSessions", [{ id: "session-1", ptyId: "pty-1" }]);
    const adapter = createAdeWebAdapter(fake.asClient());
    adapter.bindProject(project, "project-1");

    const laneEvents: unknown[] = [];
    const sessionEvents: unknown[] = [];
    adapter.ade.lanes.onLifecycleEvent((event) => laneEvents.push(event));
    adapter.ade.sessions.onChanged((event) => sessionEvents.push(event));

    fake.emitTables(["lanes"]);
    await vi.advanceTimersByTimeAsync(260);

    expect(laneEvents).toHaveLength(1);
    // Lane metadata does not imply session metadata changed. Keeping the
    // domains isolated prevents every lane changeset from refetching Work.
    expect(sessionEvents).toHaveLength(0);

    const chatEvents: unknown[] = [];
    const offChat = adapter.ade.agentChat.onEvent((event) => chatEvents.push(event));
    fake.emitChat({
      sessionId: "chat-1",
      timestamp: "2026-07-07T00:00:00.000Z",
      event: { type: "status", status: "started" } as never,
    });
    expect(chatEvents).toHaveLength(1);
    offChat();
    fake.emitChat({
      sessionId: "chat-1",
      timestamp: "2026-07-07T00:00:01.000Z",
      event: { type: "status", status: "completed" } as never,
    });
    expect(chatEvents).toHaveLength(1);

    await adapter.ade.sessions.list();
    await adapter.ade.pty.setDataSubscriptions({ ptyIds: ["pty-1"] });
    const ptyData: unknown[] = [];
    const offData = adapter.ade.pty.onData((event) => ptyData.push(event));
    fake.emitTerminalData("session-1", {
      sessionId: "session-1",
      ptyId: "pty-1",
      data: "hi",
      at: "2026-07-07T00:00:02.000Z",
      offset: 2,
    });
    expect(ptyData).toEqual([
      {
        ptyId: "pty-1",
        sessionId: "session-1",
        data: "hi",
        offset: 2,
      },
    ]);
    offData();
    fake.emitTerminalData("session-1", {
      sessionId: "session-1",
      ptyId: "pty-1",
      data: "ignored",
      at: "2026-07-07T00:00:03.000Z",
    });
    expect(ptyData).toHaveLength(1);

    adapter.dispose();
  });

  it("keeps the live terminal subscription while preview and transcript tail read history", async () => {
    fake.descriptors = descriptors(["work.listSessions"]);
    fake.commandResults.set("work.listSessions", [{ id: "session-1", ptyId: "pty-1", status: "running" }]);
    fake.terminalHistoryResults.set("session-1", {
      sessionId: "session-1",
      data: "scrollback\n",
      startOffset: 0,
      endOffset: 11,
      atStart: true,
    });
    const adapter = createAdeWebAdapter(fake.asClient());
    adapter.bindProject(project, "project-1");

    await adapter.ade.sessions.list();
    const ptyData: unknown[] = [];
    const offData = adapter.ade.pty.onData((event) => ptyData.push(event));
    await adapter.ade.pty.setDataSubscriptions({ ptyIds: ["pty-1"] });

    expect(fake.terminalSubscribeCalls).toEqual([{ sessionId: "session-1", opts: { maxBytes: 2_000_000 } }]);
    fake.emitTerminalSnapshot("session-1", {
      sessionId: "session-1",
      transcript: "scrollback\n",
      status: "running",
      runtimeState: "running",
      lastOutputPreview: "scrollback",
      capturedAt: "2026-07-07T00:00:01.000Z",
      startOffset: 0,
      endOffset: 11,
      live: true,
    });
    expect(ptyData).toEqual([
      {
        ptyId: "pty-1",
        sessionId: "session-1",
        data: "scrollback\n",
        offset: 11,
        replace: true,
      },
    ]);

    fake.emitTerminalSnapshot("session-1", {
      sessionId: "session-1",
      transcript: "recovered\n",
      status: "running",
      runtimeState: "running",
      lastOutputPreview: "recovered",
      capturedAt: "2026-07-07T00:00:01.500Z",
      startOffset: 11,
      endOffset: 21,
      delta: true,
      live: true,
    });
    expect(ptyData.at(-1)).toEqual({
      ptyId: "pty-1",
      sessionId: "session-1",
      data: "recovered\n",
      offset: 21,
    });

    await expect(adapter.ade.terminal.preview({ terminalId: "session-1", maxBytes: 4096 })).resolves.toMatchObject({
      terminalId: "session-1",
      transcript: "scrollback\n",
      source: "transcript",
    });
    expect(ptyData).toHaveLength(2);

    await expect(adapter.ade.sessions.readTranscriptTail({ sessionId: "session-1", maxBytes: 4096, raw: true })).resolves.toBe("scrollback\n");
    expect(fake.terminalSubscribeCalls).toHaveLength(1);
    expect(fake.terminalUnsubscribeCalls).toEqual([]);
    expect(fake.terminalHistoryCalls).toEqual([
      { sessionId: "session-1", beforeOffset: Number.MAX_SAFE_INTEGER, maxBytes: 4096 },
      { sessionId: "session-1", beforeOffset: Number.MAX_SAFE_INTEGER, maxBytes: 4096 },
    ]);

    fake.terminalHistoryErrors.set(
      "session-1",
      Object.assign(new Error("reconnecting"), { code: "not_connected" }),
    );
    await expect(adapter.ade.sessions.readTranscriptTail({
      sessionId: "session-1",
      maxBytes: 4096,
      raw: true,
    })).rejects.toMatchObject({ code: "not_connected" });
    await expect(adapter.ade.terminal.read({
      terminalId: "session-1",
      since: 11,
    })).rejects.toMatchObject({ code: "not_connected" });

    fake.emitTerminalData("session-1", {
      sessionId: "session-1",
      ptyId: "pty-1",
      data: "live\n",
      at: "2026-07-07T00:00:02.000Z",
      offset: 26,
    });
    expect(ptyData.at(-1)).toEqual({
      ptyId: "pty-1",
      sessionId: "session-1",
      data: "live\n",
      offset: 26,
    });

    offData();
    adapter.dispose();
    expect(fake.terminalUnsubscribeCalls).toEqual(["session-1"]);
  });

  it("keeps unknown namespaces harmless and logs once per missing leaf", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const adapter = createAdeWebAdapter(fake.asClient());

    await expect((adapter.ade as never as { mystery: { doThing: () => Promise<unknown> } }).mystery.doThing()).resolves.toBeNull();
    await expect((adapter.ade as never as { mystery: { doThing: () => Promise<unknown> } }).mystery.doThing()).resolves.toBeNull();
    const unsubscribe = (adapter.ade as never as { mystery: { onThing: (cb: () => void) => () => void } }).mystery.onThing(() => undefined);

    expect(typeof unsubscribe).toBe("function");
    expect(debug).toHaveBeenCalledTimes(2);
    expect(debug).toHaveBeenNthCalledWith(1, "[ade-web] unimplemented:", "ade.mystery", "doThing");
    expect(debug).toHaveBeenNthCalledWith(2, "[ade-web] unimplemented:", "ade.mystery", "onThing");

    adapter.dispose();
  });

  it("maps pty.write through the terminal subscription registry", async () => {
    fake.descriptors = descriptors(["work.listSessions"]);
    fake.commandResults.set("work.listSessions", [{ id: "session-1", ptyId: "pty-1" }]);
    const adapter = createAdeWebAdapter(fake.asClient());
    adapter.bindProject(project, "project-1");

    await adapter.ade.sessions.list();
    await adapter.ade.pty.write({ ptyId: "pty-1", data: "echo ok\n" });

    expect(fake.terminalInputs).toEqual([{ sessionId: "session-1", data: "echo ok\n" }]);
    adapter.dispose();
  });

  it("routes the OpenCode AI methods to their host actions and bridges the OAuth status event", async () => {
    fake.descriptors = descriptors([
      "ai.opencodeAuthMethods",
      "ai.opencodeOAuthStart",
      "ai.opencodeOAuthCancel",
      "ai.setOpencodeProviderKey",
      "ai.clearOpencodeProviderKey",
      "ai.refreshModelsDev",
    ]);
    fake.commandResults.set("ai.opencodeAuthMethods", {
      methods: { anthropic: [{ type: "oauth", label: "Claude" }] },
    });
    fake.commandResults.set("ai.opencodeOAuthStart", {
      url: "https://opencode.example/oauth",
      method: "auto",
      instructions: "Open the link to finish signing in.",
    });
    fake.commandResults.set("ai.setOpencodeProviderKey", { ok: true });
    fake.commandResults.set("ai.clearOpencodeProviderKey", { ok: true });
    fake.commandResults.set("ai.refreshModelsDev", {
      lastFetchedAt: Date.parse("2026-07-17T00:00:00.000Z"),
    });

    const adapter = createAdeWebAdapter(fake.asClient());
    adapter.bindProject(project, "project-1");

    // The web adapter builds `ai` as a Record and casts it, so type the surface
    // locally instead of depending on the preload global contract landing first.
    const ai = adapter.ade.ai as unknown as {
      opencodeAuthMethods: () => Promise<{ methods: Record<string, Array<{ type: string; label: string }>> }>;
      opencodeOAuthStart: (args: unknown) => Promise<{ url: string; method: string; instructions: string }>;
      opencodeOAuthCancel: (args: unknown) => Promise<unknown>;
      setOpencodeProviderKey: (args: unknown) => Promise<{ ok: boolean; error?: string }>;
      clearOpencodeProviderKey: (args: unknown) => Promise<{ ok: boolean; error?: string }>;
      refreshModelsDev: () => Promise<{ lastFetchedAt: number | null }>;
      onOpencodeOAuthStatus: (cb: (status: unknown) => void) => () => void;
    };

    await expect(ai.opencodeAuthMethods()).resolves.toEqual({
      methods: { anthropic: [{ type: "oauth", label: "Claude" }] },
    });
    await expect(ai.opencodeOAuthStart({ providerId: "anthropic" })).resolves.toMatchObject({
      url: "https://opencode.example/oauth",
      method: "auto",
    });
    await ai.opencodeOAuthCancel({ providerId: "anthropic" });
    await expect(ai.setOpencodeProviderKey({ providerId: "anthropic", key: "sk-test" })).resolves.toEqual({ ok: true });
    await expect(ai.clearOpencodeProviderKey({ providerId: "anthropic" })).resolves.toEqual({ ok: true });
    await expect(ai.refreshModelsDev()).resolves.toEqual({
      lastFetchedAt: Date.parse("2026-07-17T00:00:00.000Z"),
    });

    const statusEvents: unknown[] = [];
    const unsubscribe = ai.onOpencodeOAuthStatus((status) => statusEvents.push(status));
    expect(typeof unsubscribe).toBe("function");
    unsubscribe();

    expect(fake.commandCalls.map((call) => call.action)).toEqual([
      "ai.opencodeAuthMethods",
      "ai.opencodeOAuthStart",
      "ai.opencodeOAuthCancel",
      "ai.setOpencodeProviderKey",
      "ai.clearOpencodeProviderKey",
      "ai.refreshModelsDev",
    ]);

    adapter.dispose();
  });

  it("passes custom provider and model slug config patches directly to the host action", async () => {
    fake.descriptors = descriptors(["ai.updateConfig"]);
    const adapter = createAdeWebAdapter(fake.asClient());
    adapter.bindProject(project, "project-1");
    const patch = {
      customProviders: [
        {
          id: "acme",
          name: "Acme",
          baseURL: "https://acme.example/v1",
          models: ["deep-think"],
        },
      ],
      customModelSlugs: ["acme/deep-think", "openai/gpt-5"],
    };

    await adapter.ade.ai.updateConfig(patch);

    expect(fake.commandCalls).toContainEqual({
      action: "ai.updateConfig",
      args: patch,
      opts: { projectId: "project-1", timeoutMs: undefined },
    });
    adapter.dispose();
  });

  it("rejects OpenCode sign-in offline instead of resolving a fabricated result", async () => {
    // No descriptor registered = host unreachable. opencodeOAuthStart has no
    // meaningful fallback shape, so it must reject rather than resolve.
    const adapter = createAdeWebAdapter(fake.asClient());
    adapter.bindProject(project, "project-1");
    const ai = adapter.ade.ai as unknown as {
      opencodeOAuthStart: (args: unknown) => Promise<unknown>;
      opencodeAuthMethods: () => Promise<{ methods: Record<string, unknown> }>;
    };

    await expect(ai.opencodeOAuthStart({ providerId: "anthropic" })).rejects.toThrow(/unavailable/i);
    // Reads still degrade to their typed fallback.
    await expect(ai.opencodeAuthMethods()).resolves.toEqual({ methods: {} });

    adapter.dispose();
  });

  it("rejects branch-drift resolution the host cannot run", async () => {
    // The drift strip disarms its warning as soon as this resolves, so an
    // unreachable host must reject instead of handing back a status object.
    fake.descriptors = descriptors(["lanes.getBranchDrift"]);
    fake.commandResults.set("lanes.getBranchDrift", null);
    const adapter = createAdeWebAdapter(fake.asClient());
    adapter.bindProject(project, "project-1");

    await expect(adapter.ade.lanes.resolveBranchDrift({
      laneId: "lane-1",
      resolution: "switch-back",
    })).rejects.toThrow(/unavailable/i);
    // Reads still degrade to their typed fallback.
    await expect(adapter.ade.lanes.getBranchDrift({ laneId: "lane-1" })).resolves.toBeNull();

    adapter.dispose();
  });

  it("makes onOpencodeOAuthStatus live by draining OAuth status from the runtime buffer", async () => {
    vi.useFakeTimers();
    fake.descriptors = descriptors(["ai.opencodeOAuthStart", "personalChats.streamEvents"]);
    fake.commandResults.set("ai.opencodeOAuthStart", {
      url: "https://opencode.example/oauth",
      method: "auto",
      instructions: "Finish signing in.",
    });
    // The web adapter pulls the shared runtime event buffer; the OAuth status
    // transition arrives as a category:"runtime" buffered event keyed by kind.
    fake.commandResults.set("personalChats.streamEvents", {
      events: [
        {
          id: 5,
          timestamp: "2026-07-17T00:00:00.000Z",
          category: "runtime",
          payload: { kind: "opencodeOAuthStatus", event: { providerId: "anthropic", state: "connected" } },
        },
      ],
      nextCursor: 5,
      hasMore: false,
    });

    const adapter = createAdeWebAdapter(fake.asClient());
    adapter.bindProject(project, "project-1");
    const ai = adapter.ade.ai as unknown as {
      opencodeOAuthStart: (args: unknown) => Promise<unknown>;
      onOpencodeOAuthStatus: (cb: (status: { providerId: string; state: string }) => void) => () => void;
    };

    const statusEvents: Array<{ providerId: string; state: string }> = [];
    const unsubscribe = ai.onOpencodeOAuthStatus((status) => statusEvents.push(status));

    await ai.opencodeOAuthStart({ providerId: "anthropic" });
    // The status transition is drained on the next poll tick and re-emitted onto
    // the adapter bus, reaching the live subscription.
    await vi.advanceTimersByTimeAsync(1_100);

    expect(statusEvents).toEqual([{ providerId: "anthropic", state: "connected" }]);
    // A terminal state stops the scoped drain; no further polling is scheduled.
    const streamCallsAfter = fake.commandCalls.filter((call) => call.action === "personalChats.streamEvents").length;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(
      fake.commandCalls.filter((call) => call.action === "personalChats.streamEvents").length,
    ).toBe(streamCallsAfter);

    unsubscribe();
    adapter.dispose();
  });

  // --- Session lifecycle ----------------------------------------------------
  // ADE Web keeps no local database, so every settle/snooze is a sync
  // round-trip. These cover the three things that behaviour has to get right:
  // paint at once, reconcile against the machine, roll back when it says no.

  it("paints a snooze at once and files the row as snoozed before the host catches up", async () => {
    fake.descriptors = descriptors(LIFECYCLE_DESCRIPTORS);
    fake.commandResults.set("work.listSessions", [{ id: "session-1", ptyId: "pty-1" }]);
    fake.commandResults.set("session.snoozeSession", true);
    const adapter = createAdeWebAdapter(fake.asClient());
    adapter.bindProject(project, "project-1");

    const before = await adapter.ade.sessions.list();
    expect(isSessionSnoozed(before[0]!)).toBe(false);

    const untilIso = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await expect(adapter.ade.sessions.snoozeSession("session-1", untilIso)).resolves.toBe(true);

    // The host row is deliberately still un-snoozed here: the optimistic patch
    // is the only reason the row reads as snoozed, which is what puts it in the
    // shared "Snoozed" group without waiting for the changeset pump.
    const optimistic = await adapter.ade.sessions.list();
    expect(optimistic[0]!.snoozedUntil).toBe(untilIso);
    expect(optimistic[0]!.snoozedAt).toEqual(expect.any(String));
    expect(isSessionSnoozed(optimistic[0]!)).toBe(true);

    adapter.dispose();
  });

  it("retires the optimistic patch once the machine's own row agrees", async () => {
    fake.descriptors = descriptors(LIFECYCLE_DESCRIPTORS);
    fake.commandResults.set("work.listSessions", [{ id: "session-1", ptyId: "pty-1" }]);
    fake.commandResults.set("session.snoozeSession", true);
    const adapter = createAdeWebAdapter(fake.asClient());
    adapter.bindProject(project, "project-1");
    await adapter.ade.sessions.list();

    const hostUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await adapter.ade.sessions.snoozeSession("session-1", hostUntil);

    // The machine echoes back the deadline we sent but stamps its OWN
    // `snoozed_at`. That instant is reconciled by presence, so the host's row
    // must win outright as soon as it lands.
    fake.commandResults.set("work.listSessions", [
      { id: "session-1", ptyId: "pty-1", snoozedUntil: hostUntil, snoozedAt: "2026-07-20T00:00:00.000Z" },
    ]);

    await adapter.ade.sessions.list();
    await flushMicrotasks();
    const reconciled = await adapter.ade.sessions.list();

    expect(reconciled[0]!.snoozedUntil).toBe(hostUntil);
    expect(reconciled[0]!.snoozedAt).toBe("2026-07-20T00:00:00.000Z");

    adapter.dispose();
  });

  it("rolls the row back and rethrows when the host rejects a lifecycle write", async () => {
    fake.descriptors = descriptors(LIFECYCLE_DESCRIPTORS);
    fake.commandResults.set("work.listSessions", [{ id: "session-1", ptyId: "pty-1" }]);
    fake.commandErrors.set("session.snoozeSession", new Error("session is gone"));
    const adapter = createAdeWebAdapter(fake.asClient());
    adapter.bindProject(project, "project-1");
    await adapter.ade.sessions.list();

    const changes: unknown[] = [];
    adapter.ade.sessions.onChanged((event) => changes.push(event));

    await expect(
      adapter.ade.sessions.snoozeSession("session-1", new Date(Date.now() + 60 * 60 * 1000).toISOString()),
    ).rejects.toThrow("session is gone");

    // Painted, then rolled back — both need a notification or the row would sit
    // showing a snooze the machine never took.
    expect(changes).toHaveLength(2);
    const after = await adapter.ade.sessions.list();
    expect(after[0]!.snoozedUntil ?? null).toBeNull();
    expect(isSessionSnoozed(after[0]!)).toBe(false);

    adapter.dispose();
  });

  it("drops the patch when the host reports the row was not snoozed", async () => {
    fake.descriptors = descriptors(LIFECYCLE_DESCRIPTORS);
    fake.commandResults.set("work.listSessions", [{ id: "session-1", ptyId: "pty-1" }]);
    // wakeSession returns false for a row that was never snoozed.
    fake.commandResults.set("session.wakeSession", false);
    const adapter = createAdeWebAdapter(fake.asClient());
    adapter.bindProject(project, "project-1");
    await adapter.ade.sessions.list();

    await expect(adapter.ade.sessions.wakeSession("session-1", "manual")).resolves.toBe(false);

    const after = await adapter.ade.sessions.list();
    expect(after[0]!.wokeAt ?? null).toBeNull();
    expect(after[0]!.wokeReason ?? null).toBeNull();

    adapter.dispose();
  });

  // The machine actually answers these commands with an `{ ok, sessionId, … }`
  // envelope, not the bare boolean the desktop's local IPC path returns.
  // Reading the envelope as "not applied" would return false to the caller AND
  // roll the optimistic patch back on a write the machine did take.
  it("reads the host's `{ ok, … }` lifecycle envelope as the local path's boolean", async () => {
    fake.descriptors = descriptors(LIFECYCLE_DESCRIPTORS);
    fake.commandResults.set("work.listSessions", [{ id: "session-1", ptyId: "pty-1" }]);
    const untilIso = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    fake.commandResults.set("session.snoozeSession", { ok: true, sessionId: "session-1", snoozedUntil: untilIso });
    fake.commandResults.set("session.wakeSession", { ok: false, sessionId: "session-1", reason: "manual" });
    fake.commandResults.set("session.setSettleOverride", { ok: true, sessionId: "session-1", settleOverride: "active" });
    fake.commandResults.set("session.clearWokeMarker", { ok: true, sessionId: "session-1" });
    const adapter = createAdeWebAdapter(fake.asClient());
    adapter.bindProject(project, "project-1");
    await adapter.ade.sessions.list();

    await expect(adapter.ade.sessions.snoozeSession("session-1", untilIso)).resolves.toBe(true);
    // Applied, so the optimistic patch has to survive until the host row lands.
    const optimistic = await adapter.ade.sessions.list();
    expect(optimistic[0]!.snoozedUntil).toBe(untilIso);
    expect(isSessionSnoozed(optimistic[0]!)).toBe(true);

    await expect(adapter.ade.sessions.setSettleOverride("session-1", "active")).resolves.toBe(true);
    await expect(adapter.ade.sessions.clearWokeMarker("session-1")).resolves.toBe(true);
    // `ok: false` still means no-op, exactly like a bare `false`.
    await expect(adapter.ade.sessions.wakeSession("session-1", "manual")).resolves.toBe(false);

    adapter.dispose();
  });

  it("refuses lifecycle writes while the socket is down rather than silently no-op'ing", async () => {
    fake.descriptors = descriptors(LIFECYCLE_DESCRIPTORS);
    fake.commandResults.set("work.listSessions", [{ id: "session-1", ptyId: "pty-1" }]);
    const adapter = createAdeWebAdapter(fake.asClient());
    adapter.bindProject(project, "project-1");
    fake.connectionState = "reconnecting";

    await expect(adapter.ade.sessions.snoozeSession("session-1", new Date().toISOString()))
      .rejects.toThrow(SESSION_LIFECYCLE_DISCONNECTED_MESSAGE);
    await expect(adapter.ade.sessions.settle("session-1")).rejects.toThrow(SESSION_LIFECYCLE_DISCONNECTED_MESSAGE);
    expect(fake.commandCalls.filter((call) => call.action.startsWith("session."))).toEqual([]);

    adapter.dispose();
  });

  it("refuses lifecycle writes a host does not advertise", async () => {
    // An older ADE registers no `session.*` commands at all. Without the gate
    // `commands.call` would resolve to its fallback and the tap would do
    // nothing at all.
    fake.descriptors = descriptors(["work.listSessions"]);
    fake.commandResults.set("work.listSessions", [{ id: "session-1", ptyId: "pty-1" }]);
    const adapter = createAdeWebAdapter(fake.asClient());
    adapter.bindProject(project, "project-1");

    await expect(adapter.ade.sessions.snoozeSession("session-1", new Date().toISOString()))
      .rejects.toThrow(SESSION_LIFECYCLE_UNSUPPORTED_MESSAGE);
    expect(fake.commandCalls.filter((call) => call.action.startsWith("session."))).toEqual([]);

    adapter.dispose();
  });
});

const LIFECYCLE_DESCRIPTORS = [
  "work.listSessions",
  "session.settleSession",
  "session.unsettleSession",
  "session.snoozeSession",
  "session.wakeSession",
  "session.setSettleOverride",
  "session.clearWokeMarker",
];

/** Let a fire-and-forget background reconcile settle before asserting. */
async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function descriptors(actions: string[]): SyncRemoteCommandDescriptor[] {
  return actions.map((action) => ({
    action,
    scope: "project",
    policy: { viewerAllowed: true },
  }));
}

function fileBlob(content: string): SyncFileBlob {
  return {
    path: "",
    size: content.length,
    mimeType: "application/json",
    encoding: "utf-8",
    isBinary: false,
    content,
  };
}

type CommandCall = {
  action: string;
  args: Record<string, unknown>;
  opts: { projectId?: string | null; timeoutMs?: number };
};

type TerminalHistoryCall = {
  sessionId: string;
  beforeOffset: number;
  maxBytes?: number;
};

class FakeAdeSyncClient {
  descriptors: SyncRemoteCommandDescriptor[] = [];
  commandResults = new Map<string, unknown>();
  commandErrors = new Map<string, Error>();
  // The real sync client resolves requestFile() with the host's structured
  // `result` — a SyncFileBlob only for readFile/readArtifact, but an array/object
  // for listWorkspaces/listTree/etc. Model that faithfully (unknown), not "always
  // a blob", so adapter mis-parsing is caught.
  fileResults = new Map<string, unknown>();
  fileErrors = new Map<string, Error>();
  commandCalls: CommandCall[] = [];
  disconnectCalls = 0;
  accountPairCalls: Array<Record<string, unknown>> = [];
  hostDeviceId = "host-1";
  fileCalls: Array<{ action: string; args: Record<string, unknown>; opts: { projectId?: string | null; timeoutMs?: number } }> = [];
  terminalInputs: Array<{ sessionId: string; data: string }> = [];
  terminalResizes: Array<{ sessionId: string; cols: number; rows: number }> = [];
  terminalSubscribeCalls: Array<{ sessionId: string; opts: { maxBytes?: number } }> = [];
  chatSubscribeCalls: Array<{ sessionId: string; opts: Record<string, unknown> }> = [];
  chatUnsubscribeCalls: string[] = [];
  terminalUnsubscribeCalls: string[] = [];
  terminalHistoryCalls: TerminalHistoryCall[] = [];
  terminalHistoryResults = new Map<string, SyncTerminalHistoryResponsePayload>();
  terminalHistoryErrors = new Map<string, Error>();
  projects: SyncMobileProjectSummary[] = [
    {
      id: "project-1",
      displayName: "Repo",
      rootPath: "/repo",
      defaultBaseRef: "main",
      lastOpenedAt: "2026-07-07T00:00:00.000Z",
      iconDataUrl: null,
      laneCount: 1,
      isAvailable: true,
      isCached: true,
      isOpen: true,
    },
  ];
  activeProjectId: string | null = "project-1";
  projectSwitchResult: unknown = null;
  /** Transport state, so tests can exercise "the socket is down" paths. */
  connectionState: "connected" | "reconnecting" | "disconnected" = "connected";

  private readonly tableListeners = new Set<(tables: Set<string>) => void>();
  private readonly chatListeners = new Set<(payload: SyncChatEventPayload) => void>();
  private readonly catalogListeners = new Set<(payload: { projects: SyncMobileProjectSummary[] }) => void>();
  private readonly brainListeners = new Set<(payload: never) => void>();
  private readonly statusListeners = new Set<(payload: ReturnType<FakeAdeSyncClient["getStatus"]>) => void>();
  private readonly chatHandlers = new Map<string, ChatHandlers>();
  private readonly terminalHandlers = new Map<string, TerminalHandlers>();

  asClient(): AdeSyncClient {
    return this as never as AdeSyncClient;
  }

  getStatus() {
    return {
      state: this.connectionState,
      endpoint: "ws://localhost:8787",
      envId: "env-1",
      hostDeviceId: this.hostDeviceId,
      hostName: "Host",
      connectedAt: "2026-07-07T00:00:00.000Z",
      lastSeenAt: "2026-07-07T00:00:00.000Z",
      error: null,
      activeProjectId: this.activeProjectId,
      selectedEnvId: "env-1",
    };
  }

  subscribe(listener: (payload: ReturnType<FakeAdeSyncClient["getStatus"]>) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  async pairWithAccountMachine(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.accountPairCalls.push(args);
    const machine = args.machine as { deviceId?: string } | undefined;
    if (machine?.deviceId) this.hostDeviceId = machine.deviceId;
    return { envId: "account-env", activeProjectId: null };
  }

  emitStatus(): void {
    const status = this.getStatus();
    for (const listener of this.statusListeners) listener(status);
  }

  getCommandDescriptors(): SyncRemoteCommandDescriptor[] {
    return this.descriptors;
  }

  async sendCommand(action: string, args: Record<string, unknown>, opts: { projectId?: string | null; timeoutMs?: number } = {}): Promise<unknown> {
    this.commandCalls.push({ action, args, opts });
    const error = this.commandErrors.get(action);
    if (error) throw error;
    return this.commandResults.has(action) ? this.commandResults.get(action) : null;
  }

  disconnect(): void {
    this.disconnectCalls += 1;
  }

  async requestFile(action: string, args: Record<string, unknown>, opts: { projectId?: string | null; timeoutMs?: number } = {}): Promise<unknown> {
    this.fileCalls.push({ action, args, opts });
    const error = this.fileErrors.get(action);
    if (error) throw error;
    return this.fileResults.has(action) ? this.fileResults.get(action) : null;
  }

  subscribeChat(sessionId: string, opts: unknown, handlers: ChatHandlers): () => void {
    this.chatSubscribeCalls.push({
      sessionId,
      opts: opts && typeof opts === "object" ? { ...(opts as Record<string, unknown>) } : {},
    });
    this.chatHandlers.set(sessionId, handlers);
    return () => {
      this.chatUnsubscribeCalls.push(sessionId);
      if (this.chatHandlers.get(sessionId) === handlers) this.chatHandlers.delete(sessionId);
    };
  }

  subscribeTerminal(sessionId: string, opts: unknown, handlers: TerminalHandlers): () => void {
    const normalizedOpts = opts && typeof opts === "object" ? { ...(opts as { maxBytes?: number }) } : {};
    this.terminalSubscribeCalls.push({ sessionId, opts: normalizedOpts });
    this.terminalHandlers.set(sessionId, handlers);
    return () => {
      this.terminalUnsubscribeCalls.push(sessionId);
      if (this.terminalHandlers.get(sessionId) === handlers) this.terminalHandlers.delete(sessionId);
    };
  }

  sendTerminalInput(sessionId: string, data: string): void {
    this.terminalInputs.push({ sessionId, data });
  }

  sendTerminalResize(sessionId: string, cols: number, rows: number): void {
    this.terminalResizes.push({ sessionId, cols, rows });
  }

  async requestTerminalHistory(args: { sessionId: string; beforeOffset: number; maxBytes?: number }): Promise<{ sessionId: string; data: string; startOffset: number; endOffset: number; atStart: boolean }> {
    this.terminalHistoryCalls.push(args);
    const error = this.terminalHistoryErrors.get(args.sessionId);
    if (error) throw error;
    const result = this.terminalHistoryResults.get(args.sessionId);
    if (result) return result;
    return {
      sessionId: args.sessionId,
      data: "",
      startOffset: 0,
      endOffset: 0,
      atStart: true,
    };
  }

  async getProjectCatalog(): Promise<{ projects: SyncMobileProjectSummary[] }> {
    return { projects: this.projects };
  }

  async switchProject(projectId: string): Promise<unknown> {
    if (this.projectSwitchResult) return this.projectSwitchResult;
    const project = this.projects.find((entry) => entry.id === projectId);
    return { ok: Boolean(project), project };
  }

  onBrainStatus(listener: (payload: never) => void): () => void {
    this.brainListeners.add(listener);
    return () => this.brainListeners.delete(listener);
  }

  onTablesChanged(listener: (tables: Set<string>) => void): () => void {
    this.tableListeners.add(listener);
    return () => this.tableListeners.delete(listener);
  }

  onChatEvent(listener: (payload: SyncChatEventPayload) => void): () => void {
    this.chatListeners.add(listener);
    return () => this.chatListeners.delete(listener);
  }

  onProjectCatalog(listener: (payload: { projects: SyncMobileProjectSummary[] }) => void): () => void {
    this.catalogListeners.add(listener);
    return () => this.catalogListeners.delete(listener);
  }

  emitTables(tables: string[]): void {
    const payload = new Set(tables);
    for (const listener of this.tableListeners) listener(payload);
  }

  emitChat(payload: SyncChatEventPayload): void {
    for (const listener of this.chatListeners) listener(payload);
    this.chatHandlers.get(payload.sessionId)?.event?.(payload);
  }

  emitChatSnapshot(sessionId: string, payload: SyncChatSubscribeSnapshotPayload): void {
    this.chatHandlers.get(sessionId)?.snapshot?.(payload);
  }

  emitTerminalData(sessionId: string, payload: SyncTerminalDataPayload): void {
    this.terminalHandlers.get(sessionId)?.data?.(payload);
  }

  emitTerminalSnapshot(sessionId: string, payload: SyncTerminalSnapshotPayload): void {
    this.terminalHandlers.get(sessionId)?.snapshot?.(payload);
  }
}
