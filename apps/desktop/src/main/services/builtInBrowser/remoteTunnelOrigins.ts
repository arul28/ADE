/**
 * Which local loopback origins are really someone else's machine.
 *
 * A chat pinned to another machine reaches that machine's `localhost:3000`
 * through an ephemeral TCP forward, so the browser actually loads something
 * like `http://127.0.0.1:52413`. That local origin is not a stable identity:
 * the port is assigned per session, and the *next* forward on the same desktop
 * — to a different machine, or a different remote port — can be handed the
 * exact same number by the OS.
 *
 * Per-chat agent origin approvals key on origin, so without this the approval a
 * human granted for one tunnel could be inherited by an unrelated one. Every
 * forward main opens is recorded here, and the approval key carries the
 * (machine, remote port) pair the local origin currently stands for.
 */

export type RemoteTunnelOrigin = {
  machineKey: string;
  remotePort: number;
};

const originsByLocal = new Map<string, RemoteTunnelOrigin>();

function normalizeOrigin(value: string | null | undefined): string | null {
  const text = (value ?? "").trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

/**
 * Record a live forward. Both schemes are registered: the forward is raw TCP,
 * so the same local port serves whichever scheme the remote server speaks.
 */
export function recordRemoteTunnelOrigin(input: {
  localHost: string;
  localPort: number;
  machineKey: string;
  remotePort: number;
}): void {
  const machineKey = input.machineKey.trim();
  if (!machineKey) return;
  if (!Number.isInteger(input.remotePort) || !Number.isInteger(input.localPort)) return;
  const host = input.localHost.trim() || "127.0.0.1";
  const entry: RemoteTunnelOrigin = { machineKey, remotePort: input.remotePort };
  for (const protocol of ["http:", "https:"]) {
    originsByLocal.set(`${protocol}//${host}:${input.localPort}`, entry);
  }
}

/** The (machine, remote port) a local origin currently stands for, if any. */
export function lookupRemoteTunnelOrigin(
  origin: string | null | undefined,
): RemoteTunnelOrigin | null {
  const normalized = normalizeOrigin(origin);
  return normalized ? originsByLocal.get(normalized) ?? null : null;
}

/** Test-only: forwards live for the lifetime of the process otherwise. */
export function resetRemoteTunnelOrigins(): void {
  originsByLocal.clear();
}
