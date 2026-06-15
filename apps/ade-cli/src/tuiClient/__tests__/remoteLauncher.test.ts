import { describe, expect, it } from "vitest";
import {
  buildRemoteRuntimeRpcCommand,
  listRemoteSessions,
  parseRemoteAdeCodeArgs,
  remoteRuntimeLayoutCandidates,
  takeAdeCodeRemoteArgs,
} from "../remoteLauncher";

describe("ade code remote launcher", () => {
  it("detects remote as the first standalone ade code positional", () => {
    expect(takeAdeCodeRemoteArgs(["remote", "session", "--target", "mac"])).toEqual([
      "session",
      "--target",
      "mac",
    ]);
    expect(takeAdeCodeRemoteArgs(["--session", "remote"])).toBeNull();
    expect(takeAdeCodeRemoteArgs(["project"])).toBeNull();
  });

  it("parses project and session selection flags", () => {
    expect(parseRemoteAdeCodeArgs([
      "session",
      "--target",
      "workstation",
      "--project",
      "ADE",
      "--session",
      "chat-1",
    ])).toMatchObject({
      scope: "session",
      targetQuery: "workstation",
      projectQuery: "ADE",
      sessionQuery: "chat-1",
    });
  });

  it("builds the remote ADE stdio command for the selected runtime home", () => {
    const layout: Parameters<typeof buildRemoteRuntimeRpcCommand>[0] = {
      channel: "beta",
      homeDirName: ".ade-beta",
      homeDirExpr: "$HOME/.ade-beta",
      binDirExpr: "$HOME/.ade-beta/bin",
      runtimeDirExpr: "$HOME/.ade-beta/runtime",
      socketExpr: "$HOME/.ade-beta/sock/ade.sock",
      binaryExpr: "$HOME/.ade-beta/bin/ade",
    };

    expect(buildRemoteRuntimeRpcCommand(layout)).toContain('export ADE_HOME="$HOME/.ade-beta"');
    expect(buildRemoteRuntimeRpcCommand(layout)).toContain('export ADE_PACKAGE_CHANNEL="beta"');
    expect(buildRemoteRuntimeRpcCommand(layout)).toContain("export ADE_DISABLE_RUNTIME_SERVICE_INSTALL=1");
    expect(buildRemoteRuntimeRpcCommand(layout)).toContain('export ADE_PTY_HOST_WORKER_COMMAND="$HOME/.ade-beta/bin/ade"');
    expect(buildRemoteRuntimeRpcCommand(layout)).toContain("exec $HOME/.ade-beta/bin/ade --socket $HOME/.ade-beta/sock/ade.sock rpc --stdio");
  });

  it("attaches to stable remote runtimes without repairing or installing services", () => {
    const layout: Parameters<typeof buildRemoteRuntimeRpcCommand>[0] = {
      channel: null,
      homeDirName: ".ade",
      homeDirExpr: "$HOME/.ade",
      binDirExpr: "$HOME/.ade/bin",
      runtimeDirExpr: "$HOME/.ade/runtime",
      socketExpr: "$HOME/.ade/sock/ade.sock",
      binaryExpr: "$HOME/.ade/bin/ade",
    };

    expect(buildRemoteRuntimeRpcCommand(layout)).toContain("export ADE_DISABLE_RUNTIME_SERVICE_INSTALL=1");
    expect(buildRemoteRuntimeRpcCommand(layout)).not.toContain("ADE_PACKAGE_CHANNEL");
  });

  it("checks the saved remote target channel before the shared runtime home", () => {
    expect(remoteRuntimeLayoutCandidates({}, "beta").map((layout) => layout.homeDirName)).toEqual([
      ".ade-beta",
      ".ade",
      ".ade-alpha",
    ]);
    expect(remoteRuntimeLayoutCandidates({}, "alpha").map((layout) => layout.homeDirName)).toEqual([
      ".ade-alpha",
      ".ade",
      ".ade-beta",
    ]);
  });

  it("falls back to positional chat list args for older remote action adapters", async () => {
    const calls: unknown[] = [];
    const client = {
      request: async (_method: string, params: unknown) => {
        calls.push(params);
        const args = (params as { arguments?: { domain?: string; action?: string; argsList?: unknown[] } }).arguments;
        if (args?.domain === "chat" && args.action === "listSessions" && !args.argsList) {
          return { ok: false, error: { message: "invalid lane id" } };
        }
        if (args?.domain === "chat" && args.action === "listSessions" && args.argsList) {
          return {
            result: [{
              sessionId: "chat-1",
              laneId: "lane-1",
              provider: "codex",
              model: "gpt-5.5",
              status: "idle",
              startedAt: "2026-06-15T00:00:00.000Z",
              endedAt: null,
              lastActivityAt: "2026-06-15T00:01:00.000Z",
              lastOutputPreview: null,
              summary: null,
            }],
          };
        }
        if (args?.domain === "terminal" && args.action === "list") {
          return { result: [] };
        }
        throw new Error("unexpected request");
      },
    };

    await expect(listRemoteSessions(client as never, "project-1")).resolves.toMatchObject([
      { sessionId: "chat-1", kind: "chat", title: "chat-1" },
    ]);
    expect(calls).toEqual([
      expect.objectContaining({
        projectId: "project-1",
        arguments: expect.objectContaining({
          domain: "chat",
          action: "listSessions",
          args: { includeArchived: false, includeAutomation: true },
        }),
      }),
      expect.objectContaining({
        projectId: "project-1",
        arguments: expect.objectContaining({
          domain: "chat",
          action: "listSessions",
          argsList: [null, { includeArchived: false, includeAutomation: true }],
        }),
      }),
      expect.objectContaining({
        projectId: "project-1",
        arguments: expect.objectContaining({
          domain: "terminal",
          action: "list",
          args: { limit: 200 },
        }),
      }),
    ]);
  });

  it("includes legacy Claude terminals when only the resume command identifies them", async () => {
    const client = {
      request: async (_method: string, params: unknown) => {
        const args = (params as { arguments?: { domain?: string; action?: string } }).arguments;
        if (args?.domain === "chat" && args.action === "listSessions") {
          return { result: [] };
        }
        if (args?.domain === "terminal" && args.action === "list") {
          return {
            result: [
              {
                terminalId: "claude-command-1",
                laneId: "lane-1",
                title: "Claude terminal",
                status: "running",
                runtimeState: "idle",
                startedAt: "2026-06-15T00:00:00.000Z",
                toolType: "shell",
                resumeCommand: "claude --resume claude-command-1",
              },
            ],
          };
        }
        throw new Error("unexpected request");
      },
    };

    await expect(listRemoteSessions(client as never, "project-1")).resolves.toMatchObject([
      { sessionId: "claude-command-1", kind: "terminal", title: "Claude terminal" },
    ]);
  });
});
