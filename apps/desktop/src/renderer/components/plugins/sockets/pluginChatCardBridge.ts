import type { PluginSessionContext } from "../../../../shared/plugins/context";
import { runPluginSocketAction } from "./pluginActionDispatch";

/**
 * `ade:chat:card-action` → `plugin.invoke`, for cards a plugin emitted.
 *
 * `AdeCard`'s action row broadcasts every non-`open`, non-`retry` press as a
 * window CustomEvent and lets a host decide what it means — the same extension
 * shape as `ade:chat:open-info`. Until this listener existed nothing was
 * listening, so a plugin could emit a card with buttons and the buttons did
 * nothing.
 *
 * Why a window listener and not a prop on the card: many chat panes are mounted
 * at once in the Work grid, and each one renders its own transcript. A per-pane
 * handler would run the plugin's action once per mounted pane for a single
 * press. There is exactly one bridge for the app, installed on first use, and
 * it is keyed on the card's own identity rather than on which pane drew it.
 *
 * The transcript's own plugin cards no longer come through the broadcast:
 * `PluginChatCard` calls {@link handlePluginChatCardAction} directly, because
 * the press already arrives at the one card that owns it and the direct call is
 * what returns a promise — which is what lets the pressed button say "working"
 * and refuse a second press. The listener stays for plugin cards drawn by
 * anything else, and for a host that wants to claim these presses without
 * importing this module.
 *
 * The `pluginId` in the detail comes from the card's HOST-STAMPED `authoredBy`
 * (see `shared/adeCard.ts`), never from the action or the payload, so a card
 * cannot route its button presses into a plugin that did not write it.
 */

export const CHAT_CARD_ACTION_EVENT = "ade:chat:card-action";

/** What `AdeCard`'s dispatcher puts on the event, as this bridge reads it. */
export type PluginChatCardActionDetail = {
  actionId: string;
  cardId: string;
  variant?: string;
  sessionId?: string;
  /** Present only on a plugin-emitted card. Its absence is what makes this a no-op. */
  pluginId?: string;
  /** The card's own title, for the session context's `title`. */
  sessionTitle?: string;
  provider?: string | null;
};

let installed = false;

/**
 * Install the bridge, once per renderer.
 *
 * Idempotent and never torn down: it is one listener for the life of the
 * window, and the alternative — mount/unmount with the transcript — reintroduces
 * exactly the multi-pane duplication it exists to avoid. Called lazily from the
 * card dispatcher, so a build that never renders a plugin card never registers
 * anything.
 */
export function ensurePluginChatCardActionBridge(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener(CHAT_CARD_ACTION_EVENT, (event) => {
    handlePluginChatCardAction((event as CustomEvent).detail);
  });
}

/** Exposed for tests; the listener above is the only production caller. */
export function handlePluginChatCardAction(detail: unknown): Promise<void> | void {
  const parsed = readPluginChatCardActionDetail(detail);
  if (!parsed) return;
  const context: PluginSessionContext = {
    kind: "session",
    id: parsed.sessionId ?? "",
    title: parsed.sessionTitle ?? "",
    provider: parsed.provider ?? null,
    status: null,
  };
  return runPluginSocketAction(parsed.pluginId, parsed.actionId, context, {
    socket: "chat-card",
    // The row the button belonged to. A plugin that emits one card per PR, per
    // run or per file cannot tell them apart from the session alone, and
    // `cardId` is the identity it chose when it emitted — the same string it
    // re-emits to update the row.
    args: {
      card: {
        cardId: parsed.cardId,
        ...(parsed.variant ? { variant: parsed.variant } : {}),
      },
    },
  });
}

/**
 * Narrow the CustomEvent detail, or null when this press is not ours.
 *
 * A detail with no `pluginId` is a card ADE emitted; it belongs to whatever
 * other host is listening and must fall through here untouched rather than be
 * refused loudly.
 */
function readPluginChatCardActionDetail(
  detail: unknown,
): (PluginChatCardActionDetail & { pluginId: string; actionId: string; cardId: string }) | null {
  if (!detail || typeof detail !== "object") return null;
  const record = detail as Record<string, unknown>;
  const pluginId = typeof record.pluginId === "string" ? record.pluginId.trim() : "";
  const actionId = typeof record.actionId === "string" ? record.actionId.trim() : "";
  const cardId = typeof record.cardId === "string" ? record.cardId.trim() : "";
  if (!pluginId || !actionId || !cardId) return null;
  const sessionId = typeof record.sessionId === "string" ? record.sessionId.trim() : "";
  const variant = typeof record.variant === "string" ? record.variant.trim() : "";
  const sessionTitle = typeof record.sessionTitle === "string" ? record.sessionTitle : "";
  const provider = typeof record.provider === "string" ? record.provider : null;
  return {
    pluginId,
    actionId,
    cardId,
    ...(variant ? { variant } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(sessionTitle ? { sessionTitle } : {}),
    ...(provider ? { provider } : {}),
  };
}
