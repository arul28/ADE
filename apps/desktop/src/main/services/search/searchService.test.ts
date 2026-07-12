import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalSessionSummary } from "../../../shared/types/sessions";
import { createSearchService, type SearchService } from "./searchService";
import { parseSearchQuery } from "./searchQueryParser";
import {
  RANK_TIER_BODY,
  RANK_TIER_TITLE_EXACT,
  RANK_TIER_TITLE_PREFIX,
  RANK_TIER_TITLE_SUBSTRING,
  extractSnippetRanges,
  rankCandidates,
  titleRankTier
} from "./searchRanking";
import { chunkTerminalTranscript, sanitizeIndexedText } from "./terminalChunking";

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

  const writeChatLine = (sessionId: string, event: Record<string, unknown>, timestamp: string, sequence?: number) => {
    const dir = path.join(root, "transcripts", "chat");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, `${sessionId}.jsonl`),
      `${JSON.stringify({ sessionId, timestamp, event, ...(sequence != null ? { sequence } : {}) })}\n`
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

  it("rebuilds searchable chat and terminal history from compressed transcripts", async () => {
    const chat = makeSession({ id: "chat-gz", title: "Compressed chat" });
    const terminalPath = path.join(root, "transcripts", "terminal-gz.log");
    const terminal = makeSession({
      id: "terminal-gz",
      title: "Compressed terminal",
      toolType: "shell",
      status: "completed",
      transcriptPath: terminalPath,
    });
    sessions.push(chat, terminal);
    writeChatLine(
      chat.id,
      { type: "user_message", text: "compressed quasar chat" },
      "2026-07-05T10:00:00.000Z",
    );
    writeTerminalOutput(terminal.id, "compressed nebula terminal\n");
    const chatPath = path.join(root, "transcripts", "chat", `${chat.id}.jsonl`);
    fs.writeFileSync(`${chatPath}.gz`, gzipSync(fs.readFileSync(chatPath)));
    fs.unlinkSync(chatPath);
    fs.writeFileSync(`${terminalPath}.gz`, gzipSync(fs.readFileSync(terminalPath)));
    fs.unlinkSync(terminalPath);

    service.notifyChatEvent(chat.id);
    service.notifyTerminalData(terminal.id);
    await service.processPendingNow();

    expect((await service.query({ query: "quasar" })).results.some((result) => result.kind === "chat")).toBe(true);
    expect((await service.query({ query: "nebula" })).results.some((result) => result.kind === "terminal")).toBe(true);
  });

  it("uses persisted chat envelope sequence for deep link anchors", async () => {
    const session = makeSession({ id: "chat-sequence", title: "Sequence links" });
    sessions.push(session);
    writeChatLine(
      "chat-sequence",
      { type: "user_message", text: "please inspect the anchored sequence" },
      "2026-07-05T10:00:00.000Z",
      41
    );
    service.notifyChatEvent("chat-sequence");
    await service.processPendingNow();

    const result = await service.query({ query: "anchored sequence" });
    const hit = result.results.find((item) => item.kind === "chat" && item.sessionId === "chat-sequence");
    expect(hit).toBeTruthy();
    expect(hit!.id).toBe("chat:chat-sequence:0");
    expect(hit!.deepLink).toContain("event=41");
  });

  it("adds repo envelope params to session deep links when repoSlug is available", async () => {
    service.dispose();
    service = createSearchService({
      cacheDir: path.join(root, "cache"),
      transcriptsDir: path.join(root, "transcripts"),
      chatTranscriptsDir: path.join(root, "transcripts", "chat"),
      repoSlug: async () => ({ owner: "owner", name: "repo" }),
      sessions: {
        list: async () => sessions,
        get: async (id) => sessions.find((s) => s.id === id) ?? null
      },
      lanes: {
        list: async () => [
          {
            id: "lane-1",
            name: "universal-search",
            laneType: "workspace",
            branchRef: "refs/heads/ade/universal-search"
          } as never
        ]
      },
      now: () => NOW
    });
    sessions.push(makeSession({ id: "chat-repo", title: "Repo chat" }));
    writeChatLine("chat-repo", { type: "user_message", text: "portable envelope message" }, "2026-07-05T10:00:00.000Z");
    service.notifyChatEvent("chat-repo");
    await service.processPendingNow();

    const hit = (await service.query({ query: "portable envelope" })).results.find((item) => item.kind === "chat");
    expect(hit?.deepLink).toContain("repo=owner%2Frepo");
    expect(hit?.deepLink).toContain("branch=ade%2Funiversal-search");

    // Delegated lane results carry the same portable envelope.
    const laneHit = (await service.query({ query: "universal-search kind:lane" })).results.find(
      (item) => item.kind === "lane"
    );
    expect(laneHit).toBeTruthy();
    expect(laneHit!.deepLink).toContain("ade://lane/lane-1");
    expect(laneHit!.deepLink).toContain("repo=owner%2Frepo");
    expect(laneHit!.deepLink).toContain("branch=ade%2Funiversal-search");
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

  it("emits canonical commit deep links", async () => {
    const lanes = [
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
    const service = createSearchService({
      cacheDir: path.join(root, "cache"),
      transcriptsDir: path.join(root, "transcripts"),
      chatTranscriptsDir: path.join(root, "transcripts", "chat"),
      repoSlug: async () => ({ owner: "owner", name: "repo" }),
      sessions: { list: async () => [] },
      lanes: { list: async () => lanes as never },
      git: {
        listRecentCommits: async () => [
          {
            sha: "abc123456789",
            shortSha: "abc1234",
            subject: "Wire canonical commits",
            authorName: "Ada",
            authoredAt: "2026-07-05T00:00:00.000Z"
          } as never
        ],
        listBranches: async () => []
      },
      now: () => NOW
    });

    service.notifyLaneActivity("lane-work");
    await service.processPendingNow();
    const commit = (await service.query({ query: "canonical commits kind:commit" })).results[0];
    expect(commit?.deepLink).toMatch(/^ade:\/\/commit\//);
    expect(commit?.deepLink).toContain("repo=owner%2Frepo");
    service.dispose();
  });

  it("emits canonical artifact deep links", async () => {
    const service = createSearchService({
      cacheDir: path.join(root, "cache"),
      transcriptsDir: path.join(root, "transcripts"),
      chatTranscriptsDir: path.join(root, "transcripts", "chat"),
      sessions: { list: async () => [] },
      artifacts: {
        list: () => [{
          id: "artifact-123",
          title: "Proof artifact",
          description: "screenshot evidence",
          createdAt: "2026-07-05T00:00:00.000Z"
        }]
      },
      now: () => NOW
    });

    const artifact = (await service.query({ query: "screenshot kind:artifact" })).results[0];
    expect(artifact?.deepLink).toMatch(/^ade:\/\/artifact\//);
    service.dispose();
  });
});

describe("searchService caller scoping", () => {
  let root: string;
  let sessions: TerminalSessionSummary[];

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-search-test3-"));
    sessions = [];
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("limits chat/terminal results to the caller's own session while keeping other kinds", async () => {
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
    const chatDir = path.join(root, "transcripts", "chat");
    fs.mkdirSync(chatDir, { recursive: true });
    for (const id of ["mine", "theirs"]) {
      sessions.push(makeSession({ id, title: `Chat ${id}` }));
      fs.appendFileSync(
        path.join(chatDir, `${id}.jsonl`),
        `${JSON.stringify({ sessionId: id, timestamp: "2026-07-05T10:00:00.000Z", event: { type: "user_message", text: `confidential payload ${id}` } })}\n`
      );
      service.notifyChatEvent(id);
    }
    await service.processPendingNow();

    const unscoped = await service.query({ query: "confidential payload" });
    expect(new Set(unscoped.results.map((r) => r.sessionId))).toEqual(new Set(["mine", "theirs"]));

    const scoped = await service.query({
      query: "confidential payload",
      callerScope: { chatSessionId: "mine" }
    });
    expect(scoped.results.length).toBeGreaterThan(0);
    expect(scoped.results.every((r) => r.sessionId === "mine")).toBe(true);
    // totals must not leak the other session either
    expect(scoped.totalByKind.chat).toBeLessThan(unscoped.totalByKind.chat ?? 0);
    service.dispose();
  });
});

describe("searchService title-tier candidate union", () => {
  it("keeps an exact-title match on top even when body matches saturate the bm25 candidate window", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-search-test4-"));
    const sessions: TerminalSessionSummary[] = [];
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
    const chatDir = path.join(root, "transcripts", "chat");
    fs.mkdirSync(chatDir, { recursive: true });

    // One session whose TITLE is the query...
    sessions.push(makeSession({ id: "titled", title: "quorum", lastActivityAt: "2026-01-01T00:00:00.000Z" }));
    fs.appendFileSync(
      path.join(chatDir, "titled.jsonl"),
      `${JSON.stringify({ sessionId: "titled", timestamp: "2026-01-01T00:00:00.000Z", event: { type: "user_message", text: "unrelated hello" } })}\n`
    );
    service.notifyChatEvent("titled");

    // ...and one noisy session with far more than FTS_CANDIDATE_LIMIT body matches.
    sessions.push(makeSession({ id: "noisy", title: "logs", lastActivityAt: "2026-07-05T00:00:00.000Z" }));
    let noisy = "";
    for (let i = 0; i < 450; i++) {
      noisy += `${JSON.stringify({ sessionId: "noisy", timestamp: "2026-07-05T00:00:00.000Z", event: { type: "text", text: `quorum event number ${i}` } })}\n`;
    }
    fs.appendFileSync(path.join(chatDir, "noisy.jsonl"), noisy);
    service.notifyChatEvent("noisy");
    await service.processPendingNow();

    const result = await service.query({ query: "quorum", limit: 5 });
    expect(result.results[0]!.id).toBe("chat:titled:meta");

    service.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("searchService excludeSessionContent scoping", () => {
  it("removes chat and terminal results entirely while keeping other kinds", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-search-test5-"));
    const sessions: TerminalSessionSummary[] = [
      makeSession({ id: "chat-x", title: "Secret chat" })
    ];
    const service = createSearchService({
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
            name: "wombat lane",
            description: null,
            laneType: "worktree",
            baseRef: "main",
            branchRef: "ade/wombat",
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
    const chatDir = path.join(root, "transcripts", "chat");
    fs.mkdirSync(chatDir, { recursive: true });
    fs.appendFileSync(
      path.join(chatDir, "chat-x.jsonl"),
      `${JSON.stringify({ sessionId: "chat-x", timestamp: "2026-07-05T10:00:00.000Z", event: { type: "user_message", text: "wombat secret" } })}\n`
    );
    service.notifyChatEvent("chat-x");
    await service.processPendingNow();

    const unscoped = await service.query({ query: "wombat" });
    expect(unscoped.results.some((r) => r.kind === "chat")).toBe(true);
    expect(unscoped.results.some((r) => r.kind === "lane")).toBe(true);

    const scoped = await service.query({ query: "wombat", callerScope: { excludeSessionContent: true } });
    expect(scoped.results.some((r) => r.kind === "chat" || r.kind === "terminal")).toBe(false);
    expect(scoped.results.some((r) => r.kind === "lane")).toBe(true);
    expect(scoped.totalByKind.chat ?? 0).toBe(0);
    expect(scoped.totalByKind.terminal ?? 0).toBe(0);

    service.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
});

// ── Ranking primitives (searchRanking.ts is only consumed by searchService) ──

describe("titleRankTier", () => {
  it("orders exact > prefix > substring > body", () => {
    expect(titleRankTier("Fix login", "fix login")).toBe(RANK_TIER_TITLE_EXACT);
    expect(titleRankTier("Fix login flow", "fix login")).toBe(RANK_TIER_TITLE_PREFIX);
    expect(titleRankTier("Hotfix login flow", "fix login")).toBe(RANK_TIER_TITLE_SUBSTRING);
    expect(titleRankTier("Unrelated", "fix login")).toBe(RANK_TIER_BODY);
  });
});

describe("rankCandidates determinism", () => {
  const parsed = parseSearchQuery("search index");

  const corpus = [
    { docId: "d-body-good", rankTitle: "Terminal output", updatedAt: "2026-07-01T00:00:00.000Z", bm25: -3.5 },
    { docId: "d-exact", rankTitle: "Search index", updatedAt: "2026-01-01T00:00:00.000Z", bm25: -0.1 },
    { docId: "d-substr", rankTitle: "The search index rebuild", updatedAt: "2026-07-04T00:00:00.000Z", bm25: -0.2 },
    { docId: "d-prefix", rankTitle: "Search index rebuild", updatedAt: "2026-07-02T00:00:00.000Z", bm25: -0.2 },
    { docId: "d-body-weak", rankTitle: "Chat transcript", updatedAt: "2026-07-05T00:00:00.000Z", bm25: -1.0 }
  ];

  it("produces the exact expected ordering", () => {
    const ranked = rankCandidates(corpus, parsed);
    expect(ranked.map((r) => r.docId)).toEqual([
      "d-exact",
      "d-prefix",
      "d-substr",
      "d-body-good",
      "d-body-weak"
    ]);
  });

  it("is stable across input permutations", () => {
    const reversed = rankCandidates([...corpus].reverse(), parsed);
    const shuffled = rankCandidates(
      [corpus[2]!, corpus[4]!, corpus[0]!, corpus[3]!, corpus[1]!],
      parsed
    );
    const expected = rankCandidates(corpus, parsed).map((r) => r.docId);
    expect(reversed.map((r) => r.docId)).toEqual(expected);
    expect(shuffled.map((r) => r.docId)).toEqual(expected);
  });

  it("ties within a title tier break by updatedAt desc then docId asc", () => {
    const ranked = rankCandidates(
      [
        { docId: "b", rankTitle: "Search index a", updatedAt: "2026-07-01T00:00:00.000Z", bm25: 0 },
        { docId: "a", rankTitle: "Search index b", updatedAt: "2026-07-01T00:00:00.000Z", bm25: 0 },
        { docId: "c", rankTitle: "Search index c", updatedAt: "2026-07-03T00:00:00.000Z", bm25: 0 }
      ],
      parsed
    );
    expect(ranked.map((r) => r.docId)).toEqual(["c", "a", "b"]);
  });

  it("body ties break by bm25 (lower is better) before recency", () => {
    const ranked = rankCandidates(
      [
        { docId: "recent-weak", rankTitle: "", updatedAt: "2026-07-05T00:00:00.000Z", bm25: -1 },
        { docId: "old-strong", rankTitle: "", updatedAt: "2026-01-01T00:00:00.000Z", bm25: -2 }
      ],
      parsed
    );
    expect(ranked.map((r) => r.docId)).toEqual(["old-strong", "recent-weak"]);
  });
});

describe("extractSnippetRanges", () => {
  it("converts marker chars to typed ranges", () => {
    const { snippet, matchRanges } = extractSnippetRanges(
      "indexing terminal scrollback and chats"
    );
    expect(snippet).toBe("indexing terminal scrollback and chats");
    expect(matchRanges).toEqual([
      { start: 9, end: 17 },
      { start: 33, end: 38 }
    ]);
  });

  it("ignores unbalanced markers", () => {
    const { snippet, matchRanges } = extractSnippetRanges("no markers here");
    expect(snippet).toBe("no markers here");
    expect(matchRanges).toEqual([]);
  });
});

describe("rankCandidates body-only docs", () => {
  it("keeps empty-rankTitle docs in the body tier even when their session title would match", () => {
    const parsed = parseSearchQuery("search index");
    const ranked = rankCandidates(
      [
        // A message doc from a session titled "search index" ranks body-only.
        { docId: "msg", rankTitle: "", updatedAt: "2026-07-05T00:00:00.000Z", bm25: -5 },
        { docId: "meta", rankTitle: "search index", updatedAt: "2026-01-01T00:00:00.000Z", bm25: -0.1 }
      ],
      parsed
    );
    expect(ranked.map((r) => r.docId)).toEqual(["meta", "msg"]);
  });
});

// ── Terminal chunking (terminalChunking.ts is only consumed by searchService) ──

describe("sanitizeIndexedText", () => {
  it("replaces control chars but keeps newlines and tabs", () => {
    expect(sanitizeIndexedText("a\u0001b\u0007c\nd\te\u007f")).toBe("a b c\nd\te ");
  });
});

describe("chunkTerminalTranscript", () => {
  it("consumes complete lines and defers a partial tail", () => {
    const raw = Buffer.from("line one\nline two\npartial", "utf8");
    const { chunks, consumedBytes } = chunkTerminalTranscript(raw, 0);
    expect(consumedBytes).toBe(Buffer.byteLength("line one\nline two\n"));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe("line one\nline two");
    expect(chunks[0]!.startOffset).toBe(0);
    expect(chunks[0]!.endOffset).toBe(consumedBytes);
  });

  it("consumes the partial tail when forced", () => {
    const raw = Buffer.from("done\ntail without newline", "utf8");
    const { chunks, consumedBytes } = chunkTerminalTranscript(raw, 100, { force: true });
    expect(consumedBytes).toBe(raw.length);
    expect(chunks.map((c) => c.text).join("|")).toContain("tail without newline");
    expect(chunks[0]!.startOffset).toBe(100);
    expect(chunks.at(-1)!.endOffset).toBe(100 + raw.length);
  });

  it("splits oversized input at newline boundaries", () => {
    const line = `${"x".repeat(50)}\n`;
    const raw = Buffer.from(line.repeat(10), "utf8");
    const { chunks, consumedBytes } = chunkTerminalTranscript(raw, 0, { maxChunkRawBytes: 128 });
    expect(consumedBytes).toBe(raw.length);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.endOffset - chunk.startOffset).toBeLessThanOrEqual(128);
      expect(raw.subarray(chunk.startOffset, chunk.endOffset).at(-1)).toBe(0x0a);
    }
    // Chunks tile the input exactly.
    expect(chunks[0]!.startOffset).toBe(0);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.startOffset).toBe(chunks[i - 1]!.endOffset);
    }
  });

  it("never splits a UTF-8 codepoint on hard cuts", () => {
    const raw = Buffer.from("é".repeat(200), "utf8"); // 2 bytes each, no newlines
    const { chunks } = chunkTerminalTranscript(raw, 0, { force: true, maxChunkRawBytes: 65 });
    for (const chunk of chunks) {
      const roundTrip = raw.subarray(chunk.startOffset, chunk.endOffset).toString("utf8");
      expect(roundTrip).not.toContain("�");
    }
  });

  it("strips ANSI sequences from indexed text", () => {
    const raw = Buffer.from("\u001b[31mred error\u001b[0m plain\n", "utf8");
    const { chunks } = chunkTerminalTranscript(raw, 0);
    expect(chunks[0]!.text).toBe("red error plain");
  });

  it("is deterministic for the same input", () => {
    const raw = Buffer.from("a\n".repeat(5000), "utf8");
    const a = chunkTerminalTranscript(raw, 0, { maxChunkRawBytes: 256 });
    const b = chunkTerminalTranscript(raw, 0, { maxChunkRawBytes: 256 });
    expect(a).toEqual(b);
  });
});

describe("searchService review fixes (PR #709)", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-search-test6-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("rejects queries with invalid inline filters instead of broadening to match-all", async () => {
    const service = createSearchService({
      cacheDir: path.join(root, "cache"),
      transcriptsDir: path.join(root, "transcripts"),
      chatTranscriptsDir: path.join(root, "transcripts", "chat"),
      sessions: { list: async () => [makeSession({ id: "c1", title: "Something" })] },
      now: () => NOW
    });
    const chatDir = path.join(root, "transcripts", "chat");
    fs.mkdirSync(chatDir, { recursive: true });
    fs.appendFileSync(
      path.join(chatDir, "c1.jsonl"),
      `${JSON.stringify({ sessionId: "c1", timestamp: "2026-07-05T10:00:00.000Z", event: { type: "user_message", text: "findable text" } })}\n`
    );
    service.notifyChatEvent("c1");
    await service.processPendingNow();

    expect((await service.query({ query: "kind:bogus" })).results).toEqual([]);
    expect((await service.query({ query: "kind:bogus findable" })).results).toEqual([]);
    expect((await service.query({ query: "since:whenever findable" })).results).toEqual([]);
    // Valid queries still work.
    expect((await service.query({ query: "findable" })).results.length).toBeGreaterThan(0);
    service.dispose();
  });

  it("returns nothing when a supplied kinds array is entirely invalid", async () => {
    const service = createSearchService({
      cacheDir: path.join(root, "cache"),
      transcriptsDir: path.join(root, "transcripts"),
      chatTranscriptsDir: path.join(root, "transcripts", "chat"),
      sessions: { list: async () => [makeSession({ id: "c2", title: "Something" })] },
      now: () => NOW
    });
    const chatDir = path.join(root, "transcripts", "chat");
    fs.mkdirSync(chatDir, { recursive: true });
    fs.appendFileSync(
      path.join(chatDir, "c2.jsonl"),
      `${JSON.stringify({ sessionId: "c2", timestamp: "2026-07-05T10:00:00.000Z", event: { type: "user_message", text: "findable text" } })}\n`
    );
    service.notifyChatEvent("c2");
    await service.processPendingNow();

    // All-invalid kinds must not silently broaden to the default kind set.
    const allInvalid = await service.query({
      query: "findable",
      kinds: ["termnal" as never]
    });
    expect(allInvalid.results).toEqual([]);
    expect(allInvalid.totalByKind).toEqual({});
    expect(allInvalid.nextCursor).toBeNull();
    // A mixed array keeps the valid entries.
    const mixed = await service.query({
      query: "findable",
      kinds: ["termnal" as never, "chat"]
    });
    expect(mixed.results.length).toBeGreaterThan(0);
    // Omitted kinds still hits the default set.
    expect((await service.query({ query: "findable" })).results.length).toBeGreaterThan(0);
    service.dispose();
  });

  it("searches the requested lane's files when a lane filter is present", async () => {
    const quickOpen = vi.fn(async (_query: string, _limit: number, laneId?: string | null) =>
      laneId === "lane-42" ? [{ path: "lane42/file.ts" }] : [{ path: "primary/file.ts" }]
    );
    const searchText = vi.fn(async () => []);
    const service = createSearchService({
      cacheDir: path.join(root, "cache"),
      transcriptsDir: path.join(root, "transcripts"),
      chatTranscriptsDir: path.join(root, "transcripts", "chat"),
      sessions: { list: async () => [] },
      files: { quickOpen, searchText },
      now: () => NOW
    });

    const scoped = await service.query({ query: "file", laneId: "lane-42", kinds: ["file"] });
    expect(quickOpen).toHaveBeenCalledWith("file", expect.any(Number), "lane-42");
    expect(scoped.results.some((r) => r.id === "file:lane42/file.ts")).toBe(true);

    const unscoped = await service.query({ query: "file", kinds: ["file"] });
    expect(quickOpen).toHaveBeenLastCalledWith("file", expect.any(Number), null);
    expect(unscoped.results.some((r) => r.id === "file:primary/file.ts")).toBe(true);
    service.dispose();
  });
});

describe("searchService review fixes round 2 (PR #709)", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-search-test7-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("never indexes a chat-transcript session as a terminal, even with a legacy toolType", async () => {
    const sessions = [
      makeSession({ id: "legacy-1", title: "Legacy chat", toolType: "other" as never })
    ];
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
    const chatDir = path.join(root, "transcripts", "chat");
    fs.mkdirSync(chatDir, { recursive: true });
    fs.appendFileSync(
      path.join(chatDir, "legacy-1.jsonl"),
      `${JSON.stringify({ sessionId: "legacy-1", timestamp: "2026-07-05T10:00:00.000Z", event: { type: "user_message", text: "legacy quixote content" } })}\n`
    );
    service.notifyChatEvent("legacy-1");
    service.notifyTerminalData("legacy-1");
    await service.processPendingNow();

    const result = await service.query({ query: "quixote" });
    expect(result.results.some((r) => r.kind === "chat")).toBe(true);
    expect(result.results.some((r) => r.kind === "terminal")).toBe(false);
    const status = service.indexStatus();
    expect(status.docCountByKind.terminal ?? 0).toBe(0);
    service.dispose();
  });

  it("resolves a lane NAME passed via the laneId arg (CLI --lane)", async () => {
    const quickOpen = vi.fn(async () => []);
    const service = createSearchService({
      cacheDir: path.join(root, "cache"),
      transcriptsDir: path.join(root, "transcripts"),
      chatTranscriptsDir: path.join(root, "transcripts", "chat"),
      sessions: { list: async () => [] },
      lanes: {
        list: async () => [
          {
            id: "lane-uuid-1",
            name: "fix-login",
            description: null,
            laneType: "worktree",
            baseRef: "main",
            branchRef: "ade/fix-login",
            worktreePath: "/tmp/w",
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
      files: { quickOpen, searchText: async () => [] },
      now: () => NOW
    });

    await service.query({ query: "auth", laneId: "fix-login", kinds: ["file"] });
    expect(quickOpen).toHaveBeenCalledWith("auth", expect.any(Number), "lane-uuid-1");
    service.dispose();
  });
});

describe("searchService owner-scoped attached terminals", () => {
  it("keeps a chat's attached terminal visible to that chat's scoped caller", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-search-test8-"));
    const sessions = [
      makeSession({
        id: "attached-term",
        title: "chat shell",
        toolType: "shell",
        chatSessionId: "my-chat",
        status: "completed",
        endedAt: "2026-07-05T12:00:00.000Z"
      }),
      makeSession({
        id: "foreign-term",
        title: "other shell",
        toolType: "shell",
        chatSessionId: "other-chat",
        status: "completed",
        endedAt: "2026-07-05T12:00:00.000Z"
      })
    ];
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
    fs.mkdirSync(path.join(root, "transcripts"), { recursive: true });
    fs.appendFileSync(path.join(root, "transcripts", "attached-term.log"), "octopus output mine\n");
    fs.appendFileSync(path.join(root, "transcripts", "foreign-term.log"), "octopus output theirs\n");
    service.notifyTerminalData("attached-term");
    service.notifyTerminalData("foreign-term");
    await service.processPendingNow();

    const scoped = await service.query({ query: "octopus", callerScope: { chatSessionId: "my-chat" } });
    const scopedSessions = new Set(scoped.results.map((r) => r.sessionId));
    expect(scopedSessions.has("attached-term")).toBe(true);
    expect(scopedSessions.has("foreign-term")).toBe(false);

    // session: filter also resolves owner-attached terminals.
    const bySession = await service.query({ query: "octopus session:my-chat" });
    expect(bySession.results.some((r) => r.sessionId === "attached-term")).toBe(true);
    expect(bySession.results.some((r) => r.sessionId === "foreign-term")).toBe(false);

    service.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("searchService since: filter on delegated files", () => {
  it("omits file results when a since: filter is present (files carry no timestamps)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-search-test9-"));
    const quickOpen = vi.fn(async () => [{ path: "src/todo.ts" }]);
    const service = createSearchService({
      cacheDir: path.join(root, "cache"),
      transcriptsDir: path.join(root, "transcripts"),
      chatTranscriptsDir: path.join(root, "transcripts", "chat"),
      sessions: { list: async () => [] },
      files: { quickOpen, searchText: async () => [] },
      now: () => NOW
    });

    const withSince = await service.query({ query: "todo since:7d", kinds: ["file"] });
    expect(withSince.results).toEqual([]);
    expect(quickOpen).not.toHaveBeenCalled();

    const withoutSince = await service.query({ query: "todo", kinds: ["file"] });
    expect(withoutSince.results.some((r) => r.id === "file:src/todo.ts")).toBe(true);

    service.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
});
