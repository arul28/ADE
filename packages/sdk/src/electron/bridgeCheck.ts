/**
 * Check a hand-written preload bridge against the one this SDK version ships.
 *
 * `@ade-dev/sdk/electron/preload-auto` must be `webPreferences.preload`
 * itself, so a host with its own preload either bundles `exposeAdeBridge` into
 * it or copies it by hand. A hand copy can drift from the SDK (a channel name,
 * the payload shape) with no compile error and no runtime error: the bridge
 * simply never answers. Run this in the host's test suite, in Node, against the
 * function that exposes the copy.
 */

import { AdeError } from "../errors.js";
import {
  ADE_DEFAULT_BRIDGE_KEY,
  ADE_DEFAULT_CHANNEL_PREFIX,
  eventChannel,
  invokeChannel,
  type ContextBridgeLike,
  type IpcRendererLike,
} from "./protocol.js";

export type CheckAdeBridgeOptions = {
  /** The `window` key the copy should expose. Defaults to `"ade"`. */
  key?: string;
  /** The channel namespace the main process uses. Defaults to `"ade"`. */
  channelPrefix?: string;
};

type Listener = (event: unknown, ...args: unknown[]) => void;

function fail(detail: string): never {
  throw new AdeError("invalid_option", `The preload bridge does not match @ade-dev/sdk: ${detail}`);
}

/**
 * Run `expose` with a fake `contextBridge` and `ipcRenderer`, and check that
 * what it exposes behaves like `exposeAdeBridge` from this SDK version:
 *   - one object on `window[key]` with `invoke` and `onEvent`;
 *   - `invoke(method, args)` calls `ipcRenderer.invoke(<prefix>:invoke,
 *     { method, args })` and resolves to its result unchanged;
 *   - `onEvent(listener)` listens on `<prefix>:event`, passes each payload
 *     through unchanged, and its return value removes that same listener.
 *
 * Resolves when the copy matches. Rejects with `AdeError("invalid_option")`
 * naming the first difference. `expose` is typically
 * `(contextBridge, ipcRenderer) => { ...your preload's bridge code... }`.
 */
export async function checkAdeBridge(
  expose: (contextBridge: ContextBridgeLike, ipcRenderer: IpcRendererLike) => void,
  opts: CheckAdeBridgeOptions = {},
): Promise<void> {
  const key = opts.key?.trim() || ADE_DEFAULT_BRIDGE_KEY;
  const prefix = opts.channelPrefix?.trim() || ADE_DEFAULT_CHANNEL_PREFIX;
  const exposed = new Map<string, unknown>();
  const invokes: Array<{ channel: string; args: unknown[] }> = [];
  const listeners = new Map<string, Set<Listener>>();
  const reply = { ok: true, value: { probe: true } };

  const contextBridge: ContextBridgeLike = {
    exposeInMainWorld(name, api) {
      exposed.set(name, api);
    },
  };
  const ipcRenderer: IpcRendererLike = {
    invoke(channel, ...args) {
      invokes.push({ channel, args });
      return Promise.resolve(reply);
    },
    on(channel, listener) {
      let set = listeners.get(channel);
      if (!set) {
        set = new Set();
        listeners.set(channel, set);
      }
      set.add(listener as Listener);
      return ipcRenderer;
    },
    removeListener(channel, listener) {
      listeners.get(channel)?.delete(listener as Listener);
      return ipcRenderer;
    },
  };

  expose(contextBridge, ipcRenderer);

  const bridge = exposed.get(key) as
    | { invoke?: unknown; onEvent?: unknown }
    | undefined;
  if (!bridge || typeof bridge !== "object") {
    fail(`nothing was exposed on window.${key} (exposed: ${[...exposed.keys()].join(", ") || "nothing"}).`);
  }
  if (typeof bridge.invoke !== "function" || typeof bridge.onEvent !== "function") {
    fail(`window.${key} must have the functions invoke and onEvent.`);
  }

  const args = ["probe", 1];
  const result = await (bridge.invoke as (method: string, args: unknown[]) => Promise<unknown>)(
    "doctor",
    args,
  );
  const call = invokes[0];
  if (!call) fail("invoke() did not call ipcRenderer.invoke.");
  if (call.channel !== invokeChannel(prefix)) {
    fail(`invoke() used channel "${call.channel}"; the main process listens on "${invokeChannel(prefix)}".`);
  }
  const payload = call.args[0] as { method?: unknown; args?: unknown } | undefined;
  if (
    call.args.length !== 1
    || !payload
    || payload.method !== "doctor"
    || !Array.isArray(payload.args)
    || payload.args.length !== args.length
    || payload.args.some((value, index) => value !== args[index])
  ) {
    fail("invoke(method, args) must send exactly one argument, { method, args }.");
  }
  if (result !== reply) fail("invoke() must resolve to ipcRenderer.invoke's result unchanged.");

  const received: unknown[] = [];
  const stop = (bridge.onEvent as (listener: (payload: unknown) => void) => unknown)((value) => {
    received.push(value);
  });
  const eventName = eventChannel(prefix);
  const attached = listeners.get(eventName);
  if (!attached || attached.size !== 1) {
    const other = [...listeners.keys()].filter((name) => (listeners.get(name)?.size ?? 0) > 0);
    fail(`onEvent() must listen on "${eventName}" (listening on: ${other.join(", ") || "nothing"}).`);
  }
  const sample = { kind: "probe" };
  for (const listener of attached) listener({ sender: null }, sample);
  if (received.length !== 1 || received[0] !== sample) {
    fail("onEvent() must pass the payload (the second ipcRenderer argument) to the listener unchanged.");
  }
  if (typeof stop !== "function") fail("onEvent() must return a function that removes the listener.");
  (stop as () => void)();
  if ((listeners.get(eventName)?.size ?? 0) !== 0) {
    fail("the function onEvent() returned did not remove its ipcRenderer listener.");
  }
}
