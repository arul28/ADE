import { app, BrowserWindow, type IpcMainInvokeEvent } from "electron";

/**
 * Whether a URL is ADE's own renderer: the dev server's origin when
 * `VITE_DEV_SERVER_URL` is set, `http://localhost:5173` for an unpackaged
 * build started without it (what `main.ts` `getRendererUrl()` loads then),
 * else the packaged `renderer/index.html` on disk. A page in the built-in
 * browser or an agent-authored scene frame is none of these.
 */
export function isTrustedAdeRendererUrl(rawUrl: string | null | undefined): boolean {
  if (!rawUrl) return false;
  try {
    const url = new URL(rawUrl);
    const devServerUrl = process.env.VITE_DEV_SERVER_URL;
    if (devServerUrl) return url.origin === new URL(devServerUrl).origin;
    if (!app.isPackaged && url.origin === "http://localhost:5173") return true;
    return url.protocol === "file:" && /\/renderer\/index\.html$/.test(decodeURIComponent(url.pathname));
  } catch {
    return false;
  }
}

/** True when an IPC call comes from ADE's own renderer in a live ADE window. */
export function isTrustedAdeRendererSender(event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">): boolean {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return false;
  return isTrustedAdeRendererUrl(event.senderFrame?.url || event.sender.getURL());
}

/** `isTrustedAdeRendererSender`, logging the refusal so a blocked caller is visible. */
export function isTrustedAdeRendererSenderOrWarn(
  event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">,
  logger: { warn: (event: string, data: Record<string, unknown>) => void },
  channel: string,
): boolean {
  if (isTrustedAdeRendererSender(event)) return true;
  logger.warn("ipc.untrusted_sender", { channel, senderUrl: event.senderFrame?.url || event.sender.getURL() });
  return false;
}
