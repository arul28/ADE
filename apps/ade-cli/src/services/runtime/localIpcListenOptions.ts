import type { ListenOptions } from "node:net";

function isWindowsNamedPipePath(socketPath: string): boolean {
  const normalized = socketPath.trim().replace(/\//g, "\\").toLowerCase();
  return normalized.startsWith("\\\\.\\pipe\\");
}

/**
 * Make the intended-user-only Windows named-pipe boundary explicit.
 *
 * Node defaults both flags to false, but spelling them out prevents a future
 * listener refactor from accidentally opting into a pipe readable or writable
 * by every local Windows user.
 */
export function localIpcListenOptions(
  socketPath: string,
): string | ListenOptions {
  if (!isWindowsNamedPipePath(socketPath)) return socketPath;
  return {
    path: socketPath,
    readableAll: false,
    writableAll: false,
  };
}
