import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCursorSdkWorkerEnv } from "./cursorSdkPool";
import { sanitizeDroidSdkWorkerBaseEnv } from "./droidSdkPool";

/**
 * One env identity for every chat runtime.
 *
 * `buildAgentRuntimeEnv` hands every provider the same base environment, and
 * ADE_HOME plus ADE_CHAT_SESSION_ID are the two values in it that say which
 * machine and which chat the agent's injected `ade` belongs to. Claude, Codex,
 * Droid and Pi all pass them through; Cursor stripped ADE_HOME in its worker
 * denylist, and an Alpha agent's CLI silently read the stable machine. This
 * pins the rule per pool so the next denylist entry cannot re-open it.
 *
 * `buildAgentRuntimeEnv` itself is a closure inside the chat service factory
 * and is not reachable in isolation, so the pool-level env helpers -- the last
 * hop before the worker is forked, and the only place a provider has ever
 * dropped one of these -- are what this holds to the rule.
 */
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** The identity every runtime's worker must still be able to read. */
function baseEnvWithAdeIdentity(): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin",
    ADE_HOME: "/Users/admin/.ade-alpha",
    ADE_PACKAGE_CHANNEL: "alpha",
    ADE_CHAT_SESSION_ID: "bbca6866-ffc5-4d8a-9d04-8073f2e92cb6",
  };
}

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("chat runtime ADE env identity", () => {
  it("survives the Cursor SDK worker environment", () => {
    const cliBinDir = path.join(makeTempDir("ade-cli-alpha-"), "bin");
    fs.mkdirSync(cliBinDir, { recursive: true });
    const adeCommand = path.join(cliBinDir, process.platform === "win32" ? "ade-alpha.cmd" : "ade-alpha");
    fs.writeFileSync(adeCommand, "");

    const env = buildCursorSdkWorkerEnv({
      baseEnv: { ...baseEnvWithAdeIdentity(), ADE_CLI_BIN_DIR: cliBinDir, ADE_CLI_PATH: adeCommand },
      userHomeDir: "/Users/admin",
      stateRoot: "/repo/.ade/cache/cursor-sdk/hash/state",
      socketPath: "/tmp/ade-cursor-sdk/socket.sock",
      workspacePath: "/repo/.ade/worktrees/lane",
      sessionId: "bbca6866-ffc5-4d8a-9d04-8073f2e92cb6",
    });

    expect(env.ADE_HOME).toBe("/Users/admin/.ade-alpha");
    expect(env.ADE_CHAT_SESSION_ID).toBe("bbca6866-ffc5-4d8a-9d04-8073f2e92cb6");
  });

  it("survives the Droid SDK worker environment", () => {
    const env = sanitizeDroidSdkWorkerBaseEnv(baseEnvWithAdeIdentity());

    expect(env.ADE_HOME).toBe("/Users/admin/.ade-alpha");
    expect(env.ADE_CHAT_SESSION_ID).toBe("bbca6866-ffc5-4d8a-9d04-8073f2e92cb6");
  });
});
