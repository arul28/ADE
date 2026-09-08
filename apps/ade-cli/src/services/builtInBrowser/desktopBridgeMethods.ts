import type { BuiltInBrowserService } from "../../../../desktop/src/main/services/builtInBrowser/builtInBrowserService";
import {
  BUILT_IN_BROWSER_RUNTIME_STATUS_METHOD,
  type BuiltInBrowserRuntimeStatus,
} from "../../../../desktop/src/shared/types/builtInBrowserRuntimeStatus";

export const BUILT_IN_BROWSER_BRIDGE_AUTH_PARAM = "__adeDesktopBridgeAuth";
export const BUILT_IN_BROWSER_ACTOR_CAPABILITY_PARAM = "__adeBrowserActorCapability";

/**
 * Capability lifecycle methods. These are not `BuiltInBrowserService` methods:
 * they are served directly by the desktop bridge so the runtime daemon — a
 * separate process from Electron main, where the capability registry lives —
 * can have Electron mint and revoke the per-chat actor capability it injects
 * as `ADE_BROWSER_ACTOR_TOKEN`. They require bridge authentication and, unlike
 * every browser action, no actor capability of their own.
 */
export const BUILT_IN_BROWSER_ISSUE_ACTOR_CAPABILITY_METHOD = "issueActorCapability";
export const BUILT_IN_BROWSER_REVOKE_ACTOR_CAPABILITY_METHOD = "revokeActorCapability";

export type BuiltInBrowserActorCapabilityRequest = {
  chatSessionId: string;
  laneId?: string | null;
  projectRoot?: string | null;
  tabCollection?: "personal" | null;
};

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
   * Scope comes from the caller, not the argument: the bridge overwrites
   * `laneId` with the actor capability's lane, so a lane-bound agent sees its
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
  issueActorCapability: (
    input: BuiltInBrowserActorCapabilityRequest,
  ) => Promise<{ token: string }>;
  revokeActorCapability: (input: { chatSessionId: string }) => Promise<{ revoked: boolean }>;
  /**
   * Read-only Work-tools mirror. Bridge auth only — see
   * `BuiltInBrowserRuntimeStatus` for why serving it without an actor
   * capability grants nothing.
   */
  getStatusForRuntime: () => Promise<BuiltInBrowserRuntimeStatus>;
  acknowledgeRemoteRequest: (
    input: BuiltInBrowserAcknowledgeRemoteRequestArgs,
  ) => { ok: boolean };
  dispose: () => void;
};

const BUILT_IN_BROWSER_BRIDGE_SERVED_METHOD_SET = new Set<string>([
  BUILT_IN_BROWSER_ISSUE_ACTOR_CAPABILITY_METHOD,
  BUILT_IN_BROWSER_REVOKE_ACTOR_CAPABILITY_METHOD,
  BUILT_IN_BROWSER_RUNTIME_STATUS_METHOD,
]);

/**
 * True for the methods the bridge server answers itself: the two capability
 * lifecycle calls and the read-only runtime status. All three are deliberately
 * kept out of `isBuiltInBrowserDesktopBridgeMethod` so the bridge server never
 * dispatches them onto `BuiltInBrowserService`, and all three are gated on
 * bridge authentication alone — the daemon calling them has no chat and so can
 * never hold an actor capability.
 */
export function isBuiltInBrowserBridgeServedMethod(value: string): boolean {
  return BUILT_IN_BROWSER_BRIDGE_SERVED_METHOD_SET.has(value);
}

/**
 * Methods whose params must NOT be rewritten to the daemon's own project scope.
 *
 * This is deliberately a different set from `isBuiltInBrowserBridgeServedMethod`.
 * The two capability-lifecycle calls carry the scope of the chat being launched
 * — which may be a personal (project-less) chat, or a lane in another project —
 * so overwriting `projectRoot` with the daemon's own would mint a capability for
 * the wrong collection. `getStatusForRuntime` is the opposite case: the daemon
 * is project-scoped and its Work-tools mirror must read THAT project's window
 * collection, not whichever window happens to be frontmost on the machine, so it
 * takes the scope rewrite like every proxied method.
 */
const BUILT_IN_BROWSER_UNSCOPED_BRIDGE_METHOD_SET = new Set<string>([
  BUILT_IN_BROWSER_ISSUE_ACTOR_CAPABILITY_METHOD,
  BUILT_IN_BROWSER_REVOKE_ACTOR_CAPABILITY_METHOD,
]);

/** True for methods that carry their own scope — see the set's doc comment. */
export function isBuiltInBrowserUnscopedBridgeMethod(value: string): boolean {
  return BUILT_IN_BROWSER_UNSCOPED_BRIDGE_METHOD_SET.has(value);
}

const BUILT_IN_BROWSER_DESKTOP_BRIDGE_METHOD_SET = new Set<string>(
  BUILT_IN_BROWSER_DESKTOP_BRIDGE_METHODS,
);

export function isBuiltInBrowserDesktopBridgeMethod(
  value: string,
): value is BuiltInBrowserDesktopBridgeMethod {
  return BUILT_IN_BROWSER_DESKTOP_BRIDGE_METHOD_SET.has(value);
}
