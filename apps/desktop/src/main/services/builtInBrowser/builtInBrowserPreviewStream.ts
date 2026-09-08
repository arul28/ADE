import type { BuiltInBrowserPreviewStreamResult } from "../../../shared/types";
import {
  normalizeBuiltInBrowserPreviewFps,
  normalizeBuiltInBrowserPreviewMaxWidth,
} from "../../../shared/types";

/**
 * Live preview streams for browser tabs.
 *
 * The Work tab's floating corner card wants to show a tab it is *not* looking
 * at. That is a fundamentally different job from recording: there is no file,
 * no encoder, and no `getDisplayMedia` grant to negotiate — just "give me a
 * small picture, a few times a second, while somebody is watching".
 *
 * Three rules make it cheap enough to leave on:
 *
 * - **Refcounted.** Two surfaces watching the same tab share one loop. The loop
 *   exists only while `subscribers > 0`, so a tab nobody is watching costs
 *   nothing at all — there is no idle timer, no warm capture, nothing.
 * - **Skip, never queue.** If the previous `capturePage()` has not resolved when
 *   the next tick fires, that tick is dropped. A slow page therefore degrades to
 *   a lower frame rate instead of building a backlog of captures that all land
 *   at once and pin a core.
 * - **Paused, not stopped, when nobody can see it.** A hidden or minimised
 *   window keeps its subscriber count but takes no captures, so returning to the
 *   app resumes the feed without a re-subscribe handshake.
 *
 * The Electron surface — `webContents.capturePage`, `nativeImage.resize`,
 * `toJPEG` — is injected as `capture`, which is what lets the scheduling rules
 * above be tested without a browser.
 */

export type BuiltInBrowserPreviewCapture = {
  dataUrl: string;
  width: number;
  height: number;
};

export type BuiltInBrowserPreviewFrame = BuiltInBrowserPreviewCapture & {
  tabId: string;
  capturedAt: string;
};

type TimerHandle = ReturnType<typeof setInterval>;

export type BuiltInBrowserPreviewStreamDeps = {
  /**
   * Takes one frame, already downscaled to `maxWidth`. Resolving `null` means
   * "nothing to show right now" (empty bitmap, tab mid-navigation); it is not an
   * error and the loop keeps running.
   */
  capture: (tabId: string, maxWidth: number) => Promise<BuiltInBrowserPreviewCapture | null>;
  emit: (frame: BuiltInBrowserPreviewFrame) => void;
  /** False once the tab's webContents is gone — the loop stops for good. */
  isTabAlive: (tabId: string) => boolean;
  /** False while the hosting window is hidden or minimised — captures pause. */
  isVisible: () => boolean;
  onError?: (tabId: string, error: unknown) => void;
  now?: () => number;
  setLoopTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearLoopTimer?: (handle: TimerHandle) => void;
};

type StreamState = {
  tabId: string;
  subscribers: number;
  /**
   * Subscriber counts split by owner — the renderer's `webContents` id.
   *
   * A bare count cannot answer "whose subscription is this", so a renderer
   * crash had to force-drop the whole loop, taking a healthy renderer's live
   * card down with it (frozen frame forever, and its eventual `stop` arriving
   * unpaired). Keyed release makes a crash release only what that renderer
   * held. Sums to `subscribers`.
   */
  owners: Map<string, number>;
  /** Fastest rate any subscriber asked for; a slow watcher never throttles a fast one. */
  fps: number;
  /** Widest frame any subscriber asked for, for the same reason. */
  maxWidth: number;
  timer: TimerHandle | null;
  capturing: boolean;
  /** Frames dropped because the previous capture was still in flight. */
  skipped: number;
};

export type BuiltInBrowserPreviewStreams = {
  start: (
    tabId: string,
    options?: { fps?: number | null; maxWidth?: number | null; owner?: string | null },
  ) => BuiltInBrowserPreviewStreamResult;
  /**
   * Drops one subscriber.
   *
   * `hadStream` separates "the last watcher just left" from "there was never a
   * stream here" — both report `subscribers: 0`, but only the first is a state
   * change the service needs to act on. An unpaired stop (a card unmounting
   * after its tab closed) is tolerated by design, and must not cost a full
   * re-attach sweep over every tab.
   */
  stop: (
    tabId: string,
    owner?: string | null,
  ) => BuiltInBrowserPreviewStreamResult & { hadStream: boolean };
  /** Tears a tab's loop down regardless of subscriber count (tab closed/destroyed). */
  stopTab: (tabId: string) => void;
  /**
   * Drops every subscription one owner holds, across all tabs — the renderer
   * that opened them is gone.
   *
   * `ended` is the tab whose last watcher this was, which is the only case the
   * service has to act on (unpark the view).
   */
  stopOwner: (owner: string) => { tabId: string; subscribers: number; ended: boolean }[];
  /** Whether anybody is watching this tab right now. */
  hasWatchers: (tabId: string) => boolean;
  dispose: () => void;
  /** Test/diagnostic view of the loops currently running. */
  snapshot: () => { tabId: string; subscribers: number; fps: number; maxWidth: number; skipped: number }[];
};

export function createBuiltInBrowserPreviewStreams(
  deps: BuiltInBrowserPreviewStreamDeps,
): BuiltInBrowserPreviewStreams {
  const now = deps.now ?? Date.now;
  const setLoopTimer = deps.setLoopTimer ?? ((fn, ms) => setInterval(fn, ms));
  const clearLoopTimer = deps.clearLoopTimer ?? ((handle) => clearInterval(handle));
  const streams = new Map<string, StreamState>();
  let disposed = false;

  /** One bucket for every subscription that arrived without an owner (CLI, tests). */
  const UNATTRIBUTED_OWNER = "";
  const ownerKey = (owner: string | null | undefined): string =>
    typeof owner === "string" && owner.length > 0 ? owner : UNATTRIBUTED_OWNER;

  const claimOwner = (state: StreamState, owner: string | null | undefined): void => {
    const key = ownerKey(owner);
    state.owners.set(key, (state.owners.get(key) ?? 0) + 1);
  };

  /**
   * Gives one subscription back for `owner`.
   *
   * Falls back to any owner still holding one when the key is unknown, so a
   * mismatched start/stop pair can never leave `owners` disagreeing with
   * `subscribers` — which would make a later `stopOwner` over- or under-release.
   */
  const releaseOwner = (state: StreamState, owner: string | null | undefined): void => {
    const key = ownerKey(owner);
    const held = state.owners.get(key) ?? 0;
    if (held > 0) {
      if (held === 1) state.owners.delete(key);
      else state.owners.set(key, held - 1);
      return;
    }
    for (const [other, count] of state.owners) {
      if (count <= 0) continue;
      if (count === 1) state.owners.delete(other);
      else state.owners.set(other, count - 1);
      return;
    }
  };

  const clearTimer = (state: StreamState): void => {
    if (state.timer == null) return;
    clearLoopTimer(state.timer);
    state.timer = null;
  };

  const tick = (state: StreamState): void => {
    if (disposed) return;
    // A destroyed tab is terminal, not a pause: nothing will ever paint again,
    // so drop the loop rather than burning a timer on it forever.
    if (!deps.isTabAlive(state.tabId)) {
      stopTab(state.tabId);
      return;
    }
    if (!deps.isVisible()) return;
    // The skip rule. `capturing` is cleared in the promise's tail, so a capture
    // that takes longer than the interval simply thins the frame rate out.
    if (state.capturing) {
      state.skipped += 1;
      return;
    }
    state.capturing = true;
    const maxWidth = state.maxWidth;
    void deps.capture(state.tabId, maxWidth)
      .then((frame) => {
        // Subscribers can drop while a capture is in flight; emitting then would
        // be a frame for a card that has already unmounted.
        if (!frame || disposed || streams.get(state.tabId) !== state) return;
        deps.emit({
          tabId: state.tabId,
          dataUrl: frame.dataUrl,
          width: frame.width,
          height: frame.height,
          capturedAt: new Date(now()).toISOString(),
        });
      })
      .catch((error) => {
        deps.onError?.(state.tabId, error);
      })
      .finally(() => {
        state.capturing = false;
      });
  };

  const arm = (state: StreamState): void => {
    clearTimer(state);
    const intervalMs = Math.max(1, Math.round(1000 / state.fps));
    state.timer = setLoopTimer(() => tick(state), intervalMs);
  };

  const result = (state: StreamState): BuiltInBrowserPreviewStreamResult => ({
    tabId: state.tabId,
    fps: state.fps,
    maxWidth: state.maxWidth,
    subscribers: state.subscribers,
  });

  function stopTab(tabId: string): void {
    const state = streams.get(tabId);
    if (!state) return;
    clearTimer(state);
    streams.delete(tabId);
  }

  return {
    start(tabId, options = {}) {
      if (disposed) throw new Error("Browser preview streams are disposed.");
      const fps = normalizeBuiltInBrowserPreviewFps(options.fps);
      const maxWidth = normalizeBuiltInBrowserPreviewMaxWidth(options.maxWidth);
      const existing = streams.get(tabId);
      if (existing) {
        existing.subscribers += 1;
        claimOwner(existing, options.owner);
        const nextFps = Math.max(existing.fps, fps);
        const nextWidth = Math.max(existing.maxWidth, maxWidth);
        const rearm = nextFps !== existing.fps;
        existing.fps = nextFps;
        existing.maxWidth = nextWidth;
        if (rearm) arm(existing);
        return result(existing);
      }
      const state: StreamState = {
        tabId,
        subscribers: 1,
        owners: new Map([[ownerKey(options.owner), 1]]),
        fps,
        maxWidth,
        timer: null,
        capturing: false,
        skipped: 0,
      };
      streams.set(tabId, state);
      arm(state);
      return result(state);
    },

    stop(tabId, owner) {
      const state = streams.get(tabId);
      if (!state) {
        return {
          tabId,
          fps: normalizeBuiltInBrowserPreviewFps(null),
          maxWidth: normalizeBuiltInBrowserPreviewMaxWidth(null),
          subscribers: 0,
          hadStream: false,
        };
      }
      state.subscribers = Math.max(0, state.subscribers - 1);
      releaseOwner(state, owner);
      if (state.subscribers === 0) {
        const snapshot = result(state);
        stopTab(tabId);
        return { ...snapshot, hadStream: true };
      }
      return { ...result(state), hadStream: true };
    },

    stopTab,

    stopOwner(owner) {
      const key = ownerKey(owner);
      const released: { tabId: string; subscribers: number; ended: boolean }[] = [];
      for (const state of [...streams.values()]) {
        const held = state.owners.get(key) ?? 0;
        if (held <= 0) continue;
        state.owners.delete(key);
        state.subscribers = Math.max(0, state.subscribers - held);
        const ended = state.subscribers === 0;
        if (ended) stopTab(state.tabId);
        released.push({ tabId: state.tabId, subscribers: state.subscribers, ended });
      }
      return released;
    },

    hasWatchers(tabId) {
      const state = streams.get(tabId);
      return Boolean(state && state.subscribers > 0);
    },

    dispose() {
      disposed = true;
      for (const state of streams.values()) clearTimer(state);
      streams.clear();
    },

    snapshot() {
      return [...streams.values()].map((state) => ({
        tabId: state.tabId,
        subscribers: state.subscribers,
        fps: state.fps,
        maxWidth: state.maxWidth,
        skipped: state.skipped,
      }));
    },
  };
}
