import { createConnection } from "node:net";

const DEFAULT_TIMEOUT_MS = 150;

export async function probeLocalhostPort(
  port: number,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<boolean> {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return false;

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

    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.on("error", () => settle(false));
  });
}
