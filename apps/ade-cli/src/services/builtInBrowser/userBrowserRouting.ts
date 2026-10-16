import type { UserBrowserAttachService } from "../../../../desktop/src/main/services/userBrowser/userBrowserAttachService";
import {
  BUILT_IN_BROWSER_ATTACH_USER_BROWSER_METHOD,
  BUILT_IN_BROWSER_DETACH_USER_BROWSER_METHOD,
  USER_BROWSER_RUNTIME_METHODS,
  isBuiltInBrowserDesktopBridgeMethod,
  type BuiltInBrowserDesktopBridgeClient,
} from "./desktopBridgeMethods";

const USER_BROWSER_RUNTIME_METHOD_SET = new Set<string>(USER_BROWSER_RUNTIME_METHODS);

/** `attachUserBrowser` / `detachUserBrowser`: served by the runtime, never the desktop bridge. */
export function isUserBrowserRuntimeMethod(value: string): boolean {
  return USER_BROWSER_RUNTIME_METHOD_SET.has(value);
}

/**
 * Where `adeRpcServer` decided a `built_in_browser` call goes, stamped on the
 * scoped args after it authorized the call for that destination: `true` for
 * the user's browser; anything else is ADE's. The router below obeys it instead of
 * asking again, so an attachment that ends (or begins) between the check and
 * the dispatch cannot send a call somewhere it was not authorized for. A
 * caller's own copy is overwritten by the scoping, never trusted.
 */
export const USER_BROWSER_ROUTE_PARAM = "__adeUserBrowserRoute";

/** Split the routing decision off the args the destination sees. */
function takeRoute(input: unknown): { toUserBrowser: boolean; args: unknown } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { toUserBrowser: false, args: input };
  const { [USER_BROWSER_ROUTE_PARAM]: route, ...args } = input as Record<string, unknown>;
  return { toUserBrowser: route === true, args };
}

/**
 * The args the user's browser sees: no routing decision. A call nobody
 * authorized for the user's browser is refused rather than served.
 */
function userBrowserArgs(input: unknown): Record<string, unknown> {
  const { toUserBrowser, args } = takeRoute(input ?? {});
  if (!toUserBrowser) throw new Error("This call was not authorized for the user's browser.");
  if (!args || typeof args !== "object" || Array.isArray(args)) return {};
  return args as Record<string, unknown>;
}

/**
 * Wrap the desktop bridge client so an attached chat's page commands act in
 * the user's browser.
 *
 * - `attachUserBrowser` / `detachUserBrowser` are served here.
 * - A page method `adeRpcServer` routed to the user's browser (see
 *   {@link USER_BROWSER_ROUTE_PARAM}) goes to the attachment, which acts or
 *   says why it cannot. Everything else goes to ADE's browser.
 * - `getStatus` routed here adds the chat's attachment beside ADE's browser
 *   status; when no desktop answers, an attached chat still gets its
 *   attachment.
 */
export function withUserBrowserAttachment(
  bridge: BuiltInBrowserDesktopBridgeClient,
  userBrowser: UserBrowserAttachService,
): BuiltInBrowserDesktopBridgeClient {
  return new Proxy(bridge, {
    get(target, property, receiver) {
      if (property === BUILT_IN_BROWSER_ATTACH_USER_BROWSER_METHOD) {
        return (input?: unknown) =>
          userBrowser.attach(userBrowserArgs(input) as Parameters<UserBrowserAttachService["attach"]>[0]);
      }
      if (property === BUILT_IN_BROWSER_DETACH_USER_BROWSER_METHOD) {
        return (input?: unknown) =>
          userBrowser.detach(userBrowserArgs(input) as Parameters<UserBrowserAttachService["detach"]>[0]);
      }
      const inner = Reflect.get(target, property, receiver) as unknown;
      // Only browser actions route. The runtime status mirror and `dispose`
      // must always reach the bridge.
      if (
        typeof property !== "string"
        || typeof inner !== "function"
        || !isBuiltInBrowserDesktopBridgeMethod(property)
      ) {
        return inner;
      }
      const call = inner as (input?: unknown) => unknown;
      if (property === "getStatus") {
        return async (input?: unknown) => {
          const { toUserBrowser, args } = takeRoute(input);
          if (!toUserBrowser) {
            // Not attached: still report which of the user's browsers have
            // remote debugging on. A file read only; it never connects.
            const chatSessionId = args && typeof args === "object"
              ? (args as Record<string, unknown>).chatSessionId
              : null;
            const userBrowserStatus = await userBrowser
              .status({ chatSessionId: typeof chatSessionId === "string" ? chatSessionId : null })
              .catch(() => null);
            if (!userBrowserStatus) return await call.call(target, args);
            try {
              const status = await call.call(target, args);
              return status && typeof status === "object"
                ? { ...(status as object), userBrowser: userBrowserStatus }
                : { userBrowser: userBrowserStatus };
            } catch (error) {
              return {
                userBrowser: userBrowserStatus,
                builtInUnavailable: error instanceof Error ? error.message : String(error),
              };
            }
          }
          const attached = await userBrowser.dispatch("getStatus", userBrowserArgs(input)) as Record<string, unknown>;
          try {
            const status = await call.call(target, args);
            return status && typeof status === "object" ? { ...(status as object), ...attached } : attached;
          } catch (error) {
            return { ...attached, builtInUnavailable: error instanceof Error ? error.message : String(error) };
          }
        };
      }
      return (input?: unknown) => {
        const { toUserBrowser, args } = takeRoute(input);
        return toUserBrowser ? userBrowser.dispatch(property, userBrowserArgs(input)) : call.call(target, args);
      };
    },
  }) as BuiltInBrowserDesktopBridgeClient;
}
