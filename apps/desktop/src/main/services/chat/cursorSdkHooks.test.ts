import { execFileSync } from "node:child_process";
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

  it("uses a shell wrapper that allows non-ADE Cursor when Node is unavailable", () => {
    if (process.platform === "win32") return;
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

  it("fails closed for ADE Cursor hook invocations when no Node runner is available", () => {
    if (process.platform === "win32") return;
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

  it("fails closed when ADE accepts the hook connection but does not answer", async () => {
    if (process.platform === "win32") return;
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

  it("writes the POSIX shell wrapper with escaped paths", () => {
    if (process.platform === "win32") return;
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
      expect(fs.readFileSync(commandPath, "utf8")).toContain(
        String.raw`"C:\Users\Ada%%20\AppData\Local\ADE.exe" "C:\Users\Ada%%20\.cursor\hooks\ade-tool-gate.cjs"`,
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
