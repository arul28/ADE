import { createConnection } from "node:net";

const DEFAULT_TIMEOUT_MS = 150;

function probeAddress(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners("connect");
      socket.removeAllListeners("timeout");
      try { socket.destroy(); } catch { /* ignore */ }
      resolve(value);
    };

    const socket = createConnection({ host, port });
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.on("error", () => settle(false));
  });
}

/**
 * Is anything listening on this machine's loopback `port`?
 *
 * Both loopbacks are tried: Node on macOS resolves `localhost` to `::1` first,
 * so Vite and Next often bind `[::1]:<port>` only, and an IPv4-only probe
 * reported a running server as down. Connects and closes; never sends a byte.
 */
export async function probeLocalhostPort(
  port: number,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<boolean> {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return false;
  if (await probeAddress("127.0.0.1", port, timeoutMs)) return true;
  return await probeAddress("::1", port, timeoutMs);
}
