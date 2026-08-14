import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  handleInspectionUnavailableMessage,
  inspectLiveProviderSessions,
  parseHandleExePaths,
  parseLsofNameLines,
  parseProviderSessionFromPath,
  providerSessionRoots,
  type CommandResult,
  type RunCommand,
} from "./providerSessionHandles";

describe("providerSessionHandles", () => {
  const homeDir = "/Users/dev";
  const roots = providerSessionRoots({ homeDir, env: { HOME: homeDir } });

  it("parses claude, codex, droid, and pi session files from open paths", () => {
    expect(parseProviderSessionFromPath(
      path.join(homeDir, ".claude", "projects", "-Users-dev-ADE", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl"),
      roots,
    )).toEqual({ provider: "claude", sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    expect(parseProviderSessionFromPath(
      path.join(homeDir, ".codex", "sessions", "2026", "08", "14", "rollout-2026-08-14T10-00-00-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl"),
      roots,
    )).toEqual({ provider: "codex", sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });
    expect(parseProviderSessionFromPath(
      path.join(homeDir, ".factory", "sessions", "-Users-dev-ADE", "sess_droid123.jsonl"),
      roots,
    )).toEqual({ provider: "droid", sessionId: "sess_droid123" });
    expect(parseProviderSessionFromPath(
      path.join(homeDir, ".pi", "agent", "sessions", "encoded-cwd", "pi-session-id.jsonl"),
      roots,
    )).toEqual({ provider: "pi", sessionId: "pi-session-id" });
  });

  it("parses cursor chat store and transcript paths as conversation ids", () => {
    expect(parseProviderSessionFromPath(
      path.join(homeDir, ".cursor", "chats", "deadbeef", "conv-12345", "store.db"),
      roots,
    )).toEqual({ provider: "cursor", sessionId: "conv-12345" });
    expect(parseProviderSessionFromPath(
      path.join(homeDir, ".cursor", "projects", "-Users-dev-ADE", "agent-transcripts", "conv-12345", "conv-12345.jsonl"),
      roots,
    )).toEqual({ provider: "cursor", sessionId: "conv-12345" });
  });

  it("does not derive a cursor session id from a non-session file", () => {
    // `data.json` is not a session file; deriving `data` as the id would corrupt
    // the live-handle key that decides which sessions the importer hides.
    expect(parseProviderSessionFromPath(
      path.join(homeDir, ".cursor", "projects", "workspace", "data.json"),
      roots,
    )).toBeNull();
    expect(parseProviderSessionFromPath(
      path.join(homeDir, ".cursor", "chats", "deadbeef", "agent-42", "store.db"),
      roots,
    )).toBeNull();
  });

  it("ignores unrelated open files", () => {
    expect(parseProviderSessionFromPath("/usr/lib/libfoo.dylib", roots)).toBeNull();
    expect(parseProviderSessionFromPath(path.join(homeDir, ".claude", "projects"), roots)).toBeNull();
  });

  it("parses lsof -Fn and handle.exe file lines", () => {
    expect(parseLsofNameLines("p12\nntxt\nn/Users/dev/.claude/projects/x/id.jsonl\n")).toEqual([
      "txt",
      "/Users/dev/.claude/projects/x/id.jsonl",
    ]);
    expect(parseHandleExePaths("claude.exe pid: 9 type: File  C:\\Users\\dev\\.claude\\projects\\x\\id.jsonl\n")).toEqual([
      "C:\\Users\\dev\\.claude\\projects\\x\\id.jsonl",
    ]);
  });

  it("indexes live provider sessions from the pid tree's open files", async () => {
    const claudeFile = path.join(homeDir, ".claude", "projects", "-Users-dev-ADE", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl");
    const cursorNoise = path.join(homeDir, ".cursor", "projects", "workspace", "data.json");
    const runCommand: RunCommand = (command, commandArgs): CommandResult => {
      if (command === "lsof" && commandArgs[0] === "-v") return { status: 0, stdout: "", stderr: "" };
      if (command === "ps") {
        return { status: 0, stdout: "  101 claude --resume\n  777 /usr/bin/vim notes.txt\n", stderr: "" };
      }
      if (command === "pgrep") {
        return commandArgs[1] === "101"
          ? { status: 0, stdout: "102\n", stderr: "" }
          : { status: 1, stdout: "", stderr: "" };
      }
      if (command === "lsof") {
        return {
          status: 0,
          stdout: [
            "p101",
            `n${claudeFile}`,
            `n${cursorNoise}`,
            "p102",
            "n/usr/lib/libfoo.dylib",
            "p999",
            `n${path.join(homeDir, ".codex", "sessions", "2026", "08", "14", "rollout-2026-08-14T10-00-00-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl")}`,
          ].join("\n"),
          stderr: "",
        };
      }
      return { status: 1, stdout: "", stderr: "" };
    };

    const index = await inspectLiveProviderSessions({
      homeDir,
      env: { HOME: homeDir },
      extraPids: [999],
      runCommand,
      platform: "darwin",
    });

    expect(index.availability).toEqual({ available: true, method: "lsof" });
    expect([...index.byKey.keys()].sort()).toEqual([
      "claude:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "codex:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    ]);
    expect(index.byKey.get("claude:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).toEqual([
      { provider: "claude", sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", filePath: claudeFile, pid: 101 },
    ]);
  });

  it("reports an unavailable index when lsof is missing", async () => {
    const index = await inspectLiveProviderSessions({
      homeDir,
      env: { HOME: homeDir },
      runCommand: () => ({ status: null, stdout: "", stderr: "", error: "spawn lsof ENOENT" }),
      platform: "darwin",
    });
    expect(index.availability).toEqual({ available: false, reason: "lsof_unavailable" });
    expect(index.byKey.size).toBe(0);
  });

  it("documents the Windows handle-enumeration degrade", () => {
    expect(handleInspectionUnavailableMessage("windows_handle_enumeration_unavailable")).toMatch(/handle\.exe/);
  });
});
