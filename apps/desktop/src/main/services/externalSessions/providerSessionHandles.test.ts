import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  collectDescendantPidRoots,
  handleIsOwnedByTrackedPty,
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
      { provider: "claude", sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", filePath: claudeFile, pid: 101, trackedRootPid: null },
    ]);
  });

  it("parses qwen, grok, copilot, and kimi session layouts", () => {
    expect(parseProviderSessionFromPath(
      path.join(homeDir, ".qwen", "projects", "-Users-dev-ADE", "chats", "11111111-1111-4111-8111-111111111111.jsonl"),
      roots,
    )).toEqual({ provider: "qwen", sessionId: "11111111-1111-4111-8111-111111111111" });
    expect(parseProviderSessionFromPath(
      path.join(homeDir, ".grok", "sessions", "%2FUsers%2Fdev%2FADE", "01a05696-9a7e-7643-89bc-ded3663297be", "chat_history.jsonl"),
      roots,
    )).toEqual({ provider: "grok", sessionId: "01a05696-9a7e-7643-89bc-ded3663297be" });
    expect(parseProviderSessionFromPath(
      path.join(homeDir, ".copilot", "session-state", "02d4d613-d443-4649-84ed-8b040fe50159", "events.jsonl"),
      roots,
    )).toEqual({ provider: "copilot", sessionId: "02d4d613-d443-4649-84ed-8b040fe50159" });
    expect(parseProviderSessionFromPath(
      path.join(homeDir, ".kimi-code", "sessions", "wd_ade_2151c536b962", "session_0f0e0d0c-0b0a-4908-8706-050403020100", "agents", "main", "wire.jsonl"),
      roots,
    )).toEqual({ provider: "kimi", sessionId: "session_0f0e0d0c-0b0a-4908-8706-050403020100" });
  });

  it("never mints an ACP session id from a fixed-name file outside a session folder", () => {
    // Grok's per-cwd prompt history and Kimi's workspace-level files name no session.
    expect(parseProviderSessionFromPath(
      path.join(homeDir, ".grok", "sessions", "%2FUsers%2Fdev%2FADE", "prompt_history.jsonl"),
      roots,
    )).toBeNull();
    expect(parseProviderSessionFromPath(
      path.join(homeDir, ".kimi-code", "sessions", "index.jsonl"),
      roots,
    )).toBeNull();
    expect(parseProviderSessionFromPath(
      path.join(homeDir, ".qwen", "projects", "-Users-dev-ADE", "memory.json"),
      roots,
    )).toBeNull();
  });

  it("honors GROK_HOME for grok session roots", () => {
    const grokRoots = providerSessionRoots({ homeDir, env: { HOME: homeDir, GROK_HOME: "/opt/grok-home" } });
    expect(parseProviderSessionFromPath(
      path.join("/opt/grok-home", "sessions", "%2Frepo", "01a05699-10f7-7aa0-8462-5618e0289e91", "updates.jsonl"),
      grokRoots,
    )).toEqual({ provider: "grok", sessionId: "01a05699-10f7-7aa0-8462-5618e0289e91" });
  });

  it("does not record the OpenCode SQLite database basename as a session id", () => {
    for (const file of ["opencode.db", "opencode.db-wal", "opencode.db-shm"]) {
      expect(parseProviderSessionFromPath(path.join(homeDir, ".local", "share", "opencode", file), roots)).toBeNull();
    }
    expect(parseProviderSessionFromPath(
      path.join(homeDir, ".local", "share", "opencode", "storage", "session_diff", "ses_1991d0778ffekgkerhPrDEXmyf.json"),
      roots,
    )).toEqual({ provider: "opencode", sessionId: "ses_1991d0778ffekgkerhPrDEXmyf" });
  });

  it("attributes a session file held by a descendant to its tracked PTY root", async () => {
    // PTY root 500 (shell) -> 501 (node) -> 502 (qwen) holds the chat file; the
    // provider scan also finds 502, but the tracked root walks first.
    const qwenFile = path.join(homeDir, ".qwen", "projects", "-Users-dev-ADE", "chats", "11111111-1111-4111-8111-111111111111.jsonl");
    const externalFile = path.join(homeDir, ".claude", "projects", "-Users-dev-ADE", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl");
    const children: Record<string, string> = { "500": "501\n", "501": "502\n" };
    const runCommand: RunCommand = (command, commandArgs): CommandResult => {
      if (command === "lsof" && commandArgs[0] === "-v") return { status: 0, stdout: "", stderr: "" };
      if (command === "ps") return { status: 0, stdout: "  502 node /opt/homebrew/bin/qwen\n  900 claude\n", stderr: "" };
      if (command === "pgrep") {
        const out = children[commandArgs[1] ?? ""];
        return out ? { status: 0, stdout: out, stderr: "" } : { status: 1, stdout: "", stderr: "" };
      }
      if (command === "lsof") {
        return { status: 0, stdout: ["p502", `n${qwenFile}`, "p900", `n${externalFile}`].join("\n"), stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    };
    const index = await inspectLiveProviderSessions({
      homeDir,
      env: { HOME: homeDir },
      extraPids: [500],
      runCommand,
      platform: "darwin",
    });
    const [qwenHandle] = index.byKey.get("qwen:11111111-1111-4111-8111-111111111111") ?? [];
    const [claudeHandle] = index.byKey.get("claude:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa") ?? [];
    expect(qwenHandle).toMatchObject({ pid: 502, trackedRootPid: 500 });
    expect(claudeHandle).toMatchObject({ pid: 900, trackedRootPid: null });
    const tracked = new Set([500]);
    expect(handleIsOwnedByTrackedPty(qwenHandle!, tracked)).toBe(true);
    expect(handleIsOwnedByTrackedPty(claudeHandle!, tracked)).toBe(false);
    // A root pid that holds the file itself still counts.
    expect(handleIsOwnedByTrackedPty({ pid: 500, trackedRootPid: null }, tracked)).toBe(true);
  });

  it("maps Windows descendants to their tracked root through CIM", async () => {
    const runCommand: RunCommand = (command, commandArgs): CommandResult => {
      if (command !== "powershell.exe") return { status: 1, stdout: "", stderr: "" };
      const script = commandArgs[commandArgs.length - 1] ?? "";
      if (script.includes("ParentProcessId=40")) return { status: 0, stdout: "41\r\n", stderr: "" };
      if (script.includes("ParentProcessId=41")) return { status: 0, stdout: "42\r\n", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    };
    const owners = await collectDescendantPidRoots([40, 90], runCommand, "win32");
    expect([...owners.entries()].sort((a, b) => a[0] - b[0])).toEqual([[40, 40], [41, 40], [42, 40], [90, 90]]);
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
