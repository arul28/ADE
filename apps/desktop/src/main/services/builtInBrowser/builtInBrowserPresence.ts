import path from "node:path";
import { pathsEqual } from "../shared/pathCompare";
import type { BuiltInBrowserAgentPresence } from "../../../shared/types/builtInBrowser";

/**
 * "An agent is using the browser right now", derived rather than declared.
 *
 * Every surface that shows a chat — the session card, the chat header, the
 * Tools pane, the phone, the TUI — needs the same one-bit answer, and the agent
 * must never be the one to supply it. An instruction to "announce when you open
 * the browser" is a fact the model can forget, embellish, or leave set after it
 * has moved on; the only trustworthy evidence that an agent is driving the
 * browser is the browser being driven. So presence is a side effect of the
 * calls themselves: `desktopBridgeServer` touches this registry for every
 * capability-validated `built_in_browser.*` command, keyed by the chat session
 * the capability was minted for.
 *
 * Three rules follow from that, and all three are here rather than at the call
 * sites:
 *
 * - It EXPIRES. An agent that stops using the browser makes no call saying so,
 *   so a badge that waits for one would stay lit until the chat ended.
 *   {@link BUILT_IN_BROWSER_PRESENCE_EXPIRY_MS} after the last command the
 *   entry is dropped, on a timer — never on a poll, because a poller for a
 *   badge nobody is looking at is exactly the kind of idle cost the Work
 *   surfaces have been stripping out.
 * - It can be HELD. A recording runs for minutes without a single command, and
 *   dropping presence mid-capture would say the agent had walked away from the
 *   tab it is filming. A hold suspends expiry; the hold is released by the same
 *   `recording` event that tells every other surface the capture stopped
 *   (including the ones the agent did not ask for — a cap, a login handoff), so
 *   a hold cannot outlive its reason.
 * - It CLEARS on the events that end the agent's turn at the tab: the tab
 *   closes, the capability is revoked when the chat ends, or a login handoff
 *   moves the tab to the human. A handoff especially: the whole point of that
 *   state is that the agent has stepped back, and a globe still pulsing beside
 *   the chat would contradict the one banner asking the person to act.
 *
 * Deliberately in-memory and process-local, like the actor capabilities it is
 * keyed by. Presence is a statement about a live process; a replicated row
 * would outlive the Electron main that meant it and leave a phone claiming an
 * agent is browsing on a Mac that has quit.
 */

/** How long after an agent's last browser command presence survives. */
export const BUILT_IN_BROWSER_PRESENCE_EXPIRY_MS = 20_000;

export type BuiltInBrowserAgentPresenceEntry = BuiltInBrowserAgentPresence & {
  /**
   * Collection the agent's capability is scoped to, so a project-scoped read
   * (the runtime daemon's Work-tools mirror) cannot be told about a chat
   * browsing in another project. `null` is the personal collection, which is
   * scoped to no project and therefore visible to whoever asks — the same rule
   * the tab list applies to an unowned tab.
   */
  projectRoot: string | null;
};

export type BuiltInBrowserAgentPresenceTouch = {
  chatSessionId: string;
  laneId?: string | null;
  projectRoot?: string | null;
  /** The tab the command addressed, when it named one. */
  tabId?: string | null;
};

export type BuiltInBrowserAgentPresenceTracker = {
  /** Records one agent-authenticated browser command. */
  touch(input: BuiltInBrowserAgentPresenceTouch): void;
  /**
   * Suspends expiry for whichever chat is on this tab — a recording, which runs
   * for minutes without a command. Keyed by the tab so two concurrent captures
   * cannot have one's end release the other's hold.
   */
  holdForTab(tabId: string): void;
  releaseHoldForTab(tabId: string): void;
  /** The chat ended, or its capability was revoked. */
  clearForChatSession(chatSessionId: string): void;
  /** The tab went away — closed, released, or handed to a human. */
  clearForTab(tabId: string): void;
  /** Live entries, newest activity first, optionally scoped to one project. */
  list(filter?: { projectRoot?: string | null }): BuiltInBrowserAgentPresenceEntry[];
  /** Fires when an entry appears, changes tab, or expires — not on a heartbeat. */
  subscribe(listener: () => void): () => void;
  dispose(): void;
};

type PresenceRecord = {
  chatSessionId: string;
  laneId: string | null;
  projectRoot: string | null;
  tabId: string | null;
  since: number;
  lastActivityAt: number;
  holds: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
};

export function createBuiltInBrowserAgentPresenceTracker(args?: {
  expiryMs?: number;
}): BuiltInBrowserAgentPresenceTracker {
  const expiryMs = Math.max(1, args?.expiryMs ?? BUILT_IN_BROWSER_PRESENCE_EXPIRY_MS);
  const records = new Map<string, PresenceRecord>();
  const listeners = new Set<() => void>();
  let disposed = false;

  const emit = (): void => {
    if (disposed) return;
    // A listener that throws must not strand the rest: presence is decoration
    // on top of a browser command, and it may not fail that command.
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // ignore listener faults
      }
    }
  };

  const clearTimer = (record: PresenceRecord): void => {
    if (!record.timer) return;
    clearTimeout(record.timer);
    record.timer = null;
  };

  const armTimer = (record: PresenceRecord): void => {
    clearTimer(record);
    if (disposed) return;
    const remaining = Math.max(0, record.lastActivityAt + expiryMs - Date.now());
    const timer = setTimeout(() => {
      record.timer = null;
      // A hold means the agent is still on the tab with nothing to say — a
      // recording in progress. Re-arm rather than expire, so the hold is
      // checked again on the next window instead of pinning presence forever if
      // its release is ever missed.
      if (record.holds.size > 0) {
        armTimer(record);
        return;
      }
      if (records.get(record.chatSessionId) !== record) return;
      records.delete(record.chatSessionId);
      emit();
    }, remaining || 1);
    // Presence is UI decoration; it must never hold the process open.
    timer.unref?.();
    record.timer = timer;
  };

  const upsert = (input: BuiltInBrowserAgentPresenceTouch): PresenceRecord | null => {
    const chatSessionId = trimmedOrNull(input.chatSessionId);
    if (!chatSessionId || disposed) return null;
    const tabId = trimmedOrNull(input.tabId);
    const laneId = trimmedOrNull(input.laneId);
    const projectRoot = normalizedRoot(input.projectRoot);
    const now = Date.now();
    const existing = records.get(chatSessionId) ?? null;
    if (existing) {
      // A visible change is a new tab or a lane/project the entry did not have;
      // a bare heartbeat is not, and emitting on one would push an event to
      // every window and phone for every keystroke an agent types into a page.
      const changed = (tabId != null && tabId !== existing.tabId)
        || (laneId != null && laneId !== existing.laneId)
        || (projectRoot != null && projectRoot !== existing.projectRoot);
      existing.lastActivityAt = now;
      if (tabId != null) existing.tabId = tabId;
      if (laneId != null) existing.laneId = laneId;
      if (projectRoot != null) existing.projectRoot = projectRoot;
      armTimer(existing);
      if (changed) emit();
      return existing;
    }
    const record: PresenceRecord = {
      chatSessionId,
      laneId,
      projectRoot,
      tabId,
      since: now,
      lastActivityAt: now,
      holds: new Set<string>(),
      timer: null,
    };
    records.set(chatSessionId, record);
    armTimer(record);
    emit();
    return record;
  };

  return {
    touch(input) {
      upsert(input);
    },

    holdForTab(tabId) {
      const key = trimmedOrNull(tabId);
      if (!key) return;
      // Only a chat already present on the tab can hold it. A recording is
      // always armed by a command that just touched presence with this tab id,
      // so there is nothing to invent here — and nothing to resurrect if the
      // chat's presence has since been cleared by a handoff or a closed tab.
      for (const record of records.values()) {
        if (record.tabId !== key) continue;
        record.holds.add(key);
        armTimer(record);
      }
    },

    releaseHoldForTab(tabId) {
      const key = trimmedOrNull(tabId);
      if (!key) return;
      for (const record of records.values()) {
        if (!record.holds.delete(key)) continue;
        // The hold stood in for activity, so the expiry window starts now
        // rather than from whenever the last command happened to land.
        record.lastActivityAt = Date.now();
        armTimer(record);
      }
    },

    clearForChatSession(chatSessionId) {
      const key = trimmedOrNull(chatSessionId);
      if (!key) return;
      const record = records.get(key) ?? null;
      if (!record) return;
      clearTimer(record);
      records.delete(key);
      emit();
    },

    clearForTab(tabId) {
      const key = trimmedOrNull(tabId);
      if (!key) return;
      let removed = false;
      for (const [chatSessionId, record] of [...records]) {
        // A hold keyed by this tab dies with it, whichever chat owns it.
        record.holds.delete(key);
        if (record.tabId !== key) continue;
        clearTimer(record);
        records.delete(chatSessionId);
        removed = true;
      }
      if (removed) emit();
    },

    list(filter) {
      const scope = filter && "projectRoot" in filter ? normalizedRoot(filter.projectRoot) : null;
      return [...records.values()]
        .filter((record) => !scope
          || record.projectRoot == null
          || pathsEqual(record.projectRoot, scope))
        .sort((left, right) => right.lastActivityAt - left.lastActivityAt)
        .map((record) => ({
          chatSessionId: record.chatSessionId,
          laneId: record.laneId,
          projectRoot: record.projectRoot,
          tabId: record.tabId,
          since: new Date(record.since).toISOString(),
          lastActivityAt: new Date(record.lastActivityAt).toISOString(),
        }));
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    dispose() {
      disposed = true;
      for (const record of records.values()) clearTimer(record);
      records.clear();
      listeners.clear();
    },
  };
}

/**
 * The process-wide tracker.
 *
 * Module-scoped for the same reason the actor capability registry is: the two
 * writers are the desktop bridge (which validates the capability) and the
 * browser service (which sees tabs close and recordings end), and they must not
 * be able to disagree about who is browsing. Tests build their own with
 * {@link createBuiltInBrowserAgentPresenceTracker}.
 */
export const builtInBrowserAgentPresence = createBuiltInBrowserAgentPresenceTracker();

function trimmedOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function normalizedRoot(value: string | null | undefined): string | null {
  const trimmed = trimmedOrNull(value);
  return trimmed ? path.resolve(trimmed) : null;
}
