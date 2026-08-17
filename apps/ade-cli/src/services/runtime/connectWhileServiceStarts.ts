import {
  RuntimeServiceStillStartingError,
  type ServiceManagerResult,
} from "../../serviceManager/common";
import { RUNTIME_SERVICE_STARTING_CONNECT_WAIT_MS } from "../../serviceManager/runtimeServiceBudgets";

/**
 * Dials the endpoint of a service that was just installed, allowing for one
 * that reported `starting`.
 *
 * `starting` means the supervisor has a live brain that had not answered
 * inside the installer's own budget. Keep dialing — the socket appears the
 * moment the brain finishes coming up — instead of failing on the first
 * connect and leaving the caller to spawn a rival brain on a supervised
 * socket.
 */
export async function connectWhileServiceStarts<T>(args: {
  install: Pick<ServiceManagerResult, "starting" | "message">;
  socketPath: string;
  connect: () => Promise<T>;
  waitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  now?: () => number;
}): Promise<T> {
  const now = args.now ?? Date.now;
  const sleep = args.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollMs = Math.max(1, args.pollMs ?? 500);
  const waitMs = args.waitMs ?? RUNTIME_SERVICE_STARTING_CONNECT_WAIT_MS;
  const deadline = now() + (args.install.starting ? Math.max(0, waitMs) : 0);
  for (;;) {
    try {
      return await args.connect();
    } catch (error) {
      if (now() >= deadline) {
        // A `starting` install left a live, supervised brain behind. Even if it
        // outlasted our wait, the supervisor still owns that endpoint, so
        // reporting a plain connect failure — which lets the caller spawn an
        // unmanaged rival on the same socket — is exactly the wrong recovery.
        if (args.install.starting) {
          throw new RuntimeServiceStillStartingError({
            kind: "wait_exhausted",
            socketPath: args.socketPath,
            installMessage: args.install.message,
          });
        }
        throw error;
      }
      await sleep(pollMs);
    }
  }
}
