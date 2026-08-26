/**
 * The host half of `window.adePlugin` — see `shared/plugins/webviewBridge.ts`
 * for the contract this implements.
 *
 * ## The one rule
 *
 * **The plugin id comes from the sender, never from the payload.** Every call
 * is answered against the id derived from the guest's own frame URL
 * (`ade-plugin://<pluginId>/…`), cross-checked against what the window layer
 * recorded when it approved the attach. A page cannot change either: the origin
 * is fixed by the URL the host loaded, and the registry entry was written
 * before the page ran a line of script. `PluginWebviewRequest` carries no
 * `pluginId` field at all, so a payload that invents one is not "overridden" —
 * it is simply never read.
 *
 * ## Why the write path is not the action domain
 *
 * Reads go through the ordinary `plugin` action domain, the same one the
 * renderer and the CLI use. Writing a collection has no domain action and does
 * not get one here: `PLUGIN_DOMAIN_ACTIONS` is a closed list mirrored by the
 * RPC schema and iOS's compile-time allowlist, and a write action on it would
 * let any client write any plugin's rows. The bridge instead reaches the host
 * service's own writer, which applies the SAME manifest-declared-collection
 * rule `pluginSdkServer.ts` applies to a plugin's own child process — an
 * undeclared collection is refused rather than created, so `plugin.json` stays
 * an honest description of what a plugin stores.
 *
 * Electron-free by construction: the sender arrives as an id plus a URL, and
 * every effect (navigate, open externally, push) is an injected function.
 */

import { IPC } from "../../../shared/ipc";
import { isRecord } from "../../../shared/plugins/parse";
import {
  assertPluginCollectionKey,
  assertPluginCollectionName,
  PluginSdkError,
  type PluginDomainService,
} from "../../../shared/plugins/sdk";
import {
  isPluginWebviewMethod,
  parsePluginWebviewUrl,
  PLUGIN_WEBVIEW_BRIDGE_VERSION,
  type PluginWebviewChangeEvent,
  type PluginWebviewHandshake,
  type PluginWebviewMethod,
} from "../../../shared/plugins/webviewBridge";
import { subscribeToPluginChanges } from "./pluginEvents";
import {
  getPluginWebviewGuest,
  listPluginWebviewGuests,
  type PluginWebviewGuest,
} from "./pluginWebviewGuests";

/**
 * The slice of the plugin domain a page can reach.
 *
 * A `Pick` rather than the whole service because this is also the shape of what
 * a routed caller has to be able to answer, and naming four methods keeps that
 * obligation small and visible.
 */
export type PluginWebviewDomain = Pick<
  PluginDomainService,
  "get" | "getCollection" | "getManifest" | "invoke"
>;

export type PluginWebviewSender = {
  /** `event.sender.id`. The only identity an IPC message carries. */
  webContentsId: number;
  /** `event.senderFrame?.url ?? event.sender.getURL()`. */
  frameUrl: string;
};

export type PluginWebviewBridgeDeps = {
  /** The plugin domain, scoped the way the guest's host window is scoped. */
  domainFor: (guest: PluginWebviewGuest) => PluginWebviewDomain | Promise<PluginWebviewDomain>;
  /** The collections writer. See the module header for why it is separate. */
  putCollection: (args: {
    guest: PluginWebviewGuest;
    collection: string;
    key: string;
    value: unknown;
  }) => void | Promise<void>;
  /** Dispatch an `ade://` deeplink into the app. */
  openDeeplink: (args: { guest: PluginWebviewGuest; url: string }) => void | Promise<void>;
  /** Send an `https:`/`http:` URL to the user's real browser. */
  openExternalUrl: (url: string) => void | Promise<void>;
  log?: (event: string, fields: Record<string, unknown>) => void;
};

export type PluginWebviewBridgeServer = {
  handle(sender: PluginWebviewSender, payload: unknown): Promise<unknown>;
  /** The pinned plugin id for a sender, or null. Exposed for the handshake. */
  resolvePluginId(sender: PluginWebviewSender): string | null;
  /**
   * The whole attach-time handshake for a sender: the pinned plugin id and the
   * subject the host attached the guest to. Null when the sender is not a plugin
   * surface — the same grounds every method call would be refused on.
   */
  resolveHandshake(sender: PluginWebviewSender): PluginWebviewHandshake | null;
  dispose(): void;
};

/** Rows one `collections.list` may return. A page draws a list, not a table. */
const PLUGIN_WEBVIEW_LIST_MAX_ROWS = 500;

function requireString(params: Record<string, unknown>, field: string): string {
  const value = params[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new PluginSdkError("invalid_args", `"${field}" must be a non-empty string.`);
  }
  return value;
}

/**
 * Resolve the guest a message came from, or refuse.
 *
 * Two independent facts have to agree: the frame's own origin, and the registry
 * entry the window layer wrote when it approved the attach. Either alone would
 * be enough on a good day — the disagreement is what a compromised renderer
 * attaching a guest it forged, or a stale registry entry on a recycled
 * webContents id, would look like.
 */
export function resolvePluginWebviewSender(sender: PluginWebviewSender): PluginWebviewGuest {
  const guest = getPluginWebviewGuest(sender.webContentsId);
  if (!guest) {
    throw new PluginSdkError("not_permitted", "This page is not a plugin surface.");
  }
  const parsed = parsePluginWebviewUrl(sender.frameUrl);
  if (!parsed || parsed.pluginId !== guest.pluginId) {
    throw new PluginSdkError("not_permitted", "This page is not a plugin surface.");
  }
  return guest;
}

export function createPluginWebviewBridgeServer(
  deps: PluginWebviewBridgeDeps,
): PluginWebviewBridgeServer {
  const log = deps.log ?? (() => {});

  const declaredCollection = async (
    domain: PluginWebviewDomain,
    pluginId: string,
    params: Record<string, unknown>,
  ): Promise<string> => {
    const collection = assertPluginCollectionName(requireString(params, "collection"));
    const manifest = await domain.getManifest({ pluginId });
    if (!manifest) throw new PluginSdkError("plugin_not_found", `Plugin "${pluginId}" is not installed.`);
    if (!Object.prototype.hasOwnProperty.call(manifest.collections, collection)) {
      throw new PluginSdkError(
        "not_permitted",
        `Collection "${collection}" is not declared in ${pluginId}'s manifest.`,
      );
    }
    return collection;
  };

  const runMethod = async (
    guest: PluginWebviewGuest,
    method: PluginWebviewMethod,
    params: Record<string, unknown>,
  ): Promise<unknown> => {
    const pluginId = guest.pluginId;
    const domain = await deps.domainFor(guest);
    switch (method) {
      case "collections.get": {
        const collection = await declaredCollection(domain, pluginId, params);
        const key = assertPluginCollectionKey(requireString(params, "key"));
        // The domain reads by prefix; an exact key is a prefix of itself, so the
        // row is picked out here rather than adding a second read path that
        // could disagree with the list one about scoping.
        const rows = await domain.getCollection({ pluginId, collection, keyPrefix: key });
        return rows.find((row) => row.key === key)?.value ?? null;
      }

      case "collections.put": {
        const collection = await declaredCollection(domain, pluginId, params);
        const key = assertPluginCollectionKey(requireString(params, "key"));
        await deps.putCollection({ guest, collection, key, value: params.value });
        return null;
      }

      case "collections.list": {
        const collection = await declaredCollection(domain, pluginId, params);
        const options = isRecord(params.options) ? params.options : {};
        const keyPrefix = typeof options.keyPrefix === "string" ? options.keyPrefix : "";
        const requested = typeof options.limit === "number" && Number.isFinite(options.limit)
          ? Math.max(1, Math.trunc(options.limit))
          : PLUGIN_WEBVIEW_LIST_MAX_ROWS;
        const rows = await domain.getCollection({
          pluginId,
          collection,
          ...(keyPrefix ? { keyPrefix } : {}),
          limit: Math.min(requested, PLUGIN_WEBVIEW_LIST_MAX_ROWS),
        });
        // `{key, value}` only: the host row also carries its collection and a
        // timestamp, and the page already knows which collection it asked for.
        return rows.map((row) => ({ key: row.key, value: row.value }));
      }

      case "invoke": {
        const action = requireString(params, "action");
        const args = isRecord(params.args) ? params.args : {};
        return await domain.invoke({ pluginId, action, args });
      }

      case "config.get": {
        const detail = await domain.get({ pluginId });
        if (!detail) throw new PluginSdkError("plugin_not_found", `Plugin "${pluginId}" is not installed.`);
        return detail.config ?? {};
      }

      case "openDeeplink": {
        const url = requireString(params, "url");
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          throw new PluginSdkError("invalid_args", "That is not a URL.");
        }
        if (parsed.protocol === "ade:") {
          await deps.openDeeplink({ guest, url: parsed.toString() });
          return null;
        }
        if (parsed.protocol === "https:" || parsed.protocol === "http:") {
          await deps.openExternalUrl(parsed.toString());
          return null;
        }
        // `file:`, `javascript:`, `data:` and the guest's own scheme all land
        // here. Opening any of them would be a way out of the sandbox the page
        // was given, so the list of what is allowed is the whole policy.
        throw new PluginSdkError("not_permitted", "Only ade:// and http(s) links can be opened.");
      }

      default:
        throw new PluginSdkError("unsupported_method", `Unsupported bridge method: ${String(method)}`);
    }
  };

  const unsubscribe = subscribeToPluginChanges((event) => {
    if (!event.pluginId) return;
    const listeners = listPluginWebviewGuests(event.pluginId);
    if (listeners.length === 0) return;
    // Minus `pluginId`: a page only ever hears about its own plugin, and
    // carrying the id would invite a page to branch on someone else's.
    const payload: PluginWebviewChangeEvent = {
      kind: event.kind,
      ...(event.panelId ? { panelId: event.panelId } : {}),
      ...(event.collection ? { collection: event.collection } : {}),
    };
    for (const guest of listeners) {
      try {
        guest.send(IPC.pluginWebviewEvent, payload);
      } catch {
        // A guest that went away between the lookup and the send loses its
        // notification, not the change that produced it.
      }
    }
  });

  return {
    resolvePluginId(sender) {
      try {
        return resolvePluginWebviewSender(sender).pluginId;
      } catch {
        return null;
      }
    },

    resolveHandshake(sender) {
      try {
        const guest = resolvePluginWebviewSender(sender);
        return { pluginId: guest.pluginId, context: guest.context };
      } catch {
        return null;
      }
    },

    async handle(sender, payload) {
      const guest = resolvePluginWebviewSender(sender);
      if (!isRecord(payload)) {
        throw new PluginSdkError("invalid_args", "The bridge expects a request object.");
      }
      const bridgeVersion = payload.bridgeVersion;
      if (typeof bridgeVersion !== "number" || !Number.isInteger(bridgeVersion) || bridgeVersion < 1) {
        throw new PluginSdkError("invalid_args", "The bridge request carries no version.");
      }
      // Additive means an OLDER page keeps working; a page claiming a version
      // this host has never shipped is not a page this host wrote the preload
      // for.
      if (bridgeVersion > PLUGIN_WEBVIEW_BRIDGE_VERSION) {
        throw new PluginSdkError("unsupported_method", "This page needs a newer version of ADE.");
      }
      if (!isPluginWebviewMethod(payload.method)) {
        throw new PluginSdkError("unsupported_method", `Unsupported bridge method: ${String(payload.method)}`);
      }
      const params = isRecord(payload.params) ? payload.params : {};
      try {
        return await runMethod(guest, payload.method, params);
      } catch (error) {
        log("plugin.webview_bridge_failed", {
          pluginId: guest.pluginId,
          method: payload.method,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },

    dispose() {
      unsubscribe();
    },
  };
}
