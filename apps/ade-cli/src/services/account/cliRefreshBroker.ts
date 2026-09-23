import net from "node:net";
import path from "node:path";
import { AccountRefreshUnavailableError, type AccountRefreshBroker } from "./accountAuthService";
import { createAccountRefreshBroker } from "./accountRefreshBroker";
import { setSharedAccountRefreshBroker } from "./sharedAccountAuthService";
import { syntheticCallerId } from "../../lib/syntheticCallerId";

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
   * Cheap "is there a brain listening" probe, used immediately before each
   * token request. Keeping this dynamic matters because the TUI can start the
   * brain after the CLI installs its process-wide broker.
   *
   * Deliberately separate from `connect`: install runs on EVERY `ade` command,
   * so it must not perform a handshake, must not hang on a socket that accepts
   * but never answers, and must not show up in the RPC traffic a command makes.
   * Defaults to opening and immediately closing a `connect()` client.
   */
  isBrainReachable?: () => Promise<boolean>;
  timeoutMs?: number;
};

const DEFAULT_BROKER_TIMEOUT_MS = 20_000;

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
 * Its `getAccessToken` resolves to `null` when no brain is reachable. A
 * headless machine with no brain has no second refresher to race, so it keeps
 * its local exchange — a null token is what leaves the service on that path.
 *
 * Never installed by the brain itself: see the call sites in `cli.ts` and
 * `tuiClient/cli.tsx`.
 */
export async function createCliRefreshBroker(
  deps: CliRefreshBrokerDeps,
): Promise<AccountRefreshBroker> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_BROKER_TIMEOUT_MS;
  const isBrainReachable = deps.isBrainReachable ?? (async () => {
    const probe = await connectQuietly(deps.connect);
    if (!probe) return false;
    // Reachability is sampled per call; never hold the probe open while the
    // auth service decides whether it needs a fresh token.
    try {
      probe.close();
    } catch {}
    return true;
  });

  return createAccountRefreshBroker({
    isReachable: isBrainReachable,
    requestToken: async () => {
      const client = await connectQuietly(deps.connect);
      if (!client) {
        throw new AccountRefreshUnavailableError(
          "ADE's background service could not accept the account refresh request.",
        );
      }
      try {
        return await client.request<unknown>(
          "account.call",
          { action: "getToken", args: {} },
          { timeoutMs },
        );
      } finally {
        try {
          client.close();
        } catch {}
      }
    },
  });
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
    setSharedAccountRefreshBroker(broker);
    return true;
  } catch {
    // Installing the broker must never be able to fail a command.
    return false;
  }
}

/** Install the standard machine-brain transport for a CLI or TUI client. */
export async function installMachineBrainRefreshBroker(args: {
  clientName: string;
  version: string;
  protocolVersion: number | string;
  socketPath?: string | null;
}): Promise<boolean> {
  return await installCliRefreshBroker({
    isBrainReachable: async () => probeMachineBrainSocket({
      socketPath: await resolveMachineBrainSocketPath(args.socketPath),
    }),
    connect: () => connectMachineBrainForRefresh(args),
  });
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
        callerId: syntheticCallerId(args.clientName),
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
