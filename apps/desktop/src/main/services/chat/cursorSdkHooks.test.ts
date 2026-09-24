import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  cursorSdkHookShellCommandPath,
  cursorSdkHookScriptPath,
  cursorSdkHookWindowsCommandPath,
  cursorSdkHooksJsonPath,
  cursorSdkPreCompactScriptPath,
  cursorSdkPreCompactShellCommandPath,
  cursorSdkPreCompactWindowsCommandPath,
  CURSOR_SDK_PRECOMPACT_ENV,
  ensureCursorSdkUserHook,
  writeCursorSdkHookShellCommandScript,
  writeCursorSdkHookWindowsCommandScript,
} from "./cursorSdkHooks";

type Env = Record<string, string>;

async function withHome(run: (home: string) => void | Promise<void>): Promise<void> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cursor-home-"));
  try {
    await run(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function readJson(filePath: string): any {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

/** The env an ADE-launched Cursor worker gives its hooks. */
function adeEnv(socketPath: string): Env {
  return {
    ADE_CURSOR_SDK_SOCKET: socketPath,
    ADE_CURSOR_SDK_SESSION_ID: "session-1",
    ADE_CURSOR_SDK_LANE_ROOT: "/tmp/lane",
  };
}

/** Run a hook script under Node (or a wrapper under `/bin/sh` with no PATH) and parse its answer. */
function runHook(home: string, opts: { script: string; shell?: boolean; args?: string[]; env?: Env; input?: string }): any {
  const [file, pathEnv] = opts.shell ? ["/bin/sh", ""] : [process.execPath, process.env.PATH ?? ""];
  return JSON.parse(execFileSync(file, [opts.script, ...(opts.args ?? [])], {
    input: opts.input,
    env: { PATH: pathEnv, HOME: home, USERPROFILE: home, ...opts.env },
    encoding: "utf8",
  }));
}

function runAsync(file: string, args: string[], env: Env, input: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = execFile(file, args, { env, encoding: "utf8" }, (error, out) => (error ? reject(error) : resolve(out)));
    child.stdin?.end(input);
  });
}

async function withServer(
  socketPath: string,
  onSocket: (socket: net.Socket) => void,
  run: () => Promise<void>,
): Promise<void> {
  const server = net.createServer(onSocket);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    await run();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** Record each newline-terminated request and answer it via `reply`. */
function recordingSocket(received: unknown[], reply: (socket: net.Socket) => void) {
  return (socket: net.Socket) => {
    let text = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      text += chunk;
      if (!text.includes("\n")) return;
      received.push(JSON.parse(text.slice(0, text.indexOf("\n"))));
      reply(socket);
    });
  };
}

describe("Cursor SDK hook installation", () => {
  it("merges ADE's preToolUse hook into the real Cursor hooks file idempotently", () => withHome((home) => {
    const hooksPath = cursorSdkHooksJsonPath(home);
    fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
    fs.writeFileSync(hooksPath, JSON.stringify({
      version: 2,
      hooks: {
        preToolUse: [{ command: "node existing-hook.cjs", failClosed: false }],
        postToolUse: [{ command: "node post-hook.cjs" }],
      },
    }, null, 2));

    const first = ensureCursorSdkUserHook({ userHomeDir: home, nodePath: "/node path/bin/node" });
    expect(first.changed).toBe(true);
    if (process.platform === "win32") {
      expect(first.command).toContain("ade-tool-gate.cjs");
    } else {
      expect(first.command).toContain("/bin/sh");
      expect(first.command).toContain("ade-tool-gate.sh");
    }

    const config = readJson(hooksPath);
    expect(config.version).toBe(2);
    expect(config.hooks.postToolUse).toEqual([{ command: "node post-hook.cjs" }]);
    expect(config.hooks.preToolUse).toHaveLength(2);
    expect(config.hooks.preToolUse[0].command).toContain(
      process.platform === "win32" ? "ade-tool-gate.cjs" : "ade-tool-gate.sh",
    );
    expect(config.hooks.preToolUse[0].failClosed).toBe(true);
    expect(config.hooks.preToolUse[1]).toEqual({ command: "node existing-hook.cjs", failClosed: false });
    expect(fs.existsSync(cursorSdkHookScriptPath(home))).toBe(true);
    if (process.platform !== "win32") {
      expect(fs.existsSync(cursorSdkHookShellCommandPath(home))).toBe(true);
    }

    const second = ensureCursorSdkUserHook({ userHomeDir: home, nodePath: "/node path/bin/node" });
    expect(second.changed).toBe(false);
    expect(readJson(hooksPath).hooks.preToolUse).toHaveLength(2);
  }));

  it("registers a fail-open preCompact hook beside the user's own, and removes it when disabled", () => withHome((home) => {
    const hooksPath = cursorSdkHooksJsonPath(home);
    fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
    fs.writeFileSync(hooksPath, JSON.stringify({
      version: 1,
      hooks: { preCompact: [{ command: "node my-compact-log.cjs" }] },
    }));

    const installed = ensureCursorSdkUserHook({ userHomeDir: home });
    expect(readJson(hooksPath).hooks.preCompact).toEqual([
      { command: installed.preCompactCommand, failClosed: false },
      { command: "node my-compact-log.cjs" },
    ]);
    // Its own scripts, never the permission gate's.
    expect(installed.preCompactCommand).toContain(
      process.platform === "win32" ? "ade-precompact.cjs" : "ade-precompact.sh",
    );
    expect(installed.preCompactCommand).not.toContain("ade-tool-gate");
    expect(ensureCursorSdkUserHook({ userHomeDir: home }).changed).toBe(false);

    expect(ensureCursorSdkUserHook({ userHomeDir: home, preCompact: false }).changed).toBe(true);
    expect(readJson(hooksPath).hooks.preCompact).toEqual([{ command: "node my-compact-log.cjs" }]);
    expect(readJson(hooksPath).hooks.preToolUse).toHaveLength(1);
  }));

  it("leaves a preCompact value that is not an array alone and still installs the tool gate", () => withHome((home) => {
    const hooksPath = cursorSdkHooksJsonPath(home);
    fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
    const userPreCompact = { command: "node my-compact-log.cjs" };
    fs.writeFileSync(hooksPath, JSON.stringify({ version: 1, hooks: { preCompact: userPreCompact } }));

    const installed = ensureCursorSdkUserHook({ userHomeDir: home });
    expect(installed.preCompactSkipped).toBe(true);
    const config = readJson(hooksPath);
    expect(config.hooks.preCompact).toEqual(userPreCompact);
    expect(config.hooks.preToolUse).toHaveLength(1);
    expect(config.hooks.preToolUse[0].failClosed).toBe(true);
    expect(ensureCursorSdkUserHook({ userHomeDir: home })).toMatchObject({ changed: false, preCompactSkipped: true });
  }));

  it("drops the preCompact key entirely when ADE's entry was the only one", () => withHome((home) => {
    ensureCursorSdkUserHook({ userHomeDir: home });
    expect(readJson(cursorSdkHooksJsonPath(home)).hooks.preCompact).toHaveLength(1);
    ensureCursorSdkUserHook({ userHomeDir: home, preCompact: false });
    expect(readJson(cursorSdkHooksJsonPath(home)).hooks).not.toHaveProperty("preCompact");
  }));

  it("answers the preCompact hook with an empty object even when ADE's socket is gone", () => withHome((home) => {
    ensureCursorSdkUserHook({ userHomeDir: home });
    expect(runHook(home, {
      script: cursorSdkPreCompactScriptPath(home),
      input: JSON.stringify({ hook_event_name: "preCompact", context_tokens: 1 }),
      env: { [CURSOR_SDK_PRECOMPACT_ENV]: "1", ...adeEnv(path.join(home, "missing.sock")) },
    })).toEqual({});
  }));

  it.skipIf(process.platform === "win32")("answers the preCompact hook with an empty object when no Node runner exists", () => withHome((home) => {
    ensureCursorSdkUserHook({ userHomeDir: home });
    expect(runHook(home, {
      script: cursorSdkPreCompactShellCommandPath(home),
      shell: true,
      env: { [CURSOR_SDK_PRECOMPACT_ENV]: "1", ...adeEnv(path.join(home, "missing.sock")) },
    })).toEqual({});
  }));

  it("allows non-ADE Cursor hook invocations to pass through", () => withHome((home) => {
    ensureCursorSdkUserHook({ userHomeDir: home });
    expect(runHook(home, { script: cursorSdkHookScriptPath(home), input: "{}" })).toEqual({ permission: "allow" });
  }));

  // With no Node on PATH the shell wrapper still lets non-ADE Cursor sessions
  // through, and fails closed for ADE ones.
  it.skipIf(process.platform === "win32").each([
    ["allows a non-ADE Cursor session", false],
    ["fails closed for an ADE Cursor session", true],
  ])("the gate shell wrapper %s when no Node runner is available", (_label, isAde) => withHome((home) => {
    ensureCursorSdkUserHook({ userHomeDir: home });
    const decision = runHook(home, {
      script: cursorSdkHookShellCommandPath(home),
      shell: true,
      env: isAde ? adeEnv(path.join(home, "missing.sock")) : {},
    });
    if (isAde) {
      expect(decision.permission).toBe("deny");
      expect(decision.user_message).toContain("requires Node.js");
    } else {
      expect(decision).toEqual({ permission: "allow" });
    }
  }));

  it.each([
    ["the env socket", "env"],
    ["an explicit --socket argument", "arg"],
    ["an explicit --socket= argument", "arg="],
  ])("fails closed when an ADE Cursor hook cannot reach the policy socket named by %s", (_label, via) => withHome((home) => {
    ensureCursorSdkUserHook({ userHomeDir: home });
    const socketPath = path.join(home, "missing.sock");
    const decision = runHook(home, {
      script: cursorSdkHookScriptPath(home),
      input: "{}",
      args: via === "arg" ? ["--socket", socketPath] : via === "arg=" ? [`--socket=${socketPath}`] : [],
      env: via === "env" ? adeEnv(socketPath) : {},
    });
    expect(decision.permission).toBe("deny");
    expect(decision.user_message).toContain("ENOENT");
  }));

  it.skipIf(process.platform === "win32")("fails closed when ADE accepts the hook connection but does not answer", () => withHome(async (home) => {
    const socketPath = path.join(home, "silent.sock");
    ensureCursorSdkUserHook({ userHomeDir: home });
    await withServer(socketPath, (socket) => socket.resume(), async () => {
      const decision = runHook(home, {
        script: cursorSdkHookScriptPath(home),
        input: "{}",
        env: { ...adeEnv(socketPath), ADE_CURSOR_SDK_RESPONSE_TIMEOUT_MS: "20" },
      });
      expect(decision.permission).toBe("deny");
      expect(decision.user_message).toContain("Timed out waiting");
    });
  }));

  it.skipIf(process.platform === "win32")("relays ADE's answer to the tool gate but always answers {} to preCompact", () => withHome(async (home) => {
    const socketPath = path.join(home, "ade.sock");
    const received: unknown[] = [];
    const decision = { permission: "deny", user_message: "no", agent_message: "no" };
    const payload = { hook_event_name: "preCompact", context_tokens: 7 };
    const run = (scriptPath: string) => runAsync(process.execPath, [scriptPath], {
      PATH: process.env.PATH ?? "",
      HOME: home,
      USERPROFILE: home,
      [CURSOR_SDK_PRECOMPACT_ENV]: "1",
      ...adeEnv(socketPath),
    }, JSON.stringify(payload));
    ensureCursorSdkUserHook({ userHomeDir: home });
    await withServer(socketPath, recordingSocket(received, (socket) => socket.write(`${JSON.stringify(decision)}\n`)), async () => {
      expect(JSON.parse(await run(cursorSdkHookScriptPath(home)))).toEqual(decision);
      expect(JSON.parse(await run(cursorSdkPreCompactScriptPath(home)))).toEqual({});
      expect(received).toEqual([
        { payload, sessionId: "session-1", laneRoot: "/tmp/lane" },
        { payload, sessionId: "session-1", laneRoot: "/tmp/lane", adeHook: "preCompact" },
      ]);
    });
  }));

  it.skipIf(process.platform === "win32")("never reports preCompact to an older build's worker, even after it rewrote the gate scripts", () => withHome(async (home) => {
    const socketPath = path.join(home, "ade.sock");
    const received: unknown[] = [];
    const runEntry = (command: string, extraEnv: Env) => runAsync("/bin/sh", ["-c", command], {
      PATH: process.env.PATH ?? "",
      HOME: home,
      ADE_CURSOR_SDK_NODE: process.execPath,
      ...adeEnv(socketPath),
      ...extraEnv,
    }, JSON.stringify({ hook_event_name: "preCompact", context_tokens: 3 }));
    const installed = ensureCursorSdkUserHook({ userHomeDir: home });
    // The older build rewrites the shared gate scripts with its own gate and
    // keeps every hook it does not know, so ADE's preCompact entry survives.
    const denyAll = `#!/bin/sh\ncat >/dev/null\nprintf '%s' '{"permission":"deny","user_message":"older gate"}'\n`;
    fs.writeFileSync(cursorSdkHookShellCommandPath(home), denyAll, { mode: 0o755 });
    fs.writeFileSync(
      cursorSdkHookScriptPath(home),
      `process.stdout.write(JSON.stringify({ permission: "deny", user_message: "older gate" }));\n`,
    );
    const [entry] = readJson(cursorSdkHooksJsonPath(home)).hooks.preCompact;
    expect(entry).toEqual({ command: installed.preCompactCommand, failClosed: false });
    // An older ADE build's worker treats every hook line as a tool call.
    const olderWorker = recordingSocket(received, (socket) => {
      socket.end(`${JSON.stringify({ permission: "deny", user_message: "unknown tool" })}\n`);
    });
    await withServer(socketPath, olderWorker, async () => {
      // The older build's worker does not set ADE_CURSOR_SDK_PRECOMPACT: nothing reaches its socket.
      expect(JSON.parse(await runEntry(entry.command, {}))).toEqual({});
      expect(received).toEqual([]);

      // A worker that sets it gets the report, and the hook still answers {} whatever the socket says.
      expect(JSON.parse(await runEntry(entry.command, { [CURSOR_SDK_PRECOMPACT_ENV]: "1" }))).toEqual({});
      expect(received).toEqual([{
        payload: { hook_event_name: "preCompact", context_tokens: 3 },
        sessionId: "session-1",
        laneRoot: "/tmp/lane",
        adeHook: "preCompact",
      }]);
    });
  }));

  it.skipIf(process.platform === "win32")("answers {} from the preCompact shell wrapper without starting Node unless ADE_CURSOR_SDK_PRECOMPACT is set", () => withHome((home) => {
    ensureCursorSdkUserHook({ userHomeDir: home });
    const marker = path.join(home, "runner-started");
    const fakeNode = path.join(home, "fake-node");
    fs.writeFileSync(fakeNode, `#!/bin/sh\ncat >/dev/null\n: > "$RUNNER_MARKER"\nprintf '%s' '{"ran":true}'\n`, { mode: 0o755 });
    const run = (extraEnv: Env) => JSON.parse(execFileSync("/bin/sh", [cursorSdkPreCompactShellCommandPath(home)], {
      input: JSON.stringify({ hook_event_name: "preCompact" }),
      env: {
        PATH: "/usr/bin:/bin",
        HOME: home,
        RUNNER_MARKER: marker,
        ADE_CURSOR_SDK_NODE: fakeNode,
        ADE_CURSOR_SDK_SOCKET: path.join(home, "missing.sock"),
        ADE_CURSOR_SDK_SESSION_ID: "session-1",
        ...extraEnv,
      },
      encoding: "utf8",
    }));

    expect(run({})).toEqual({});
    expect(fs.existsSync(marker)).toBe(false);
    expect(run({ [CURSOR_SDK_PRECOMPACT_ENV]: "1" })).toEqual({ ran: true });
    expect(fs.existsSync(marker)).toBe(true);
  }));

  it("does not let the preCompact reporter connect unless ADE_CURSOR_SDK_PRECOMPACT is set", () => withHome(async (home) => {
    const socketPath = process.platform === "win32"
      ? `\\\\.\\pipe\\ade-precompact-${process.pid}-${Date.now()}`
      : path.join(home, "ade.sock");
    let connections = 0;
    ensureCursorSdkUserHook({ userHomeDir: home });
    await withServer(socketPath, (socket) => {
      connections += 1;
      socket.end("{}\n");
    }, async () => {
      const stdout = await runAsync(
        process.execPath,
        [cursorSdkPreCompactScriptPath(home), "--socket", socketPath],
        { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home, ADE_CURSOR_SDK_SOCKET: socketPath },
        JSON.stringify({ hook_event_name: "preCompact" }),
      );
      expect(JSON.parse(stdout)).toEqual({});
      expect(connections).toBe(0);
    });
  }));

  it("still installs the tool gate when the preCompact scripts cannot be written", () => withHome((home) => {
    const hooksPath = cursorSdkHooksJsonPath(home);
    fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
    const userPreCompact = { command: "node my-compact-log.cjs" };
    fs.writeFileSync(hooksPath, JSON.stringify({
      version: 1,
      hooks: { preCompact: [{ command: "/bin/sh \"/old/ade-precompact.sh\"", failClosed: false }, userPreCompact] },
    }));
    // A directory where the reporter script belongs makes its write fail.
    fs.mkdirSync(cursorSdkPreCompactScriptPath(home), { recursive: true });

    const installed = ensureCursorSdkUserHook({ userHomeDir: home });
    expect(installed.preCompactCommand).toBeNull();
    expect(installed.preCompactError).toMatch(/EISDIR|EPERM|illegal operation/i);
    const config = readJson(hooksPath);
    expect(config.hooks.preToolUse).toEqual([{ command: installed.command, failClosed: true }]);
    expect(fs.existsSync(cursorSdkHookScriptPath(home))).toBe(true);
    // ADE's stale entry is gone; the user's own entry stays.
    expect(config.hooks.preCompact).toEqual([userPreCompact]);
  }));

  it("replaces an earlier preCompact entry that pointed at the gate scripts", () => withHome((home) => {
    const hooksPath = cursorSdkHooksJsonPath(home);
    fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
    const gateCommand = `/bin/sh "${cursorSdkHookShellCommandPath(home)}"`;
    fs.writeFileSync(hooksPath, JSON.stringify({
      version: 1,
      hooks: { preCompact: [{ command: `${gateCommand} --pre-compact`, failClosed: false }] },
    }));
    const installed = ensureCursorSdkUserHook({ userHomeDir: home });
    expect(readJson(hooksPath).hooks.preCompact).toEqual([
      { command: installed.preCompactCommand, failClosed: false },
    ]);
  }));

  it("does not overwrite malformed user hooks.json", () => withHome((home) => {
    const hooksPath = cursorSdkHooksJsonPath(home);
    fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
    fs.writeFileSync(hooksPath, "{ nope");
    expect(() => ensureCursorSdkUserHook({ userHomeDir: home })).toThrow(/not valid JSON/);
    expect(fs.readFileSync(hooksPath, "utf8")).toBe("{ nope");
  }));

  it("rejects hook command paths with control characters", () => withHome((home) => {
    expect(() => ensureCursorSdkUserHook({
      userHomeDir: home,
      nodePath: `/node\npath/bin/node`,
    })).toThrow(/control characters/);
  }));

  it.skipIf(process.platform === "win32")("writes the POSIX shell wrapper with escaped paths", () => withHome((home) => {
    const commandPath = cursorSdkHookShellCommandPath(home);
    writeCursorSdkHookShellCommandScript({
      commandPath,
      nodePath: "/tmp/node's/bin/node",
      scriptPath: "/tmp/ADE Hooks/ade-tool-gate.cjs",
    });
    const content = fs.readFileSync(commandPath, "utf8");
    expect(content).toContain("script_path='/tmp/ADE Hooks/ade-tool-gate.cjs'");
    expect(content).toContain("configured_node='/tmp/node'\\''s/bin/node'");
    const decision = runHook(home, {
      script: commandPath,
      shell: true,
      args: [`--socket=${path.join(home, "missing.sock")}`],
    });
    expect(decision.permission).toBe("deny");
    expect(decision.user_message).toContain("requires Node.js");
  }));

  it("writes the Windows Electron command wrapper with escaped batch percent signs", () => withHome((home) => {
    const commandPath = cursorSdkHookWindowsCommandPath(home);
    writeCursorSdkHookWindowsCommandScript({
      commandPath,
      electronPath: String.raw`C:\Users\Ada%20\AppData\Local\ADE.exe`,
      scriptPath: String.raw`C:\Users\Ada%20\.cursor\hooks\ade-tool-gate.cjs`,
    });
    // `%*` forwards Cursor's own hook arguments to the bridge script, the way
    // the POSIX wrapper forwards "$@".
    expect(fs.readFileSync(commandPath, "utf8")).toContain(
      String.raw`"C:\Users\Ada%%20\AppData\Local\ADE.exe" "C:\Users\Ada%%20\.cursor\hooks\ade-tool-gate.cjs" %*`,
    );
  }));

  it("runs packaged Electron hooks on Windows through cmd wrappers, and gives only the preCompact one the ADE_CURSOR_SDK_PRECOMPACT guard", () => withHome((home) => {
    const originalPlatform = process.platform;
    const originalElectron = process.versions.electron;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    Object.defineProperty(process.versions, "electron", { value: "37.0.0", configurable: true });
    try {
      const installed = ensureCursorSdkUserHook({ userHomeDir: home });
      expect(installed.command).toBe(`cmd /d /c "${cursorSdkHookWindowsCommandPath(home)}"`);
      expect(installed.preCompactCommand).toContain("ade-precompact.cmd");
      const preCompactCmd = fs.readFileSync(cursorSdkPreCompactWindowsCommandPath(home), "utf8");
      expect(preCompactCmd.split("\r\n").slice(0, 7)).toEqual([
        "@echo off",
        "setlocal",
        `if not defined ${CURSOR_SDK_PRECOMPACT_ENV} (`,
        "  more >nul 2>nul",
        "  echo {}",
        "  exit /b 0",
        ")",
      ]);
      expect(fs.readFileSync(cursorSdkHookWindowsCommandPath(home), "utf8")).not.toContain("if not defined");
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
      if (originalElectron === undefined) {
        Reflect.deleteProperty(process.versions, "electron");
      } else {
        Object.defineProperty(process.versions, "electron", { value: originalElectron, configurable: true });
      }
    }
  }));
});
