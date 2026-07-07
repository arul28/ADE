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
  });

  it("boots before and after a bound project", async () => {
    const adapter = createAdeWebAdapter(fake.asClient());

    await expect(adapter.ade.app.getProject()).resolves.toBeNull();
    await expect(adapter.ade.app.getWindowSession()).resolves.toMatchObject({
      windowId: null,
      project: null,
      binding: null,
    });

    adapter.bindProject(project);

    await expect(adapter.ade.app.getProject()).resolves.toEqual(project);
    await expect(adapter.ade.app.getWindowSession()).resolves.toMatchObject({
      windowId: null,
      project,
      binding: null,
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
    adapter.bindProject(project);

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
    adapter.bindProject(project);

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
    adapter.bindProject(project);

    await expect(adapter.ade.files.listWorkspaces()).resolves.toEqual(workspaces);
    await expect(adapter.ade.files.listTree({ workspaceId: "ws-1" } as never)).resolves.toEqual(tree);
    // A host that has no data for the action still yields the typed fallback.
    await expect(adapter.ade.files.searchText({ workspaceId: "ws-1", query: "x" } as never)).resolves.toEqual([]);

    adapter.dispose();
  });

  it("fans out table, chat, and terminal events and unsubscribes listeners", async () => {
    vi.useFakeTimers();
    fake.descriptors = descriptors(["work.listSessions"]);
    fake.commandResults.set("work.listSessions", [{ id: "session-1", ptyId: "pty-1" }]);
    const adapter = createAdeWebAdapter(fake.asClient());
    adapter.bindProject(project);

    const laneEvents: unknown[] = [];
    const sessionEvents: unknown[] = [];
    adapter.ade.lanes.onLifecycleEvent((event) => laneEvents.push(event));
    adapter.ade.sessions.onChanged((event) => sessionEvents.push(event));

    fake.emitTables(["lanes"]);
    await vi.advanceTimersByTimeAsync(260);

    expect(laneEvents).toHaveLength(1);
    expect(sessionEvents).toHaveLength(1);

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
    adapter.bindProject(project);

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
    adapter.bindProject(project);

    await adapter.ade.sessions.list();
    await adapter.ade.pty.write({ ptyId: "pty-1", data: "echo ok\n" });

    expect(fake.terminalInputs).toEqual([{ sessionId: "session-1", data: "echo ok\n" }]);
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
  // The real sync client resolves requestFile() with the host's structured
  // `result` — a SyncFileBlob only for readFile/readArtifact, but an array/object
  // for listWorkspaces/listTree/etc. Model that faithfully (unknown), not "always
  // a blob", so adapter mis-parsing is caught.
  fileResults = new Map<string, unknown>();
  commandCalls: CommandCall[] = [];
  fileCalls: Array<{ action: string; args: Record<string, unknown>; opts: { projectId?: string | null; timeoutMs?: number } }> = [];
  terminalInputs: Array<{ sessionId: string; data: string }> = [];
  terminalResizes: Array<{ sessionId: string; cols: number; rows: number }> = [];
  terminalSubscribeCalls: Array<{ sessionId: string; opts: { maxBytes?: number } }> = [];
  terminalUnsubscribeCalls: string[] = [];
  terminalHistoryCalls: TerminalHistoryCall[] = [];
  terminalHistoryResults = new Map<string, SyncTerminalHistoryResponsePayload>();
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
      activeProjectId: "project-1",
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
    return this.commandResults.has(action) ? this.commandResults.get(action) : null;
  }

  async requestFile(action: string, args: Record<string, unknown>, opts: { projectId?: string | null; timeoutMs?: number } = {}): Promise<unknown> {
    this.fileCalls.push({ action, args, opts });
    return this.fileResults.has(action) ? this.fileResults.get(action) : null;
  }

  subscribeChat(sessionId: string, _opts: unknown, handlers: ChatHandlers): () => void {
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
