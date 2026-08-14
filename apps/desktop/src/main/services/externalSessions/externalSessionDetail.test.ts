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

import { discoverClaudeSessions } from "./discoverClaude";
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
