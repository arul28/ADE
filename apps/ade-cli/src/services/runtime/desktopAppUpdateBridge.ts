import { JsonRpcClient, JsonRpcResponseError } from "../../tuiClient/jsonRpcClient";

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
