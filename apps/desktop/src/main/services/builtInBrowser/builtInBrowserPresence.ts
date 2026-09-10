import path from "node:path";
import { pathsEqual } from "../shared/pathCompare";
import {
  BUILT_IN_BROWSER_PRESENCE_EXPIRY_MS,
  BUILT_IN_BROWSER_PRESENCE_HOLD_MAX_MS,
} from "../../../shared/types/builtInBrowser";
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
 * - It can be HELD, but not forever. A recording runs for minutes without a
 *   single command, and dropping presence mid-capture would say the agent had
 *   walked away from the tab it is filming. A hold suspends expiry; the hold is
 *   released by the same `recording` event that tells every other surface the
 *   capture stopped (including the ones the agent did not ask for — a cap, a
 *   login handoff). That event is the only release, so every hold also carries a
 *   deadline ({@link BUILT_IN_BROWSER_PRESENCE_HOLD_MAX_MS}) and is dropped when
 *   it passes: a release lost to a torn-down renderer or a window closed under
 *   a capture must cost one deadline, not the life of the process.
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
 *
 * Both windows — the expiry and the hold deadline — live in
 * `shared/types/builtInBrowser` rather than here, because the runtime daemon
 * sizes its own staleness window from the expiry and must not value-import an
 * Electron-main module to read it.
 */

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
  /**
   * Records one agent-authenticated browser command.
   *
   * Reports whether this call is what created the entry, and the sequence
   * number it wrote — the two things a caller needs to take its own touch back
   * if the command it was announcing then failed. See `clearForChatSession`.
   *
   * The stamp is a counter rather than a clock because the clock is not fine
   * enough to tell two touches apart: parallel `ade browser` calls from one
   * chat share an actor token and routinely land in the same millisecond, and
   * a `lastActivityAt` guard would then let a failing call retract a live
   * agent. The counter is tracker-wide and never reused, so a sequence cannot
   * accidentally match a record that was cleared and re-created meanwhile.
   */
  touch(input: BuiltInBrowserAgentPresenceTouch): { created: boolean; sequence: number };
  /**
   * Suspends expiry for whichever chat is on this tab — a recording, which runs
   * for minutes without a command. Keyed by the tab so two concurrent captures
   * cannot have one's end release the other's hold, and deadlined so a release
   * that never arrives cannot suspend expiry forever.
   */
  holdForTab(tabId: string): void;
  releaseHoldForTab(tabId: string): void;
  /**
   * The chat ended, its capability was revoked — or a command that had already
   * announced itself never ran.
   *
   * `ifSequence` makes the clear conditional on the entry not having moved
   * since: an undo is only ever correct for the exact touch it is retracting,
   * and a concurrent command from the same chat that landed in between is a
   * live agent whose globe must stay lit. A conditional clear also refuses
   * while the record holds a tab — a recording started between the leading
   * touch and the failure is a live capture, and deleting the record would
   * take its hold with it and leave the eventual `recording:false` release
   * with nothing to find. An unconditional clear (the chat ended, a handoff
   * moved the tab to a human) is a fact, not a retraction, and always applies.
   */
  clearForChatSession(chatSessionId: string, options?: { ifSequence?: number }): void;
  /** The tab went away — closed, released, or handed to a human. */
  clearForTab(tabId: string): void;
  /**
   * The same, for a whole window's tabs at once, with ONE notification.
   *
   * Closing a window with six tabs used to publish six full presence sets to
   * every other window and phone, each one a superset of the next.
   */
  clearForTabs(tabIds: readonly string[]): void;
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
  /** Tracker-wide, never reused — see `touch`. */
  sequence: number;
  /** Tab id → the moment the hold stops counting, whatever it is waiting for. */
  holds: Map<string, number>;
  timer: ReturnType<typeof setTimeout> | null;
};

export function createBuiltInBrowserAgentPresenceTracker(args?: {
  expiryMs?: number;
  holdMaxMs?: number;
}): BuiltInBrowserAgentPresenceTracker {
  const expiryMs = Math.max(1, args?.expiryMs ?? BUILT_IN_BROWSER_PRESENCE_EXPIRY_MS);
  const holdMaxMs = Math.max(1, args?.holdMaxMs ?? BUILT_IN_BROWSER_PRESENCE_HOLD_MAX_MS);
  const records = new Map<string, PresenceRecord>();
  const listeners = new Set<() => void>();
  let nextSequence = 1;
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
    const now = Date.now();
    // A held record wakes at its earliest hold deadline, not at the expiry it
    // is suspending: expiry has usually already passed under a long capture, and
    // arming on that would spin a 1ms timer for the length of the recording.
    const wakeAt = record.holds.size > 0
      ? Math.min(...record.holds.values())
      : record.lastActivityAt + expiryMs;
    const timer = setTimeout(() => {
      record.timer = null;
      if (records.get(record.chatSessionId) !== record) return;
      // A hold whose deadline has passed is a release that never arrived. Drop
      // it and judge the record on what is left, so a missed `recording:false`
      // cannot pin presence for the life of the process.
      const firedAt = Date.now();
      for (const [tabId, deadline] of [...record.holds]) {
        if (deadline <= firedAt) record.holds.delete(tabId);
      }
      // Still held, or touched while the timer was pending: both mean the agent
      // is still on the tab, so re-arm on the fact that is now nearest.
      if (record.holds.size > 0 || record.lastActivityAt + expiryMs > firedAt) {
        armTimer(record);
        return;
      }
      records.delete(record.chatSessionId);
      emit();
    }, Math.max(1, wakeAt - now));
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
      existing.sequence = nextSequence++;
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
      sequence: nextSequence++,
      holds: new Map<string, number>(),
      timer: null,
    };
    records.set(chatSessionId, record);
    armTimer(record);
    emit();
    return record;
  };

  /** Shared by the single- and batch-tab clears; `true` when a record went. */
  const clearTabWithoutEmit = (tabId: string): boolean => {
    const key = trimmedOrNull(tabId);
    if (!key) return false;
    let removed = false;
    for (const [chatSessionId, record] of [...records]) {
      // A hold keyed by this tab dies with it, whichever chat owns it.
      record.holds.delete(key);
      if (record.tabId !== key) continue;
      clearTimer(record);
      records.delete(chatSessionId);
      removed = true;
    }
    return removed;
  };

  return {
    touch(input) {
      const existing = records.get(trimmedOrNull(input.chatSessionId) ?? "") ?? null;
      const record = upsert(input);
      return {
        created: Boolean(record) && !existing,
        sequence: record?.sequence ?? 0,
      };
    },

    holdForTab(tabId) {
      const key = trimmedOrNull(tabId);
      if (!key) return;
      // Only a chat already present on the tab can hold it. A recording is
      // always armed by a command that just touched presence with this tab id,
      // so there is nothing to invent here — and nothing to resurrect if the
      // chat's presence has since been cleared by a handoff or a closed tab.
      const deadline = Date.now() + holdMaxMs;
      for (const record of records.values()) {
        if (record.tabId !== key) continue;
        // Re-holding refreshes the deadline: a `recording:true` for a tab that
        // is already held is a live capture saying so again.
        record.holds.set(key, deadline);
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

    clearForChatSession(chatSessionId, options) {
      const key = trimmedOrNull(chatSessionId);
      if (!key) return;
      const record = records.get(key) ?? null;
      if (!record) return;
      if (options?.ifSequence != null) {
        if (record.sequence !== options.ifSequence) return;
        // A hold is a capture that outlived the command which armed it; the
        // failing command is not entitled to take the recording's presence.
        if (record.holds.size > 0) return;
      }
      clearTimer(record);
      records.delete(key);
      emit();
    },

    clearForTab(tabId) {
      if (clearTabWithoutEmit(tabId)) emit();
    },

    clearForTabs(tabIds) {
      let removed = false;
      for (const tabId of tabIds) {
        if (clearTabWithoutEmit(tabId)) removed = true;
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
