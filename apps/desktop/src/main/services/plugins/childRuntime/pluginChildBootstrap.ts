/**
 * The process a plugin's code actually runs in.
 *
 * Bundled as a standalone CJS script and started by `pluginChildSupervisor`
 * with `spawn(process.execPath, [thisFile])`. It talks NDJSON over stdio and
 * nothing else: stdin carries host frames, stdout carries child frames, stderr
 * is free-form diagnostics the supervisor rings for crash messages.
 *
 * Everything here runs with the plugin's code in the same isolate, so the file
 * assumes the plugin is buggy, not malicious-proof: it guards the protocol
 * (console capture, frame caps, structural errors) and lets the host own every
 * capability the plugin could otherwise reach.
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { isPathInside } from "../../shared/pathCompare";
import {
  decodePluginFrame,
  encodePluginFrame,
  fromPluginStructuralError,
  pluginCollectionPutParams,
  PluginSdkError,
  readPluginChatDeliveryAction,
  toPluginStructuralError,
  type AdePluginSdk,
  type PluginAnyEventPayload,
  type PluginAudioClip,
  type PluginAuthSessionStart,
  type PluginChatHydrateResult,
  type PluginCredentialHandoffResult,
  type PluginOfficialOAuthClient,
  type PluginSessionIssues,
  type PluginChatSessionRef,
  type PluginChildFrame,
  type PluginCollectionRow,
  type PluginEventName,
  type PluginHostFrame,
  type PluginIssueLink,
  type PluginLaneSummary,
  type PluginLogLevel,
  type PluginModule,
  type PluginNotificationResult,
  type PluginSchedule,
  type PluginSdkMethod,
} from "../../../../shared/plugins/sdk";
import type { PluginManifest } from "../../../../shared/plugins/manifest";
import type { PluginEntityKind, PluginSocketKind } from "../../../../shared/plugins/sockets";
import { installPluginNetworkGuard } from "./pluginChildNetworkGuard";

/** One stdin line larger than this is a framing failure, not a message. */
const PLUGIN_CHILD_MAX_LINE_BYTES = 8 * 1024 * 1024;

/** How often the child checks that its parent is still alive. */
const PLUGIN_CHILD_ORPHAN_POLL_MS = 2_000;

function writeFrame(frame: PluginChildFrame): void {
  try {
    process.stdout.write(encodePluginFrame(frame));
  } catch {
    // The host is gone; the orphan watchdog will take this process with it.
  }
}

function fatal(error: unknown, exitCode = 1): never {
  writeFrame({ type: "fatal", error: toPluginStructuralError(error) });
  process.exit(exitCode);
}

/**
 * Reroute `console` BEFORE the plugin entry is loaded.
 *
 * LOAD-BEARING: stdout is the NDJSON frame channel. A single `console.log` from
 * plugin code — or from a dependency it pulled in at import time — would inject
 * a non-frame line into the stream and desynchronise the host's line reader.
 * Captured output becomes `log` frames instead, which is also what makes it
 * visible in `ade plugin logs`.
 */
function captureConsole(emit: (level: PluginLogLevel, message: string) => void): void {
  const render = (parts: unknown[]): string => parts
    .map((part) => {
      if (typeof part === "string") return part;
      try {
        return JSON.stringify(part);
      } catch {
        return String(part);
      }
    })
    .join(" ");
  const bind = (level: PluginLogLevel) => (...parts: unknown[]): void => emit(level, render(parts));
  console.log = bind("info");
  console.info = bind("info");
  console.debug = bind("debug");
  console.warn = bind("warn");
  console.error = bind("error");
}

function readParentPid(): number | null {
  const raw = process.env.ADE_RUNTIME_PARENT_PID?.trim();
  if (!raw) return null;
  const pid = Number.parseInt(raw, 10);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Self-exit when the host disappears. Same contract as the runtime's own orphan
 * check: a plugin child holding a lane's files open after ADE quit is a wedge
 * nobody goes looking for.
 */
function startOrphanWatchdog(): void {
  const parentPid = readParentPid();
  if (parentPid == null || parentPid === process.pid) return;
  const timer = setInterval(() => {
    if (process.ppid === 1 || !isPidAlive(parentPid)) process.exit(0);
  }, PLUGIN_CHILD_ORPHAN_POLL_MS);
  timer.unref?.();
}

/** Resolve the manifest entry against the plugin root, refusing any escape. */
function resolveEntryPath(pluginRoot: string, entry: string): string {
  const root = fs.realpathSync(pluginRoot);
  const resolved = path.resolve(root, entry);
  const real = fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
  if (!isPathInside(real, root)) {
    throw new PluginSdkError("not_permitted", `Plugin entry "${entry}" resolves outside the plugin directory.`);
  }
  return real;
}

export function runPluginChild(): void {
  const pluginId = process.env.ADE_PLUGIN_ID?.trim() ?? "";
  const pluginRootEnv = process.env.ADE_PLUGIN_ROOT?.trim() ?? "";
  if (!pluginId || !pluginRootEnv) fatal(new Error("ADE_PLUGIN_ID and ADE_PLUGIN_ROOT are required."));

  const pendingSdk = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const listeners = new Map<PluginEventName, Set<(payload: PluginAnyEventPayload) => void>>();
  let pluginModule: PluginModule | null = null;
  let started = false;

  const emitLog = (level: PluginLogLevel, message: string, fields?: Record<string, unknown>): void => {
    writeFrame({ type: "log", level, message, ...(fields ? { fields } : {}) });
  };

  const callHost = (method: PluginSdkMethod, params: Record<string, unknown>): Promise<unknown> => {
    const requestId = randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      pendingSdk.set(requestId, { resolve, reject });
      writeFrame({ type: "sdk", requestId, method, params });
    });
  };

  /**
   * Tell the host this child does or does not want an event kind.
   *
   * Deliberately not awaited and deliberately swallowed. `ade.events.on` is a
   * synchronous call that returns an unsubscribe function, so there is nothing
   * to hand a rejection to — and an unhandled one here would reach the child's
   * `unhandledRejection` handler, which is fatal. An older host that has never
   * heard of the method answers `unsupported_method`; the plugin's listener
   * still works for every event that host broadcasts, which is exactly the
   * additive-handshake promise.
   */
  const tellHostSubscription = (event: PluginEventName, subscribed: boolean): void => {
    void callHost("events.subscribe", { event, subscribed }).catch(() => {});
  };

  let helloSdkVersion = 0;

  const buildSdk = (manifest: PluginManifest): AdePluginSdk => ({
    pluginId,
    sdkVersion: helloSdkVersion,
    manifest,
    actions: {
      invoke: (domain, action, args) => callHost("actions.invoke", { domain, action, args: args ?? {} }),
    },
    collections: {
      get: (collection, key) => callHost("collections.get", { collection, key }),
      put: async (collection, key, value, options) => {
        await callHost("collections.put", pluginCollectionPutParams(collection, key, value, options));
      },
      delete: async (collection, key) => {
        await callHost("collections.delete", { collection, key });
      },
      list: async (collection, options) => (
        await callHost("collections.list", { collection, options: options ?? {} })
      ) as PluginCollectionRow[],
    },
    secrets: {
      get: async (name) => (await callHost("secrets.get", { name })) as string | null,
      set: async (name, value) => {
        await callHost("secrets.set", { name, value });
      },
      delete: async (name) => {
        await callHost("secrets.delete", { name });
      },
      getProviderKey: async (provider) => (
        await callHost("secrets.getProviderKey", { provider })
      ) as string | null,
      hasProviderKey: async (provider) => (
        await callHost("secrets.hasProviderKey", { provider })
      ) as boolean,
    },
    auth: {
      beginSession: async (input) => (
        await callHost("auth.beginSession", {
          sessionId: input.sessionId,
          params: input.params ?? {},
          ...(input.transport ? { transport: input.transport } : {}),
        })
      ) as PluginAuthSessionStart,
      cancelSession: async (sessionId) => {
        await callHost("auth.cancelSession", { sessionId });
      },
      requestHandoff: async (builtin) => (
        await callHost("auth.requestHandoff", { builtin })
      ) as PluginCredentialHandoffResult,
      officialClient: async (provider) => (
        await callHost("auth.officialClient", { provider })
      ) as PluginOfficialOAuthClient,
    },
    contributions: {
      publish: async (
        entityKind: PluginEntityKind,
        entityId: string,
        socket: PluginSocketKind,
        payload: Record<string, unknown> | null,
      ) => {
        await callHost("contributions.publish", { entityKind, entityId, socket, payload });
      },
    },
    events: {
      on: (event, listener) => {
        const wrapped = listener as (payload: PluginAnyEventPayload) => void;
        let set = listeners.get(event);
        if (!set) {
          set = new Set();
          listeners.set(event, set);
        }
        const wasEmpty = set.size === 0;
        set.add(wrapped);
        // The host delivers a runtime hook only to the children that asked for
        // it — `tool.before` fires dozens of times a turn, and a plugin that
        // never listens should not be written to at all. Told on the FIRST
        // listener for a kind and untold on the last, so a plugin that adds and
        // drops listeners does not restate the subscription per call.
        if (wasEmpty) tellHostSubscription(event, true);
        return () => {
          if (!set?.delete(wrapped)) return;
          if (set.size === 0) tellHostSubscription(event, false);
        };
      },
    },
    panels: {
      update: async (panelId, schema) => {
        await callHost("panels.update", { panelId, schema });
      },
    },
    config: {
      get: async () => (await callHost("config.get", {})) as Record<string, string | number | boolean | null>,
      // Both author spellings — `set("k", v)` and `set({k: v})` — normalize to
      // the one `{values}` frame the host validates, so a plugin writing a
      // whole form pays for one call and one file write.
      //
      // `value === undefined` becomes `null`, which the host reads as "reset to
      // the manifest default". `false` and `0` are values, not absences, so the
      // check is on `undefined` alone.
      set: async (
        keyOrValues: string | Record<string, string | number | boolean | null>,
        value?: string | number | boolean | null,
      ) => (await callHost("config.set", {
        values: typeof keyOrValues === "string"
          ? { [keyOrValues]: value === undefined ? null : value }
          : keyOrValues,
      })) as Record<string, string | number | boolean | null>,
    },
    audio: {
      captureClip: async (options) => (
        await callHost("audio.captureClip", { options: options ?? {} })
      ) as PluginAudioClip,
    },
    notifications: {
      post: async (input) => (
        await callHost("notifications.post", { input: input ?? {} })
      ) as PluginNotificationResult,
    },
    schedules: {
      create: async (input) => (
        await callHost("schedules.create", { input: input ?? {} })
      ) as PluginSchedule,
      list: async () => (await callHost("schedules.list", {})) as PluginSchedule[],
      delete: async (scheduleId) => {
        await callHost("schedules.delete", { scheduleId });
      },
    },
    automations: {
      emitTrigger: async (input) => {
        await callHost("automations.emitTrigger", { input: input ?? {} });
      },
    },
    webhooks: {
      url: async (channelId) => (
        await callHost("webhooks.url", channelId ? { channelId } : {})
      ) as string,
      ack: async (deliveryId) => {
        await callHost("webhooks.ack", { deliveryId });
      },
    },
    chat: {
      createSession: async (input) => (
        await callHost("chat.createSession", { input })
      ) as PluginChatSessionRef,
      appendAssistant: async (sessionId, chunk) => {
        await callHost("chat.appendAssistant", { sessionId, chunk });
      },
      appendUser: async (sessionId, input) => {
        await callHost("chat.appendUser", { sessionId, input });
      },
      emitStatus: async (sessionId, status) => {
        await callHost("chat.emitStatus", { sessionId, status });
      },
      setArtifacts: async (sessionId, artifacts) => {
        await callHost("chat.setArtifacts", { sessionId, artifacts });
      },
      attachBranch: async (sessionId, input) => {
        await callHost("chat.attachBranch", { sessionId, input });
      },
      // Returns the host's page result so a plugin can stop paging once ADE
      // says it already had that far back. See `PluginChatHydrateResult`.
      hydrate: async (sessionId, transcript, options) => (
        await callHost("chat.hydrate", {
          sessionId,
          transcript,
          ...(options ? { options } : {}),
        }) as PluginChatHydrateResult
      ),
    },
    lanes: {
      list: async () => (await callHost("lanes.list", {})) as PluginLaneSummary[],
      get: async (laneId) => (
        await callHost("lanes.get", { laneId })
      ) as PluginLaneSummary | null,
      listSessionIssues: async (laneId) => (
        await callHost("lanes.listSessionIssues", { laneId })
      ) as PluginSessionIssues[],
      // `input.issue` carries no `pluginId`: the host stamps the calling
      // plugin's own id over whatever arrived, and unlinking checks against
      // that. See `PluginIssueRefInput`.
      linkIssue: async (input) => (
        await callHost("lanes.linkIssue", { input })
      ) as PluginIssueLink,
      unlinkIssue: async (input) => (
        await callHost("lanes.unlinkIssue", { input })
      ) as boolean,
    },
    clipboard: {
      read: async () => (await callHost("clipboard.read", {})) as string,
      write: async (text) => {
        await callHost("clipboard.write", { text });
      },
    },
    dialogs: {
      pickFile: async (options) => (
        await callHost("dialogs.pickFile", { options: options ?? {} })
      ) as string,
    },
    memory: {
      get: (key) => callHost("memory.get", { key }),
      set: async (key, value) => {
        await callHost("memory.set", { key, value });
      },
      delete: async (key) => {
        await callHost("memory.delete", { key });
      },
      list: async (options) => (
        await callHost("memory.list", { options: options ?? {} })
      ) as PluginCollectionRow[],
    },
    log: emitLog,
  });

  const handleHello = async (frame: Extract<PluginHostFrame, { type: "hello" }>): Promise<void> => {
    if (started) return;
    started = true;
    helloSdkVersion = frame.sdkVersion;
    captureConsole((level, message) => emitLog(level, message));
    const sdk = buildSdk(frame.manifest);
    // Plugin code reads `ade` as a global rather than importing anything: the
    // child has no ADE package on disk to resolve, and a global keeps the
    // plugin's own module graph free of a host dependency.
    (globalThis as Record<string, unknown>).ade = sdk;

    // BEFORE the entry is required, for the same reason `captureConsole` is: a
    // dependency that opens a socket at import time is exactly the case a
    // guard installed afterwards would miss. A manifest with no `network`
    // declares no hosts, which is a real answer — that plugin reaches none.
    installPluginNetworkGuard({
      pluginId,
      hosts: frame.manifest.network?.hosts ?? [],
      onRefused: (message, fields) => emitLog("warn", message, fields),
    });

    const entry = frame.manifest.entry;
    if (entry) {
      const entryPath = resolveEntryPath(frame.pluginRoot, entry);
      // `createRequire` anchored inside the plugin so its own `node_modules`
      // resolve, and so esbuild leaves this dynamic load alone at bundle time.
      const requireFromPlugin = createRequire(path.join(frame.pluginRoot, "noop.cjs"));
      const loaded = requireFromPlugin(entryPath) as PluginModule & { default?: PluginModule };
      pluginModule = loaded.default ?? loaded;
      await pluginModule.activate?.(sdk);
    }
    writeFrame({ type: "ready", actions: Object.keys(pluginModule?.actions ?? {}) });
  };

  /**
   * Run the plugin's `chat.turn` / `chat.interrupt` listeners and WAIT for them.
   *
   * These two arrive as reserved `invoke` actions rather than `event` frames
   * because the transport's event channel is fire-and-forget by contract — the
   * host drops frames a wedged child is not draining — and a dropped user
   * message is a chat that silently stops answering. Reusing `invoke` gets the
   * request id, the timeout and a structured rejection for free.
   *
   * Every listener is awaited, and one that throws fails the turn: the host
   * turns the rejection into a visible failed turn rather than leaving the
   * user watching a spinner. A plugin that registered no listener at all is
   * `unsupported_method`, which is the honest answer — it declared a chat
   * runtime and never wired it up.
   */
  const runChatDelivery = async (event: "chat.turn" | "chat.interrupt", payload: unknown): Promise<null> => {
    const registered = [...(listeners.get(event) ?? [])];
    if (!registered.length) {
      throw new PluginSdkError(
        "unsupported_method",
        `Plugin "${pluginId}" declares a chat runtime but registered no "${event}" listener.`,
      );
    }
    await Promise.all(registered.map(async (listener) => {
      await (listener as (value: unknown) => unknown | Promise<unknown>)(payload);
    }));
    return null;
  };

  const handleInvoke = async (frame: Extract<PluginHostFrame, { type: "invoke" }>): Promise<void> => {
    try {
      const chatEvent = readPluginChatDeliveryAction(frame.action);
      if (chatEvent) {
        const delivered = await runChatDelivery(chatEvent, frame.args);
        writeFrame({ type: "invokeResult", requestId: frame.requestId, result: delivered });
        return;
      }
      const handler = pluginModule?.actions?.[frame.action];
      if (!handler) {
        throw new PluginSdkError("unsupported_method", `Plugin "${pluginId}" has no action "${frame.action}".`);
      }
      const result = await handler(frame.args);
      writeFrame({ type: "invokeResult", requestId: frame.requestId, result });
    } catch (error) {
      writeFrame({ type: "invokeResult", requestId: frame.requestId, error: toPluginStructuralError(error) });
    }
  };

  const handleShutdown = async (): Promise<void> => {
    try {
      await pluginModule?.deactivate?.();
    } catch (error) {
      emitLog("error", `deactivate failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exit(0);
  };

  const handleFrame = (frame: PluginHostFrame): void => {
    switch (frame.type) {
      case "hello":
        void handleHello(frame).catch((error: unknown) => fatal(error));
        return;
      case "invoke":
        void handleInvoke(frame);
        return;
      case "event": {
        for (const listener of listeners.get(frame.payload.event) ?? []) {
          try {
            listener(frame.payload);
          } catch (error) {
            emitLog("error", `event listener failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        return;
      }
      case "sdkResult": {
        const waiter = pendingSdk.get(frame.requestId);
        if (!waiter) return;
        pendingSdk.delete(frame.requestId);
        if (frame.error) waiter.reject(fromPluginStructuralError(frame.error));
        else waiter.resolve(frame.result);
        return;
      }
      case "shutdown":
        void handleShutdown();
        return;
    }
  };

  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    if (buffer.length > PLUGIN_CHILD_MAX_LINE_BYTES) {
      fatal(new PluginSdkError("invalid_args", "Host frame exceeded the NDJSON line limit."));
    }
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const frame = decodePluginFrame<PluginHostFrame>(line);
      if (frame) handleFrame(frame);
    }
  });
  process.stdin.on("end", () => process.exit(0));
  process.stdin.on("error", () => process.exit(0));

  startOrphanWatchdog();

  process.on("uncaughtException", (error) => fatal(error));
  process.on("unhandledRejection", (reason) => fatal(reason));
}

function isEntryModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = typeof __filename === "string" ? __filename : fileURLToPath(import.meta.url);
  try {
    return path.resolve(entry) === path.resolve(self);
  } catch {
    return false;
  }
}

// Both conditions matter: the env check keeps a test that imports this module
// from spawning a protocol handler, and the entry check keeps a bundler that
// pulls the file into another graph from doing the same.
if (process.env.ADE_PLUGIN_ID && isEntryModule()) runPluginChild();
