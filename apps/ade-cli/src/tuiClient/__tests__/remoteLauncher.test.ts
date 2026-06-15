import { describe, expect, it } from "vitest";
import {
  buildRemoteRuntimeRpcCommand,
  parseRemoteAdeCodeArgs,
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
    expect(buildRemoteRuntimeRpcCommand(layout)).toContain('export ADE_PTY_HOST_WORKER_COMMAND="$HOME/.ade-beta/bin/ade"');
    expect(buildRemoteRuntimeRpcCommand(layout)).toContain("exec $HOME/.ade-beta/bin/ade --socket $HOME/.ade-beta/sock/ade.sock rpc --stdio");
  });
});
