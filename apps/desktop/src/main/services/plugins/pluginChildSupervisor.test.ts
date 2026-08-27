import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { Logger } from "../logging/logger";
import type { PluginManifest } from "../../../shared/plugins/manifest";
import { PluginSdkError, type PluginSdkMethod } from "../../../shared/plugins/sdk";
import {
  createPluginChildSupervisor,
  PLUGIN_CHILD_MAX_FAST_FAILURES,
  PLUGIN_CHILD_READY_TIMEOUT_MS,
  pluginChildRestartDelayMs,
  sanitizePluginChildBaseEnv,
  type PluginChildSupervisor,
} from "./pluginChildSupervisor";
import {
  resetPluginChangeListenersForTests,
  subscribeToPluginChanges,
  type PluginChangeEvent,
} from "./pluginEvents";

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
  tools: [],
  automationTriggers: [],
  automationSteps: [],
  searchProviders: [],
  keybindings: [],
  chatRuntimes: [],
  webhookIngress: [],
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

/**
 * Run and clear every queued timer. The array collects each `invoke`'s timeout
 * alongside restart timers, so a test asserts on what draining them DOES rather
 * than on how many are queued.
 */
function runScheduled(timers: { scheduled: ScheduledTimer[] }): void {
  const queued = [...timers.scheduled];
  timers.scheduled.length = 0;
  for (const timer of queued) timer.run();
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the supervisor to settle.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("pluginChildSupervisor", () => {
  afterEach(() => resetPluginChangeListenersForTests());
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

  // Producer (b) of the change bus: a client watching a plugin's health learns
  // about a crash from these, so every transition has to be reported once.
  it("announces each status transition exactly once", async () => {
    const seen: PluginChangeEvent[] = [];
    subscribeToPluginChanges((event) => {
      if (event.kind === "status") seen.push(event);
    });
    const timers = fakeTimers();
    const supervisor = makeSupervisor("announcer", {
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      now: () => 1_000,
    });

    await supervisor.start();
    await expect(supervisor.invoke("crash", {})).rejects.toMatchObject({ code: "plugin_crashed" });

    const statuses = seen.map((event) => event.status);
    expect(statuses.slice(0, 2)).toEqual(["starting", "running"]);
    expect(statuses).toContain("crashed");
    expect(statuses.at(-1)).toBe("restarting");
    expect(seen.every((event) => event.pluginId === "announcer")).toBe(true);
    // Repeats are the failure mode worth guarding: the supervisor writes
    // `status` from six places, and a re-announced value would make a client
    // refetch on every exit-path hop rather than on real transitions.
    expect(statuses.filter((status) => status === "crashed")).toHaveLength(1);
  });

  // Backoff alone never gives up. Without containment a plugin that dies on
  // startup respawns every 30s forever and the surfaces never settle into a
  // state the user can act on.
  it("stops reviving a plugin that keeps failing fast, and says so", async () => {
    const statuses: (string | undefined)[] = [];
    subscribeToPluginChanges((event) => {
      if (event.kind === "status") statuses.push(event.status);
    });
    const timers = fakeTimers();
    // A constant clock makes every lifetime 0ms, so each exit is a "fast"
    // failure by definition — the case containment exists for.
    const supervisor = makeSupervisor("contained", {
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      now: () => 1_000,
    });

    await supervisor.start();
    for (let attempt = 1; attempt < PLUGIN_CHILD_MAX_FAST_FAILURES; attempt += 1) {
      timers.scheduled.length = 0;
      await expect(supervisor.invoke("crash", {})).rejects.toMatchObject({ code: "plugin_crashed" });
      // Still trying: the status says a restart is pending, and running the
      // queued timers brings the child back.
      expect(supervisor.status()).toBe("restarting");
      runScheduled(timers);
      await waitFor(() => supervisor.status() === "running");
    }

    timers.scheduled.length = 0;
    await expect(supervisor.invoke("crash", {})).rejects.toMatchObject({ code: "plugin_crashed" });

    // The fifth fast failure contains it: the status stays terminal, and
    // draining every queued timer does NOT bring the child back.
    expect(supervisor.status()).toBe("crashed");
    expect(statuses.at(-1)).toBe("crashed");
    expect(supervisor.logs().at(-1)?.message).toContain("Stopped restarting");
    runScheduled(timers);
    expect(supervisor.status()).toBe("crashed");

    // And it stays contained: another call must not quietly resume the loop.
    await expect(supervisor.start()).rejects.toMatchObject({ code: "plugin_crashed" });
    await expect(supervisor.invoke("greet", {})).rejects.toMatchObject({
      message: expect.stringContaining("Restart it to try again"),
    });
    expect(supervisor.status()).toBe("crashed");
  });

  it("never contains a plugin that stays up between crashes", async () => {
    const timers = fakeTimers();
    let clock = 0;
    const supervisor = makeSupervisor("healthy-between-crashes", {
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      now: () => clock,
    });

    await supervisor.start();
    for (let attempt = 0; attempt < PLUGIN_CHILD_MAX_FAST_FAILURES + 2; attempt += 1) {
      timers.scheduled.length = 0;
      // Every child lives well past the healthy threshold before dying, so the
      // consecutive-failure run never builds up.
      clock += 120_000;
      await expect(supervisor.invoke("crash", {})).rejects.toMatchObject({ code: "plugin_crashed" });
      expect(supervisor.status()).toBe("restarting");
      runScheduled(timers);
      await waitFor(() => supervisor.status() === "running");
    }

    expect(supervisor.status()).toBe("running");
  });

  it("never lets a previous spawn's ready timer kill the child that replaced it", async () => {
    const timers = fakeTimers();
    const supervisor = makeSupervisor("stale-ready-timer", {
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      now: () => 1_000,
    });

    await supervisor.start();
    // The first spawn's ready timer. Nothing clears it in the fake clock, which
    // is exactly the situation a crash-restart produces on the real one.
    const staleReady = timers.scheduled.find((timer) => timer.delay === PLUGIN_CHILD_READY_TIMEOUT_MS);
    expect(staleReady).toBeDefined();
    timers.scheduled.length = 0;

    await expect(supervisor.invoke("crash", {})).rejects.toMatchObject({ code: "plugin_crashed" });
    expect(supervisor.status()).toBe("restarting");
    runScheduled(timers);
    // The replacement is mid-handshake — the one window where a stale timer
    // sees `starting` and concludes the child it is watching timed out.
    expect(supervisor.status()).toBe("starting");

    staleReady!.run();
    await waitFor(() => supervisor.status() === "running");
    const pid = supervisor.pid();

    // The timer belonged to the child that already died, so the replacement is
    // untouched: same process, still answering. Without the generation check it
    // is sent `shutdown` here and the supervisor lands on `stopped` with no pid.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(supervisor.status()).toBe("running");
    expect(supervisor.pid()).toBe(pid);
    await expect(supervisor.invoke("echo", { ok: true })).resolves.toMatchObject({
      echoed: { ok: true },
    });
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
