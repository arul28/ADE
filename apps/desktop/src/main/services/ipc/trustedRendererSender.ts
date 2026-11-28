import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";
import { AdeExpectedError } from "../../../shared/expectedError";
import { BRAND } from "../../../shared/brand";

/**
 * Whether a URL is ADE's own renderer: the dev server's origin when
 * `VITE_DEV_SERVER_URL` is set, `http://localhost:5173` for an unpackaged
 * build started without it (what `main.ts` `getRendererUrl()` loads then),
 * else the packaged `renderer/index.html` on disk. A page in the built-in
 * browser or an agent-authored scene frame is none of these.
 */
export function isTrustedAdeRendererUrl(rawUrl: string | null | undefined): boolean {
  if (!rawUrl) return false;
  // Every trusted IPC call asks this, with the same few frame URLs. The answer
  // depends only on the URL, the dev server setting and `app.isPackaged`, so
  // it is kept per URL and dev server setting.
  const devServerUrl = process.env.VITE_DEV_SERVER_URL ?? "";
  const key = `${devServerUrl}\u0000${rawUrl}`;
  const known = trustedUrlVerdicts.get(key);
  if (known !== undefined) return known;
  const verdict = classifyRendererUrl(rawUrl, devServerUrl);
  // Frame URLs carry the route in the hash, so the set can grow; start over past the cap.
  if (trustedUrlVerdicts.size >= TRUSTED_URL_VERDICT_LIMIT) trustedUrlVerdicts.clear();
  trustedUrlVerdicts.set(key, verdict);
  return verdict;
}

const TRUSTED_URL_VERDICT_LIMIT = 64;
const trustedUrlVerdicts = new Map<string, boolean>();

function classifyRendererUrl(rawUrl: string, devServerUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (devServerUrl) return url.origin === new URL(devServerUrl).origin;
    if (!app.isPackaged && url.origin === "http://localhost:5173") return true;
    return url.protocol === "file:" && /\/renderer\/index\.html$/.test(decodeURIComponent(url.pathname));
  } catch {
    return false;
  }
}

export type AdeRendererSenderState = "trusted" | "gone" | "untrusted";

/**
 * The sending frame's URL, else (no frame at all) its WebContents' URL. Null
 * when it cannot be read: the frame was disposed under the call (Electron
 * throws "Render frame was disposed" from `url`), which is a window closing
 * or reloading, not a page. A frame that is there but unreadable never falls
 * back to the WebContents' URL, so it is refused, not trusted on the
 * window's word.
 */
function readSenderUrl(event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">): string | null {
  try {
    const frame = event.senderFrame;
    // A frame with no page yet (empty URL) is the same teardown or early load.
    if (frame) return frame.url || null;
    const contentsUrl = typeof event.sender.getURL === "function" ? event.sender.getURL() : null;
    return contentsUrl || null;
  } catch {
    return null;
  }
}

/**
 * One classification for a handler that must distinguish a closing window from
 * a foreign page. A destroyed window or WebContents is `gone` (expected during
 * teardown); a live window whose frame is not ADE's renderer is `untrusted`.
 */
export function adeRendererSenderState(event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">): AdeRendererSenderState {
  let win: Electron.BrowserWindow | null = null;
  let url: string | null = null;
  try {
    if (typeof event.sender.isDestroyed === "function" && event.sender.isDestroyed()) return "gone";
    // No URL at all: the frame that sent this was disposed before the call was
    // handled. On quit, `destroyWindowsForExit` tears the ADE window down
    // while its last polls and streams are still queued (ADE-DESKTOP-4C and
    // -96 came right after the quit prompt's button; -CG, -1H, -E4, -E5 are
    // the same burst of a window going away).
    // A live page always has a URL, even `about:blank`, so this is teardown.
    // Refused either way; only the report differs.
    url = readSenderUrl(event);
    if (url === null) return "gone";
    win = BrowserWindow.fromWebContents(event.sender);
    // No owning window: either ADE's own renderer still sending after its
    // window closed (on macOS the app outlives it; the closing page's polls
    // and streams fire once more), or a guest/panel surface. Only ADE's
    // renderer URL is the teardown; any other page is still an untrusted
    // sender, recorded as one. Both are refused.
    if (!win) return isTrustedAdeRendererUrl(url) ? "gone" : "untrusted";
    if (typeof win.isDestroyed === "function" && win.isDestroyed()) return "gone";
  } catch {
    return "gone";
  }
  return isTrustedAdeRendererUrl(url) ? "trusted" : "untrusted";
}

/** True when an IPC call comes from ADE's own renderer in a live ADE window. */
export function isTrustedAdeRendererSender(event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">): boolean {
  return adeRendererSenderState(event) === "trusted";
}

/** `isTrustedAdeRendererSender`, logging the refusal so a blocked caller is visible. */
export function isTrustedAdeRendererSenderOrWarn(
  event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">,
  logger: { warn: (event: string, data: Record<string, unknown>) => void },
  channel: string,
): boolean {
  const state = adeRendererSenderState(event);
  if (state === "trusted") return true;
  // A closing window is expected, not an intrusion: only a live foreign frame
  // earns the warning.
  if (state === "untrusted") {
    logger.warn("ipc.untrusted_sender", { channel, senderUrl: readSenderUrl(event) });
  }
  return false;
}

/**
 * One registration choke point for channels that only ADE's own renderer may
 * call. A closing window is an expected refusal; a live foreign frame is
 * logged as `ipc.untrusted_sender` and rejected as an unexpected error.
 */
export function createTrustedIpcHandle(
  logger: { warn: (event: string, data: Record<string, unknown>) => void },
): typeof ipcMain.handle {
  return (channel, listener) =>
    ipcMain.handle(channel, (event, ...args) => {
      const state = adeRendererSenderState(event);
      if (state === "trusted") return listener(event, ...args);
      const refusal = `${channel} is only available to the ${BRAND.NAME} window.`;
      if (state === "gone") throw new AdeExpectedError(refusal, "user");
      logger.warn("ipc.untrusted_sender", { channel, senderUrl: readSenderUrl(event) });
      throw new Error(refusal);
    });
}
