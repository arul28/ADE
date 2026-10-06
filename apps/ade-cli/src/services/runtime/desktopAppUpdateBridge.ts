import { JsonRpcClient, JsonRpcResponseError } from "../../tuiClient/jsonRpcClient";
import { BUILT_IN_BROWSER_BRIDGE_AUTH_PARAM } from "../builtInBrowser/desktopBridgeMethods";

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
 * Every way of NOT reaching a capable app -- no app has attached, its bridge
 * socket is gone, the token is stale, or the app predates this method -- comes
 * back `attached: false`, so the caller falls back to the standalone runtime.
 * Once an app has answered, its answer stands, failures included: falling
 * back then would race the very app that just said no.
 */
export async function requestDesktopAppUpdate(args: {
  socketPath: string;
  authToken: string | null;
  targetVersion: string | null;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
}): Promise<DesktopAppUpdateRouting> {
  const authToken = args.authToken?.trim();
  if (!authToken) return { attached: false, detail: "No ADE desktop app is attached to this machine's brain." };
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
        { targetVersion: args.targetVersion, [BUILT_IN_BROWSER_BRIDGE_AUTH_PARAM]: authToken },
        { timeoutMs: args.requestTimeoutMs ?? INSTALL_REQUEST_TIMEOUT_MS },
      );
    } catch (error) {
      // A protocol-level refusal: an app from before this method, or a token
      // from an app that has since restarted. The app's own failures come back
      // as a `failed` outcome, never as an RPC error.
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
