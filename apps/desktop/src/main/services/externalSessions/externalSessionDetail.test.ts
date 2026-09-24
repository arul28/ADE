import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./discoverClaude", () => ({
  discoverClaudeSessions: vi.fn(),
}));
vi.mock("./discoverCodex", () => ({
  discoverCodexSessions: vi.fn(),
}));
vi.mock("./discoverCursor", () => ({
  discoverCursorSessions: vi.fn(),
}));
vi.mock("./discoverDroid", () => ({
  discoverDroidSessions: vi.fn(),
}));
vi.mock("./discoverOpenCode", () => ({
  discoverOpenCodeSessions: vi.fn(),
}));
vi.mock("./discoverPi", () => ({
  discoverPiSessions: vi.fn(),
}));
// Never spawn a real `opencode export` from a unit test.
vi.mock("./events/opencode", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./events/opencode")>()),
  runOpenCodeExport: vi.fn(async () => null),
}));

import type {
  ExternalSessionDetail,
  ExternalSessionDetailArgs,
} from "../../../shared/types/externalSessionDetail";
import { discoverClaudeSessions } from "./discoverClaude";
import { discoverCursorSessions } from "./discoverCursor";
import { discoverOpenCodeSessions } from "./discoverOpenCode";
import {
  loadExternalSessionDetail,
  normalizeExternalSessionDetailArgs,
  startExternalSessionDetailWatch,
  stopExternalSessionDetailWatch,
} from "./externalSessionDetail";

function writeJsonl(filePath: string, rows: unknown[]): void {
  fs.writeFileSync(
    filePath,
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
    "utf8",
  );
}

describe("externalSessionDetail", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.clearAllMocks();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("normalizes detail args and rejects junk", () => {
    expect(normalizeExternalSessionDetailArgs({
      provider: "claude",
      sessionId: "  abc  ",
    })).toEqual({ provider: "claude", sessionId: "abc" });
    expect(normalizeExternalSessionDetailArgs({
      provider: "grok",
      sessionId: "g-1",
      before: " cursor ",
    })).toEqual({ provider: "grok", sessionId: "g-1", before: "cursor" });
    expect(() => normalizeExternalSessionDetailArgs({})).toThrow(/provider/i);
    expect(() => normalizeExternalSessionDetailArgs({ provider: "claude", sessionId: "" })).toThrow(/sessionId/i);
  });

  it("re-parses a generous transcript tail from the session file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-ext-detail-"));
    tempDirs.push(dir);
    const filePath = path.join(dir, "session.jsonl");
    const rows = Array.from({ length: 12 }, (_, index) => ({
      type: index % 2 === 0 ? "user" : "assistant",
      role: index % 2 === 0 ? "user" : "assistant",
      text: `turn ${index + 1} ${"word ".repeat(20)}`,
      timestamp: Date.parse("2026-08-01T00:00:00.000Z") + index * 1000,
    }));
    writeJsonl(filePath, rows);
    vi.mocked(discoverClaudeSessions).mockResolvedValue([
      {
        provider: "claude",
        id: "sess-1",
        cwd: "/Users/dev/project",
        title: "Fix login",
        preview: "turn 1",
        messages: [{ role: "user", text: "tiny sample", at: 1 }],
        createdAt: Date.parse("2026-08-01T00:00:00.000Z"),
        updatedAt: Date.parse("2026-08-01T00:00:11.000Z"),
        messageCount: 6,
        launch: { model: "anthropic/claude-sonnet-5" },
        sourcePath: filePath,
      },
    ]);

    const detail = await loadExternalSessionDetail({ provider: "claude", sessionId: "sess-1" });
    expect(detail.messages.length).toBeGreaterThan(2);
    expect(detail.messages.at(-1)?.text).toContain("turn 12");
    expect(detail.model).toBe("anthropic/claude-sonnet-5");
    expect(detail.watchable).toBe(true);
    expect(detail.sourcePath).toBe(filePath);
  });

  it("returns the conversation as preview events and pages back with `before`", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-ext-detail-events-"));
    tempDirs.push(dir);
    const filePath = path.join(dir, "session.jsonl");
    const rows: unknown[] = [];
    for (let turn = 0; turn < 150; turn += 1) {
      rows.push({
        type: "user",
        uuid: `u${turn}`,
        timestamp: new Date(Date.parse("2026-08-01T00:00:00.000Z") + turn * 3000).toISOString(),
        message: { role: "user", content: [{ type: "text", text: `question ${turn}` }] },
      });
      rows.push({
        type: "assistant",
        uuid: `a${turn}`,
        timestamp: new Date(Date.parse("2026-08-01T00:00:01.000Z") + turn * 3000).toISOString(),
        message: { role: "assistant", content: [{ type: "tool_use", id: `toolu_${turn}`, name: "Read", input: { path: `f${turn}.ts` } }] },
      });
      rows.push({
        type: "user",
        uuid: `r${turn}`,
        timestamp: new Date(Date.parse("2026-08-01T00:00:02.000Z") + turn * 3000).toISOString(),
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${turn}`, content: "body" }] },
      });
    }
    writeJsonl(filePath, rows);
    vi.mocked(discoverClaudeSessions).mockResolvedValue([
      {
        provider: "claude",
        id: "sess-events",
        cwd: "/Users/dev/project",
        title: null,
        preview: null,
        createdAt: null,
        updatedAt: null,
        messageCount: 150,
        sourcePath: filePath,
      },
    ]);

    const detail = await loadExternalSessionDetail({ provider: "claude", sessionId: "sess-events" });
    // `messages` keeps its old shape for iOS and the TUI.
    expect(detail.messages.at(-1)).toMatchObject({ role: "user", text: "question 149" });
    const events = detail.events ?? [];
    expect(events).toHaveLength(200);
    expect(events.every((envelope) => envelope.sessionId === "external-preview:claude:sess-events")).toBe(true);
    expect(events.some(({ event }) => event.type === "system_notice")).toBe(false);
    expect(events.at(-2)?.event).toMatchObject({ type: "tool_call", tool: "Read", itemId: "toolu_149" });
    expect(events.at(-1)?.event).toMatchObject({ type: "tool_result", itemId: "toolu_149" });
    expect(detail.hasOlder).toBe(true);
    expect(detail.olderCursor).toEqual(expect.any(String));

    const older = await loadExternalSessionDetail({
      provider: "claude",
      sessionId: "sess-events",
      before: detail.olderCursor,
    });
    expect(older.events).toHaveLength(200);
    // The newest page began at turn 83's tool call; this one ends just before it.
    expect(older.events?.at(-1)?.event).toMatchObject({ type: "user_message", text: "question 83" });
    expect(older.hasOlder).toBe(true);

    const oldest = await loadExternalSessionDetail({
      provider: "claude",
      sessionId: "sess-events",
      before: older.olderCursor,
    });
    expect(oldest.events).toHaveLength(50);
    expect(oldest.events?.[0]?.event).toMatchObject({ type: "user_message", text: "question 0" });
    expect(oldest.hasOlder).toBe(false);
    expect(oldest.olderCursor).toBeNull();
  });

  it("keeps the sampled messages for a store-only Cursor chat instead of reading SQLite as JSONL", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-ext-detail-cursor-"));
    tempDirs.push(dir);
    const storePath = path.join(dir, "store.db");
    // A JSON-looking line inside the binary is what the suffix reader used to
    // turn into a garbage message.
    fs.writeFileSync(storePath, `SQLite format 3\u0000\n${JSON.stringify({ role: "user", text: "blob fragment" })}\n`);
    vi.mocked(discoverCursorSessions).mockResolvedValue([
      {
        provider: "cursor",
        id: "cur-1",
        cwd: "/Users/dev/project",
        title: null,
        preview: "real prompt",
        messages: [{ role: "user", text: "real prompt", at: null }],
        createdAt: null,
        updatedAt: null,
        messageCount: 1,
        sourcePath: storePath,
      },
    ]);
    const detail = await loadExternalSessionDetail({ provider: "cursor", sessionId: "cur-1" });
    expect(detail.messages).toEqual([{ role: "user", text: "real prompt", at: null }]);
  });

  it("threads the home it is given into discovery", async () => {
    vi.mocked(discoverClaudeSessions).mockResolvedValue([]);
    const env = { HOME: "/Users/other" };
    await loadExternalSessionDetail({ provider: "claude", sessionId: "sess-home" }, { homeDir: "/Users/other", env });
    expect(discoverClaudeSessions).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "sess-home",
      homeDir: "/Users/other",
      env,
    }));
  });

  it("marks OpenCode details unwatchable when there is no session file", async () => {
    vi.mocked(discoverOpenCodeSessions).mockResolvedValue([
      {
        provider: "opencode",
        id: "oc-1",
        cwd: "/Users/dev/project",
        title: "OpenCode chat",
        preview: "hello",
        messages: [{ role: "user", text: "hello", at: null }],
        createdAt: null,
        updatedAt: null,
        messageCount: 1,
        sourcePath: null,
      },
    ]);
    const detail = await loadExternalSessionDetail({ provider: "opencode", sessionId: "oc-1" });
    expect(detail.watchable).toBe(false);
    expect(detail.messages).toEqual([{ role: "user", text: "hello", at: null }]);
    // No export available: the preview falls back to the sampled messages.
    expect(detail.events?.map(({ event }) => event.type)).toEqual(["user_message"]);
  });

  it("starts a watchable tail and tears it down", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-ext-watch-"));
    tempDirs.push(dir);
    const filePath = path.join(dir, "session.jsonl");
    writeJsonl(filePath, [{ type: "user", role: "user", text: "first", timestamp: 1 }]);
    vi.mocked(discoverClaudeSessions).mockImplementation(async () => ([
      {
        provider: "claude" as const,
        id: "watch-1",
        cwd: "/tmp",
        title: null,
        preview: "first",
        createdAt: 1,
        updatedAt: Date.now(),
        messageCount: 1,
        sourcePath: filePath,
      },
    ]));

    const first = await startExternalSessionDetailWatch({
      senderId: 1,
      watchId: "w1",
      provider: "claude",
      sessionId: "watch-1",
      onUpdate: () => undefined,
    });
    expect(first.watchable).toBe(true);
    fs.appendFileSync(filePath, `${JSON.stringify({ type: "user", role: "user", text: "third", timestamp: 3 })}\n`);
    const reloaded = await loadExternalSessionDetail({ provider: "claude", sessionId: "watch-1" });
    expect(reloaded.messages.some((message) => message.text.includes("third"))).toBe(true);
    stopExternalSessionDetailWatch(1, "w1");
    stopExternalSessionDetailWatch(1, "w1");
  });

  it("loads the watched detail, first and on change, through the loader it is given", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-ext-watch-loader-"));
    tempDirs.push(dir);
    const filePath = path.join(dir, "session.jsonl");
    writeJsonl(filePath, [{ type: "user", role: "user", text: "first", timestamp: 1 }]);
    const loadDetail = vi.fn(async (detailArgs: ExternalSessionDetailArgs): Promise<ExternalSessionDetail> => ({
      provider: detailArgs.provider,
      id: detailArgs.sessionId,
      cwd: null,
      title: null,
      model: null,
      createdAt: null,
      updatedAt: null,
      messageCount: null,
      messages: [],
      sourcePath: filePath,
      watchable: true,
    }));
    const onUpdate = vi.fn();
    try {
      await startExternalSessionDetailWatch({
        senderId: 3,
        watchId: "loader",
        provider: "claude",
        sessionId: "watch-loader",
        onUpdate,
        loadDetail,
      });
      expect(loadDetail).toHaveBeenCalledWith({ provider: "claude", sessionId: "watch-loader" });
      fs.appendFileSync(filePath, `${JSON.stringify({ type: "user", role: "user", text: "second", timestamp: 2 })}\n`);
      await vi.waitFor(() => expect(onUpdate).toHaveBeenCalled(), { timeout: 3000 });
      expect(loadDetail.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(discoverClaudeSessions).not.toHaveBeenCalled();
    } finally {
      stopExternalSessionDetailWatch(3, "loader");
    }
  });

  it("leaves exactly one watcher when two starts for the same watch id interleave", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-ext-race-"));
    tempDirs.push(dir);
    const filePath = path.join(dir, "session.jsonl");
    writeJsonl(filePath, [{ type: "user", role: "user", text: "first", timestamp: 1 }]);
    const releases: Array<() => void> = [];
    vi.mocked(discoverClaudeSessions).mockImplementation(async () => {
      await new Promise<void>((resolve) => releases.push(resolve));
      return [
        {
          provider: "claude" as const,
          id: "race-1",
          cwd: "/tmp",
          title: null,
          preview: "first",
          createdAt: 1,
          updatedAt: Date.now(),
          messageCount: 1,
          sourcePath: filePath,
        },
      ];
    });
    const watchSpy = vi.spyOn(fs, "watch");
    const watchFileSpy = vi.spyOn(fs, "watchFile");
    const unwatchFileSpy = vi.spyOn(fs, "unwatchFile");

    try {
      const start = (): Promise<unknown> => startExternalSessionDetailWatch({
        senderId: 7,
        watchId: "race",
        provider: "claude",
        sessionId: "race-1",
        onUpdate: () => undefined,
      });
      const first = start();
      await vi.waitFor(() => expect(releases.length).toBe(1));
      const second = start();
      await vi.waitFor(() => expect(releases.length).toBe(2));
      // The superseded start resolves last; it must not install a watcher on top
      // of the newer one, which would leak the entry it overwrote.
      releases[1]!();
      await second;
      releases[0]!();
      await first;

      expect(watchSpy).toHaveBeenCalledTimes(1);
      expect(watchFileSpy).toHaveBeenCalledTimes(1);
      expect(unwatchFileSpy).not.toHaveBeenCalled();

      stopExternalSessionDetailWatch(7, "race");
      expect(unwatchFileSpy).toHaveBeenCalledTimes(1);
      expect(unwatchFileSpy).toHaveBeenCalledWith(filePath);
    } finally {
      stopExternalSessionDetailWatch(7, "race");
      watchSpy.mockRestore();
      watchFileSpy.mockRestore();
      unwatchFileSpy.mockRestore();
    }
  });
});
