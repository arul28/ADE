import type { BuiltInBrowserService } from "../../../../desktop/src/main/services/builtInBrowser/builtInBrowserService";

export const BUILT_IN_BROWSER_BRIDGE_AUTH_PARAM = "__adeDesktopBridgeAuth";

const runtimeValidatedPersonalScopes = new WeakSet<object>();

/**
 * Marks the exact params object produced by the runtime's actor-capability
 * check. A caller cannot synthesize this marker through JSON-RPC input.
 */
export function markRuntimeValidatedBuiltInBrowserPersonalScope<
  Params extends Record<string, unknown>,
>(params: Params): Params {
  runtimeValidatedPersonalScopes.add(params);
  return params;
}

export function isRuntimeValidatedBuiltInBrowserPersonalScope(
  params: unknown,
): params is Record<string, unknown> {
  return Boolean(params && typeof params === "object" && runtimeValidatedPersonalScopes.has(params));
}

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
] as const satisfies readonly (keyof BuiltInBrowserService)[];

export type BuiltInBrowserDesktopBridgeMethod =
  (typeof BUILT_IN_BROWSER_DESKTOP_BRIDGE_METHODS)[number];

export type BuiltInBrowserDesktopBridgeClient = {
  [Method in BuiltInBrowserDesktopBridgeMethod]:
    BuiltInBrowserService[Method] extends (...args: infer Args) => unknown
      ? (...args: BridgeArgs<Args>) => Promise<BridgeReturn<Method>>
      : never;
} & {
  dispose: () => void;
};

const BUILT_IN_BROWSER_DESKTOP_BRIDGE_METHOD_SET = new Set<string>(
  BUILT_IN_BROWSER_DESKTOP_BRIDGE_METHODS,
);

export function isBuiltInBrowserDesktopBridgeMethod(
  value: string,
): value is BuiltInBrowserDesktopBridgeMethod {
  return BUILT_IN_BROWSER_DESKTOP_BRIDGE_METHOD_SET.has(value);
}
