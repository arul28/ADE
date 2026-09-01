import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PluginManifest } from "../../../../shared/plugins/manifest";
import {
  decodePluginFrame,
  encodePluginFrame,
  type PluginChildFrame,
  type PluginHostFrame,
} from "../../../../shared/plugins/sdk";
import { runPluginChild } from "./pluginChildBootstrap";

/**
 * The network guard is the one collaborator that must NOT be real here.
 *
 * It patches `globalThis.fetch` and the `node:http`/`https`/`net`/`tls` bindings
 * of whatever process it runs in — which in the child is exactly right and in a
 * vitest worker would mean the rest of the file, and anything sharing the
 * worker, talks to a plugin's declared-host list. Its own behaviour is covered
 * by `pluginChildNetworkGuard.test.ts`; what this file is about is which frames
 * the dispatcher answers.
 */
vi.mock("./pluginChildNetworkGuard", () => ({ installPluginNetworkGuard: () => {} }));

const BASE_MANIFEST: PluginManifest = {
  name: "tracker",
  version: "1.0.0",
  displayName: "Tracker",
  description: "",
  vocabVersion: 1,
  entry: "index.cjs",
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

/**
 * A plugin whose `actions` is a plain object literal — the shape every real
 * plugin ships, and the reason a prototype-chain lookup is reachable at all.
 */
const PLUGIN_ENTRY = `
module.exports = {
  actions: {
    ping: (args) => ({ pong: args }),
    missing: undefined,
  },
};
`;

/**
 * `runPluginChild` talks to `process.stdin` and `process.stdout` and nothing
 * else, so the harness swaps both and drives the real function in-process. A
 * spawned child would need the file bundled first; the frame handling under
 * test is the same either way, and this keeps the failure readable.
 */
type Harness = {
  frames: PluginChildFrame[];
  send: (frame: PluginHostFrame) => void;
  invoke: (action: string, args?: Record<string, unknown>) => Promise<InvokeResult>;
};

type InvokeResult = Extract<PluginChildFrame, { type: "invokeResult" }>;

let harness: Harness;
let restore: (() => void)[] = [];

/** Let the child's promise chain run; `handleInvoke` is fire-and-forget. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(async () => {
  restore = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-plugin-child-"));
  fs.writeFileSync(path.join(root, "index.cjs"), PLUGIN_ENTRY, "utf8");
  restore.push(() => fs.rmSync(root, { recursive: true, force: true }));

  // The parent pid is cleared as well as the two required vars: with one set,
  // the orphan watchdog would start an interval that calls `process.exit` on
  // the vitest worker the moment it decided the "host" was gone.
  const previousEnv = {
    ADE_PLUGIN_ID: process.env.ADE_PLUGIN_ID,
    ADE_PLUGIN_ROOT: process.env.ADE_PLUGIN_ROOT,
    ADE_RUNTIME_PARENT_PID: process.env.ADE_RUNTIME_PARENT_PID,
  };
  process.env.ADE_PLUGIN_ID = "tracker";
  process.env.ADE_PLUGIN_ROOT = root;
  delete process.env.ADE_RUNTIME_PARENT_PID;
  restore.push(() => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  // `captureConsole` rewires the real console once the hello frame lands.
  const console0 = { log: console.log, info: console.info, debug: console.debug, warn: console.warn, error: console.error };
  restore.push(() => Object.assign(console, console0));

  const stdin = Object.assign(new EventEmitter(), { setEncoding: () => {} });
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process, "stdin");
  Object.defineProperty(process, "stdin", { configurable: true, value: stdin });
  restore.push(() => {
    if (stdinDescriptor) Object.defineProperty(process, "stdin", stdinDescriptor);
  });

  const frames: PluginChildFrame[] = [];
  const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    for (const line of String(chunk).split("\n")) {
      const frame = decodePluginFrame<PluginChildFrame>(line);
      if (frame) frames.push(frame);
    }
    return true;
  });
  restore.push(() => write.mockRestore());

  // The child installs its own fatal handlers; leaving them on the shared
  // process would swallow the next file's failures.
  const before = {
    uncaught: process.listeners("uncaughtException"),
    unhandled: process.listeners("unhandledRejection"),
  };
  restore.push(() => {
    for (const listener of process.listeners("uncaughtException")) {
      if (!before.uncaught.includes(listener)) process.off("uncaughtException", listener);
    }
    for (const listener of process.listeners("unhandledRejection")) {
      if (!before.unhandled.includes(listener)) process.off("unhandledRejection", listener);
    }
  });
  restore.push(() => { delete (globalThis as Record<string, unknown>).ade; });

  runPluginChild();

  let requestId = 0;
  const send = (frame: PluginHostFrame): void => { stdin.emit("data", encodePluginFrame(frame)); };
  harness = {
    frames,
    send,
    invoke: async (action, args = {}) => {
      requestId += 1;
      const id = `req-${requestId}`;
      send({ type: "invoke", requestId: id, action, args });
      await settle();
      const result = frames.find((frame): frame is InvokeResult => frame.type === "invokeResult" && frame.requestId === id);
      if (!result) throw new Error(`no invokeResult for "${action}"`);
      return result;
    },
  };

  send({ type: "hello", sdkVersion: 1, pluginId: "tracker", pluginRoot: root, manifest: BASE_MANIFEST, config: {} });
  await settle();
});

afterEach(() => {
  while (restore.length > 0) restore.pop()!();
  vi.restoreAllMocks();
});

describe("plugin child action dispatch", () => {
  it("advertises the plugin's own actions and runs one", async () => {
    const ready = harness.frames.find((frame) => frame.type === "ready");
    expect(ready).toMatchObject({ type: "ready", actions: ["ping", "missing"] });

    const result = await harness.invoke("ping", { n: 1 });
    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({ pong: { n: 1 } });
  });

  it.each(["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"])(
    "refuses the inherited %s as unsupported_method rather than invoking it",
    async (action) => {
      // Without the own-key check these resolve through `Object.prototype` to
      // real functions, pass the truthiness test, and answer a bogus success —
      // `Object(args)` or "[object Object]" — for an action no plugin declared.
      const result = await harness.invoke(action, { n: 1 });
      expect(result.result).toBeUndefined();
      expect(result.error?.code).toBe("unsupported_method");
      expect(result.error?.message).toContain(action);
    },
  );

  it("still answers unsupported_method for a plain unknown action and for an own key holding nothing", async () => {
    // The own-key guard must not turn either of these into something else:
    // an undeclared name, and a declared name whose value is undefined.
    for (const action of ["nope", "missing"]) {
      const result = await harness.invoke(action);
      expect(result.error?.code).toBe("unsupported_method");
    }
  });
});
