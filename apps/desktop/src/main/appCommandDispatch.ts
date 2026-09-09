import { IPC } from "../shared/ipc";
import type { AppCommandPayload } from "../shared/types/core";

/**
 * How long a command with an app-wide fallback waits for proof the renderer can
 * still answer before main runs the fallback itself.
 *
 * Long enough that a busy-but-healthy renderer always wins the race, short
 * enough that a wedged window still feels like a keystroke rather than a hang.
 */
export const APP_COMMAND_LIVENESS_TIMEOUT_MS = 1_200;

export type AppCommandWebContents = {
  isDestroyed: () => boolean;
  isCrashed: () => boolean;
  send: (channel: string, payload: unknown) => void;
  executeJavaScript: (code: string) => Promise<unknown>;
};

export type AppCommandWindow = {
  id: number;
  isDestroyed: () => boolean;
  webContents: AppCommandWebContents;
};

/**
 * One sender for every native-menu command main hands to the renderer.
 *
 * Zoom (⌘+/−/0) and menu (⌘F, ⌘W) commands were two identical routes — two IPC
 * channels, two preload bridges, two near-identical `send*Command` helpers in
 * `main.ts`. They are the same mechanism: Electron consumes an accelerator in
 * the browser process before any renderer keydown fires (and the built-in
 * browser's page has focus in a *different* WebContents entirely), so the only
 * way the command reaches a pane is as a message sent down from the menu. So
 * there is one channel, `IPC.appCommand`, carrying `{ kind, command }`.
 *
 * Two things a naive `webContents.send` gets wrong, and this owns:
 *
 * - A window we did not open (a DevTools window, a native panel) has no ADE
 *   renderer at all, so the command would vanish. Those run `fallback`.
 * - A window whose renderer has crashed or is wedged in a long task *also*
 *   swallows the command — and for ⌘W that matters, because ⌘W is the escape
 *   hatch for exactly that window. The menu used `role: "close"` before this
 *   route existed, which closed from the browser process unconditionally;
 *   `fallback` restores that guarantee by running when the renderer cannot be
 *   shown to be alive.
 * - A window whose renderer has not MOUNTED its subscriber yet swallows it too,
 *   and no probe can see that: `executeJavaScript` resolves as soon as the JS
 *   context exists, which is a second or more before React mounts `TopBar`. So
 *   readiness is announced rather than inferred (`hasCommandSubscriber`), and
 *   until the ack arrives a command with a fallback runs the fallback.
 */
export function createAppCommandSender<TWindow extends AppCommandWindow>(args: {
  /** True when this window id belongs to a window with an ADE renderer in it. */
  hasRenderer: (windowId: number) => boolean;
  /**
   * True once this window's renderer has said its command subscriber is live.
   *
   * Optional so a caller that cannot observe the ack keeps today's behaviour
   * rather than falling back on every command forever.
   */
  hasCommandSubscriber?: (windowId: number) => boolean;
  livenessTimeoutMs?: number;
}): (
  payload: AppCommandPayload,
  window: TWindow | null | undefined,
  fallback?: (window: TWindow) => void,
) => void {
  const livenessTimeoutMs = Math.max(
    0,
    args.livenessTimeoutMs ?? APP_COMMAND_LIVENESS_TIMEOUT_MS,
  );

  /**
   * Does this renderer's JS loop still turn?
   *
   * `isCrashed()` only catches a dead render process. A round-trip that has to
   * be scheduled on the renderer's own event loop answers the real question: a
   * crashed one rejects, a wedged one never resolves, a healthy one is back
   * within a frame.
   */
  const canAnswer = async (contents: AppCommandWebContents): Promise<boolean> => {
    if (contents.isDestroyed() || contents.isCrashed()) return false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        contents.executeJavaScript("0").then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), livenessTimeoutMs);
          timer.unref?.();
        }),
      ]);
    } catch {
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  return (payload, window, fallback) => {
    if (!window || window.isDestroyed()) return;
    const contents = window.webContents;
    if (!args.hasRenderer(window.id) || contents.isDestroyed() || contents.isCrashed()) {
      fallback?.(window);
      return;
    }
    /*
      Boot, and only boot.

      Between "the renderer has a JS context" and "the renderer is listening"
      there is a window of a second or more in which the liveness probe says
      yes and the command is dropped on the floor. ⌘W is the one command that
      cannot be allowed to do nothing, so while it has an app-wide fallback and
      no subscriber has announced itself, main answers it the way the old
      `role: "close"` menu item did. Commands with no fallback (zoom, find) are
      still sent: losing one of those is a no-op, not a dead window.
    */
    if (fallback && args.hasCommandSubscriber && !args.hasCommandSubscriber(window.id)) {
      fallback(window);
      return;
    }
    contents.send(IPC.appCommand, payload);
    if (!fallback) return;
    void canAnswer(contents).then((alive) => {
      if (alive || window.isDestroyed()) return;
      fallback(window);
    });
  };
}
