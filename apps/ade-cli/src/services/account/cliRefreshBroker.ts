import net from "node:net";
import path from "node:path";
import { AccountRefreshUnavailableError, type AccountRefreshBroker } from "./accountAuthService";
import { setSharedAccountRefreshBroker } from "./sharedAccountAuthService";

/**
 * The slice of a JSON-RPC client this broker needs. Deliberately structural so
 * the CLI, the TUI, and the tests can each supply their own transport — the
 * broker itself never opens a socket it was not handed a way to open.
 */
export type CliRefreshBrokerClient = {
  request<T = unknown>(
    method: string,
    params?: unknown,
    options?: { timeoutMs?: number },
  ): Promise<T>;
  close(): void;
};

export type CliRefreshBrokerDeps = {
  /**
   * Opens one connection to this machine's brain, already initialized. MUST
   * resolve to `null` (not reject) when there is no brain listening: "no brain"
   * is a supported state, not a failure.
   */
  connect: () => Promise<CliRefreshBrokerClient | null>;
  /**
   * Cheap "is there a brain listening" probe, used once at install time.
   *
   * Deliberately separate from `connect`: install runs on EVERY `ade` command,
   * so it must not perform a handshake, must not hang on a socket that accepts
   * but never answers, and must not show up in the RPC traffic a command makes.
   * Defaults to opening and immediately closing a `connect()` client, which is
   * what the tests use.
   */
  isBrainReachable?: () => Promise<boolean>;
  timeoutMs?: number;
};

const DEFAULT_BROKER_TIMEOUT_MS = 20_000;

/** The brain's `account.call` envelope is `{ domain, action, result }`. */
function unwrapBrainAccountResult(raw: unknown): unknown {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    if (
      Object.prototype.hasOwnProperty.call(record, "result") &&
      (typeof record.domain === "string" || typeof record.action === "string")
    ) {
      return record.result;
    }
  }
  return raw;
}

async function connectQuietly(
  connect: CliRefreshBrokerDeps["connect"],
): Promise<CliRefreshBrokerClient | null> {
  try {
    return await connect();
  } catch {
    // A refused socket, a stale socket file, a brain that died mid-handshake:
    // all of them mean the same thing here — there is nobody to defer to.
    return null;
  }
}

/**
 * The CLI/TUI half of the single-refresher rule.
 *
 * The rotating refresh token is single-use, so exactly one process per machine
 * may exchange it, and that process is the brain. Mirrors
 * `createBrainRefreshBroker` in the desktop's accountBridge: same RPC
 * (`account.call` / `getToken`), same refusal to forward `forceRefresh`, same
 * `AccountRefreshUnavailableError` for a brain that answered badly.
 *
 * Resolves to `null` when no brain is reachable. A headless machine with no
 * brain has no second refresher to race, so it keeps its local exchange — which
 * is only correct because a null broker (not a throwing one) is what leaves the
 * service on that path.
 *
 * Never installed by the brain itself: see the call sites in `cli.ts` and
 * `tuiClient/cli.tsx`.
 */
export async function createCliRefreshBroker(
  deps: CliRefreshBrokerDeps,
): Promise<AccountRefreshBroker | null> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_BROKER_TIMEOUT_MS;
  if (deps.isBrainReachable) {
    let reachable = false;
    try {
      reachable = await deps.isBrainReachable();
    } catch {
      reachable = false;
    }
    if (!reachable) return null;
  } else {
    const probe = await connectQuietly(deps.connect);
    if (!probe) return null;
    // Reachability proved; the probe is not held open for the life of the
    // process. Each refresh opens its own short-lived connection so a command
    // never keeps a socket alive it is not using.
    try {
      probe.close();
    } catch {}
  }
  return {
    async getAccessToken() {
      // `forceRefresh` is deliberately not forwarded: only the brain decides
      // when the credential is exchanged.
      const client = await connectQuietly(deps.connect);
      if (!client) {
        throw new AccountRefreshUnavailableError(
          "ADE's background service isn't running on this computer, so the account token could not be refreshed.",
        );
      }
      try {
        const raw = await client.request<unknown>(
          "account.call",
          { action: "getToken", args: {} },
          { timeoutMs },
        );
        const token = unwrapBrainAccountResult(raw);
        if (typeof token !== "string" || !token.trim()) {
          throw new AccountRefreshUnavailableError(
            "The ADE brain did not return an account token.",
          );
        }
        return token.trim();
      } catch (error) {
        if (error instanceof AccountRefreshUnavailableError) throw error;
        // Everything the brain can fail with here is transport- or
        // brain-shaped. The broker cannot observe the issuer, so it is never
        // entitled to condemn the session: report transient and keep the
        // stored record intact.
        throw new AccountRefreshUnavailableError(
          "ADE couldn't ask the brain for an account token. Try again in a moment.",
          { cause: error },
        );
      } finally {
        try {
          client.close();
        } catch {}
      }
    },
  };
}

/**
 * Install the broker process-wide, best effort. Returns whether one was
 * installed so callers can log/test the decision.
 */
export async function installCliRefreshBroker(
  deps: CliRefreshBrokerDeps,
): Promise<boolean> {
  try {
    const broker = await createCliRefreshBroker(deps);
    if (!broker) return false;
    setSharedAccountRefreshBroker(broker);
    return true;
  } catch {
    // Installing the broker must never be able to fail a command.
    return false;
  }
}

/**
 * Default transport: one initialized connection to this machine's brain socket,
 * or `null` when nothing is listening. Never spawns a brain — a broker that
 * could start the very process it defers to would turn every `ade` command into
 * a brain launcher.
 */
export async function connectMachineBrainForRefresh(args: {
  clientName: string;
  version: string;
  protocolVersion: number | string;
  socketPath?: string | null;
} ): Promise<CliRefreshBrokerClient | null> {
  const { JsonRpcClient } = await import("../../tuiClient/jsonRpcClient");
  const socketPath = await resolveMachineBrainSocketPath(args.socketPath);
  let client: CliRefreshBrokerClient;
  try {
    client = await JsonRpcClient.connect(socketPath);
  } catch {
    return null;
  }
  try {
    await client.request("ade/initialize", {
      protocolVersion: args.protocolVersion,
      clientInfo: { name: args.clientName, version: args.version },
      identity: {
        // No chatSessionId: this connection is the machine operator asking for
        // the machine's own token, not an agent session acting in a chat.
        callerId: `${args.clientName}:${process.pid}`,
        role: "cto",
      },
    });
  } catch {
    try {
      client.close();
    } catch {}
    return null;
  }
  return client;
}

/**
 * Does this machine's brain socket accept a connection right now?
 *
 * Connect-and-drop only: no handshake, no request, bounded by `timeoutMs`. A
 * socket that accepts but never answers reads as reachable here and fails later
 * as transient unavailability — which is the correct order of errors, because
 * the alternative is stalling every `ade` command behind a wedged brain.
 */
export function probeMachineBrainSocket(args: {
  socketPath: string;
  timeoutMs?: number;
}): Promise<boolean> {
  const timeoutMs = args.timeoutMs ?? 750;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (reachable: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch {}
      resolve(reachable);
    };
    let socket: net.Socket;
    try {
      socket = args.socketPath.startsWith("tcp://")
        ? net.createConnection({
            host: new URL(args.socketPath).hostname || "127.0.0.1",
            port: Number.parseInt(new URL(args.socketPath).port, 10),
          })
        : net.createConnection(args.socketPath);
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/** The machine brain socket path the broker talks to, override-aware. */
export async function resolveMachineBrainSocketPath(
  override?: string | null,
): Promise<string> {
  const { resolveMachineAdeLayout } = await import("../projects/machineLayout");
  const raw =
    override?.trim() ||
    process.env.ADE_RUNTIME_SOCKET_PATH?.trim() ||
    resolveMachineAdeLayout().socketPath;
  return raw.startsWith("tcp://") || raw.startsWith("\\\\")
    ? raw
    : path.resolve(raw);
}
