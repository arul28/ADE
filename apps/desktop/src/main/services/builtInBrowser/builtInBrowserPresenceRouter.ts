import type { BrowserWindow } from "electron";
import type { BuiltInBrowserAgentPresence, BuiltInBrowserEventPayload } from "../../../shared/types";
import { builtInBrowserAgentPresence } from "./builtInBrowserPresence";
import type {
  BuiltInBrowserAgentPresenceEntry,
  BuiltInBrowserAgentPresenceTracker,
} from "./builtInBrowserPresence";

/**
 * The one place that turns browser facts into agent-presence, and presence into
 * per-window events.
 *
 * The tracker below it knows who is browsing and when that expires; the browser
 * coordinator above it knows about windows, collections and tabs. Neither knows
 * the routing rule, and that rule is the part with teeth: presence is scoped to
 * the asking window's projects, and the pushed event and every seed must apply
 * the same scope or one window disagrees with itself depending on which arrived
 * last. Keeping the transitions, the projection and the subscription together
 * means there is exactly one copy of it.
 */
export type BuiltInBrowserPresenceRouter = {
  /** Presence side effects read off the event stream. */
  noteEvent(payload: BuiltInBrowserEventPayload): void;
  /** The badge's seed for one window, scoped to that window's projects. */
  presenceForWindow(win: BrowserWindow | null | undefined): BuiltInBrowserAgentPresence[];
  /** The `getStatus` seed, scoped to the collection the status describes. */
  presenceForProjectRoot(projectRoot: string | null): BuiltInBrowserAgentPresence[];
  /** A window's services are being disposed: end its agents' turn at every tab. */
  noteWindowTabsClosed(tabIds: readonly string[]): void;
  /** One tab closed, resolved before the tab is gone. */
  noteTabClosed(tabId: string): void;
  /** Drops this router's subscription. The tracker itself is process-wide. */
  dispose(): void;
};

/** The public shape, which never carries the entry's collection scope. */
function toPublicPresence(entry: BuiltInBrowserAgentPresenceEntry): BuiltInBrowserAgentPresence {
  return {
    chatSessionId: entry.chatSessionId,
    laneId: entry.laneId,
    tabId: entry.tabId,
    since: entry.since,
    lastActivityAt: entry.lastActivityAt,
  };
}

export function createBuiltInBrowserPresenceRouter(args: {
  onEvent?: ((payload: BuiltInBrowserEventPayload, targetWindow?: BrowserWindow | null) => void) | null;
  /** Every live window that has opened the browser, in routing order. */
  listWindows: () => BrowserWindow[];
  /** The project collections one window holds, for scoping what it may be told. */
  scopeForWindow: (win: BrowserWindow) => Array<string | null>;
  projectRootsMatch: (left: string | null | undefined, right: string | null | undefined) => boolean;
  isLiveWindow: (value: unknown) => boolean;
  /** Tests build their own tracker; the app shares the process-wide one. */
  presence?: BuiltInBrowserAgentPresenceTracker;
}): BuiltInBrowserPresenceRouter {
  const presence = args.presence ?? builtInBrowserAgentPresence;

  /**
   * A personal-collection agent belongs to no project and is visible to whoever
   * asks — the rule `list({ projectRoot })` already applies. `null` roots mean
   * an unscoped read, which only a caller with no window to scope by can make.
   */
  const scoped = (
    entries: BuiltInBrowserAgentPresenceEntry[],
    roots: Array<string | null> | null,
  ): BuiltInBrowserAgentPresence[] =>
    entries
      .filter((entry) => !roots
        || entry.projectRoot == null
        || roots.some((root) => args.projectRootsMatch(root, entry.projectRoot)))
      .map(toPublicPresence);

  /**
   * Agent-presence side effects that only the event stream can see.
   *
   * Both are read off events rather than off the methods that cause them,
   * because the interesting cases are the ones no agent asked for: a recording
   * that hit its wall-clock cap, or one a login handoff suspended, stops without
   * a `stopRecording` call, and a handoff can be started by the auto-offer.
   * Driving presence from the announcement means the badge cannot outlive the
   * fact — there is no path that ends a capture or opens a handoff quietly.
   */
  const noteEvent = (payload: BuiltInBrowserEventPayload): void => {
    if (payload.type === "recording") {
      // A capture runs for minutes with no commands. Hold presence while it
      // does, and let go the moment it stops for ANY reason.
      if (payload.recording) presence.holdForTab(payload.tabId);
      else presence.releaseHoldForTab(payload.tabId);
      return;
    }
    if (payload.type === "handoff-started") {
      // The agent has explicitly stepped back from this tab so a human can sign
      // in. A globe still pulsing beside the chat would contradict the one
      // banner asking the person to act.
      presence.clearForTab(payload.tabId);
      const owner = payload.handoff.previousOwner.chatSessionId
        ?? payload.handoff.requestedByChatSessionId;
      // Also by chat: an agent whose last command named no tab has presence with
      // a null `tabId`, which the tab-scoped clear above cannot match.
      if (owner) presence.clearForChatSession(owner);
    }
  };

  // Presence changes are pushed, not polled: the surfaces that show it (session
  // cards, the chat header, the tool tab's dot) are already subscribed to this
  // stream, and expiry happens on a timer with nothing else to ride along with.
  //
  // Sent per window and scoped to that window's projects, the same routing every
  // other browser event takes. A broadcast of the whole set lit a dot beside a
  // chat in project A for an agent browsing in project B — and it contradicted
  // the `getStatus` seed, which has always been scoped to the collection it
  // describes, so the same window disagreed with itself depending on which of
  // the two arrived last.
  const unsubscribe = presence.subscribe(() => {
    const updatedAt = new Date().toISOString();
    const entries = presence.list();
    // No window has opened the browser at all (a fallback-service process, a
    // test): there is no window whose scope could be read, and an unscoped
    // broadcast would contradict the scoping this block exists to enforce.
    // Nobody is listening either, so say nothing.
    for (const win of args.listWindows()) {
      args.onEvent?.({
        type: "agent-presence",
        presence: scoped(entries, args.scopeForWindow(win)),
        updatedAt,
      }, win);
    }
  });

  return {
    noteEvent,
    presenceForWindow(win) {
      const roots = args.isLiveWindow(win) ? args.scopeForWindow(win as BrowserWindow) : null;
      return scoped(presence.list(), roots);
    },
    presenceForProjectRoot(projectRoot) {
      return presence.list({ projectRoot }).map(toPublicPresence);
    },
    noteWindowTabsClosed(tabIds) {
      presence.clearForTabs(tabIds);
    },
    noteTabClosed(tabId) {
      presence.clearForTab(tabId);
    },
    dispose() {
      unsubscribe();
    },
  };
}
