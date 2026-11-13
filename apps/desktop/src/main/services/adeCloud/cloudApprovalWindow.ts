import { randomUUID } from "node:crypto";
import { BrowserWindow } from "electron";
import type { CloudApprovalMode, CloudApprovalWindowResult } from "./cloudMachineCreator";
import { BUILT_IN_BROWSER_PARTITION } from "../builtInBrowser/builtInBrowserConstants";

type Logger = {
  info(event: string, meta?: Record<string, unknown>): void;
  warn(event: string, meta?: Record<string, unknown>): void;
};

/** How long the private sign-in window waits before it shows itself to the person. */
const APPROVAL_SHOW_AFTER_MS = 6_000;
const APPROVAL_TIMEOUT_MS = 5 * 60_000;

/**
 * Opens the one-time sign-in link in a private, in-memory session (nothing it
 * signs in to outlives the window) and waits for `/device/callback`.
 *
 * The window starts hidden. If the sign-in has not reached the callback a few
 * seconds after its last page change, the page is waiting on the person (a
 * consent screen), so the window is shown, named after the box, and is the one
 * confirmation they give. ADE never clicks anything on it.
 */
export function openCloudApprovalWindow(
  args: {
    url: string;
    mode: CloudApprovalMode;
    title: string;
    signal: AbortSignal;
    onNeedsPerson: () => void;
    /**
     * A window a brain borrowed (its lane launch): at a step only a person
     * can take, end with `needs_person` instead of showing and waiting, since
     * this screen may not be where the person is. The brain sends the link.
     */
    endWhenPersonNeeded?: boolean;
  },
  logger: Logger,
): Promise<CloudApprovalWindowResult> {
  // The approval page always needs the person: nothing to open.
  if (args.endWhenPersonNeeded && args.mode === "browser") {
    logger.info("cloud.approval_window_finished", { result: "needs_person", shown: false });
    return Promise.resolve("needs_person");
  }
  const win = new BrowserWindow({
    show: false,
    width: 540,
    height: 720,
    title: args.title,
    autoHideMenuBar: true,
    webPreferences: {
      // A ticket signs in on its own, so it gets a throwaway session. The
      // approval page needs the person's existing ADE sign-in, which lives in
      // ADE's own browser.
      partition: args.mode === "ticket" ? `cloud-sign-in-${randomUUID()}` : BUILT_IN_BROWSER_PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // Keep the box's name in the title bar, whatever the page calls itself.
  win.on("page-title-updated", (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  return new Promise((resolve) => {
    let settled = false;
    let shown = false;
    let showTimer: NodeJS.Timeout | null = null;
    const finish = (result: CloudApprovalWindowResult) => {
      if (settled) return;
      settled = true;
      if (showTimer) clearTimeout(showTimer);
      clearTimeout(timeout);
      if (!win.isDestroyed()) win.destroy();
      logger.info("cloud.approval_window_finished", { result, shown });
      resolve(result);
    };
    const timeout = setTimeout(() => finish("timed_out"), APPROVAL_TIMEOUT_MS);
    const armShow = () => {
      if (shown || settled) return;
      if (showTimer) clearTimeout(showTimer);
      showTimer = setTimeout(() => {
        if (settled || win.isDestroyed()) return;
        if (args.endWhenPersonNeeded) {
          finish("needs_person");
          return;
        }
        shown = true;
        win.show();
        win.focus();
        args.onNeedsPerson();
      }, APPROVAL_SHOW_AFTER_MS);
    };
    const pageAt = (url: string): { host: string; path: string } | null => {
      try {
        const parsed = new URL(url);
        return { host: parsed.host, path: parsed.pathname };
      } catch {
        return null;
      }
    };
    win.webContents.on("did-navigate", (_event, url) => {
      const page = pageAt(url);
      // Host and path only: query strings here carry one-time tickets and codes.
      logger.info("cloud.approval_window_page", { host: page?.host ?? null, path: page?.path ?? null });
      armShow();
    });
    win.webContents.on("did-finish-load", () => {
      const page = pageAt(win.webContents.getURL());
      if (page?.path !== "/device/callback") return;
      void win.webContents
        .executeJavaScript("document.title + ' ' + (document.body ? document.body.innerText : '')", true)
        .then((text: unknown) => {
          if (typeof text === "string" && /signed in/i.test(text)) {
            finish("signed_in");
          } else {
            // The callback answered with a failure page; let the person read it.
            if (args.endWhenPersonNeeded) {
              finish("needs_person");
            } else if (!shown && !win.isDestroyed()) {
              shown = true;
              win.show();
              args.onNeedsPerson();
            }
          }
        })
        .catch((error: unknown) => {
          // The window closed under the read, or the page would not answer.
          // The window's close or timeout still settles the flow.
          logger.warn("cloud.approval_window_read_failed", { error: error instanceof Error ? error.name : "unknown" });
        });
    });
    win.on("closed", () => finish("closed"));
    if (args.signal.aborted) {
      finish("cancelled");
      return;
    }
    args.signal.addEventListener("abort", () => finish("cancelled"), { once: true });
    // Never the message: Electron puts the URL, a one-time sign-in ticket, in it.
    void win.loadURL(args.url).catch((error: unknown) => {
      const code = (error as { code?: unknown } | null)?.code;
      logger.warn("cloud.approval_window_load_failed", { code: typeof code === "string" ? code : null });
    });
    if (args.mode === "browser") {
      // The approval page always needs the person: show it at once.
      shown = true;
      win.show();
      win.focus();
      args.onNeedsPerson();
    } else {
      armShow();
    }
  });
}
