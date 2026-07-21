import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectInfo } from "../../../../shared/types";
import type {
  SyncChatEventPayload,
  SyncFileBlob,
  SyncTerminalHistoryResponsePayload,
  SyncMobileProjectSummary,
  SyncRemoteCommandDescriptor,
  SyncTerminalDataPayload,
  SyncTerminalSnapshotPayload,
} from "../../../../shared/types/sync";
import { createAdeWebAdapter } from "../index";
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
    const accountClient = {
      getSnapshot: () => snapshot,
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
      "pairMachine",
      "pollLogin",
      "removeMachine",
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

    expect(fake.terminalSubscribeCalls).toEqual([{ sessionId: "session-1", opts: { maxBytes: 1024 } }]);
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
    expect(ptyData).toEqual([]);

    await expect(adapter.ade.terminal.preview({ terminalId: "session-1", maxBytes: 4096 })).resolves.toMatchObject({
      terminalId: "session-1",
      transcript: "scrollback\n",
      source: "transcript",
    });
    expect(ptyData).toEqual([]);

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
      offset: 16,
    });
    expect(ptyData).toEqual([
      {
        ptyId: "pty-1",
        sessionId: "session-1",
        data: "live\n",
        offset: 16,
      },
    ]);

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
});

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
  fileCalls: Array<{ action: string; args: Record<string, unknown>; opts: { projectId?: string | null; timeoutMs?: number } }> = [];
  terminalInputs: Array<{ sessionId: string; data: string }> = [];
  terminalResizes: Array<{ sessionId: string; cols: number; rows: number }> = [];
  terminalSubscribeCalls: Array<{ sessionId: string; opts: { maxBytes?: number } }> = [];
  chatSubscribeCalls: Array<{ sessionId: string; opts: Record<string, unknown> }> = [];
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
      state: "connected" as const,
      endpoint: "ws://localhost:8787",
      envId: "env-1",
      hostDeviceId: "host-1",
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
    return () => this.chatHandlers.delete(sessionId);
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

  emitTerminalData(sessionId: string, payload: SyncTerminalDataPayload): void {
    this.terminalHandlers.get(sessionId)?.data?.(payload);
  }

  emitTerminalSnapshot(sessionId: string, payload: SyncTerminalSnapshotPayload): void {
    this.terminalHandlers.get(sessionId)?.snapshot?.(payload);
  }
}
