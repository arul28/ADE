import type { BuiltInBrowserService } from "../../../../desktop/src/main/services/builtInBrowser/builtInBrowserService";
import {
  BUILT_IN_BROWSER_RUNTIME_STATUS_METHOD,
  type BuiltInBrowserRuntimeStatus,
} from "../../../../desktop/src/shared/types/builtInBrowserRuntimeStatus";

type SourceWindowLike = {
  id: number;
  isDestroyed(): boolean;
} | null | undefined;

type BridgeArgs<Args extends unknown[]> =
  [Args[0]] extends [undefined]
    ? []
    : [Args[0]] extends [SourceWindowLike]
      ? []
      : undefined extends Args[0]
        ? [input?: Exclude<Args[0], undefined>]
        : [input: Args[0]];

type BridgeReturn<Method extends BuiltInBrowserDesktopBridgeMethod> =
  BuiltInBrowserService[Method] extends (...args: infer _Args) => infer Result
    ? Awaited<Result>
    : never;

export const BUILT_IN_BROWSER_DESKTOP_BRIDGE_METHODS = [
  "getStatus",
  /**
   * The dev servers ADE sniffed out of its own terminals — the same feed the
   * Browser pane's launchpad chips render. Read-only, and here rather than
   * renderer-only because an agent that just started `npm run dev` in an ADE
   * shell otherwise has to guess the port before it can `ade browser open` it.
   *
   * Scope comes from the caller, not the argument: the runtime overwrites
   * `laneId` with the calling chat's lane, so a lane-bound agent sees its
   * own lane's servers whatever it asks for. A personal (project-less) chat has
   * no lane and gets the machine-wide list, which carries no more than the
   * project roots `ade projects list` already prints.
   */
  "getDevServers",
  "requestOriginAccess",
  "claim",
  "startHandoff",
  "waitForHandoff",
  "startSession",
  "listSessions",
  "endSession",
  "showPanel",
  "setBounds",
  "navigate",
  "createTab",
  "switchTab",
  "closeTab",
  "reload",
  "goBack",
  "goForward",
  "stop",
  "observe",
  "getTrace",
  "click",
  "typeText",
  "dispatchKey",
  "scroll",
  "fill",
  "clear",
  "wait",
  "startInspect",
  "stopInspect",
  "captureScreenshot",
  "selectPoint",
  "selectCurrent",
  "clearSelection",
  "setEmulation",
  "setZoom",
  "findInPage",
  "stopFindInPage",
  "setDevTools",
  "setNetworkLogging",
  "getNetworkLog",
  "exportHar",
  "hover",
  "drag",
  "selectOption",
  "uploadFile",
  "startRecording",
  "stopRecording",
  /**
   * A step caption (`ade proof step`) for the chat's browser recordings. They
   * live in the desktop's demo track registry, so the brain forwards steps here.
   */
  "noteDemoStep",
] as const satisfies readonly (keyof BuiltInBrowserService)[];

export type BuiltInBrowserDesktopBridgeMethod =
  (typeof BUILT_IN_BROWSER_DESKTOP_BRIDGE_METHODS)[number];

/**
 * Methods the runtime daemon serves itself rather than proxying to Electron.
 *
 * `acknowledgeRemoteRequest` is not a `BuiltInBrowserService` method and never
 * reaches the desktop bridge: it is how a desktop elsewhere tells THIS machine
 * that it took a forwarded `ade browser open`. Named once here so the three
 * sites that special-case it (the action allowlist, `adeRpcServer`'s scoping
 * chain, and `remoteBrowserForwarder`) all point at the same constant instead
 * of three bare string comparisons.
 */
export const BUILT_IN_BROWSER_ACKNOWLEDGE_REMOTE_REQUEST_METHOD = "acknowledgeRemoteRequest";

export type BuiltInBrowserAcknowledgeRemoteRequestArgs = {
  requestId: string;
  desktopLabel?: string;
  accepted?: boolean;
  reason?: string | null;
};

export type BuiltInBrowserDesktopBridgeClient = {
  [Method in BuiltInBrowserDesktopBridgeMethod]:
    BuiltInBrowserService[Method] extends (...args: infer Args) => unknown
      ? (...args: BridgeArgs<Args>) => Promise<BridgeReturn<Method>>
      : never;
} & {
  /** Read-only Work-tools mirror — see `BuiltInBrowserRuntimeStatus`. */
  getStatusForRuntime: () => Promise<BuiltInBrowserRuntimeStatus>;
  acknowledgeRemoteRequest: (
    input: BuiltInBrowserAcknowledgeRemoteRequestArgs,
  ) => { ok: boolean };
  dispose: () => void;
};

const BUILT_IN_BROWSER_BRIDGE_SERVED_METHOD_SET = new Set<string>([
  BUILT_IN_BROWSER_RUNTIME_STATUS_METHOD,
]);

/**
 * True for the methods the bridge server answers itself (the read-only runtime
 * status), kept out of `isBuiltInBrowserDesktopBridgeMethod` so the bridge
 * server never dispatches them onto `BuiltInBrowserService`.
 */
export function isBuiltInBrowserBridgeServedMethod(value: string): boolean {
  return BUILT_IN_BROWSER_BRIDGE_SERVED_METHOD_SET.has(value);
}

const BUILT_IN_BROWSER_DESKTOP_BRIDGE_METHOD_SET = new Set<string>(
  BUILT_IN_BROWSER_DESKTOP_BRIDGE_METHODS,
);

export function isBuiltInBrowserDesktopBridgeMethod(
  value: string,
): value is BuiltInBrowserDesktopBridgeMethod {
  return BUILT_IN_BROWSER_DESKTOP_BRIDGE_METHOD_SET.has(value);
}
