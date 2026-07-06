import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalSessionSummary } from "../../../shared/types/sessions";
import { createSearchService, type SearchService } from "./searchService";

const NOW = new Date("2026-07-06T12:00:00.000Z");

function makeSession(overrides: Partial<TerminalSessionSummary> & { id: string }): TerminalSessionSummary {
  return {
    laneId: "lane-1",
    laneName: "universal-search",
    ptyId: null,
    tracked: true,
    pinned: false,
    goal: null,
    toolType: "claude-chat",
    title: "Untitled chat",
    status: "running",
    startedAt: "2026-07-01T00:00:00.000Z",
    endedAt: null,
    exitCode: null,
    transcriptPath: "",
    headShaStart: null,
    headShaEnd: null,
    lastOutputPreview: null,
    lastActivityAt: "2026-07-05T00:00:00.000Z",
    summary: null,
    runtimeState: "idle",
    resumeCommand: null,
    ...overrides
  } as TerminalSessionSummary;
}

describe("searchService", () => {
  let root: string;
  let service: SearchService;
  let sessions: TerminalSessionSummary[];

  const writeChatLine = (sessionId: string, event: Record<string, unknown>, timestamp: string) => {
    const dir = path.join(root, "transcripts", "chat");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, `${sessionId}.jsonl`),
      `${JSON.stringify({ sessionId, timestamp, event })}\n`
    );
  };

  const writeTerminalOutput = (sessionId: string, text: string) => {
    const dir = path.join(root, "transcripts");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `${sessionId}.log`), text);
  };

  const createService = () =>
    createSearchService({
      cacheDir: path.join(root, "cache"),
      transcriptsDir: path.join(root, "transcripts"),
      chatTranscriptsDir: path.join(root, "transcripts", "chat"),
      sessions: {
        list: async () => sessions,
        get: async (id) => sessions.find((s) => s.id === id) ?? null
      },
      lanes: {
        list: async () => [
          {
            id: "lane-1",
            name: "universal-search",
            description: "Search palette work",
            laneType: "workspace",
            baseRef: "main",
            branchRef: "ade/universal-search",
            worktreePath: "/tmp/x",
            parentLaneId: null,
            childCount: 0,
            stackDepth: 0,
            parentStatus: null,
            isEditProtected: false,
            status: { dirty: false, ahead: 0, behind: 0 },
            color: null,
            icon: null,
            tags: [],
            createdAt: "2026-07-01T00:00:00.000Z"
          } as never
        ]
      },
      now: () => NOW
    });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-search-test-"));
    sessions = [];
    service = createService();
  });

  afterEach(() => {
    service.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("indexes appended chat messages and finds them immediately after processing", async () => {
    const session = makeSession({ id: "chat-1", title: "Fix login flow" });
    sessions.push(session);
    writeChatLine(
      "chat-1",
      { type: "user_message", text: "please investigate the flaky retry logic" },
      "2026-07-05T10:00:00.000Z"
    );
    service.notifyChatEvent("chat-1");
    await service.processPendingNow();

    const result = await service.query({ query: "flaky retry" });
    expect(result.results.length).toBeGreaterThan(0);
    const hit = result.results.find((item) => item.kind === "chat" && item.id.includes(":0"));
    expect(hit).toBeTruthy();
    expect(hit!.sessionId).toBe("chat-1");
    expect(hit!.snippet.toLowerCase()).toContain("flaky");
    expect(hit!.matchRanges.length).toBeGreaterThan(0);
    expect(hit!.deepLink).toContain("event=0");
  });

  it("indexes only new lines on subsequent appends (incremental cursor)", async () => {
    sessions.push(makeSession({ id: "chat-2", title: "Chat two" }));
    writeChatLine("chat-2", { type: "user_message", text: "first message alpha" }, "2026-07-05T10:00:00.000Z");
    service.notifyChatEvent("chat-2");
    await service.processPendingNow();

    writeChatLine("chat-2", { type: "text", text: "second message bravo" }, "2026-07-05T11:00:00.000Z");
    service.notifyChatEvent("chat-2");
    await service.processPendingNow();

    const alpha = await service.query({ query: "alpha kind:chat" });
    const bravo = await service.query({ query: "bravo kind:chat" });
    expect(alpha.results.some((r) => r.id === "chat:chat-2:0")).toBe(true);
    expect(bravo.results.some((r) => r.id === "chat:chat-2:1")).toBe(true);
    // No duplicate docs for the first message.
    expect(alpha.results.filter((r) => r.id.startsWith("chat:chat-2:")).length).toBe(1);
  });

  it("indexes ANSI-stripped terminal scrollback with offset deep links", async () => {
    sessions.push(
      makeSession({
        id: "term-1",
        title: "npm test",
        toolType: "shell",
        status: "completed",
        endedAt: "2026-07-05T12:00:00.000Z"
      })
    );
    writeTerminalOutput("term-1", "[32mall checks passed[0m\nsegmentation fault in worker\n");
    service.notifyTerminalData("term-1");
    await service.processPendingNow();

    const result = await service.query({ query: "segmentation fault" });
    const hit = result.results.find((item) => item.kind === "terminal");
    expect(hit).toBeTruthy();
    expect(hit!.snippet).not.toContain("");
    expect(hit!.deepLink).toContain("offset=0");
  });

  it("removes all docs when a session is deleted", async () => {
    sessions.push(makeSession({ id: "chat-3", title: "Doomed chat" }));
    writeChatLine("chat-3", { type: "user_message", text: "ephemeral zanzibar content" }, "2026-07-05T10:00:00.000Z");
    service.notifyChatEvent("chat-3");
    await service.processPendingNow();
    expect((await service.query({ query: "zanzibar" })).results.length).toBeGreaterThan(0);

    service.notifySessionChanged("chat-3", "deleted");
    const after = await service.query({ query: "zanzibar" });
    expect(after.results.length).toBe(0);
  });

  it("ranks exact title above prefix above substring above body", async () => {
    sessions.push(
      makeSession({ id: "s-exact", title: "deploy pipeline", lastActivityAt: "2026-01-01T00:00:00.000Z" }),
      makeSession({ id: "s-prefix", title: "deploy pipeline to prod", lastActivityAt: "2026-07-05T00:00:00.000Z" }),
      makeSession({ id: "s-substr", title: "the deploy pipeline saga", lastActivityAt: "2026-07-05T00:00:00.000Z" }),
      makeSession({ id: "s-body", title: "unrelated", lastActivityAt: "2026-07-05T00:00:00.000Z" })
    );
    for (const id of ["s-exact", "s-prefix", "s-substr"]) {
      writeChatLine(id, { type: "user_message", text: "hello there" }, "2026-07-04T00:00:00.000Z");
      service.notifyChatEvent(id);
    }
    writeChatLine("s-body", { type: "user_message", text: "the deploy pipeline broke" }, "2026-07-04T00:00:00.000Z");
    service.notifyChatEvent("s-body");
    await service.processPendingNow();

    const result = await service.query({ query: "deploy pipeline", kinds: ["chat"] });
    const metaOrder = result.results
      .filter((item) => item.id.endsWith(":meta"))
      .map((item) => item.sessionId);
    expect(metaOrder).toEqual(["s-exact", "s-prefix", "s-substr"]);
    // Body match ranks after all title-tier matches.
    const bodyIdx = result.results.findIndex((item) => item.sessionId === "s-body");
    const lastMetaIdx = result.results.findIndex((item) => item.sessionId === "s-substr");
    expect(bodyIdx).toBeGreaterThan(lastMetaIdx);
  });

  it("is deterministic: same query twice returns identical results", async () => {
    sessions.push(makeSession({ id: "chat-4", title: "Determinism" }));
    for (let i = 0; i < 20; i++) {
      writeChatLine("chat-4", { type: "text", text: `message number ${i} about caching` }, "2026-07-05T10:00:00.000Z");
    }
    service.notifyChatEvent("chat-4");
    await service.processPendingNow();

    const a = await service.query({ query: "caching" });
    const b = await service.query({ query: "caching" });
    expect(a).toEqual(b);
  });

  it("filters by kind:, lane:, and since:", async () => {
    sessions.push(
      makeSession({ id: "chat-5", title: "Old chat", lastActivityAt: "2026-05-01T00:00:00.000Z" }),
      makeSession({
        id: "term-5",
        title: "Recent terminal",
        toolType: "shell",
        laneId: "lane-1",
        lastActivityAt: "2026-07-05T00:00:00.000Z",
        status: "completed",
        endedAt: "2026-07-05T00:00:00.000Z"
      })
    );
    writeChatLine("chat-5", { type: "user_message", text: "needle in the haystack" }, "2026-05-01T00:00:00.000Z");
    writeTerminalOutput("term-5", "needle in the terminal\n");
    service.notifyChatEvent("chat-5");
    service.notifyTerminalData("term-5");
    await service.processPendingNow();

    const chatOnly = await service.query({ query: "needle kind:chat" });
    expect(chatOnly.results.every((item) => item.kind === "chat")).toBe(true);
    expect(chatOnly.results.length).toBeGreaterThan(0);

    const recent = await service.query({ query: "needle since:30d" });
    expect(recent.results.every((item) => item.updatedAt >= "2026-06-06")).toBe(true);
    expect(recent.results.some((item) => item.kind === "terminal")).toBe(true);
    expect(recent.results.some((item) => item.kind === "chat")).toBe(false);
  });

  it("paginates with a stable cursor", async () => {
    sessions.push(makeSession({ id: "chat-6", title: "Pagination" }));
    for (let i = 0; i < 12; i++) {
      writeChatLine("chat-6", { type: "text", text: `pagination fixture item ${i}` }, `2026-07-05T10:${String(i).padStart(2, "0")}:00.000Z`);
    }
    service.notifyChatEvent("chat-6");
    await service.processPendingNow();

    const page1 = await service.query({ query: "pagination fixture", limit: 5 });
    expect(page1.results.length).toBe(5);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = await service.query({ query: "pagination fixture", limit: 5, cursor: page1.nextCursor! });
    expect(page2.results.length).toBe(5);
    const ids1 = new Set(page1.results.map((r) => r.id));
    expect(page2.results.every((r) => !ids1.has(r.id))).toBe(true);
  });

  it("delegates lane results at query time", async () => {
    const result = await service.query({ query: "universal" });
    const lane = result.results.find((item) => item.kind === "lane");
    expect(lane).toBeTruthy();
    expect(lane!.title).toBe("universal-search");
    expect(lane!.deepLink).toContain("lane");
  });

  it("rebuilds the index from scratch", async () => {
    sessions.push(makeSession({ id: "chat-7", title: "Rebuild me" }));
    writeChatLine("chat-7", { type: "user_message", text: "xylophone contents" }, "2026-07-05T10:00:00.000Z");
    service.notifyChatEvent("chat-7");
    await service.processPendingNow();
    expect((await service.query({ query: "xylophone" })).results.length).toBeGreaterThan(0);

    const rebuild = service.rebuildIndex();
    expect(rebuild.started).toBe(true);
    await service.processPendingNow();
    // Give the async backfill kickoff a tick to enqueue.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await service.processPendingNow();
    expect((await service.query({ query: "xylophone" })).results.length).toBeGreaterThan(0);
  });

  it("reports index status", async () => {
    sessions.push(makeSession({ id: "chat-8", title: "Status" }));
    writeChatLine("chat-8", { type: "user_message", text: "status check" }, "2026-07-05T10:00:00.000Z");
    service.notifyChatEvent("chat-8");
    await service.processPendingNow();

    const status = service.indexStatus();
    expect(status.ready).toBe(true);
    expect(status.docCount).toBeGreaterThan(0);
    expect(status.docCountByKind.chat).toBeGreaterThan(0);
    expect(status.indexPath).toContain("search-index.db");
  });
});

describe("searchService classification and lane-git dedup", () => {
  let root: string;
  let sessions: TerminalSessionSummary[];

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-search-test2-"));
    sessions = [];
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const writeChatLine = (sessionId: string, event: Record<string, unknown>, timestamp: string) => {
    const dir = path.join(root, "transcripts", "chat");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, `${sessionId}.jsonl`),
      `${JSON.stringify({ sessionId, timestamp, event })}\n`
    );
  };

  it("indexes cursor-chat sessions (toolType 'cursor') as chat", async () => {
    const service = createSearchService({
      cacheDir: path.join(root, "cache"),
      transcriptsDir: path.join(root, "transcripts"),
      chatTranscriptsDir: path.join(root, "transcripts", "chat"),
      sessions: {
        list: async () => sessions,
        get: async (id) => sessions.find((s) => s.id === id) ?? null
      },
      now: () => NOW
    });
    sessions.push(makeSession({ id: "cursor-1", title: "Cursor chat", toolType: "cursor" }));
    writeChatLine("cursor-1", { type: "user_message", text: "cursor quimby message" }, "2026-07-05T10:00:00.000Z");
    service.notifyChatEvent("cursor-1");
    await service.processPendingNow();

    const result = await service.query({ query: "quimby" });
    expect(result.results.some((item) => item.kind === "chat" && item.sessionId === "cursor-1")).toBe(true);
    service.dispose();
  });

  it("indexes branches only from the primary lane", async () => {
    const lanes = [
      {
        id: "lane-primary",
        name: "main",
        laneType: "primary",
        baseRef: "main",
        branchRef: "main",
        worktreePath: "/tmp/a",
        parentLaneId: null,
        childCount: 0,
        stackDepth: 0,
        parentStatus: null,
        isEditProtected: false,
        status: { dirty: false, ahead: 0, behind: 0 },
        color: null,
        icon: null,
        tags: [],
        createdAt: "2026-07-01T00:00:00.000Z"
      },
      {
        id: "lane-work",
        name: "feature",
        laneType: "worktree",
        baseRef: "main",
        branchRef: "ade/feature",
        worktreePath: "/tmp/b",
        parentLaneId: null,
        childCount: 0,
        stackDepth: 0,
        parentStatus: null,
        isEditProtected: false,
        status: { dirty: false, ahead: 0, behind: 0 },
        color: null,
        icon: null,
        tags: [],
        createdAt: "2026-07-01T00:00:00.000Z"
      }
    ] as never[];
    const listBranches = vi.fn().mockResolvedValue([
      { name: "main", isCurrent: true, isRemote: false, upstream: null },
      { name: "ade/feature", isCurrent: false, isRemote: false, upstream: null }
    ]);
    const service = createSearchService({
      cacheDir: path.join(root, "cache"),
      transcriptsDir: path.join(root, "transcripts"),
      chatTranscriptsDir: path.join(root, "transcripts", "chat"),
      sessions: { list: async () => [] },
      lanes: { list: async () => lanes as never },
      git: {
        listRecentCommits: async () => [],
        listBranches
      },
      now: () => NOW
    });

    service.notifyLaneActivity("lane-primary");
    service.notifyLaneActivity("lane-work");
    await service.processPendingNow();

    expect(listBranches).toHaveBeenCalledTimes(1);
    expect(listBranches).toHaveBeenCalledWith({ laneId: "lane-primary" });
    const result = await service.query({ query: "kind:branch feature" });
    const branchIds = result.results.map((item) => item.id);
    expect(branchIds).toEqual(["branch:lane-primary:ade/feature"]);
    service.dispose();
  });
});
