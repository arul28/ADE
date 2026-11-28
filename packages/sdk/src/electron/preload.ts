/**
 * `@daex-dev/sdk/electron/preload` — the preload half of the Electron bridge.
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
  DAEX_DEFAULT_BRIDGE_KEY,
  DAEX_DEFAULT_CHANNEL_PREFIX,
  eventChannel,
  invokeChannel,
  type DaexBridge,
  type DaexIpcEventPayload,
  type DaexIpcInvokeResponse,
  type ContextBridgeLike,
  type IpcRendererLike,
} from "./protocol.js";

export type ExposeDaexBridgeOptions = {
  /** `window` key the bridge lands on. Defaults to `"ade"`. */
  key?: string;
  /** Channel namespace. Must match the main process. Defaults to `"ade"`. */
  channelPrefix?: string;
};

/**
 * Expose the DAEX bridge on `window[key]`.
 *
 * Call it once, at the top level of your preload:
 *
 *   const { contextBridge, ipcRenderer } = require("electron");
 *   exposeDaexBridge(contextBridge, ipcRenderer);
 *
 * The surface is deliberately two functions wide. Every method name, argument
 * shape and subscription rule lives in the renderer half, so a preload written
 * against one SDK version keeps working as the method table grows.
 */
export function exposeDaexBridge(
  contextBridge: ContextBridgeLike,
  ipcRenderer: IpcRendererLike,
  opts: ExposeDaexBridgeOptions = {},
): void {
  const key = opts.key?.trim() || DAEX_DEFAULT_BRIDGE_KEY;
  const prefix = opts.channelPrefix?.trim() || DAEX_DEFAULT_CHANNEL_PREFIX;
  // Built by the same two functions the main process uses, never by a template
  // literal of their own: the channel name is the contract between two
  // processes, and a second spelling of it desynchronizes silently — no compile
  // error, no runtime error, just a bridge that never answers.
  const invokeName = invokeChannel(prefix);
  const eventName = eventChannel(prefix);

  const bridge: DaexBridge = {
    invoke(method: string, args: unknown[]): Promise<DaexIpcInvokeResponse> {
      return ipcRenderer.invoke(invokeName, { method, args }) as Promise<DaexIpcInvokeResponse>;
    },
    onEvent(listener: (payload: DaexIpcEventPayload) => void): () => void {
      const handler = (_event: unknown, payload: DaexIpcEventPayload) => {
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

export { DAEX_DEFAULT_BRIDGE_KEY, DAEX_DEFAULT_CHANNEL_PREFIX } from "./protocol.js";
export type { DaexBridge, ContextBridgeLike, IpcRendererLike } from "./protocol.js";

// Pre-DAEX names, kept as deprecated aliases so code written against the
// `@ade-dev` packages keeps compiling. Remove them in a future major version.
/** @deprecated Use {@link ExposeDaexBridgeOptions}. */
export type ExposeAdeBridgeOptions = ExposeDaexBridgeOptions;
/** @deprecated Use {@link exposeDaexBridge}. */
export const exposeAdeBridge = exposeDaexBridge;

// Pre-DAEX names: deprecated aliases of the DAEX* exports above, kept so code
// written against the `@ade-dev` packages keeps compiling.
export { ADE_DEFAULT_BRIDGE_KEY, ADE_DEFAULT_CHANNEL_PREFIX } from "./protocol.js";
export type { AdeBridge } from "./protocol.js";
