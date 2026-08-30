/**
 * `window.adePlugin` — the only thing a plugin's own page can reach.
 *
 * This preload runs INSIDE the guest: sandboxed, context-isolated, no Node, and
 * loaded next to HTML the plugin wrote. It publishes one object and nothing
 * else. There is no `window.ade`, no `ipcRenderer`, no `require` — a page that
 * wants anything else has to ask through a method named in
 * {@link PLUGIN_WEBVIEW_METHODS}, and the host answers against the plugin id it
 * derived itself.
 *
 * ## The stability promise
 *
 * BRIDGE_VERSION is 1, and it moves the way `PLUGIN_SDK_VERSION` moves: methods
 * are added, never removed or re-shaped. `window.adePlugin.version` is what a
 * page checks before calling something a v1 host would not have. Every call
 * carries the version it was written against, so the host can refuse a page
 * claiming to be newer than the preload it was actually handed.
 *
 * ## Why the plugin id is not read from `location`
 *
 * It would be one line, and it would be worth nothing. This file runs inside the
 * guest, so anything it derives locally is only as trustworthy as the guest is —
 * a page that could influence its own URL would be naming its own plugin id.
 * The id is asked of the HOST once, synchronously, over
 * {@link IPC.pluginWebviewHandshake}, and the host answers from the registry it
 * wrote when it approved the attach. It is exposed only so a page can label
 * itself; nothing on the wire carries it, because every call is already answered
 * against the sender's own origin.
 *
 * ## Deliberately absent
 *
 * `secrets` (a page is the last place a plugin's credentials should be
 * readable), `contributions.publish` and `panels.update` (a page draws itself;
 * publishing into ADE's other surfaces is the child process's job),
 * `collections.delete` (destructive, and not needed to build a UI), and any
 * form of raw IPC. None of these are stubbed — a missing method reads as "this
 * host cannot do it", and a stub reads as a button that always fails.
 */

import { contextBridge, ipcRenderer } from "electron";

import { stripElectronErrorWrapper } from "../shared/codedError";
import { IPC } from "../shared/ipc";
import {
  PLUGIN_WEBVIEW_BRIDGE_VERSION,
  PLUGIN_WEBVIEW_EVENTS,
  type AdePluginWebviewBridge,
  type PluginWebviewChangeEvent,
  type PluginWebviewContext,
  type PluginWebviewEventName,
  type PluginWebviewHandshake,
  type PluginWebviewMethod,
} from "../shared/plugins/webviewBridge";

/**
 * One call, one refusal shape.
 *
 * Electron wraps a rejected handler's error as
 * `Error invoking remote method '…': Error: <code>: <message>`; the page gets
 * the host's own sentence with that wrapper stripped and no stack — a stack
 * from the main process is not the page's to read, and it names files the plugin
 * author cannot act on.
 */
async function call(method: PluginWebviewMethod, params: Record<string, unknown>): Promise<unknown> {
  try {
    return await ipcRenderer.invoke(IPC.pluginWebviewBridge, {
      bridgeVersion: PLUGIN_WEBVIEW_BRIDGE_VERSION,
      method,
      params,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(stripElectronErrorWrapper(message));
  }
}

/**
 * The host's answer to "which plugin is this page".
 *
 * Synchronous because `pluginId` is a plain property on the bridge: a page reads
 * it while rendering, and a promise there would make every plugin write an
 * await for a fact the host already knew before the page loaded. Empty when the
 * host declines to say, which is the same answer as "this is not a plugin
 * surface" — every method call would be refused on the same grounds.
 */
function readHandshake(): PluginWebviewHandshake {
  try {
    const answer: unknown = ipcRenderer.sendSync(IPC.pluginWebviewHandshake);
    if (answer && typeof answer === "object") {
      const record = answer as Record<string, unknown>;
      const pluginId = typeof record.pluginId === "string" ? record.pluginId : "";
      const context = record.context && typeof record.context === "object"
        ? (record.context as PluginWebviewContext)
        : null;
      return { pluginId, context };
    }
  } catch {
    // Fall through to the empty handshake.
  }
  return { pluginId: "", context: null };
}

const handshake = readHandshake();

const adePlugin: AdePluginWebviewBridge = {
  version: PLUGIN_WEBVIEW_BRIDGE_VERSION,
  pluginId: handshake.pluginId,
  context: handshake.context,

  collections: {
    get: (collection: string, key: string) => call("collections.get", { collection, key }),
    put: async (collection: string, key: string, value: unknown) => {
      await call("collections.put", { collection, key, value });
    },
    list: async (collection: string, options?: { keyPrefix?: string; limit?: number }) => {
      const rows = await call("collections.list", { collection, ...(options ? { options } : {}) });
      return Array.isArray(rows) ? rows as { key: string; value: unknown }[] : [];
    },
  },

  invoke: (action: string, args?: Record<string, unknown>) =>
    call("invoke", { action, ...(args ? { args } : {}) }),

  config: {
    get: async () => {
      const config = await call("config.get", {});
      return (config ?? {}) as Record<string, string | number | boolean | null>;
    },
    // Both spellings normalize to the one `{values}` frame the host validates.
    // `undefined` becomes `null`, which the host reads as "reset to the
    // manifest default"; `false` and `0` are values, so the check is on
    // `undefined` alone.
    set: async (
      keyOrValues: string | Record<string, string | number | boolean | null>,
      value?: string | number | boolean | null,
    ) => {
      const config = await call("config.set", {
        values: typeof keyOrValues === "string"
          ? { [keyOrValues]: value === undefined ? null : value }
          : keyOrValues,
      });
      return (config ?? {}) as Record<string, string | number | boolean | null>;
    },
  },

  events: {
    on: (event: PluginWebviewEventName, listener: (payload: PluginWebviewChangeEvent) => void) => {
      // Checked against the closed list rather than ignored: a page that
      // subscribed to a name this host does not send would sit waiting forever
      // for an event, which is indistinguishable from a broken plugin.
      if (!PLUGIN_WEBVIEW_EVENTS.some((name) => name === event)) {
        throw new Error(`Unknown plugin event: ${String(event)}`);
      }
      const forward = (_event: unknown, payload: unknown): void => {
        listener((payload ?? {}) as PluginWebviewChangeEvent);
      };
      ipcRenderer.on(IPC.pluginWebviewEvent, forward);
      return () => {
        ipcRenderer.removeListener(IPC.pluginWebviewEvent, forward);
      };
    },
  },

  openDeeplink: async (url: string) => {
    await call("openDeeplink", { url });
  },
};

contextBridge.exposeInMainWorld("adePlugin", adePlugin);
