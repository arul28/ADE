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

const DESKTOP_CLIENT_NAME_SET: ReadonlySet<string> = new Set(Object.values(DESKTOP_CLIENT_NAMES));

export function isDesktopClientName(name: string | null | undefined): boolean {
  return typeof name === "string" && DESKTOP_CLIENT_NAME_SET.has(name);
}
