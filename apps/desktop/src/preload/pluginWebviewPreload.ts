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
 * BRIDGE_VERSION is 2, and it moves the way `PLUGIN_SDK_VERSION` moves: methods
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
import type { PluginActionPrompt, PluginActionPromptAnswer } from "../shared/plugins/sdk";
import {
  clampPluginWebviewHeight,
  isPluginWebviewEventName,
  PLUGIN_WEBVIEW_BRIDGE_VERSION,
  PLUGIN_WEBVIEW_EVENTS,
  PLUGIN_WEBVIEW_RESIZE_CHANNEL,
  type AdePluginWebviewBridge,
  type PluginWebviewComposerAttach,
  type PluginWebviewConfirm,
  type PluginWebviewContext,
  type PluginWebviewDialogSubmit,
  type PluginWebviewEventName,
  type PluginWebviewHandshake,
  type PluginWebviewHostKind,
  type PluginWebviewListOptions,
  type PluginWebviewMethod,
  type PluginWebviewResize,
  type PluginWebviewThemeSnapshot,
  type PluginWebviewToast,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * One IPC listener, fanned out to the page's own listeners by event name.
 *
 * The host sends every push on a single channel with the name inside the frame
 * (`PluginWebviewEventFrame`), so this file subscribes once and routes. A
 * channel per name would mean the preload guessing at names a future host might
 * add, and a page hearing nothing when it guessed wrong.
 */
const eventListeners = new Map<PluginWebviewEventName, Set<(payload: unknown) => void>>();
let eventChannelAttached = false;

function subscribeToEvent(
  event: PluginWebviewEventName,
  listener: (payload: unknown) => void,
): () => void {
  if (!eventChannelAttached) {
    eventChannelAttached = true;
    ipcRenderer.on(IPC.pluginWebviewEvent, (_ipcEvent: unknown, frame: unknown) => {
      // A frame that names no event is read as `changed`: that is what the v1
      // host sent bare on this channel, and a page written against v1 must keep
      // hearing its collection changes from a host that has not been restarted.
      const named = isRecord(frame) && isPluginWebviewEventName(frame.event) ? frame.event : null;
      const name: PluginWebviewEventName = named ?? "changed";
      const payload = named ? (frame as Record<string, unknown>).payload : frame;
      for (const registered of [...(eventListeners.get(name) ?? [])]) {
        try {
          registered(payload ?? {});
        } catch {
          // One page listener throwing must not stop the others hearing it.
        }
      }
    });
  }
  const set = eventListeners.get(event) ?? new Set<(payload: unknown) => void>();
  set.add(listener);
  eventListeners.set(event, set);
  return () => {
    eventListeners.get(event)?.delete(listener);
  };
}

const adePlugin: AdePluginWebviewBridge = {
  version: PLUGIN_WEBVIEW_BRIDGE_VERSION,
  pluginId: handshake.pluginId,
  context: handshake.context,

  collections: {
    get: (collection: string, key: string) => call("collections.get", { collection, key }),
    put: async (collection: string, key: string, value: unknown) => {
      await call("collections.put", { collection, key, value });
    },
    list: async (collection: string, options?: PluginWebviewListOptions) => {
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
    on: ((event: PluginWebviewEventName, listener: (payload: never) => void) => {
      // Checked against the closed list rather than ignored: a page that
      // subscribed to a name this host does not send would sit waiting forever
      // for an event, which is indistinguishable from a broken plugin.
      if (!PLUGIN_WEBVIEW_EVENTS.some((name) => name === event)) {
        throw new Error(`Unknown plugin event: ${String(event)}`);
      }
      return subscribeToEvent(event, listener as (payload: unknown) => void);
    }) as AdePluginWebviewBridge["events"]["on"],
  },

  openDeeplink: async (url: string) => {
    await call("openDeeplink", { url });
  },

  openSettings: async (target: { entryId: string } | { socketId: string }) => {
    await call("openSettings", { ...target });
  },

  surface: {
    close: async () => {
      await call("surface.close", {});
    },
  },

  composer: {
    attach: async (issue: PluginWebviewComposerAttach) => {
      await call("composer.attach", { issue });
    },
    insert: async (text: string) => {
      await call("composer.insert", { text });
    },
  },

  dialog: {
    // The same `{issue}` frame `composer.attach` sends, deliberately: the two
    // verbs carry the identical record and differ only in where the host puts
    // it. `null` rides as `null` rather than being dropped — it is the answer
    // that clears a previous choice, and a page that could not send it would
    // have no way to undo one. Where the page is drawn is not asserted here:
    // the host reads the placement it captured at attach and refuses anything
    // but a `dialog-picker`, because a claim from inside the guest is not a
    // fact about where ADE drew it.
    submit: async (answer: PluginWebviewDialogSubmit) => {
      await call("dialog.submit", { issue: answer?.issue ?? null });
    },
  },

  ui: {
    toast: async (toast: PluginWebviewToast) => {
      const answer = await call("ui.toast", { toast });
      const id = isRecord(answer) && typeof answer.id === "string" ? answer.id : "";
      return { id };
    },
    dismissToast: async (id: string) => {
      await call("ui.dismissToast", { id });
    },
    prompt: async (prompt: PluginActionPrompt) => {
      const answer = await call("ui.prompt", { prompt });
      return (answer ?? null) as PluginActionPromptAnswer | null;
    },
    confirm: async (request: PluginWebviewConfirm) => {
      return (await call("ui.confirm", { confirm: request })) === true;
    },
    // `sendToHost`, not `invoke`: this reaches the `<webview>` element that owns
    // the frame, which is the only party that can grow it, and it authorizes
    // nothing — a page reporting its own height cannot move or cover anything
    // outside its own frame. See `PLUGIN_WEBVIEW_RESIZE_CHANNEL`. Clamped here
    // as well as in the host so the page's own logging shows the number that
    // will actually be applied, and an unusable value is dropped rather than
    // sent as a zero the host would read as "collapse me".
    resize: (size: PluginWebviewResize) => {
      const height = clampPluginWebviewHeight(size?.height);
      if (height === null) return;
      ipcRenderer.sendToHost(PLUGIN_WEBVIEW_RESIZE_CHANNEL, { height });
    },
  },

  clipboard: {
    read: async () => {
      const text = await call("clipboard.read", {});
      return typeof text === "string" ? text : "";
    },
    write: async (text: string) => {
      await call("clipboard.write", { text });
    },
  },

  theme: {
    get: async () => {
      const theme = await call("theme.get", {});
      return (theme ?? { scheme: "dark", tokens: {} }) as PluginWebviewThemeSnapshot;
    },
  },

  host: {
    // The unsubscribe function is handed back rather than a handle the page has
    // to keep: a page that loses the id has no way to stop a subscription, and
    // the closure cannot be forged into someone else's.
    subscribe: async (options: { kinds: PluginWebviewHostKind[] }) => {
      const answer = await call("host.subscribe", { kinds: options.kinds });
      const subscriptionId = isRecord(answer) && typeof answer.subscriptionId === "string"
        ? answer.subscriptionId
        : "";
      let stopped = false;
      return () => {
        if (stopped || !subscriptionId) return;
        stopped = true;
        void call("host.unsubscribe", { subscriptionId }).catch(() => {
          // A guest that is already gone has nothing to unsubscribe from.
        });
      };
    },
  },
};

contextBridge.exposeInMainWorld("adePlugin", adePlugin);
