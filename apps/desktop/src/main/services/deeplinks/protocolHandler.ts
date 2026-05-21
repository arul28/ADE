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

const ADE_OPEN_HTTPS_RE = /^https?:\/\/ade\.app\/open\b/i;
const ADE_SCHEME_RE = new RegExp(`^${ADE_DEEPLINK_SCHEME}://`, "i");

function isAdeDeeplinkArg(arg: unknown): arg is string {
  if (typeof arg !== "string") return false;
  return ADE_SCHEME_RE.test(arg) || ADE_OPEN_HTTPS_RE.test(arg);
}

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
  /**
   * When true, ask the OS to make this app the default `ade://` handler. When
   * false the single-instance lock and `open-url` / `second-instance`
   * listeners are still installed so the app can dispatch deeplinks delivered
   * to it (e.g. via `duti` or a manual user binding), but it won't try to
   * claim the scheme on boot. Defaults to false — callers decide based on
   * channel.
   */
  claimAsDefault?: boolean;
}): void {
  const { dispatch } = options;
  const log = options.log ?? (() => {});
  const claimAsDefault = options.claimAsDefault === true;

  // Register URL scheme. The argv variant is required on Windows/Linux so the
  // OS spawn picks up the URL on cold-start. Beta/Alpha channels (and dev
  // builds by default) skip this so they don't fight Stable for the binding
  // on machines where multiple channels are installed.
  if (claimAsDefault) {
    if (process.defaultApp) {
      // Dev mode: we're running as `electron <flags> <app-path> <more-flags>`.
      // To make `open ade://...` re-launch the SAME dev process we must pass
      // all original argv to the OS-spawned process, not just `argv[1]` (which
      // in practice is usually a flag like `--remote-debugging-port=9222`,
      // not the app path — so passing only that gives you the bare Electron
      // splash screen instead of ADE). Strip any deeplink URLs that may
      // already be in argv (cold-start) so they don't get re-issued.
      const respawnArgs = process.argv
        .slice(1)
        .filter((arg): arg is string => typeof arg === "string" && !isAdeDeeplinkArg(arg));
      // npm exec / the dev launcher already pass an absolute path for the
      // app entry, so pass argv through unchanged — applying path.resolve to
      // non-flag args turns flag VALUES (e.g. `YES` after
      // `-ApplePersistenceIgnoreState`) into bogus paths.
      app.setAsDefaultProtocolClient(
        ADE_DEEPLINK_SCHEME,
        process.execPath,
        respawnArgs,
      );
      log("deeplink.scheme_claimed", {
        scheme: ADE_DEEPLINK_SCHEME,
        mode: "dev",
        respawnArgs,
      });
    } else {
      app.setAsDefaultProtocolClient(ADE_DEEPLINK_SCHEME);
      log("deeplink.scheme_claimed", { scheme: ADE_DEEPLINK_SCHEME, mode: "packaged" });
    }
  } else {
    log("deeplink.scheme_skipped", { scheme: ADE_DEEPLINK_SCHEME });
  }

  const coldStartDeeplinkArgs = process.argv.slice(1).filter(isAdeDeeplinkArg);

  // Single-instance lock: a second invocation routes through `second-instance`
  // instead of starting a fresh Electron process. Non-claiming channels can
  // still open as regular app instances when they were not launched to handle
  // a deeplink.
  const acquired = app.requestSingleInstanceLock();
  if (!acquired) {
    const shouldForwardToLockHolder = claimAsDefault || coldStartDeeplinkArgs.length > 0;
    log("deeplink.single_instance.lock_lost", {
      claimAsDefault,
      deeplinkArgCount: coldStartDeeplinkArgs.length,
      shouldForwardToLockHolder,
    });
    if (shouldForwardToLockHolder) {
      app.quit();
      return;
    }
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
      if (isAdeDeeplinkArg(arg)) consume(arg, "second-instance");
    }
  });

  // Pick up any URL embedded in this process's own argv (Windows cold-start).
  for (const arg of coldStartDeeplinkArgs) {
    pendingUrls.push(arg);
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
