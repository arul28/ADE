import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenCodeClient } from "@opencode/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAdeOpenCodeIsolationPaths } from "../../../shared/opencodeDataHome";
import {
  classifyOpenCodeLaunchFailure,
  OpenCodeLaunchError,
  renderOpenCodeDiagnostic,
} from "./openCodeServer";
import {
  recoverManagedOpenCodeOrphans,
  writeManagedServerRecord,
} from "./openCodeServerOrphans";
import { applyOpenCodeSessionMode } from "./openCodeSession";
import { buildOpenCodeConfig, openCodeSessionRulesFor, type OpenCodePermissionRule } from "./openCodeConfig";

const spawnSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
  spawnSync: spawnSyncMock,
}));

let adeHome = "";
let previousAdeHome: string | undefined;
let previousOpenCodeRoot: string | undefined;
let previousHome: string | undefined;
let liveServer = true;

beforeEach(() => {
  adeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-opencode-orphan-test-"));
  previousAdeHome = process.env.ADE_HOME;
  previousOpenCodeRoot = process.env.ADE_OPENCODE_XDG_ROOT;
  previousHome = process.env.HOME;
  process.env.ADE_HOME = path.join(adeHome, "ade");
  delete process.env.ADE_OPENCODE_XDG_ROOT;
  process.env.HOME = path.join(adeHome, "home");
  fs.mkdirSync(process.env.HOME, { recursive: true });
  vi.spyOn(os, "homedir").mockReturnValue(process.env.HOME);
  liveServer = true;
  spawnSyncMock.mockReset();
  spawnSyncMock.mockImplementation((command: string, args: string[] = []) => {
    if (command === "wmic") {
      return {
        error: null,
        status: 0,
        stdout: [
          "Node,CommandLine,ParentProcessId,ProcessId",
          'HOST,"C:\\ADE\\opencode.exe serve --port 43120",1,42424',
        ].join("\r\n"),
      };
    }
    if (String(command).toLowerCase().includes("taskkill")) liveServer = false;
    return { error: null, status: 0, stdout: "", stderr: "" };
  });
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
    if (pid !== 42424) {
      const missing = new Error("missing test process") as NodeJS.ErrnoException;
      missing.code = "ESRCH";
      throw missing;
    }
    if (signal === 0 && !liveServer) {
      const exited = new Error("test server exited") as NodeJS.ErrnoException;
      exited.code = "ESRCH";
      throw exited;
    }
    return true;
  }) as typeof process.kill);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (previousAdeHome === undefined) delete process.env.ADE_HOME;
  else process.env.ADE_HOME = previousAdeHome;
  if (previousOpenCodeRoot === undefined) delete process.env.ADE_OPENCODE_XDG_ROOT;
  else process.env.ADE_OPENCODE_XDG_ROOT = previousOpenCodeRoot;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  fs.rmSync(adeHome, { recursive: true, force: true });
});

describe("OpenCode server diagnostics", () => {
  it("preserves actionable port and install failures for callers", () => {
    const portFailure = Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" });
    const diagnostic = classifyOpenCodeLaunchFailure(portFailure, {
      port: 4310,
      binaryPath: "/bin/opencode",
    });
    expect(diagnostic).toEqual({ kind: "port-conflict", port: 4310 });
    expect(renderOpenCodeDiagnostic(diagnostic)).toContain("Port 4310 is already in use");

    const notInstalled = classifyOpenCodeLaunchFailure(new Error("spawn ENOENT"), {
      port: 4310,
      binaryPath: "/bin/opencode",
    });
    expect(notInstalled).toEqual({ kind: "not-installed" });
    expect(new OpenCodeLaunchError(notInstalled).message).toContain("not-installed");
  });

  it("recovers a Windows .exe server from the on-disk registry", async () => {
    const paths = resolveAdeOpenCodeIsolationPaths();
    const configFile = path.join(paths.root, "config-ade", "recovered-server.json");
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, "{}", "utf8");
    writeManagedServerRecord({
      pid: 42424,
      port: 43120,
      ownerPid: 42425,
      startedAt: 1,
      configFile,
    });

    const result = await recoverManagedOpenCodeOrphans({ force: true, activePorts: () => new Set() });

    expect(result).toEqual({ recoveredPids: [42424], skippedPids: [] });
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "wmic",
      ["process", "get", "ProcessId,ParentProcessId,CommandLine", "/FORMAT:CSV"],
      expect.objectContaining({ windowsHide: true }),
    );
    expect(spawnSyncMock.mock.calls.some(([command]) => String(command).toLowerCase().includes("taskkill"))).toBe(true);
    expect(fs.existsSync(configFile)).toBe(false);
    expect(fs.existsSync(path.join(paths.runtimeDir, "servers", "42424.json"))).toBe(false);
  });

  it("does not kill an unidentified Windows registry PID", async () => {
    const paths = resolveAdeOpenCodeIsolationPaths();
    const configFile = path.join(paths.root, "config-ade", "unidentified-server.json");
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, "{}", "utf8");
    writeManagedServerRecord({
      pid: 42424,
      port: 43120,
      ownerPid: 42425,
      startedAt: 1,
      configFile,
    });
    spawnSyncMock.mockImplementation(() => ({
      error: null,
      status: 0,
      stdout: 'Node,CommandLine,ParentProcessId,ProcessId\r\n',
      stderr: "",
    }));

    const result = await recoverManagedOpenCodeOrphans({ force: true, activePorts: () => new Set() });

    expect(result).toEqual({ recoveredPids: [], skippedPids: [42424] });
    expect(spawnSyncMock.mock.calls.some(([command]) => String(command).toLowerCase().includes("taskkill"))).toBe(false);
    expect(fs.existsSync(configFile)).toBe(true);
    expect(fs.existsSync(path.join(paths.runtimeDir, "servers", "42424.json"))).toBe(true);
  });
});

describe("OpenCode session mode", () => {
  it("moves an ADE agent back to the configured default for config-toml", async () => {
    const switchAgent = vi.fn();
    const client = {
      config: {
        get: vi.fn().mockResolvedValue([
          { type: "document", info: { default_agent: "project-default" } },
        ]),
      },
      session: {
        switchAgent,
        switchModel: vi.fn(),
        update: vi.fn(),
      },
    } as unknown as OpenCodeClient;

    await applyOpenCodeSessionMode(
      client,
      {
        id: "session-1",
        agent: "ade-full-auto",
        permissions: [{ action: "edit", resource: "*", effect: "deny" }],
        location: { directory: "/workspace" },
      },
      { agent: null, rules: [] },
    );

    expect(switchAgent).toHaveBeenCalledWith({ sessionID: "session-1", agent: "project-default" });
    expect(client.session.update).toHaveBeenCalledWith({ sessionID: "session-1", permissions: [] });
  });
});

/**
 * OpenCode's evaluation: the last rule whose action and resource match wins
 * (`*` matches anything). Enough to read what a rule list decides.
 */
function decide(rules: readonly OpenCodePermissionRule[], action: string, resource: string): string | undefined {
  const matches = (pattern: string, value: string) => pattern === "*" || pattern === value;
  return [...rules].reverse().find((rule) => matches(rule.action, action) && matches(rule.resource, resource))?.effect;
}

describe("OpenCode lane guard", () => {
  const agents = buildOpenCodeConfig({ projectConfig: {} as never }).agents as Record<string, { permissions: OpenCodePermissionRule[] }>;

  it.each([
    ["full-auto session", openCodeSessionRulesFor("full-auto")],
    ["edit session", openCodeSessionRulesFor("edit")],
    ["plan session", openCodeSessionRulesFor("plan")],
    ["config-toml session", openCodeSessionRulesFor("config-toml")],
    ["ade-full-auto agent", agents["ade-full-auto"]!.permissions],
    ["ade-edit agent", agents["ade-edit"]!.permissions],
    ["ade-helper agent", agents["ade-helper"]!.permissions],
  ])("keeps a %s out of OpenCode's worktree tools and off its own lane", (_label, rules) => {
    expect(decide(rules, "opencode_worktree_create", "*")).toBe("deny");
    expect(decide(rules, "opencode_worktree_list", "*")).toBe("deny");
    expect(decide(rules, "opencode_session_move", "*")).toBe("deny");
    // `worktree_remove` asks for `edit` on the worktree, relative to the session directory.
    expect(decide(rules, "edit", ".")).toBe("deny");
  });

  it("leaves file edits to the mode", () => {
    expect(decide(openCodeSessionRulesFor("full-auto"), "edit", "src/index.ts")).toBe("allow");
    expect(decide(openCodeSessionRulesFor("edit"), "edit", "src/index.ts")).toBe("ask");
    expect(decide(openCodeSessionRulesFor("plan"), "edit", "src/index.ts")).toBe("deny");
    // The user's own config decides everything else for config-toml.
    expect(decide(openCodeSessionRulesFor("config-toml"), "edit", "src/index.ts")).toBeUndefined();
  });
});
