import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  handleInspectionUnavailableMessage,
  parseHandleExePaths,
  parseLsofNameLines,
  parseProviderSessionFromPath,
  providerSessionRoots,
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

  it("parses cursor chat store paths as conversation ids", () => {
    expect(parseProviderSessionFromPath(
      path.join(homeDir, ".cursor", "chats", "deadbeef", "conv-12345", "store.db"),
      roots,
    )).toEqual({ provider: "cursor", sessionId: "conv-12345" });
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

  it("documents the Windows handle-enumeration degrade", () => {
    expect(handleInspectionUnavailableMessage("windows_handle_enumeration_unavailable")).toMatch(/handle\.exe/);
  });
});
