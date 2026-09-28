/**
 * `@ade-dev/sdk/electron/preload-auto` — a preload that exposes the bridge by
 * itself, for `webPreferences.preload`.
 *
 * `@ade-dev/sdk/electron/preload` only EXPORTS `exposeAdeBridge`. Pointing
 * `webPreferences.preload` at it loads the function and never calls it, so
 * `window.ade` stays undefined and every renderer call waits for a bridge that
 * is not there. This entry is that same function, called once with the default
 * key (`"ade"`) and channel prefix (`"ade"`):
 *
 *   webPreferences: {
 *     preload: require.resolve("@ade-dev/sdk/electron/preload-auto"),
 *     sandbox: true,
 *   }
 *
 * It is one CommonJS file whose only `require` is `"electron"`, the one module
 * a `sandbox: true` preload may load. A host that needs another key or prefix,
 * or its own channels beside ADE's, writes its own preload instead.
 */

import type { ContextBridgeLike, IpcRendererLike } from "./protocol.js";
import { exposeAdeBridge } from "./preload.js";

declare const require: (id: "electron") => {
  contextBridge: ContextBridgeLike;
  ipcRenderer: IpcRendererLike;
};

const electron = require("electron");
exposeAdeBridge(electron.contextBridge, electron.ipcRenderer);
