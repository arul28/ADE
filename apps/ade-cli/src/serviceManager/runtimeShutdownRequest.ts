import net from "node:net";

/**
 * Cooperative shutdown for a live ADE brain, over the brain's own JSON-RPC
 * endpoint.
 *
 * `process.kill(pid, "SIGTERM")` is a POSIX concept. libuv maps every Windows
 * "signal" except `0` onto `TerminateProcess`, so the target's
 * `process.once("SIGTERM", ...)` handler NEVER runs -- measured on Windows 11
 * 26200, the target was gone in ~19ms with no handler output. Everything the
 * brain does on an orderly exit (flushing SQLite/CRDT state, tearing down
 * sockets, releasing the sync-host singleton lock) is skipped, and the next
 * start then has to recover from a lock whose owner was never given the chance
 * to release it.
 *
 * The orderly path is already exposed on the wire: `multiProjectRpcServer`'s
 * `shutdown` method invokes the SAME `finish()` that `cli.ts` registers as the
 * SIGTERM handler. So on Windows we ask over that channel instead of shooting
 * the process, and the caller escalates to `taskkill /F` only when the brain
 * does not go away inside the grace window.
 *
 * `runtime/info` is requested first and its reported pid is compared with the
 * pid we intend to stop. A pid scraped out of a port diagnosis or a supervisor
 * pid record can have been recycled, and the endpoint may be served by a
 * different brain entirely -- no pid match, no shutdown request.
 */

export type RuntimeShutdownRequestResult =
  | { requested: true }
  | { requested: false; reason: string };

const RUNTIME_INFO_ID = 1;
const SHUTDOWN_ID = 2;

export async function requestAdeRuntimeShutdown(args: {
  pid: number;
  socketPath: string;
  timeoutMs?: number;
  /** Injectable transport so the handshake can be tested without a live brain. */
  connect?: (socketPath: string) => net.Socket;
}): Promise<RuntimeShutdownRequestResult> {
  const socketPath = args.socketPath?.trim() ?? "";
  if (!socketPath) {
    return { requested: false, reason: "no runtime endpoint is known for this process" };
  }
  // A `tcp://` endpoint carries an auth token in its URL and is served by a
  // remote/proxied runtime, not by a brain this machine may terminate.
  if (socketPath.startsWith("tcp://")) {
    return { requested: false, reason: `runtime endpoint ${socketPath} is not a local socket` };
  }
  if (!Number.isInteger(args.pid) || args.pid <= 0) {
    return { requested: false, reason: `invalid target pid ${String(args.pid)}` };
  }
  const timeoutMs = Math.max(250, Math.floor(args.timeoutMs ?? 2_000));
  const connect = args.connect ?? ((target: string) => net.createConnection({ path: target }));

  let socket: net.Socket;
  try {
    socket = connect(socketPath);
  } catch (error) {
    return {
      requested: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  return await new Promise<RuntimeShutdownRequestResult>((resolve) => {
    let settled = false;
    let buffer = "";
    let stage: "identifying" | "stopping" = "identifying";
    const finish = (result: RuntimeShutdownRequestResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch { /* already gone */ }
      resolve(result);
    };
    // Deliberately NOT unref'd: the caller awaits this promise, so a standalone
    // CLI must stay alive until the handshake resolves one way or the other.
    const timer = setTimeout(() => {
      finish({
        requested: false,
        reason: `the runtime endpoint did not answer within ${timeoutMs}ms`,
      });
    }, timeoutMs);
    const send = (id: number, method: string): void => {
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method })}\n`, "utf8");
    };
    socket.on("error", (error: Error) => {
      finish({ requested: false, reason: error.message });
    });
    socket.on("close", () => {
      // Once the request is out, a close IS the acknowledgement: `finish()` on
      // the brain's side tears down its listening socket, and that teardown
      // races the JSON-RPC response back to us. Reading it as a refusal sends
      // the caller straight to `taskkill /F` and cuts short the very flush this
      // path exists to allow. Before the request goes out it means the opposite
      // -- the endpoint hung up without ever being asked.
      finish(
        stage === "stopping"
          ? { requested: true }
          : { requested: false, reason: "the runtime endpoint closed before it could be asked to stop" },
      );
    });
    socket.on("connect", () => {
      send(RUNTIME_INFO_ID, "runtime/info");
    });
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message: { id?: unknown; result?: unknown; error?: unknown };
        try {
          message = JSON.parse(line) as typeof message;
        } catch {
          // The endpoint also emits notifications; a frame we cannot read is
          // never a reason to abandon the handshake.
          continue;
        }
        if (message.id === RUNTIME_INFO_ID && stage === "identifying") {
          const reportedPid = Number((message.result as { pid?: unknown } | null)?.pid);
          if (!Number.isInteger(reportedPid) || reportedPid !== args.pid) {
            finish({
              requested: false,
              reason: `runtime endpoint ${socketPath} is served by pid ${
                Number.isInteger(reportedPid) ? reportedPid : "unknown"
              }, not ${args.pid}`,
            });
            return;
          }
          stage = "stopping";
          send(SHUTDOWN_ID, "shutdown");
          continue;
        }
        if (message.id === SHUTDOWN_ID && stage === "stopping") {
          finish(
            message.error
              ? { requested: false, reason: `the runtime refused the shutdown request: ${JSON.stringify(message.error)}` }
              : { requested: true },
          );
          return;
        }
      }
    });
  });
}
