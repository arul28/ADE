import { EventEmitter } from "node:events";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildDelegatedCliEnv,
  cliArgvOwnsRuntime,
  cliCommandWord,
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
    });
    expect(spawnFn).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\cmd.exe",
      ["/d", "/s", "/c", "\"\"C:\\Temp\\ade-cli-shims\\x\\ade.cmd\" \"apple\" \"tap\" \"two words\"\""],
      expect.objectContaining({ windowsVerbatimArguments: true }),
    );
    child.emit("exit", 0, null);
    await expect(pending).resolves.toEqual({ code: 0, signal: null });
  });
});

describe("cliArgvOwnsRuntime", () => {
  it("finds the command word after global flags", () => {
    expect(cliCommandWord(["--socket", "/tmp/a.sock", "--project-root", "/x", "apple", "status"])).toBe("apple");
    expect(cliCommandWord(["--socket", "apple", "status"])).toBe("apple");
    expect(cliCommandWord(["--json"])).toBeNull();
  });

  it("never hands a brain start to another install", () => {
    expect(cliArgvOwnsRuntime(["serve", "--socket", "/tmp/a.sock"])).toBe(true);
    expect(cliArgvOwnsRuntime(["--socket", "/tmp/a.sock", "runtime", "run"])).toBe(true);
    expect(cliArgvOwnsRuntime(["rpc", "stdio"])).toBe(true);
    expect(cliArgvOwnsRuntime(["apple", "status"])).toBe(false);
    expect(cliArgvOwnsRuntime(["chat", "send", "serve"])).toBe(false);
  });
});
