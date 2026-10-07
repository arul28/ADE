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

function chatOf(input: unknown): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = (input as Record<string, unknown>).chatSessionId;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Wrap the desktop bridge client so an attached chat's page commands act in
 * the user's browser.
 *
 * - `attachUserBrowser` / `detachUserBrowser` are served here.
 * - While the calling chat is attached, every page method goes to the
 *   attachment instead of ADE's browser (or is refused with the reason).
 * - `getStatus` adds the chat's attachment beside ADE's browser status; when
 *   no desktop answers, an attached chat still gets its attachment.
 *
 * Every other call, and every call from a chat that is not attached, passes
 * through untouched.
 */
export function withUserBrowserAttachment(
  bridge: BuiltInBrowserDesktopBridgeClient,
  userBrowser: UserBrowserAttachService,
): BuiltInBrowserDesktopBridgeClient {
  return new Proxy(bridge, {
    get(target, property, receiver) {
      if (property === BUILT_IN_BROWSER_ATTACH_USER_BROWSER_METHOD) {
        return (input?: unknown) => userBrowser.attach((input ?? {}) as Parameters<UserBrowserAttachService["attach"]>[0]);
      }
      if (property === BUILT_IN_BROWSER_DETACH_USER_BROWSER_METHOD) {
        return (input?: unknown) => userBrowser.detach((input ?? {}) as Parameters<UserBrowserAttachService["detach"]>[0]);
      }
      const inner = Reflect.get(target, property, receiver) as unknown;
      // Only browser actions route. The capability lifecycle, the runtime
      // status mirror and `dispose` carry a chat id too, and must always reach
      // the bridge.
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
          const chatSessionId = chatOf(input);
          if (!userBrowser.isAttached(chatSessionId)) return await call.call(target, input);
          const attached = await userBrowser.dispatch("getStatus", input) as Record<string, unknown>;
          try {
            const status = await call.call(target, input);
            return status && typeof status === "object" ? { ...(status as object), ...attached } : attached;
          } catch (error) {
            return { ...attached, builtInUnavailable: error instanceof Error ? error.message : String(error) };
          }
        };
      }
      return (input?: unknown) => {
        const chatSessionId = chatOf(input);
        if (userBrowser.routes(chatSessionId, property)) return userBrowser.dispatch(property, input);
        return call.call(target, input);
      };
    },
  }) as BuiltInBrowserDesktopBridgeClient;
}
