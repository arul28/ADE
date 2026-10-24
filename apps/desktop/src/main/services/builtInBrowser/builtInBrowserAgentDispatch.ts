import {
  JsonRpcError,
  JsonRpcErrorCode,
} from "../../../../../ade-cli/src/jsonrpc";
import {
  isBuiltInBrowserDesktopBridgeMethod,
} from "../../../../../ade-cli/src/services/builtInBrowser/desktopBridgeMethods";
import { carryExpected } from "../../../shared/expectedError";
import { builtInBrowserAgentPresence } from "./builtInBrowserPresence";
import type { BuiltInBrowserService } from "./builtInBrowserService";

/** The two calls that end the agent's turn at a tab, and clear its presence themselves. */
const TURN_ENDING_BRIDGE_METHODS = new Set<string>(["closeTab", "startHandoff"]);

/**
 * Run one `built_in_browser.*` method as an agent: the identity in `rawParams`
 * (chat, lane, project or personal collection) is the caller's answer to "who
 * is this", presence is lit around the call, and nothing is forced.
 *
 * Shared by the two ways an agent's command arrives: the bridge socket, from
 * the runtime on this machine, and `runRemoteAgentCall`, from a runtime on
 * another machine whose user sits at this desktop.
 */
export async function dispatchBuiltInBrowserAgentCall(
  service: BuiltInBrowserService,
  name: string,
  rawParams: Record<string, unknown>,
): Promise<unknown> {
  if (!isBuiltInBrowserDesktopBridgeMethod(name)) {
    throw new JsonRpcError(
      JsonRpcErrorCode.methodNotFound,
      `Action 'built_in_browser.${name}' is not exposed by the desktop bridge.`,
    );
  }
  // The runtime daemon decides who is calling: it resolves the chat, its lane
  // and its project (or the personal collection) from the caller it already
  // knows, and sends them here. A call with no chat (the user's own terminal)
  // is allowed too; it just owns no tab.
  const chatSessionId = normalizedString(rawParams.chatSessionId);
  const laneId = normalizedString(rawParams.laneId);
  const tabCollection = rawParams.tabCollection === "personal" ? "personal" : null;
  const projectRoot = tabCollection === "personal" ? null : normalizedString(rawParams.projectRoot);
  const params = {
    ...rawParams,
    chatSessionId: chatSessionId ?? undefined,
    laneId: laneId ?? undefined,
    ...(projectRoot
      ? { projectRoot, tabCollection: undefined }
      : { projectRoot: undefined, tabCollection: tabCollection ?? undefined }),
    force: false,
  };
  // A step caption touches no tab: it must not light the browser's presence.
  if (name === "noteDemoStep") {
    return service.noteDemoStep(params);
  }
  const callable: unknown = service[name];
  if (typeof callable !== "function") {
    throw new JsonRpcError(
      JsonRpcErrorCode.methodNotFound,
      `Desktop bridge cannot dispatch built_in_browser.${name}.`,
    );
  }
  // Recorded on BOTH edges of the call.
  //
  // Before, because a `wait`, a slow navigation or a long `observe` is
  // exactly the stretch a person is trying to explain, and a globe that lit
  // only on completion stayed dark for the whole of it — indefinitely, for
  // back-to-back long calls, since the twenty-second window would not even
  // start until one returned. After, because that window should be measured
  // from when the agent finished, not from when it began.
  //
  // Every method counts, reads included: `status` and `observe` are how an
  // agent looks at the page, and a badge that lit only for writes would go
  // dark while it read.
  //
  // Presence is a chat's ("this chat is browsing"); a chatless call has none.
  const presenceTouch = chatSessionId
    ? { chatSessionId, laneId, projectRoot, tabId: normalizedString(rawParams.tabId) }
    : null;
  const opened = presenceTouch ? builtInBrowserAgentPresence.touch(presenceTouch) : null;
  try {
    const result = await (callable as (input: unknown) => Promise<unknown>).call(service, params);
    // …except after the two calls that END the agent's turn at the tab. Both
    // clear presence from inside the dispatch, and a trailing touch would
    // re-create the record they just removed — with the dead or handed-off
    // tab id — leaving the badge saying "browsing" for a full expiry window
    // after the agent closed its last tab, or pulsing beside the very banner
    // asking a human to sign in.
    if (presenceTouch && !TURN_ENDING_BRIDGE_METHODS.has(name)) {
      builtInBrowserAgentPresence.touch(presenceTouch);
    }
    return result;
  } catch (error) {
    // The call did nothing to the browser ("No ADE browser window is open for
    // project…"), so the announcement is taken back — but only when this call
    // is what made it. A failure inside a stream of commands leaves presence
    // the earlier ones earned, and the `ifSequence` guard drops the undo if a
    // concurrent command from the same chat moved the entry meanwhile (or if
    // a recording took a hold on it while this call was in flight).
    if (chatSessionId && opened?.created) {
      builtInBrowserAgentPresence.clearForChatSession(chatSessionId, {
        ifSequence: opened.sequence,
      });
    }
    if (error instanceof JsonRpcError) throw error;
    // The browser's answers ("Browser tab not found") stay marked across the
    // bridge, so the brain does not report them as its own failures.
    throw carryExpected(error, new JsonRpcError(
      JsonRpcErrorCode.internalError,
      error instanceof Error ? error.message : String(error),
    ));
  }
}

function normalizedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
