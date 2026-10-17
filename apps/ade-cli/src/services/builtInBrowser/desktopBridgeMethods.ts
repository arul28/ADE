import type { BuiltInBrowserService } from "../../../../desktop/src/main/services/builtInBrowser/builtInBrowserService";
import type { BuiltInBrowserRemoteCallMethod } from "../../../../desktop/src/shared/types/builtInBrowserRemote";
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
  /**
   * The page's rendered text, paged. `observe` maps what can be clicked and
   * leaves the prose out; this is how an agent reads an article or a doc.
   */
  "readText",
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
 * Which machine's browser runs each bridge method for an agent whose user sits
 * at a desktop on another machine (`remoteBrowserForwarder`):
 *
 * - `open`: puts a URL on a screen. It tries the user's desktop first.
 * - `user-desktop`: acts on one of the chat's tabs, so it runs where the tabs
 *   are. Only a method in `BUILT_IN_BROWSER_REMOTE_CALL_METHODS` can be here.
 * - `local-file`: reads or writes a file on the agent's machine, so it runs
 *   there (`--here`).
 * - `agent-machine`: about the agent's machine itself (its dev servers, a
 *   recording's step caption, the pane's own layout).
 *
 * Every bridge method must have a route; the type makes a new one fail to
 * compile until it is given one.
 */
type BuiltInBrowserMethodRoutes = {
  readonly [Method in BuiltInBrowserDesktopBridgeMethod]: Method extends BuiltInBrowserRemoteCallMethod
    ? "open" | "user-desktop"
    : "open" | "local-file" | "agent-machine";
};

export const BUILT_IN_BROWSER_METHOD_ROUTES = {
  getStatus: "user-desktop",
  getDevServers: "agent-machine",
  requestOriginAccess: "user-desktop",
  claim: "user-desktop",
  startHandoff: "user-desktop",
  waitForHandoff: "user-desktop",
  startSession: "user-desktop",
  listSessions: "user-desktop",
  endSession: "user-desktop",
  showPanel: "open",
  setBounds: "agent-machine",
  navigate: "open",
  createTab: "open",
  switchTab: "user-desktop",
  closeTab: "user-desktop",
  reload: "user-desktop",
  goBack: "user-desktop",
  goForward: "user-desktop",
  stop: "user-desktop",
  observe: "user-desktop",
  getTrace: "user-desktop",
  click: "user-desktop",
  typeText: "user-desktop",
  dispatchKey: "user-desktop",
  scroll: "user-desktop",
  fill: "user-desktop",
  clear: "user-desktop",
  wait: "user-desktop",
  startInspect: "user-desktop",
  stopInspect: "user-desktop",
  captureScreenshot: "user-desktop",
  selectPoint: "user-desktop",
  selectCurrent: "user-desktop",
  clearSelection: "user-desktop",
  setEmulation: "user-desktop",
  setZoom: "user-desktop",
  findInPage: "user-desktop",
  readText: "user-desktop",
  stopFindInPage: "user-desktop",
  setDevTools: "user-desktop",
  setNetworkLogging: "user-desktop",
  getNetworkLog: "user-desktop",
  exportHar: "local-file",
  hover: "user-desktop",
  drag: "user-desktop",
  selectOption: "user-desktop",
  uploadFile: "local-file",
  startRecording: "local-file",
  stopRecording: "local-file",
  noteDemoStep: "agent-machine",
} as const satisfies BuiltInBrowserMethodRoutes;

export type BuiltInBrowserLocalFileMethod = {
  [Method in BuiltInBrowserDesktopBridgeMethod]: (typeof BUILT_IN_BROWSER_METHOD_ROUTES)[Method] extends "local-file"
    ? Method
    : never;
}[BuiltInBrowserDesktopBridgeMethod];

/**
 * Methods the runtime daemon serves itself rather than proxying to Electron.
 *
 * `acknowledgeRemoteRequest` is not a `BuiltInBrowserService` method and never
 * reaches the desktop bridge: it is how a desktop elsewhere tells THIS machine
 * that it took a forwarded `ade browser open`. The daemon and desktop main
 * import this constant; the shared action allowlist (`adeActionAccess`) names
 * it as a literal, because the shared layer does not import the CLI.
 */
export const BUILT_IN_BROWSER_ACKNOWLEDGE_REMOTE_REQUEST_METHOD = "acknowledgeRemoteRequest";

/**
 * How a desktop elsewhere answers a command this machine sent it
 * (`built_in_browser_remote_call`): once when it takes the command, once with
 * the outcome. Runtime-served for the same reason as `acknowledgeRemoteRequest`.
 */
export const BUILT_IN_BROWSER_REPLY_REMOTE_CALL_METHOD = "replyRemoteCall";

/**
 * Runtime-served methods for the user's own browser (`ade browser attach` /
 * `detach`). Like `acknowledgeRemoteRequest`, they never reach the desktop
 * bridge: the runtime reaches the user's browser directly, so they work on a
 * headless or remote runtime. `userBrowserRouting` serves them.
 */
export const BUILT_IN_BROWSER_ATTACH_USER_BROWSER_METHOD = "attachUserBrowser";
export const BUILT_IN_BROWSER_DETACH_USER_BROWSER_METHOD = "detachUserBrowser";
export const USER_BROWSER_RUNTIME_METHODS = [
  BUILT_IN_BROWSER_ATTACH_USER_BROWSER_METHOD,
  BUILT_IN_BROWSER_DETACH_USER_BROWSER_METHOD,
] as const;

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
  replyRemoteCall: (input: unknown) => { ok: boolean };
  dispose: () => void;
};

/**
 * True for the method the bridge server answers itself (the read-only runtime
 * status), kept out of `isBuiltInBrowserDesktopBridgeMethod` so the bridge
 * server never dispatches it onto `BuiltInBrowserService`.
 */
export function isBuiltInBrowserBridgeServedMethod(value: string): boolean {
  return value === BUILT_IN_BROWSER_RUNTIME_STATUS_METHOD;
}

const BUILT_IN_BROWSER_DESKTOP_BRIDGE_METHOD_SET = new Set<string>(
  BUILT_IN_BROWSER_DESKTOP_BRIDGE_METHODS,
);

export function isBuiltInBrowserDesktopBridgeMethod(
  value: string,
): value is BuiltInBrowserDesktopBridgeMethod {
  return BUILT_IN_BROWSER_DESKTOP_BRIDGE_METHOD_SET.has(value);
}
