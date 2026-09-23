/**
 * `ade-cli:5504`, `ade-code:912`: a caller id a client makes from its name and
 * its own pid when its environment names no chat session and no attempt.
 *
 * It identifies a PROCESS. It is a usable caller id, but it must never become
 * an owner of anything durable, and the brain must not fill it in with its own
 * environment identity.
 */
export function syntheticCallerId(clientName: string, pid: number = process.pid): string {
  return `${clientName}:${pid}`;
}

export function isSyntheticCallerId(id: string | null | undefined): boolean {
  return Boolean(id && /^[a-z][a-z0-9-]*:\d+$/.test(id));
}

/**
 * Every name the desktop's main process gives a brain when it connects: the
 * runtime connection, its probes, recovery and remote runtimes.
 *
 * The brain keeps user-only verbs (deleting an installed simulator) for these
 * names. The name is the client's own claim, so this separates the desktop from
 * the `ade` CLI and TUI; it is not authentication.
 */
export const DESKTOP_CLIENT_NAMES = {
  local: "ade-desktop-local",
  localProbe: "ade-desktop-local-probe",
  serviceInstallProbe: "ade-desktop-service-install-probe",
  recovery: "ade-desktop-recovery",
  remote: "ade-desktop-remote",
} as const;

export type DesktopClientName = (typeof DESKTOP_CLIENT_NAMES)[keyof typeof DESKTOP_CLIENT_NAMES];

const DESKTOP_CLIENT_NAME_SET: ReadonlySet<string> = new Set(Object.values(DESKTOP_CLIENT_NAMES));

export function isDesktopClientName(name: string | null | undefined): name is DesktopClientName {
  return typeof name === "string" && DESKTOP_CLIENT_NAME_SET.has(name);
}
