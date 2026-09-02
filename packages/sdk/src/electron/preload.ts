/**
 * `@ade-dev/sdk/electron/preload` — the preload half of the Electron bridge.
 *
 * THIS FILE MUST BUNDLE TO ONE SELF-CONTAINED FILE. A preload that runs under
 * `sandbox: true` has no module resolution: it cannot `require` a file path and
 * it cannot reach `node_modules`. So this entry imports nothing at run time —
 * only types, which vanish at build — and its published artifact
 * (`dist/electron/preload.cjs`) is a single file with no `require` and no
 * `import` of any kind. Point `webPreferences.preload` straight at that file,
 * or bundle this module into your own preload.
 *
 * WHAT CROSSES. Functions and plain data only. `contextBridge` structured-clones
 * everything it passes, so a class instance arrives as a bare object with no
 * prototype and no methods. The renderer therefore receives an id plus two
 * functions and rebuilds every object shape on its own side.
 */

import {
  ADE_DEFAULT_BRIDGE_KEY,
  ADE_DEFAULT_CHANNEL_PREFIX,
  eventChannel,
  invokeChannel,
  type AdeBridge,
  type AdeIpcEventPayload,
  type AdeIpcInvokeResponse,
  type ContextBridgeLike,
  type IpcRendererLike,
} from "./protocol.js";

export type ExposeAdeBridgeOptions = {
  /** `window` key the bridge lands on. Defaults to `"ade"`. */
  key?: string;
  /** Channel namespace. Must match the main process. Defaults to `"ade"`. */
  channelPrefix?: string;
};

/**
 * Expose the ADE bridge on `window[key]`.
 *
 * Call it once, at the top level of your preload:
 *
 *   const { contextBridge, ipcRenderer } = require("electron");
 *   exposeAdeBridge(contextBridge, ipcRenderer);
 *
 * The surface is deliberately two functions wide. Every method name, argument
 * shape and subscription rule lives in the renderer half, so a preload written
 * against one SDK version keeps working as the method table grows.
 */
export function exposeAdeBridge(
  contextBridge: ContextBridgeLike,
  ipcRenderer: IpcRendererLike,
  opts: ExposeAdeBridgeOptions = {},
): void {
  const key = opts.key?.trim() || ADE_DEFAULT_BRIDGE_KEY;
  const prefix = opts.channelPrefix?.trim() || ADE_DEFAULT_CHANNEL_PREFIX;
  // Built by the same two functions the main process uses, never by a template
  // literal of their own: the channel name is the contract between two
  // processes, and a second spelling of it desynchronizes silently — no compile
  // error, no runtime error, just a bridge that never answers.
  const invokeName = invokeChannel(prefix);
  const eventName = eventChannel(prefix);

  const bridge: AdeBridge = {
    invoke(method: string, args: unknown[]): Promise<AdeIpcInvokeResponse> {
      return ipcRenderer.invoke(invokeName, { method, args }) as Promise<AdeIpcInvokeResponse>;
    },
    onEvent(listener: (payload: AdeIpcEventPayload) => void): () => void {
      const handler = (_event: unknown, payload: AdeIpcEventPayload) => {
        listener(payload);
      };
      ipcRenderer.on(eventName, handler);
      return () => {
        ipcRenderer.removeListener(eventName, handler);
      };
    },
  };

  contextBridge.exposeInMainWorld(key, bridge);
}

export { ADE_DEFAULT_BRIDGE_KEY, ADE_DEFAULT_CHANNEL_PREFIX } from "./protocol.js";
export type { AdeBridge, ContextBridgeLike, IpcRendererLike } from "./protocol.js";
