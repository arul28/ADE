import { execFile, spawn } from "node:child_process";
import { resolveTrustedWindowsTool } from "../../lib/trustedWindowsTools";
import { JsonRpcClient, JsonRpcResponseError } from "../../lib/jsonRpcClient";

/**
 * "Update & restart" for a machine whose ADE desktop app is open.
 *
 * On such a machine the brain is the app's: launchd (or the Windows per-user
 * service) runs it out of `/Applications/ADE.app` / the installed app, and the
 * app re-registers that service whenever it sees the brain go missing. So
 * updating the standalone runtime under `~/.ade` and restarting the service
 * does not stick -- the open app puts its own, older brain straight back
 * (2026-10-05, Mac Studio: clobbered 10 ms after the updater finished). The
 * only update that lands there is the app's own: swap the app, and its
 * post-update transaction restarts the brain on the new build.
 *
 * So the brain asks the app, over the desktop bridge it already uses for the
 * built-in browser, to install its update. The app answers at once and quits
 * to install a moment later, after this brain has replied to whoever asked.
 */

export const DESKTOP_APP_UPDATE_BRIDGE_PREFIX = "app_update.";
export const DESKTOP_APP_UPDATE_INSTALL_METHOD = `${DESKTOP_APP_UPDATE_BRIDGE_PREFIX}install`;

export type DesktopAppUpdateInstallRequest = {
  /** What the asking client believes is newest. Null means "whatever is latest". */
  targetVersion: string | null;
};

export type DesktopAppUpdateInstallOutcome =
  /** The update is downloaded; the app quits to install it in a moment. */
  | "installing"
  /** The update is downloading; the app installs it when the download finishes. */
  | "downloading"
  /** The app already runs the target (or newer). Nothing to install. */
  | "already_current"
  /** The app's own release feed has nothing newer. */
  | "no_update"
  /** This app cannot update itself (a development or channel build). */
  | "unsupported"
  /** The app tried and could not: the message says which step. */
  | "failed";

export type DesktopAppUpdateInstallResult = {
  outcome: DesktopAppUpdateInstallOutcome;
  /** The app's own version. */
  currentVersion: string | null;
  /** The version being installed (or found), when there is one. */
  version: string | null;
  /** One plain line for the person who pressed the button. */
  message: string;
};

export type DesktopAppUpdateRouting =
  /** No desktop app answered for this machine: the caller updates the standalone runtime. */
  | { attached: false; detail: string }
  | { attached: true; result: DesktopAppUpdateInstallResult };

const CONNECT_TIMEOUT_MS = 3_000;
/**
 * The app may run a feed check before answering, so this is a network round
 * trip plus the bridge hop -- well short of the remote caller's own timeout.
 */
const INSTALL_REQUEST_TIMEOUT_MS = 90_000;

const OUTCOMES = new Set<DesktopAppUpdateInstallOutcome>([
  "installing",
  "downloading",
  "already_current",
  "no_update",
  "unsupported",
  "failed",
]);

function readResult(value: unknown): DesktopAppUpdateInstallResult | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const outcome = record.outcome;
  if (typeof outcome !== "string" || !OUTCOMES.has(outcome as DesktopAppUpdateInstallOutcome)) return null;
  const text = (field: unknown): string | null =>
    typeof field === "string" && field.trim() ? field.trim() : null;
  return {
    outcome: outcome as DesktopAppUpdateInstallOutcome,
    currentVersion: text(record.currentVersion),
    version: text(record.version),
    message: text(record.message) ?? "",
  };
}

/**
 * Ask this machine's desktop app to install its update.
 *
 * A missing socket is `attached: false`. A credential refusal from an older
 * app is different: the app owns the machine's brain and the caller must not
 * fall back to a standalone runtime that the app can immediately overwrite.
 */
export async function requestDesktopAppUpdate(args: {
  socketPath: string;
  targetVersion: string | null;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
}): Promise<DesktopAppUpdateRouting> {
  let client: JsonRpcClient | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    try {
      client = await Promise.race([
        JsonRpcClient.connect(args.socketPath),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Timed out reaching the ADE desktop app.")),
            args.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
          );
        }),
      ]);
    } catch (error) {
      return {
        attached: false,
        detail: `The ADE desktop app is not reachable: ${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
    let raw: unknown;
    try {
      raw = await client.request(
        DESKTOP_APP_UPDATE_INSTALL_METHOD,
        { targetVersion: args.targetVersion },
        { timeoutMs: args.requestTimeoutMs ?? INSTALL_REQUEST_TIMEOUT_MS },
      );
    } catch (error) {
      // A credential refusal means an app answered but predates the
      // credential-free method. Treat it as attached and incompatible:
      // falling back would let the open older app restore its own brain over
      // the standalone update we just installed. Other protocol errors (such
      // as this app having no updater to offer) remain a safe fallback.
      if (error instanceof JsonRpcResponseError && /authentication failed/i.test(error.message)) {
        return {
          attached: true,
          result: {
            outcome: "failed",
            currentVersion: null,
            version: null,
            message: `The ADE desktop app declined the request: ${error.message}`,
          },
        };
      }
      if (error instanceof JsonRpcResponseError) {
        return { attached: false, detail: `The ADE desktop app declined the request: ${error.message}` };
      }
      return {
        attached: true,
        result: {
          outcome: "failed",
          currentVersion: null,
          version: null,
          message: `The ADE app on this machine did not answer: ${error instanceof Error ? error.message : String(error)}`,
        },
      };
    }
    const result = readResult(raw);
    if (!result) {
      return { attached: false, detail: "The ADE desktop app sent an answer this brain does not understand." };
    }
    return { attached: true, result };
  } finally {
    if (client) {
      try {
        client.close();
      } catch {
        // ignore close failures
      }
    }
  }
}

/**
 * The installed ADE app this brain runs from, when the brain is the app's own:
 * launchd runs `/Applications/ADE.app/Contents/MacOS/ADE … cli.cjs serve`
 * (the bundle is returned), and the Windows per-user service runs
 * `ADE.exe …\\ade-cli\\cli.cjs serve` as Node (the exe is returned). Null for
 * the standalone runtime (`ade` / `ade.exe`, which is not Electron), a
 * development brain (node, or the bare Electron under `node_modules`, which
 * would open as an empty Electron app), and other platforms.
 */
export function hostAppPath(
  execPath: string = process.execPath,
  platform: NodeJS.Platform = process.platform,
  electronVersion: string | undefined = process.versions.electron,
): string | null {
  if (/[\\/]node_modules[\\/]/.test(execPath)) return null;
  if (platform === "darwin") return /^(\/.*?\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath)?.[1] ?? null;
  if (platform === "win32") return electronVersion && /\.exe$/i.test(execPath) ? execPath : null;
  return null;
}

/** How long a closed app gets to open and answer on the bridge. */
const CLOSED_APP_ANSWER_WAIT_MS = 60_000;
const CLOSED_APP_POLL_MS = 2_000;

function openApp(appPath: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform === "win32") {
    return new Promise((resolve, reject) => {
      // Through `cmd /c start`, which exits at once: the app is then nobody's
      // child, so a later `taskkill /T` of this brain's tree (watchdog
      // recovery) cannot take the open app and its unsaved work with it.
      // This process is the same exe run as Node; the app must not inherit that.
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(resolveTrustedWindowsTool("cmd"), ["/d", "/c", "start", "", appPath], {
        stdio: "ignore",
        windowsHide: true,
        env,
      });
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`start exited with ${code}`));
      });
    });
  }
  return new Promise((resolve, reject) => {
    // `-g` keeps it behind whatever is in front on that Mac.
    execFile("/usr/bin/open", ["-g", "-a", appPath], { timeout: 15_000 }, (error, _stdout, stderr) => {
      if (error) reject(new Error(String(stderr ?? "").trim() || error.message));
      else resolve();
    });
  });
}

/**
 * "Update & restart" for a machine whose brain is the app's own while the app
 * is closed.
 *
 * The standalone update would move the brain to `~/.ade/bin/ade`. macOS keeps
 * its privacy permissions per program, and that program has none: its first
 * read of a project on an external drive, or in Desktop, Documents or
 * Downloads, puts a permission prompt on that Mac's screen and the brain waits
 * on it with nobody there to answer (Mac Studio, 2026-10-27: offline for 33
 * minutes after "Update all machines"). So the app is opened in the background
 * and installs its own update, as it does when it is already open. When it
 * cannot be opened or never answers, the update is refused with that reason
 * instead of switching the program that runs the brain.
 *
 * Windows has no such prompt, but the same split applies: a standalone update
 * leaves the app on the old version, and the app puts its own older brain back
 * the next time it opens. So it is opened there too (in front: Windows has no
 * background launch), and installs and restarts itself.
 */
export async function requestUpdateThroughClosedApp(args: {
  appPath: string;
  socketPath: string;
  targetVersion: string | null;
}): Promise<DesktopAppUpdateRouting> {
  const refuse = (detail: string): DesktopAppUpdateRouting => ({
    attached: true,
    result: {
      outcome: "failed",
      currentVersion: null,
      version: null,
      message: `ADE is closed on this computer and could not be opened to update itself (${detail}). Open ADE there, then update again.`,
    },
  });
  try {
    await openApp(args.appPath);
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error));
  }
  const deadline = Date.now() + CLOSED_APP_ANSWER_WAIT_MS;
  let detail = "it did not answer";
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, CLOSED_APP_POLL_MS));
    const routing = await requestDesktopAppUpdate({
      socketPath: args.socketPath,
      targetVersion: args.targetVersion,
      connectTimeoutMs: CLOSED_APP_POLL_MS,
    });
    if (routing.attached) {
      // "unsupported" would send the caller to the standalone update, the very
      // switch this route exists to avoid.
      return routing.result.outcome === "unsupported"
        ? refuse(routing.result.message || "this ADE build cannot update itself")
        : routing;
    }
    detail = routing.detail;
  }
  return refuse(`${detail} within ${CLOSED_APP_ANSWER_WAIT_MS / 1000} seconds`);
}
