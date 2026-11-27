/*
  Phone size. A remote viewer that sends its picture size (`viewport`) gets
  the page laid out at it: a touch-device emulation through the same
  debugger-held override a device preset uses, labelled "Phone view" so the
  person at the desktop knows why. It is the viewer's, never the desktop's:

  - It is never put over an emulation someone else set, and a `setEmulation`
    while it is on (the toolbar's device control, an agent's `emulate`)
    takes the tab over for the rest of the watch.
  - It yields while the person at the desktop has the tab in front of them,
    or while the tab records, has DevTools open or is mid sign-in.
  - It comes off when the watch lapses, or when reads keep arriving without
    a viewport (the phone switched to desktop size). Two viewers can watch
    one tab, so a read without a viewport clears it only once no read with
    one has arrived for a moment.

  Only this code clears it: a slot's `applied` is the exact state object it
  put on the tab, and a tab whose `emulation` is any other object is not its
  to touch.
*/

import type {
  BuiltInBrowserEmulationState,
  BuiltInBrowserRemoteViewport,
} from "../../../shared/types/builtInBrowser";
import { builtInBrowserRemoteViewportEmulation } from "../../../shared/builtInBrowserEmulation";
import type { Logger } from "../logging/logger";
import { errorMessage } from "./builtInBrowserConstants";
import type { BrowserDebuggerHoldOwner, BrowserTabState } from "./builtInBrowserService";

/** How long a read with a viewport keeps phone size on against reads without one. */
const REMOTE_VIEWPORT_HOLD_MS = 2_000;
/** A release that keeps losing to new reads gives up after this many rounds. */
const RELEASE_ROUNDS = 3;

/** One tab's phone-size state. */
type RemoteViewportSlot = {
  /** The emulation this code put on the tab, by identity; null when none. */
  applied: BuiltInBrowserEmulationState | null;
  /** The next state to reach (null: off), not started yet; undefined when none. */
  pending: BuiltInBrowserEmulationState | null | undefined;
  /** The state being applied right now; undefined when idle. */
  inFlight: BuiltInBrowserEmulationState | null | undefined;
  /** The run applying `pending`, one at a time; null when idle. */
  drain: Promise<void> | null;
  /** When a read last asked for a viewport. */
  askedAt: number;
  /** Someone set the tab's size during this watch: phone size stays off until it ends. */
  yielded: boolean;
  /** Phone size could not be put on the tab (no debugger): not retried until the watch ends. */
  failed: boolean;
};

export type RemoteViewportDeps = {
  logger: () => Logger | null;
  tabById: (tabId: string) => BrowserTabState | null;
  /** A remote watch on the tab is live (its lease has not lapsed). */
  isWatched: (tabId: string) => boolean;
  /** The person at the desktop is looking at this tab right now. */
  isTabOnScreen?: (tabId: string) => boolean;
  acquireDebuggerHold: (tab: BrowserTabState, owner: BrowserDebuggerHoldOwner) => Promise<void>;
  releaseDebuggerHold: (tab: BrowserTabState, owner: BrowserDebuggerHoldOwner) => void;
  /** Puts an emulation on the tab (null: takes it off), without touching `tab.emulation`. */
  sendEmulationCommands: (tab: BrowserTabState, next: BuiltInBrowserEmulationState | null) => Promise<void>;
  /** Re-sends the tab's own `tab.emulation`. */
  reapplyTabEmulation: (tab: BrowserTabState) => void;
  /** The tab's layout size changed: drop stale frames, re-place the view, emit status. */
  onLayoutChanged: (tab: BrowserTabState) => void;
  /** Phone size came off the tab: put the recording viewport back if it applies. */
  onCleared?: (tab: BrowserTabState) => void;
};

export type RemoteViewportAnswer = { viewportApplied?: boolean; viewportNote?: string | null };

export type RemoteViewport = ReturnType<typeof createRemoteViewport>;

export function createRemoteViewport(deps: RemoteViewportDeps) {
  const slots = new Map<string, RemoteViewportSlot>();

  const slotFor = (tabId: string): RemoteViewportSlot => {
    let slot = slots.get(tabId);
    if (!slot) {
      slot = { applied: null, pending: undefined, inFlight: undefined, drain: null, askedAt: 0, yielded: false, failed: false };
      slots.set(tabId, slot);
    }
    return slot;
  };

  const dropSlot = (tabId: string): void => {
    slots.delete(tabId);
  };

  /** The slot is still this tab's, and the tab is still open. */
  const isLive = (tab: BrowserTabState, slot: RemoteViewportSlot): boolean => (
    slots.get(tab.id) === slot && !tab.webContents.isDestroyed()
  );

  const owns = (tab: BrowserTabState, slot: RemoteViewportSlot): boolean => (
    Boolean(slot.applied && tab.emulation === slot.applied)
  );

  /** Where the tab's phone size is heading: pending, else in flight, else applied. */
  const heading = (slot: RemoteViewportSlot): BuiltInBrowserEmulationState | null => {
    if (slot.pending !== undefined) return slot.pending;
    if (slot.inFlight !== undefined) return slot.inFlight;
    return slot.applied;
  };

  const sameMetrics = (
    a: BuiltInBrowserEmulationState | null,
    b: BuiltInBrowserEmulationState | null,
  ): boolean => Boolean(
    a && b
    && a.width === b.width
    && a.height === b.height
    && a.deviceScaleFactor === b.deviceScaleFactor
    && a.userAgent === b.userAgent,
  );

  /** Why the tab keeps its own size for a remote viewer, as a sentence; null when phone size may apply. */
  function blocker(tab: BrowserTabState, slot: RemoteViewportSlot): string | null {
    if (slot.yielded) return "The tab's size was changed on the desktop, so it stays at that size.";
    if (tab.emulation && !owns(tab, slot)) {
      return `The tab is set to ${tab.emulation.label} on the desktop, so it shows at that size.`;
    }
    if (deps.isTabOnScreen?.(tab.id)) return "Someone is looking at this tab on the desktop, so it keeps the desktop's size.";
    if (tab.recording || tab.recordingStarting) return "The tab is being recorded, so it keeps the recording's size.";
    if (tab.devToolsMode !== null) return "DevTools is open on this tab, so it keeps its own size.";
    if (tab.handoff) return "Someone is signing in on this tab, so it keeps its own size.";
    if (slot.failed) return "The desktop couldn't lay this tab out at phone size.";
    return null;
  }

  /** One change at a time per tab; a newer target replaces one not yet started. Resolves once the tab is idle. */
  function queue(tab: BrowserTabState, slot: RemoteViewportSlot, next: BuiltInBrowserEmulationState | null): Promise<void> {
    slot.pending = next;
    // Started on the next microtask, so `drain` is set before the run can
    // finish and clear it.
    slot.drain ??= Promise.resolve().then(() => drainSlot(tab, slot));
    return slot.drain;
  }

  async function drainSlot(tab: BrowserTabState, slot: RemoteViewportSlot): Promise<void> {
    try {
      while (slot.pending !== undefined && isLive(tab, slot)) {
        const target = slot.pending;
        slot.pending = undefined;
        slot.inFlight = target;
        try {
          await apply(tab, slot, target);
        } finally {
          slot.inFlight = undefined;
        }
      }
    } finally {
      slot.drain = null;
      // Nothing on the tab, nothing to do and nobody watching: the slot goes.
      if (slots.get(tab.id) === slot && !slot.applied && slot.pending === undefined && !deps.isWatched(tab.id)) {
        dropSlot(tab.id);
      }
    }
  }

  /** Takes the override off and lets go of the debugger, unless someone set their own size meanwhile. */
  async function clearOverride(tab: BrowserTabState): Promise<void> {
    try {
      await deps.sendEmulationCommands(tab, null);
    } finally {
      // A `setEmulation` that landed during the await owns the hold now, and
      // the null above may have reached Chromium after its override.
      if (!tab.emulation) deps.releaseDebuggerHold(tab, "emulation");
      else deps.reapplyTabEmulation(tab);
    }
  }

  async function apply(
    tab: BrowserTabState,
    slot: RemoteViewportSlot,
    next: BuiltInBrowserEmulationState | null,
  ): Promise<void> {
    if (tab.webContents.isDestroyed()) return;
    const ours = slot.applied;
    try {
      if (next) {
        // Re-checked here: the desktop may have moved since the read queued it.
        if (blocker(tab, slot)) return;
        await deps.acquireDebuggerHold(tab, "emulation");
        await deps.sendEmulationCommands(tab, next);
        // The tab closed on the way: nothing to record against it.
        if (!isLive(tab, slot)) return;
        if (slot.yielded || (tab.emulation && tab.emulation !== ours)) {
          // Someone set their own size while this was on its way: theirs stands.
          if (tab.emulation) deps.reapplyTabEmulation(tab);
          else await clearOverride(tab);
          return;
        }
        if (!deps.isWatched(tab.id) || blocker(tab, slot)) {
          // The watch lapsed, or the desktop took the tab (on screen, a
          // recording, DevTools), while this was on its way: back to the
          // tab's own size rather than leave a phone layout nobody watches.
          slot.applied = null;
          if (ours && tab.emulation === ours) tab.emulation = null;
          await clearOverride(tab);
          if (!isLive(tab, slot)) return;
          deps.onCleared?.(tab);
        } else {
          tab.emulation = next;
          slot.applied = next;
        }
      } else {
        // Not ours (any more): nothing to take off.
        if (!ours || tab.emulation !== ours) {
          slot.applied = null;
          return;
        }
        slot.applied = null;
        tab.emulation = null;
        await clearOverride(tab);
        if (!isLive(tab, slot)) return;
        deps.onCleared?.(tab);
      }
    } catch (error) {
      deps.logger()?.debug("built_in_browser.remote_viewport_failed", {
        tabId: tab.id,
        err: errorMessage(error),
      });
      if (next && isLive(tab, slot) && !owns(tab, slot)) {
        slot.failed = true;
        // A half-applied phone size: let the tab go back to its own.
        if (!tab.emulation && tab.debuggerHolds.has("emulation")) deps.releaseDebuggerHold(tab, "emulation");
      }
      return;
    }
    deps.onLayoutChanged(tab);
  }

  return {
    /**
     * One remote read: lay the tab out at `viewport` (or start taking phone
     * size off, for a read without one), and say whether it is on.
     */
    sync(tab: BrowserTabState, viewport: BuiltInBrowserRemoteViewport | null): RemoteViewportAnswer {
      const now = Date.now();
      if (!viewport) {
        const slot = slots.get(tab.id);
        if (slot && heading(slot) && now - slot.askedAt >= REMOTE_VIEWPORT_HOLD_MS) void queue(tab, slot, null);
        return {};
      }
      const slot = slotFor(tab.id);
      slot.askedAt = now;
      const reason = blocker(tab, slot);
      if (reason) {
        if (heading(slot)) void queue(tab, slot, null);
        return { viewportApplied: false, viewportNote: reason };
      }
      const wanted = builtInBrowserRemoteViewportEmulation(viewport);
      if (!sameMetrics(heading(slot), wanted)) void queue(tab, slot, wanted);
      return {
        viewportApplied: owns(tab, slot) && sameMetrics(tab.emulation, wanted),
        viewportNote: null,
      };
    },

    /** The watch on a tab ended: its phone size comes off, and the next watch starts fresh. */
    end(tabId: string): void {
      const slot = slots.get(tabId);
      if (!slot) return;
      slot.askedAt = 0;
      slot.yielded = false;
      slot.failed = false;
      const tab = deps.tabById(tabId);
      if (tab && heading(slot)) {
        void queue(tab, slot, null);
      } else if (!slot.drain) {
        dropSlot(tabId);
      }
    },

    /** Someone else set the tab's size: forget phone size for the rest of this watch. */
    yieldTo(tabId: string): void {
      const slot = slots.get(tabId);
      const hadOne = Boolean(slot && heading(slot));
      if (slot) {
        slot.applied = null;
        slot.pending = undefined;
      }
      if (hadOne || deps.isWatched(tabId)) slotFor(tabId).yielded = true;
    },

    /**
     * Take phone size off now and wait until it is off, before something that
     * needs the tab's own layout (a recording's first frame, DevTools, a
     * sign-in). The caller has already made the tab blocked, or opens it
     * right after, so a read meanwhile does not put it back.
     */
    async release(tab: BrowserTabState): Promise<void> {
      for (let round = 0; round < RELEASE_ROUNDS; round += 1) {
        const slot = slots.get(tab.id);
        if (!slot) return;
        if (heading(slot)) await queue(tab, slot, null);
        else if (slot.drain) await slot.drain;
        else return;
      }
    },

    /** The tab closed: nothing to undo. */
    forget: dropSlot,
  };
}
