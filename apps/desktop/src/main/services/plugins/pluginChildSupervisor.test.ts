import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { Logger } from "../logging/logger";
import type { PluginManifest } from "../../../shared/plugins/manifest";
import { PluginSdkError, type PluginSdkMethod } from "../../../shared/plugins/sdk";
import {
  createPluginChildSupervisor,
  pluginChildRestartDelayMs,
  sanitizePluginChildBaseEnv,
  type PluginChildSupervisor,
} from "./pluginChildSupervisor";

/**
 * A throwaway child that speaks the NDJSON protocol and nothing else. Using a
 * real process rather than a mocked one is the point: the stdio framing, the
 * `ready` handshake, and the exit path are exactly what these tests exist to
 * cover.
 */
const CHILD_SCRIPT = `
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const frame = JSON.parse(line);
    if (frame.type === "hello") {
      write({ type: "ready", actions: ["echo", "crash", "askHost"] });
    } else if (frame.type === "invoke") {
      if (frame.action === "crash") process.exit(7);
      if (frame.action === "askHost") {
        pendingInvoke = frame.requestId;
        write({ type: "sdk", requestId: "sdk-1", method: "config.get", params: {} });
        continue;
      }
      write({ type: "invokeResult", requestId: frame.requestId, result: { echoed: frame.args } });
    } else if (frame.type === "sdkResult") {
      write({ type: "invokeResult", requestId: pendingInvoke, result: frame.result });
    } else if (frame.type === "shutdown") {
      process.exit(0);
    }
  }
});
let pendingInvoke = null;
function write(frame) {
  process.stdout.write(JSON.stringify(frame) + "\\n");
}
`;

const manifest: PluginManifest = {
  name: "fixture",
  version: "1.0.0",
  displayName: "Fixture",
  description: "",
  vocabVersion: 1,
  entry: "index.js",
  surfaces: [],
  panels: [],
  sockets: [],
  collections: {},
  settings: [],
  cli: [],
  skills: [],
  official: false,
};

function silentLogger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

type ScheduledTimer = { delay: number; run: () => void };

/** A `setTimeout` that records instead of waiting. */
function fakeTimers(): { scheduled: ScheduledTimer[]; setTimeoutFn: typeof setTimeout; clearTimeoutFn: typeof clearTimeout } {
  const scheduled: ScheduledTimer[] = [];
  const setTimeoutFn = ((handler: (...timerArgs: unknown[]) => void, delay?: number) => {
    const handle = { unref: () => handle };
    scheduled.push({ delay: delay ?? 0, run: () => handler() });
    return handle;
  }) as unknown as typeof setTimeout;
  return { scheduled, setTimeoutFn, clearTimeoutFn: (() => {}) as unknown as typeof clearTimeout };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the supervisor to settle.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("pluginChildSupervisor", () => {
  let pluginRoot: string;
  let previousBootstrapPath: string | undefined;
  const active: PluginChildSupervisor[] = [];

  beforeAll(() => {
    pluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-plugin-child-"));
    const scriptPath = path.join(pluginRoot, "bootstrap.cjs");
    fs.writeFileSync(scriptPath, CHILD_SCRIPT, "utf8");
    previousBootstrapPath = process.env.ADE_PLUGIN_CHILD_BOOTSTRAP_PATH;
    process.env.ADE_PLUGIN_CHILD_BOOTSTRAP_PATH = scriptPath;
  });

  afterEach(async () => {
    while (active.length) await active.pop()?.dispose();
  });

  afterAll(() => {
    if (previousBootstrapPath === undefined) delete process.env.ADE_PLUGIN_CHILD_BOOTSTRAP_PATH;
    else process.env.ADE_PLUGIN_CHILD_BOOTSTRAP_PATH = previousBootstrapPath;
    fs.rmSync(pluginRoot, { recursive: true, force: true });
  });

  function makeSupervisor(
    pluginId: string,
    overrides: Partial<Parameters<typeof createPluginChildSupervisor>[0]> = {},
  ): PluginChildSupervisor {
    const supervisor = createPluginChildSupervisor({
      pluginId,
      pluginRoot,
      manifest,
      logger: silentLogger(),
      config: {},
      onSdkCall: async () => ({ answered: true }),
      ...overrides,
    });
    active.push(supervisor);
    return supervisor;
  }

  it("starts, reports ready, and round-trips an invoke", async () => {
    const supervisor = makeSupervisor("round-trip");
    await supervisor.start();

    expect(supervisor.status()).toBe("running");
    expect(supervisor.pid()).toBeTypeOf("number");
    await expect(supervisor.invoke("echo", { hello: "world" })).resolves.toEqual({
      echoed: { hello: "world" },
    });
  });

  it("serves an SDK call the child makes back into the host", async () => {
    const calls: PluginSdkMethod[] = [];
    const supervisor = makeSupervisor("sdk-bridge", {
      onSdkCall: async (method) => {
        calls.push(method);
        return { theme: "dark" };
      },
    });
    await supervisor.start();

    await expect(supervisor.invoke("askHost", {})).resolves.toEqual({ theme: "dark" });
    expect(calls).toEqual(["config.get"]);
  });

  it("marks an unexpected exit as a crash and schedules a backed-off restart", async () => {
    const timers = fakeTimers();
    const supervisor = makeSupervisor("crasher", {
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      now: () => 1_000,
    });
    await supervisor.start();
    timers.scheduled.length = 0;

    await expect(supervisor.invoke("crash", {})).rejects.toMatchObject({ code: "plugin_crashed" });

    expect(supervisor.restartCount()).toBe(1);
    expect(supervisor.lastCrashAt()).toBe(new Date(1_000).toISOString());
    expect(supervisor.status()).toBe("restarting");
    // 1s * 2^0 for the first crash — the windowsSupervisor curve, ported.
    expect(timers.scheduled.at(-1)?.delay).toBe(1_000);

    // Running the scheduled restart brings the child back; the next crash
    // doubles the delay rather than restarting the curve.
    timers.scheduled.at(-1)?.run();
    await waitFor(() => supervisor.status() === "running");
    timers.scheduled.length = 0;

    await expect(supervisor.invoke("crash", {})).rejects.toMatchObject({ code: "plugin_crashed" });
    expect(supervisor.restartCount()).toBe(2);
    expect(timers.scheduled.at(-1)?.delay).toBe(2_000);
  });

  it("stops restarting once disposed", async () => {
    const timers = fakeTimers();
    const supervisor = makeSupervisor("disposed", {
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    await supervisor.start();
    timers.scheduled.length = 0;

    await expect(supervisor.invoke("crash", {})).rejects.toMatchObject({ code: "plugin_crashed" });
    const restart = timers.scheduled.at(-1);
    expect(restart?.delay).toBe(1_000);

    await supervisor.dispose();
    restart?.run();

    expect(supervisor.status()).toBe("stopped");
    expect(supervisor.pid()).toBeNull();
    await expect(supervisor.invoke("echo", {})).rejects.toBeInstanceOf(PluginSdkError);
  });

  // The real child runtime only exists as a bundle, so this covers it once the
  // build produces one and is visibly skipped (not silently passing) until then.
  const bundledBootstrap = [
    path.join(process.cwd(), "dist", "main", "pluginChildBootstrap.cjs"),
    path.join(process.cwd(), "dist", "pluginChildBootstrap.cjs"),
  ].find((candidate) => fs.existsSync(candidate));

  it.skipIf(!bundledBootstrap)("runs a real plugin through the bundled child bootstrap", async () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-plugin-fixture-"));
    fs.writeFileSync(
      path.join(fixtureRoot, "index.js"),
      `let sdk = null;
       module.exports = {
         activate(ade) { sdk = ade; console.log("activated"); },
         actions: {
           async greet(args) {
             const config = await sdk.config.get();
             return \`\${config.greeting} \${args.who}\`;
           },
           boom() { throw new Error("handler exploded"); },
         },
       };`,
      "utf8",
    );
    const previous = process.env.ADE_PLUGIN_CHILD_BOOTSTRAP_PATH;
    process.env.ADE_PLUGIN_CHILD_BOOTSTRAP_PATH = bundledBootstrap!;
    const logs: string[] = [];
    const supervisor = makeSupervisor("fixture", {
      pluginRoot: fixtureRoot,
      config: { greeting: "hey" },
      onSdkCall: async () => ({ greeting: "hey" }),
      onLog: (entry) => logs.push(entry.message),
    });
    try {
      await supervisor.start();
      await expect(supervisor.invoke("greet", { who: "world" })).resolves.toBe("hey world");
      // `console.log` inside plugin code must become a log frame, not a stray
      // line in the NDJSON stream.
      expect(logs.some((line) => line.includes("activated"))).toBe(true);
      await expect(supervisor.invoke("boom", {})).rejects.toMatchObject({ message: "handler exploded" });
      await expect(supervisor.invoke("missing", {})).rejects.toMatchObject({ code: "unsupported_method" });
    } finally {
      if (previous === undefined) delete process.env.ADE_PLUGIN_CHILD_BOOTSTRAP_PATH;
      else process.env.ADE_PLUGIN_CHILD_BOOTSTRAP_PATH = previous;
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("caps the restart delay and resets nothing below the healthy threshold", () => {
    expect(pluginChildRestartDelayMs(0)).toBe(1_000);
    expect(pluginChildRestartDelayMs(1)).toBe(1_000);
    expect(pluginChildRestartDelayMs(4)).toBe(8_000);
    expect(pluginChildRestartDelayMs(30)).toBe(30_000);
  });

  it("strips host control-plane variables from the child environment", () => {
    const env = sanitizePluginChildBaseEnv({
      PATH: "/usr/bin",
      ADE_RUNTIME_SOCKET_PATH: "/tmp/ade.sock",
      ADE_DEFAULT_ROLE: "cto",
      ADE_RUNTIME_PARENT_PID: "999",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.ADE_RUNTIME_SOCKET_PATH).toBeUndefined();
    expect(env.ADE_DEFAULT_ROLE).toBeUndefined();
    expect(env.ADE_RUNTIME_PARENT_PID).toBeUndefined();
  });
});
