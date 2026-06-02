import type { BuiltInBrowserService } from "../../../../desktop/src/main/services/builtInBrowser/builtInBrowserService";

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
