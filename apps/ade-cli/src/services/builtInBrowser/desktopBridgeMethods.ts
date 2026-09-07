import type { BuiltInBrowserService } from "../../../../desktop/src/main/services/builtInBrowser/builtInBrowserService";

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
  "requestOriginAccess",
  "claim",
  "startHandoff",
  // `endHandoff` is on the bridge only so the desktop renderer's own `Hand back`
  // can reach a locally-pinned runtime. `adeRpcServer` gates it to user clients,
  // so an agent cannot end a sign-in the human is still in the middle of.
  "endHandoff",
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
  dispose: () => void;
};

const BUILT_IN_BROWSER_ACTOR_CAPABILITY_METHOD_SET = new Set<string>([
  BUILT_IN_BROWSER_ISSUE_ACTOR_CAPABILITY_METHOD,
  BUILT_IN_BROWSER_REVOKE_ACTOR_CAPABILITY_METHOD,
]);

/**
 * True for the capability lifecycle methods above. They are deliberately kept
 * out of `isBuiltInBrowserDesktopBridgeMethod` so the bridge server never
 * dispatches them onto `BuiltInBrowserService`.
 */
export function isBuiltInBrowserActorCapabilityMethod(value: string): boolean {
  return BUILT_IN_BROWSER_ACTOR_CAPABILITY_METHOD_SET.has(value);
}

const BUILT_IN_BROWSER_DESKTOP_BRIDGE_METHOD_SET = new Set<string>(
  BUILT_IN_BROWSER_DESKTOP_BRIDGE_METHODS,
);

export function isBuiltInBrowserDesktopBridgeMethod(
  value: string,
): value is BuiltInBrowserDesktopBridgeMethod {
  return BUILT_IN_BROWSER_DESKTOP_BRIDGE_METHOD_SET.has(value);
}
