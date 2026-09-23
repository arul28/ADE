import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  __buildCursorSdkHookCommandForTests,
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

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ade-cursor-home-"));
}

function readJson(filePath: string): any {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

describe("Cursor SDK hook installation", () => {
  it("merges ADE's preToolUse hook into the real Cursor hooks file idempotently", () => {
    const home = tempHome();
    try {
      const hooksPath = cursorSdkHooksJsonPath(home);
      fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
      fs.writeFileSync(hooksPath, JSON.stringify({
        version: 2,
        hooks: {
          preToolUse: [{ command: "node existing-hook.cjs", failClosed: false }],
          postToolUse: [{ command: "node post-hook.cjs" }],
        },
      }, null, 2));

      const first = ensureCursorSdkUserHook({
        userHomeDir: home,
        nodePath: "/node path/bin/node",
      });
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

      const second = ensureCursorSdkUserHook({
        userHomeDir: home,
        nodePath: "/node path/bin/node",
      });
      expect(second.changed).toBe(false);
      expect(readJson(hooksPath).hooks.preToolUse).toHaveLength(2);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("registers a fail-open preCompact hook beside the user's own, and removes it when disabled", () => {
    const home = tempHome();
    try {
      const hooksPath = cursorSdkHooksJsonPath(home);
      fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
      fs.writeFileSync(hooksPath, JSON.stringify({
        version: 1,
        hooks: { preCompact: [{ command: "node my-compact-log.cjs" }] },
      }));

      const installed = ensureCursorSdkUserHook({ userHomeDir: home });
      const preCompact = readJson(hooksPath).hooks.preCompact;
      expect(preCompact).toEqual([
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
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("leaves a preCompact value that is not an array alone and still installs the tool gate", () => {
    const home = tempHome();
    try {
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
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("drops the preCompact key entirely when ADE's entry was the only one", () => {
    const home = tempHome();
    try {
      ensureCursorSdkUserHook({ userHomeDir: home });
      expect(readJson(cursorSdkHooksJsonPath(home)).hooks.preCompact).toHaveLength(1);
      ensureCursorSdkUserHook({ userHomeDir: home, preCompact: false });
      expect(readJson(cursorSdkHooksJsonPath(home)).hooks).not.toHaveProperty("preCompact");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("answers the preCompact hook with an empty object even when ADE's socket is gone", () => {
    const home = tempHome();
    try {
      ensureCursorSdkUserHook({ userHomeDir: home });
      const stdout = execFileSync(process.execPath, [cursorSdkPreCompactScriptPath(home)], {
        input: JSON.stringify({ hook_event_name: "preCompact", context_tokens: 1 }),
        env: {
          PATH: process.env.PATH ?? "",
          HOME: home,
          USERPROFILE: home,
          [CURSOR_SDK_PRECOMPACT_ENV]: "1",
          ADE_CURSOR_SDK_SOCKET: path.join(home, "missing.sock"),
          ADE_CURSOR_SDK_SESSION_ID: "session-1",
          ADE_CURSOR_SDK_LANE_ROOT: "/tmp/lane",
        },
        encoding: "utf8",
      });
      expect(JSON.parse(stdout)).toEqual({});
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("answers the preCompact hook with an empty object when no Node runner exists", () => {
    const home = tempHome();
    try {
      ensureCursorSdkUserHook({ userHomeDir: home });
      const stdout = execFileSync("/bin/sh", [cursorSdkPreCompactShellCommandPath(home)], {
        env: {
          PATH: "",
          HOME: home,
          USERPROFILE: home,
          [CURSOR_SDK_PRECOMPACT_ENV]: "1",
          ADE_CURSOR_SDK_SOCKET: path.join(home, "missing.sock"),
          ADE_CURSOR_SDK_SESSION_ID: "session-1",
        },
        encoding: "utf8",
      });
      expect(JSON.parse(stdout)).toEqual({});
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("allows non-ADE Cursor hook invocations to pass through", () => {
    const home = tempHome();
    try {
      ensureCursorSdkUserHook({ userHomeDir: home });
      const stdout = execFileSync(process.execPath, [cursorSdkHookScriptPath(home)], {
        input: "{}",
        env: {
          PATH: process.env.PATH ?? "",
          HOME: home,
          USERPROFILE: home,
        },
        encoding: "utf8",
      });
      expect(JSON.parse(stdout)).toEqual({ permission: "allow" });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("uses a shell wrapper that allows non-ADE Cursor when Node is unavailable", () => {
    const home = tempHome();
    try {
      ensureCursorSdkUserHook({ userHomeDir: home });
      const stdout = execFileSync("/bin/sh", [cursorSdkHookShellCommandPath(home)], {
        env: {
          PATH: "",
          HOME: home,
          USERPROFILE: home,
        },
        encoding: "utf8",
      });
      expect(JSON.parse(stdout)).toEqual({ permission: "allow" });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("fails closed for ADE Cursor hook invocations when no Node runner is available", () => {
    const home = tempHome();
    try {
      ensureCursorSdkUserHook({ userHomeDir: home });
      const stdout = execFileSync("/bin/sh", [cursorSdkHookShellCommandPath(home)], {
        env: {
          PATH: "",
          HOME: home,
          USERPROFILE: home,
          ADE_CURSOR_SDK_SOCKET: path.join(home, "missing.sock"),
          ADE_CURSOR_SDK_SESSION_ID: "session-1",
          ADE_CURSOR_SDK_LANE_ROOT: "/tmp/lane",
        },
        encoding: "utf8",
      });
      const decision = JSON.parse(stdout);
      expect(decision.permission).toBe("deny");
      expect(decision.user_message).toContain("requires Node.js");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("fails closed when an ADE Cursor hook cannot reach the policy socket", () => {
    const home = tempHome();
    try {
      ensureCursorSdkUserHook({ userHomeDir: home });
      const stdout = execFileSync(process.execPath, [cursorSdkHookScriptPath(home)], {
        input: "{}",
        env: {
          PATH: process.env.PATH ?? "",
          HOME: home,
          USERPROFILE: home,
          ADE_CURSOR_SDK_SOCKET: path.join(home, "missing.sock"),
          ADE_CURSOR_SDK_SESSION_ID: "session-1",
          ADE_CURSOR_SDK_LANE_ROOT: "/tmp/lane",
        },
        encoding: "utf8",
      });
      const decision = JSON.parse(stdout);
      expect(decision.permission).toBe("deny");
      expect(decision.user_message).toContain("ENOENT");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("fails closed when a hook is launched with an explicit socket argument", () => {
    const home = tempHome();
    try {
      ensureCursorSdkUserHook({ userHomeDir: home });
      const stdout = execFileSync(process.execPath, [
        cursorSdkHookScriptPath(home),
        "--socket",
        path.join(home, "missing.sock"),
      ], {
        input: "{}",
        env: {
          PATH: process.env.PATH ?? "",
          HOME: home,
          USERPROFILE: home,
        },
        encoding: "utf8",
      });
      const decision = JSON.parse(stdout);
      expect(decision.permission).toBe("deny");
      expect(decision.user_message).toContain("ENOENT");

      const equalsStdout = execFileSync(process.execPath, [
        cursorSdkHookScriptPath(home),
        `--socket=${path.join(home, "missing.sock")}`,
      ], {
        input: "{}",
        env: {
          PATH: process.env.PATH ?? "",
          HOME: home,
          USERPROFILE: home,
        },
        encoding: "utf8",
      });
      const equalsDecision = JSON.parse(equalsStdout);
      expect(equalsDecision.permission).toBe("deny");
      expect(equalsDecision.user_message).toContain("ENOENT");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("fails closed when ADE accepts the hook connection but does not answer", async () => {
    const home = tempHome();
    const socketPath = path.join(home, "silent.sock");
    const server = net.createServer((socket) => {
      socket.resume();
    });
    try {
      ensureCursorSdkUserHook({ userHomeDir: home });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });
      const stdout = execFileSync(process.execPath, [cursorSdkHookScriptPath(home)], {
        input: "{}",
        env: {
          PATH: process.env.PATH ?? "",
          HOME: home,
          USERPROFILE: home,
          ADE_CURSOR_SDK_SOCKET: socketPath,
          ADE_CURSOR_SDK_SESSION_ID: "session-1",
          ADE_CURSOR_SDK_LANE_ROOT: "/tmp/lane",
          ADE_CURSOR_SDK_RESPONSE_TIMEOUT_MS: "20",
        },
        encoding: "utf8",
      });
      const decision = JSON.parse(stdout);
      expect(decision.permission).toBe("deny");
      expect(decision.user_message).toContain("Timed out waiting");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("relays ADE's answer to the tool gate but always answers {} to preCompact", async () => {
    const home = tempHome();
    const socketPath = path.join(home, "ade.sock");
    const received: Array<Record<string, unknown>> = [];
    const decision = { permission: "deny", user_message: "no", agent_message: "no" };
    const server = net.createServer((socket) => {
      let text = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        text += chunk;
        if (!text.includes("\n")) return;
        received.push(JSON.parse(text.slice(0, text.indexOf("\n"))));
        socket.write(`${JSON.stringify(decision)}\n`);
      });
    });
    const run = (scriptPath: string) => new Promise<string>((resolve, reject) => {
      const child = execFile(process.execPath, [scriptPath], {
        env: {
          PATH: process.env.PATH ?? "",
          HOME: home,
          USERPROFILE: home,
          [CURSOR_SDK_PRECOMPACT_ENV]: "1",
          ADE_CURSOR_SDK_SOCKET: socketPath,
          ADE_CURSOR_SDK_SESSION_ID: "session-1",
          ADE_CURSOR_SDK_LANE_ROOT: "/tmp/lane",
        },
        encoding: "utf8",
      }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
      child.stdin?.end(JSON.stringify({ hook_event_name: "preCompact", context_tokens: 7 }));
    });
    try {
      ensureCursorSdkUserHook({ userHomeDir: home });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });
      expect(JSON.parse(await run(cursorSdkHookScriptPath(home)))).toEqual(decision);
      expect(JSON.parse(await run(cursorSdkPreCompactScriptPath(home)))).toEqual({});
      expect(received).toEqual([
        { payload: { hook_event_name: "preCompact", context_tokens: 7 }, sessionId: "session-1", laneRoot: "/tmp/lane" },
        {
          payload: { hook_event_name: "preCompact", context_tokens: 7 },
          sessionId: "session-1",
          laneRoot: "/tmp/lane",
          adeHook: "preCompact",
        },
      ]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("never reports preCompact to an older build's worker, even after it rewrote the gate scripts", async () => {
    const home = tempHome();
    const socketPath = path.join(home, "ade.sock");
    const received: Array<Record<string, unknown>> = [];
    // An older ADE build's worker treats every hook line as a tool call.
    const server = net.createServer((socket) => {
      let text = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        text += chunk;
        if (!text.includes("\n")) return;
        received.push(JSON.parse(text.slice(0, text.indexOf("\n"))));
        socket.end(`${JSON.stringify({ permission: "deny", user_message: "unknown tool" })}\n`);
      });
    });
    const runEntry = (command: string, extraEnv: Record<string, string>) => new Promise<string>((resolve, reject) => {
      const child = execFile("/bin/sh", ["-c", command], {
        env: {
          PATH: process.env.PATH ?? "",
          HOME: home,
          ADE_CURSOR_SDK_NODE: process.execPath,
          ADE_CURSOR_SDK_SOCKET: socketPath,
          ADE_CURSOR_SDK_SESSION_ID: "session-1",
          ADE_CURSOR_SDK_LANE_ROOT: "/tmp/lane",
          ...extraEnv,
        },
        encoding: "utf8",
      }, (error, out) => (error ? reject(error) : resolve(out)));
      child.stdin?.end(JSON.stringify({ hook_event_name: "preCompact", context_tokens: 3 }));
    });
    try {
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
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });

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
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("answers {} from the preCompact shell wrapper without starting Node unless ADE_CURSOR_SDK_PRECOMPACT is set", () => {
    const home = tempHome();
    try {
      ensureCursorSdkUserHook({ userHomeDir: home });
      const marker = path.join(home, "runner-started");
      const fakeNode = path.join(home, "fake-node");
      fs.writeFileSync(fakeNode, `#!/bin/sh\ncat >/dev/null\n: > "$RUNNER_MARKER"\nprintf '%s' '{"ran":true}'\n`, { mode: 0o755 });
      const run = (extraEnv: Record<string, string>) => execFileSync("/bin/sh", [cursorSdkPreCompactShellCommandPath(home)], {
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
      });

      expect(JSON.parse(run({}))).toEqual({});
      expect(fs.existsSync(marker)).toBe(false);
      expect(JSON.parse(run({ [CURSOR_SDK_PRECOMPACT_ENV]: "1" }))).toEqual({ ran: true });
      expect(fs.existsSync(marker)).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not let the preCompact reporter connect unless ADE_CURSOR_SDK_PRECOMPACT is set", async () => {
    const home = tempHome();
    const socketPath = process.platform === "win32"
      ? `\\\\.\\pipe\\ade-precompact-${process.pid}-${Date.now()}`
      : path.join(home, "ade.sock");
    let connections = 0;
    const server = net.createServer((socket) => {
      connections += 1;
      socket.end("{}\n");
    });
    try {
      ensureCursorSdkUserHook({ userHomeDir: home });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });
      const stdout = await new Promise<string>((resolve, reject) => {
        const child = execFile(process.execPath, [cursorSdkPreCompactScriptPath(home), "--socket", socketPath], {
          env: { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home, ADE_CURSOR_SDK_SOCKET: socketPath },
          encoding: "utf8",
        }, (error, out) => (error ? reject(error) : resolve(out)));
        child.stdin?.end(JSON.stringify({ hook_event_name: "preCompact" }));
      });
      expect(JSON.parse(stdout)).toEqual({});
      expect(connections).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("still installs the tool gate when the preCompact scripts cannot be written", () => {
    const home = tempHome();
    try {
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
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("replaces an earlier preCompact entry that pointed at the gate scripts", () => {
    const home = tempHome();
    try {
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
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("keeps the gate scripts free of any preCompact branch", () => {
    const home = tempHome();
    try {
      ensureCursorSdkUserHook({ userHomeDir: home });
      const gateFiles = [cursorSdkHookScriptPath(home)];
      if (process.platform !== "win32") gateFiles.push(cursorSdkHookShellCommandPath(home));
      for (const file of gateFiles) {
        const text = fs.readFileSync(file, "utf8");
        expect(text).not.toMatch(/pre-?compact/i);
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not overwrite malformed user hooks.json", () => {
    const home = tempHome();
    try {
      const hooksPath = cursorSdkHooksJsonPath(home);
      fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
      fs.writeFileSync(hooksPath, "{ nope");
      expect(() => ensureCursorSdkUserHook({ userHomeDir: home })).toThrow(/not valid JSON/);
      expect(fs.readFileSync(hooksPath, "utf8")).toBe("{ nope");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects hook command paths with control characters", () => {
    const home = tempHome();
    try {
      expect(() => ensureCursorSdkUserHook({
        userHomeDir: home,
        nodePath: `/node\npath/bin/node`,
      })).toThrow(/control characters/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("uses a cmd wrapper for packaged Electron hooks on Windows", () => {
    const originalPlatform = process.platform;
    const originalElectron = process.versions.electron;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    Object.defineProperty(process.versions, "electron", { value: "37.0.0", configurable: true });
    try {
      const command = __buildCursorSdkHookCommandForTests(
        undefined,
        String.raw`C:\Users\Ada Lovelace\.cursor\hooks\ade-tool-gate.cjs`,
        String.raw`C:\Users\Ada Lovelace\.cursor\hooks\ade-tool-gate.cmd`,
        undefined,
      );
      expect(command).toBe(`cmd /d /c "C:\\Users\\Ada Lovelace\\.cursor\\hooks\\ade-tool-gate.cmd"`);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
      if (originalElectron === undefined) {
        Reflect.deleteProperty(process.versions, "electron");
      } else {
        Object.defineProperty(process.versions, "electron", { value: originalElectron, configurable: true });
      }
    }
  });

  it.skipIf(process.platform === "win32")("writes the POSIX shell wrapper with escaped paths", () => {
    const home = tempHome();
    try {
      const commandPath = cursorSdkHookShellCommandPath(home);
      writeCursorSdkHookShellCommandScript({
        commandPath,
        nodePath: "/tmp/node's/bin/node",
        scriptPath: "/tmp/ADE Hooks/ade-tool-gate.cjs",
      });
      const content = fs.readFileSync(commandPath, "utf8");
      expect(content).toContain("script_path='/tmp/ADE Hooks/ade-tool-gate.cjs'");
      expect(content).toContain("configured_node='/tmp/node'\\''s/bin/node'");
      const stdout = execFileSync("/bin/sh", [commandPath, `--socket=${path.join(home, "missing.sock")}`], {
        env: {
          PATH: "",
          HOME: home,
          USERPROFILE: home,
        },
        encoding: "utf8",
      });
      const decision = JSON.parse(stdout);
      expect(decision.permission).toBe("deny");
      expect(decision.user_message).toContain("requires Node.js");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("writes the Windows Electron command wrapper with escaped batch percent signs", () => {
    const home = tempHome();
    try {
      const commandPath = cursorSdkHookWindowsCommandPath(home);
      writeCursorSdkHookWindowsCommandScript({
        commandPath,
        electronPath: String.raw`C:\Users\Ada%20\AppData\Local\ADE.exe`,
        scriptPath: String.raw`C:\Users\Ada%20\.cursor\hooks\ade-tool-gate.cjs`,
      });
      const script = fs.readFileSync(commandPath, "utf8");
      expect(script).toContain(
        String.raw`"C:\Users\Ada%%20\AppData\Local\ADE.exe" "C:\Users\Ada%%20\.cursor\hooks\ade-tool-gate.cjs" %*`,
      );
      // Cursor's own hook arguments must reach the bridge script, the way the
      // POSIX wrapper forwards "$@".
      expect(script).toContain("%*");
      expect(script).toContain("setlocal");
      expect(script).not.toContain("if not defined");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("gives only the Windows preCompact wrapper the ADE_CURSOR_SDK_PRECOMPACT guard", () => {
    const home = tempHome();
    const originalPlatform = process.platform;
    const originalElectron = process.versions.electron;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    Object.defineProperty(process.versions, "electron", { value: "37.0.0", configurable: true });
    try {
      const installed = ensureCursorSdkUserHook({ userHomeDir: home });
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
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
