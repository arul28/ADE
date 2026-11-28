/**
 * `@daex-dev/sdk/electron` — the main-process entry of the Electron bridge.
 *
 * Three entry points, one per process, in the shape `@sentry/electron` proved
 * works under a hardened configuration:
 *
 *   main      import { registerDaexIpc }   from "@daex-dev/sdk/electron";
 *   preload   import { exposeDaexBridge }  from "@daex-dev/sdk/electron/preload";
 *   renderer  import { createDaexIpcClient } from "@daex-dev/sdk/electron/renderer";
 *
 * NOT AN ELECTRON DEPENDENCY. `electron` is neither a dependency nor an
 * optional peer of this package. Every Electron object is described
 * structurally, so any Electron version whose `ipcMain`, `ipcRenderer` and
 * `contextBridge` still have these members works, and a Node host with no
 * Electron at all can still import and unit-test the bridge.
 *
 * IMPORT `DaexError` FROM HERE, not from `@daex-dev/sdk`, when you want
 * `instanceof` to hold on an error the bridge produced. The subpaths are
 * separate bundles, so each carries its own copy of the class. The `code` field
 * is the stable check and it crosses the boundary intact either way.
 */

export {
  registerDaexIpc,
  navigationEndsRendererWorld,
  daexErrorCodeOf,
  type DaexChatClientSource,
  type DaexIpcBridgeHandle,
  type DaexIpcOpenContext,
  type RegisterDaexIpcOptions,
  type ThreadRemovalKind,
} from "./main.js";
export { DAEX_IPC_RENDERER_OPEN_FIELDS } from "./rendererOptions.js";
export { checkDaexBridge, type CheckDaexBridgeOptions } from "./bridgeCheck.js";

export {
  DAEX_DEFAULT_BRIDGE_KEY,
  DAEX_DEFAULT_CHANNEL_PREFIX,
  DAEX_IPC_METHODS,
  DAEX_IPC_THREAD_KEY_METHODS,
  compareEnvelopes,
  envelopeDedupeKey,
  eventChannel,
  invokeChannel,
  mergeHistoryWithBuffer,
} from "./protocol.js";

export type {
  DaexBridge,
  DaexIpcClientEvent,
  DaexIpcErrorPayload,
  DaexIpcEventPayload,
  DaexIpcInvokeRequest,
  DaexIpcInvokeResponse,
  DaexIpcMethod,
  DaexIpcProvidersEvent,
  DaexIpcSubscription,
  DaexIpcThreadEvent,
  DaexIpcThreadSnapshot,
  ContextBridgeLike,
  IpcMainInvokeEventLike,
  IpcMainLike,
  IpcRendererLike,
  WebContentsLike,
} from "./protocol.js";

export { DaexError, type DaexErrorCode } from "../errors.js";

// Pre-DAEX names: deprecated aliases of the DAEX* exports above, kept so code
// written against the `@ade-dev` packages keeps compiling.
export { ADE_DEFAULT_BRIDGE_KEY, ADE_DEFAULT_CHANNEL_PREFIX, ADE_IPC_METHODS, ADE_IPC_THREAD_KEY_METHODS } from "./protocol.js";
export type { AdeBridge, AdeIpcClientEvent, AdeIpcErrorPayload, AdeIpcEventPayload, AdeIpcInvokeRequest, AdeIpcInvokeResponse, AdeIpcMethod, AdeIpcProvidersEvent, AdeIpcSubscription, AdeIpcThreadEvent, AdeIpcThreadSnapshot } from "./protocol.js";
export { ADE_IPC_RENDERER_OPEN_FIELDS } from "./rendererOptions.js";
export { adeErrorCodeOf, registerAdeIpc } from "./main.js";
export type { AdeChatClientSource, AdeIpcBridgeHandle, AdeIpcOpenContext, RegisterAdeIpcOptions } from "./main.js";
export { AdeError } from "../errors.js";
export type { AdeErrorCode } from "../errors.js";
export { checkAdeBridge } from "./bridgeCheck.js";
export type { CheckAdeBridgeOptions } from "./bridgeCheck.js";
