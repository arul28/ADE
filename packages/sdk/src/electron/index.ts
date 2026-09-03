/**
 * `@ade-dev/sdk/electron` — the main-process entry of the Electron bridge.
 *
 * Three entry points, one per process, in the shape `@sentry/electron` proved
 * works under a hardened configuration:
 *
 *   main      import { registerAdeIpc }   from "@ade-dev/sdk/electron";
 *   preload   import { exposeAdeBridge }  from "@ade-dev/sdk/electron/preload";
 *   renderer  import { createAdeIpcClient } from "@ade-dev/sdk/electron/renderer";
 *
 * NOT AN ELECTRON DEPENDENCY. `electron` is neither a dependency nor an
 * optional peer of this package. Every Electron object is described
 * structurally, so any Electron version whose `ipcMain`, `ipcRenderer` and
 * `contextBridge` still have these members works, and a Node host with no
 * Electron at all can still import and unit-test the bridge.
 *
 * IMPORT `AdeError` FROM HERE, not from `@ade-dev/sdk`, when you want
 * `instanceof` to hold on an error the bridge produced. The subpaths are
 * separate bundles, so each carries its own copy of the class. The `code` field
 * is the stable check and it crosses the boundary intact either way.
 */

export {
  registerAdeIpc,
  navigationEndsRendererWorld,
  adeErrorCodeOf,
  type RegisterAdeIpcOptions,
} from "./main.js";

export {
  ADE_DEFAULT_BRIDGE_KEY,
  ADE_DEFAULT_CHANNEL_PREFIX,
  ADE_IPC_METHODS,
  ADE_IPC_THREAD_KEY_METHODS,
  compareEnvelopes,
  envelopeDedupeKey,
  eventChannel,
  invokeChannel,
  mergeHistoryWithBuffer,
} from "./protocol.js";

export type {
  AdeBridge,
  AdeIpcErrorPayload,
  AdeIpcEventPayload,
  AdeIpcInvokeRequest,
  AdeIpcInvokeResponse,
  AdeIpcMethod,
  AdeIpcProvidersEvent,
  AdeIpcSubscription,
  AdeIpcThreadEvent,
  AdeIpcThreadSnapshot,
  ContextBridgeLike,
  IpcMainInvokeEventLike,
  IpcMainLike,
  IpcRendererLike,
  WebContentsLike,
} from "./protocol.js";

export { AdeError, type AdeErrorCode } from "../errors.js";
