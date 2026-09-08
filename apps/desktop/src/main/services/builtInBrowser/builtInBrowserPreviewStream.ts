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
    options?: { fps?: number | null; maxWidth?: number | null },
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
  stop: (tabId: string) => BuiltInBrowserPreviewStreamResult & { hadStream: boolean };
  /** Tears a tab's loop down regardless of subscriber count (tab closed/destroyed). */
  stopTab: (tabId: string) => void;
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

    stop(tabId) {
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
      if (state.subscribers === 0) {
        const snapshot = result(state);
        stopTab(tabId);
        return { ...snapshot, hadStream: true };
      }
      return { ...result(state), hadStream: true };
    },

    stopTab,

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
