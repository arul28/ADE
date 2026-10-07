import path from "node:path";
import { JsonRpcClient } from "../../tuiClient/jsonRpcClient";
import type { Logger } from "../../../../desktop/src/main/services/logging/logger";
import { MAX_HANDOFF_TIMEOUT_MS } from "../../../../desktop/src/main/services/builtInBrowser/builtInBrowserHandoff";
import { DEMO_RECORDING_STOP_TIMEOUT_MS } from "../../../../desktop/src/shared/demoVideo/demoContract";
import { ELEVATED_DESKTOP_MESSAGE, ELEVATED_DESKTOP_TITLE } from "../../../../desktop/src/shared/types/builtInBrowser";
import {
  isBuiltInBrowserBridgeServedMethod,
  isBuiltInBrowserDesktopBridgeMethod,
  type BuiltInBrowserDesktopBridgeClient,
} from "./desktopBridgeMethods";
import { desktopBridgeSocketMissing } from "./desktopBridgeConnection";

/**
 * Proxy `built_in_browser` service used by the runtime daemon.
 *
 * The real `BuiltInBrowserService` lives in the desktop's Electron main
 * process because it owns the browser pane's `WebContentsView`. The runtime
 * daemon runs under `ELECTRON_RUN_AS_NODE=1` and has no Electron APIs, so it
 * cannot construct the service itself. Instead the desktop hosts a
 * side-channel JSON-RPC socket at `<adeHome>/sock/desktop-bridge.sock`
 * (see `MachineAdeLayout.desktopBridgeSocketPath`) and the daemon proxies
 * `built_in_browser.<method>` calls through this client.
 *
 * The connection is lazy. If no desktop is running, the first call throws
 * `DesktopBridgeUnavailableError` and the daemon stays functional for every
 * other domain. Reconnection on next call is automatic when the desktop comes
 * back. `remoteBrowserForwarder` catches that one error class for the three
 * "put this URL on a screen" methods and hands them to a desktop that has this
 * machine's lane pinned instead.
 */

const REQUEST_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 3_000;
/** Ceiling for a login handoff wait. The service's own cap, imported not copied. */
const MAX_HANDOFF_WAIT_MS = MAX_HANDOFF_TIMEOUT_MS;

async function raceWithTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

/**
 * No desktop is listening on this machine's bridge socket.
 *
 * Distinguished from every other bridge failure because it is the one case with
 * a working alternative: a desktop pinned to this machine from somewhere else
 * can open the URL in ITS browser over a port-forward, so `ade browser open`
 * forwards instead of failing (see `remoteBrowserForwarder`).
 */
export class DesktopBridgeUnavailableError extends Error {
  readonly socketPath: string;

  constructor(socketPath: string, message: string) {
    super(message);
    this.name = "DesktopBridgeUnavailableError";
    this.socketPath = socketPath;
  }
}

/**
 * An ADE Desktop from before the bridge dropped its secret refuses every call
 * with this. It only happens mid-update, while the background service is newer
 * than the app.
 */
const OLD_DESKTOP_AUTH_REFUSAL = /bridge authentication failed/i;
const OLD_DESKTOP_MESSAGE =
  "ADE Desktop is older than ADE's background service. Restart ADE Desktop to finish updating.";

function isClosedSocketError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:socket (?:is )?closed|socket hang up|EPIPE|ECONNRESET|ERR_STREAM_DESTROYED)/i.test(message);
}

export function createBuiltInBrowserDesktopBridgeClient(args: {
  socketPath: string;
  projectRoot?: string | null;
  logger: Logger;
}): BuiltInBrowserDesktopBridgeClient {
  const { socketPath, logger } = args;
  const projectRoot = args.projectRoot?.trim() || null;
  let client: JsonRpcClient | null = null;
  let connecting: Promise<JsonRpcClient> | null = null;
  let disposed = false;

  const socketDescription = path.basename(socketPath) || socketPath;

  async function connect(): Promise<JsonRpcClient> {
    if (disposed) throw new Error("Desktop browser bridge client has been disposed.");
    if (desktopBridgeSocketMissing(socketPath)) {
      throw new DesktopBridgeUnavailableError(
        socketPath,
        `No ADE Desktop browser is attached to this machine (bridge socket ${socketPath} is not listening). The built-in browser runs inside ADE Desktop, so browser actions need a desktop attached here. \`ade browser open <url>\` is the exception: it forwards the URL to a desktop that has this lane pinned, which reaches this machine's localhost ports over a tunnel.`,
      );
    }
    try {
      return await raceWithTimeout(
        JsonRpcClient.connect(socketPath),
        CONNECT_TIMEOUT_MS,
        `Timed out connecting to desktop browser bridge at ${socketDescription}.`,
      );
    } catch (error) {
      // A stale socket file (desktop crashed) refuses the connection rather
      // than being absent, so it is the same "no desktop here" condition.
      throw new DesktopBridgeUnavailableError(
        socketPath,
        `Could not reach an ADE Desktop browser on this machine (${socketDescription}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async function ensureClient(): Promise<JsonRpcClient> {
    if (disposed) throw new Error("Desktop browser bridge client has been disposed.");
    if (client) return client;
    if (!connecting) {
      connecting = connect()
        .then((c) => {
          if (disposed) {
            try {
              c.close();
            } catch {
              // ignore
            }
            throw new Error("Desktop browser bridge client has been disposed.");
          }
          c.onClose(() => {
            if (client === c) client = null;
          });
          client = c;
          return c;
        })
        .finally(() => {
          connecting = null;
        });
    }
    return await connecting;
  }

  function drop(reason?: unknown): void {
    if (client) {
      try {
        client.close();
      } catch {
        // ignore
      }
      client = null;
    }
    if (reason) {
      logger.warn("built_in_browser_bridge.connection_dropped", {
        socketPath,
        reason: reason instanceof Error ? reason.message : String(reason),
      });
    }
  }

  // Every call lands in this daemon's project, except a personal chat's: the
  // caller scoping marks those `tabCollection: "personal"`, which has no
  // project at all.
  const withRuntimeScope = (params: unknown): Record<string, unknown> => {
    const record = params && typeof params === "object" && !Array.isArray(params)
      ? params as Record<string, unknown>
      : {};
    if (record.tabCollection === "personal") {
      return { ...record, projectRoot: undefined, tabCollection: "personal" };
    }
    return {
      ...record,
      projectRoot: projectRoot ?? undefined,
      tabCollection: undefined,
    };
  };

  async function callBridge(method: string, params?: unknown, retried = false): Promise<unknown> {
    // A headless machine fails here with `DesktopBridgeUnavailableError`, the
    // one class `remoteBrowserForwarder` forwards on.
    const c = await ensureClient();
    const requestParams = withRuntimeScope(params);
    const timeoutMs = bridgeCallTimeoutMs(method, requestParams);
    try {
      return await raceWithTimeout(
        c.request(`built_in_browser.${method}`, requestParams),
        timeoutMs,
        `Desktop browser bridge call ${method} timed out after ${timeoutMs}ms.`,
      );
    } catch (error) {
      // Drop the connection on any error so the next call reconnects.
      drop(error);
      if (!retried && isClosedSocketError(error)) {
        return await callBridge(method, params, true);
      }
      if (OLD_DESKTOP_AUTH_REFUSAL.test(error instanceof Error ? error.message : String(error))) {
        throw new Error(OLD_DESKTOP_MESSAGE);
      }
      throw error;
    }
  }

  const bridge = {
    dispose: () => {
      disposed = true;
      drop();
    },
  };

  return new Proxy(bridge, {
    get(target, property, receiver) {
      if (
        typeof property === "string"
        && (isBuiltInBrowserDesktopBridgeMethod(property)
          || isBuiltInBrowserBridgeServedMethod(property))
      ) {
        return (params?: unknown) => callBridge(property, params);
      }
      return Reflect.get(target, property, receiver);
    },
  }) as BuiltInBrowserDesktopBridgeClient;
}

/**
 * How long one bridge call may take.
 *
 * Everything the browser does is a page interaction and fits the flat budget —
 * except `waitForHandoff`, which is *supposed* to sit there while a human signs
 * in. Its budget is the handoff window the caller asked for plus slack, so the
 * transport cannot report a timeout for a handoff that is still open. And
 * `stopRecording`, which answers only after the demo video is made.
 */
function bridgeCallTimeoutMs(method: string, params: unknown): number {
  if (method === "stopRecording") return DEMO_RECORDING_STOP_TIMEOUT_MS + REQUEST_TIMEOUT_MS;
  if (method !== "waitForHandoff") return REQUEST_TIMEOUT_MS;
  const requested = params && typeof params === "object" && !Array.isArray(params)
    ? (params as { timeoutMs?: unknown }).timeoutMs
    : null;
  const window = typeof requested === "number" && Number.isFinite(requested)
    ? Math.floor(requested)
    : MAX_HANDOFF_WAIT_MS;
  return Math.min(MAX_HANDOFF_WAIT_MS, Math.max(REQUEST_TIMEOUT_MS, window)) + REQUEST_TIMEOUT_MS;
}

/**
 * Budget for one attach probe. Generous on purpose: the probe runs while the
 * brain is still opening the project, and a Node timer that expires during an
 * event-loop stall fires before the pipe's answer is read — a 3 s budget
 * turned a 3.9 s stall on a Windows PC into a permanent "no desktop".
 */
const PROBE_TIMEOUT_MS = 15_000;

/** Whether the desktop app answers on its bridge, and why not when it does not. */
export type DesktopBridgeProbe =
  | { attached: true }
  | {
    attached: false;
    /** `access_denied` does not change on a retry; the rest may. */
    kind: "access_denied" | "unreachable" | "timeout";
    /** One plain sentence for logs, `record stop` and proof metadata. */
    reason: string;
  };

function bridgeProbeFailure(error: unknown): DesktopBridgeProbe & { attached: false } {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | null)?.code;
  // Windows reports a pipe whose DACL refuses this process as EPERM/EACCES.
  // The one way that happens between two ADE processes of the same user is an
  // ADE desktop app started as administrator: its pipe admits administrators
  // only, and the background service runs as the plain user.
  if (code === "EPERM" || code === "EACCES" || /\b(?:EPERM|EACCES)\b/.test(message)) {
    return {
      attached: false,
      kind: "access_denied",
      reason: process.platform === "win32"
        ? `${ELEVATED_DESKTOP_TITLE}. ${ELEVATED_DESKTOP_MESSAGE}`
        : "the ADE desktop app's bridge socket refused the background service",
    };
  }
  if (/timed out/i.test(message)) {
    return { attached: false, kind: "timeout", reason: "the ADE desktop app did not answer in time" };
  }
  if (OLD_DESKTOP_AUTH_REFUSAL.test(message)) {
    return { attached: false, kind: "unreachable", reason: OLD_DESKTOP_MESSAGE };
  }
  return { attached: false, kind: "unreachable", reason: `the ADE desktop app could not be reached (${message})` };
}

/**
 * Asks the desktop app on this machine whether it is there. Never throws.
 * `built_in_browser.authenticate` is a no-op the bridge answers for anyone who
 * can open the socket.
 */
export async function probeDesktopBridge(args: {
  socketPath: string;
  timeoutMs?: number;
}): Promise<DesktopBridgeProbe> {
  const timeoutMs = args.timeoutMs ?? PROBE_TIMEOUT_MS;
  if (desktopBridgeSocketMissing(args.socketPath)) {
    return { attached: false, kind: "unreachable", reason: "the ADE desktop app is not running on this machine" };
  }
  let client: JsonRpcClient | null = null;
  const connecting = JsonRpcClient.connect(args.socketPath);
  try {
    client = await raceWithTimeout(connecting, timeoutMs, "Timed out reaching the ADE desktop app's bridge.");
    await raceWithTimeout(
      client.request("built_in_browser.authenticate", {}),
      timeoutMs,
      "Timed out reaching the ADE desktop app's bridge.",
    );
    return { attached: true };
  } catch (error) {
    // A connect that lands after the timeout is nobody's: close it then.
    if (!client) void connecting.then((late) => late.close(), () => {});
    return bridgeProbeFailure(error);
  } finally {
    client?.close();
  }
}
