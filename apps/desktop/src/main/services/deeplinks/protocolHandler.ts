import path from "node:path";
import { app, BrowserWindow } from "electron";

import {
  ADE_DEEPLINK_SCHEME,
  parseDeeplink,
  type DeeplinkTarget,
} from "../../../shared/deeplinks";
import { IPC } from "../../../shared/ipc";
import type {
  AppNavigationRequest,
  AppNavigationTarget,
} from "../../../shared/types";

export type DeeplinkDispatchTarget = AppNavigationTarget;

export type DeeplinkDispatcher = (
  request: AppNavigationRequest,
) => Promise<void> | void;

/**
 * Register ADE as the OS handler for `ade://` URLs and wire up the
 * single-instance lock so a second `open ade://...` invocation reuses the
 * already-running window rather than spawning a new one.
 *
 * Must be called BEFORE `app.whenReady()` so the OS routes the cold-start URL
 * through this process.
 */
export function registerAdeProtocolHandler(options: {
  /** Called for every successfully parsed inbound deeplink. */
  dispatch: DeeplinkDispatcher;
  /** Optional structured log hook. */
  log?: (event: string, fields: Record<string, unknown>) => void;
}): void {
  const { dispatch } = options;
  const log = options.log ?? (() => {});

  // Register URL scheme. The argv variant is required on Windows/Linux so the
  // OS spawn picks up the URL on cold-start.
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(ADE_DEEPLINK_SCHEME, process.execPath, [
        path.resolve(process.argv[1]),
      ]);
    }
  } else {
    app.setAsDefaultProtocolClient(ADE_DEEPLINK_SCHEME);
  }

  // Single-instance lock: a second invocation routes through `second-instance`
  // instead of starting a fresh Electron process. We rely on whoever wires
  // this up to have already called `app.whenReady()` semantics correctly;
  // requesting the lock is idempotent.
  const acquired = app.requestSingleInstanceLock();
  if (!acquired) {
    log("deeplink.single_instance.lock_lost", {});
    app.quit();
    return;
  }

  // Buffer URLs received before whenReady so they aren't dropped.
  const pendingUrls: string[] = [];
  let ready = false;

  const consume = (url: string, source: string) => {
    if (!url) return;
    if (!ready) {
      pendingUrls.push(url);
      log("deeplink.buffered", { url, source });
      return;
    }
    handleDeeplinkUrl(url, source, dispatch, log);
  };

  // macOS: cold-start URL arrives via `open-url`. Hot-state URLs do too.
  app.on("open-url", (event, url) => {
    event.preventDefault();
    consume(url, "open-url");
  });

  // Windows / Linux: second invocation passes argv. The OS spawn launches a
  // second process; the lock holder receives `second-instance` with that argv.
  app.on("second-instance", (_event, argv) => {
    // Focus an existing window first so the user sees the action visually.
    const wins = BrowserWindow.getAllWindows();
    const focusable = wins.find((win) => !win.isDestroyed());
    if (focusable) {
      if (focusable.isMinimized()) focusable.restore();
      focusable.show();
      focusable.focus();
    }
    for (const arg of argv) {
      if (typeof arg !== "string") continue;
      if (
        arg.startsWith(`${ADE_DEEPLINK_SCHEME}://`) ||
        /^https?:\/\/ade\.app\/open\b/i.test(arg)
      ) {
        consume(arg, "second-instance");
      }
    }
  });

  // Pick up any URL embedded in this process's own argv (Windows cold-start).
  for (const arg of process.argv.slice(1)) {
    if (typeof arg !== "string") continue;
    if (
      arg.startsWith(`${ADE_DEEPLINK_SCHEME}://`) ||
      /^https?:\/\/ade\.app\/open\b/i.test(arg)
    ) {
      pendingUrls.push(arg);
    }
  }

  // Flush buffer once the app is ready. Use `whenReady()` rather than
  // `app.on('ready')` so we don't re-fire after activate.
  void app.whenReady().then(() => {
    ready = true;
    const buffered = pendingUrls.splice(0);
    for (const url of buffered) {
      handleDeeplinkUrl(url, "buffered", dispatch, log);
    }
  });
}

/**
 * Parse + dispatch a single URL. Exposed so callers (e.g., `ade open` CLI
 * subcommand routing through RPC) can reuse the exact mapping.
 */
export function handleDeeplinkUrl(
  rawUrl: string,
  source: string,
  dispatch: DeeplinkDispatcher,
  log: (event: string, fields: Record<string, unknown>) => void = () => {},
): void {
  const parsed = parseDeeplink(rawUrl);
  if (!parsed.ok) {
    log("deeplink.parse_failed", {
      url: rawUrl,
      source,
      error: parsed.error,
    });
    return;
  }
  const navigationTarget = deeplinkToNavigationTarget(parsed.target);
  log("deeplink.dispatch", { url: rawUrl, source, kind: navigationTarget.kind });
  void Promise.resolve(
    dispatch({
      target: navigationTarget,
      source: `deeplink:${source}`,
    }),
  ).catch((err: unknown) => {
    log("deeplink.dispatch_failed", {
      url: rawUrl,
      source,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

export function deeplinkToNavigationTarget(target: DeeplinkTarget): AppNavigationTarget {
  switch (target.kind) {
    case "lane":
      return { kind: "lane", laneId: target.laneId };
    case "pr":
      return {
        kind: "pr",
        prNumber: target.prNumber,
        repoOwner: target.repoOwner,
        repoName: target.repoName,
      };
    case "branch":
      return {
        kind: "branch",
        repoOwner: target.repoOwner,
        repoName: target.repoName,
        branch: target.branch,
        prNumber: target.prNumber ?? null,
      };
    case "linear-issue":
      return {
        kind: "linear-issue",
        issueIdentifier: target.issueIdentifier,
        branch: target.branch ?? null,
      };
  }
}

/** Reference helper: the IPC channel used to broadcast the navigation event. */
export const DEEPLINK_NAVIGATE_IPC = IPC.appNavigate;
