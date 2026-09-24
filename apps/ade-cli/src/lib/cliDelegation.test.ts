import { EventEmitter } from "node:events";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildDelegatedCliEnv,
  cliArgvOwnsRuntime,
  cliCommandWord,
  parseAdeCmdShim,
  resolveCliDelegationTarget,
  runDelegatedCli,
  type CliDelegationFs,
} from "./cliDelegation";
import { renderAdeCliShim } from "../services/runtime/adeCliShim";

const STABLE_ENTRY = "/Applications/ADE.app/Contents/Resources/ade-cli/cli.cjs";
const ALPHA_ENTRY = "/Applications/ADE Alpha.app/Contents/Resources/ade-cli/cli.cjs";
const ALPHA_SHIM = "/tmp/ade-cli-shims/abc123/ade";

function fakeFs(files: Record<string, string>, links: Record<string, string> = {}): CliDelegationFs {
  return {
    isFile: (filePath) => filePath in files || (links[filePath] ?? "") in files,
    realpath: (filePath) => links[filePath] ?? (filePath in files ? filePath : null),
    readHead: (filePath, maxBytes) => files[links[filePath] ?? filePath]?.slice(0, maxBytes) ?? null,
  };
}

const shimFs = fakeFs({
  [ALPHA_SHIM]: renderAdeCliShim({
    entryPath: ALPHA_ENTRY,
    execPath: "/Applications/ADE Alpha.app/Contents/MacOS/ADE Alpha",
    brain: { socketPath: "/Users/a/.ade-alpha/sock/ade.sock", adeHome: "/Users/a/.ade-alpha" },
    platform: "darwin",
  }),
  [ALPHA_ENTRY]: "",
  [STABLE_ENTRY]: "",
});

describe("resolveCliDelegationTarget", () => {
  const agentEnv = { ADE_CLI_PATH: ALPHA_SHIM, ADE_CLI_ENTRY_PATH: ALPHA_ENTRY };

  it("delegates when an older CLI on PATH is not the entry ADE launched the agent with", () => {
    expect(resolveCliDelegationTarget(agentEnv, STABLE_ENTRY, shimFs, "darwin")).toEqual({
      command: ALPHA_SHIM,
      entry: ALPHA_ENTRY,
    });
  });

  it("runs normally when the current CLI is the declared entry", () => {
    expect(resolveCliDelegationTarget(agentEnv, ALPHA_ENTRY, shimFs, "darwin")).toBeNull();
  });

  it("never delegates again once the loop guard is set", () => {
    expect(resolveCliDelegationTarget({ ...agentEnv, ADE_CLI_DELEGATED: "1" }, STABLE_ENTRY, shimFs, "darwin")).toBeNull();
  });

  it("honors the ADE_CLI_NO_DELEGATE opt-out", () => {
    expect(resolveCliDelegationTarget({ ...agentEnv, ADE_CLI_NO_DELEGATE: "1" }, STABLE_ENTRY, shimFs, "darwin")).toBeNull();
  });

  it("runs normally when ADE_CLI_PATH names a file that does not exist", () => {
    expect(
      resolveCliDelegationTarget({ ...agentEnv, ADE_CLI_PATH: "/tmp/gone/ade" }, STABLE_ENTRY, shimFs, "darwin"),
    ).toBeNull();
    expect(resolveCliDelegationTarget({}, STABLE_ENTRY, shimFs, "darwin")).toBeNull();
  });

  it("never swaps a source-checkout build run on purpose for the installed app", () => {
    const laneEntry = "/work/repo/apps/ade-cli/dist/cli.cjs";
    const fsLike = fakeFs({ [ALPHA_SHIM]: "#!/bin/sh\n", [ALPHA_ENTRY]: "", [laneEntry]: "" });
    expect(resolveCliDelegationTarget(agentEnv, laneEntry, fsLike, "darwin")).toBeNull();
  });

  it("recognizes the packaged bin/ade -> ../cli.cjs layout without ADE_CLI_ENTRY_PATH", () => {
    const alphaBin = "/Applications/ADE Alpha.app/Contents/Resources/ade-cli/bin/ade";
    const fsLike = fakeFs({ [alphaBin]: "#!/bin/sh\n", [ALPHA_ENTRY]: "", [STABLE_ENTRY]: "" });
    expect(resolveCliDelegationTarget({ ADE_CLI_PATH: alphaBin }, ALPHA_ENTRY, fsLike, "darwin")).toBeNull();
    expect(resolveCliDelegationTarget({ ADE_CLI_PATH: alphaBin }, STABLE_ENTRY, fsLike, "darwin")).toEqual({
      command: alphaBin,
      entry: ALPHA_ENTRY,
    });
  });

  it("reads a shim's embedded entry when no entry path is declared", () => {
    expect(resolveCliDelegationTarget({ ADE_CLI_PATH: ALPHA_SHIM }, ALPHA_ENTRY, shimFs, "darwin")).toBeNull();
    expect(resolveCliDelegationTarget({ ADE_CLI_PATH: ALPHA_SHIM }, STABLE_ENTRY, shimFs, "darwin")).toEqual({
      command: ALPHA_SHIM,
      entry: null,
    });
  });
});

describe("buildDelegatedCliEnv", () => {
  it("sets the guard and drops module dirs the stale launcher prepended", () => {
    const staleResources = path.dirname(path.dirname(STABLE_ENTRY));
    const alphaModules = "/Applications/ADE Alpha.app/Contents/Resources/app.asar.unpacked/node_modules";
    const env = buildDelegatedCliEnv(
      {
        NODE_PATH: [`${staleResources}/app-arm64.asar.unpacked/node_modules`, alphaModules].join(path.delimiter),
        ADE_AGENT_SKILLS_DIRS: `${staleResources}/agent-skills`,
        KEEP: "yes",
      },
      STABLE_ENTRY,
    );
    expect(env).toMatchObject({ ADE_CLI_DELEGATED: "1", NODE_PATH: alphaModules, KEEP: "yes" });
    expect(env.ADE_AGENT_SKILLS_DIRS).toBeUndefined();
  });
});

describe("runDelegatedCli", () => {
  it("passes argv verbatim to the shim and reports the child's exit", async () => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
    const spawnFn = vi.fn(() => child as never);
    const signalSource = new EventEmitter();
    const argv = ["apple", "status", "--json", "two words", "$HOME", "a\"b"];
    const pending = runDelegatedCli({
      target: { command: ALPHA_SHIM, entry: ALPHA_ENTRY },
      argv,
      env: { ADE_CLI_DELEGATED: "1" },
      platform: "darwin",
      spawnFn,
      signalSource: signalSource as never,
    });

    expect(spawnFn).toHaveBeenCalledWith(ALPHA_SHIM, argv, expect.objectContaining({
      stdio: "inherit",
      env: { ADE_CLI_DELEGATED: "1" },
      windowsHide: true,
      windowsVerbatimArguments: false,
    }));
    signalSource.emit("SIGTERM", "SIGTERM");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");

    child.emit("exit", 3, null);
    await expect(pending).resolves.toEqual({ code: 3, signal: null });
    expect(signalSource.listenerCount("SIGTERM")).toBe(0);
  });

  it("runs a Windows .cmd shim through cmd.exe with each argument quoted", async () => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
    const spawnFn = vi.fn(() => child as never);
    const pending = runDelegatedCli({
      target: { command: "C:\\Temp\\ade-cli-shims\\x\\ade.cmd", entry: null },
      argv: ["apple", "tap", "two words"],
      env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      platform: "win32",
      spawnFn,
      signalSource: new EventEmitter() as never,
      // Not an ADE shim, so it keeps the cmd.exe path.
      fsLike: fakeFs({ "C:\\Temp\\ade-cli-shims\\x\\ade.cmd": "@echo off\r\nnode other.js %*\r\n" }),
    });
    expect(spawnFn).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\cmd.exe",
      ["/d", "/s", "/c", "\"\"C:\\Temp\\ade-cli-shims\\x\\ade.cmd\" \"apple\" \"tap\" \"two words\"\""],
      // Hidden: a parent with no console would otherwise open a visible one.
      expect.objectContaining({ windowsVerbatimArguments: true, windowsHide: true }),
    );
    child.emit("exit", 0, null);
    await expect(pending).resolves.toEqual({ code: 0, signal: null });
  });

  it("regression: starts an ADE .cmd shim's runtime and entry directly, so %VAR% in argv stays literal", async () => {
    const shimPath = "C:\\Users\\a\\AppData\\Local\\Temp\\ade-cli-shims\\x\\ade.cmd";
    const execPath = "C:\\Program Files\\ADE Alpha\\ADE Alpha.exe";
    const entryPath = "C:\\Program Files\\ADE Alpha\\resources\\ade-cli\\cli.cjs";
    const shim = renderAdeCliShim({
      entryPath,
      execPath,
      brain: { socketPath: "\\\\.\\pipe\\ade-alpha-100%", adeHome: "C:\\Users\\a\\.ade-alpha" },
      platform: "win32",
    });
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
    const spawnFn = vi.fn(() => child as never);
    const argv = ["chat", "send", "100% done at %USERPROFILE%\nline two"];
    const pending = runDelegatedCli({
      target: { command: shimPath, entry: null },
      argv,
      env: { ADE_CLI_DELEGATED: "1" },
      platform: "win32",
      spawnFn,
      signalSource: new EventEmitter() as never,
      fsLike: fakeFs({ [shimPath]: shim }),
    });
    expect(spawnFn).toHaveBeenCalledWith(execPath, [entryPath, ...argv], expect.objectContaining({
      windowsHide: true,
      windowsVerbatimArguments: false,
      // The shim's brain defaults apply because the caller picked no brain.
      env: {
        ADE_CLI_DELEGATED: "1",
        ADE_HOME: "C:\\Users\\a\\.ade-alpha",
        ADE_RUNTIME_SOCKET_PATH: "\\\\.\\pipe\\ade-alpha-100%",
        ELECTRON_RUN_AS_NODE: "1",
      },
    }));
    child.emit("exit", 0, null);
    await expect(pending).resolves.toEqual({ code: 0, signal: null });
  });
});

describe("parseAdeCmdShim", () => {
  it("reads back what renderAdeCliShim writes, and keeps a caller's own brain", () => {
    const text = renderAdeCliShim({
      entryPath: "C:\\ade\\cli.cjs",
      execPath: "C:\\ade\\ADE.exe",
      brain: { socketPath: null, adeHome: null },
      platform: "win32",
    });
    expect(parseAdeCmdShim(text)).toEqual({ execPath: "C:\\ade\\ADE.exe", entryPath: "C:\\ade\\cli.cjs", defaults: [] });
  });

  it("refuses a shim it did not write, or one for a native binary", () => {
    expect(parseAdeCmdShim("@echo off\r\nsetlocal\r\ndel /q *\r\n\"a\" \"b\" %*\r\n")).toBeNull();
    expect(parseAdeCmdShim(renderAdeCliShim({
      entryPath: "C:\\ade\\ade.exe",
      execPath: "C:\\ade\\ADE.exe",
      brain: { socketPath: null, adeHome: null },
      platform: "win32",
    }))).toBeNull();
  });
});

describe("cliArgvOwnsRuntime", () => {
  it("finds the command word after global flags", () => {
    expect(cliCommandWord(["--socket", "/tmp/a.sock", "--project-root", "/x", "apple", "status"])).toBe("apple");
    expect(cliCommandWord(["--socket", "apple", "status"])).toBe("apple");
    expect(cliCommandWord(["--json"])).toBeNull();
    // Same socket-path test as the CLI's own parser, Windows spellings included.
    expect(cliCommandWord(["--socket", "C:\\ade\\ade.sock", "apple"])).toBe("apple");
    expect(cliCommandWord(["--socket", "\\\\.\\pipe\\ade", "apple"])).toBe("apple");
  });

  it("never hands a brain start to another install", () => {
    expect(cliArgvOwnsRuntime(["serve", "--socket", "/tmp/a.sock"])).toBe(true);
    expect(cliArgvOwnsRuntime(["--socket", "/tmp/a.sock", "runtime", "run"])).toBe(true);
    expect(cliArgvOwnsRuntime(["rpc", "stdio"])).toBe(true);
    expect(cliArgvOwnsRuntime(["apple", "status"])).toBe(false);
    expect(cliArgvOwnsRuntime(["chat", "send", "serve"])).toBe(false);
  });
});
