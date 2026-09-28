import { syntheticCallerId } from "./syntheticCallerId";

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

/**
 * The name a brain's CTO connects with when it runs actions for its tools: on
 * another machine over the paired channel, and on its home machine in process.
 *
 * Not a desktop name, so it never reaches user-only verbs, and the brain does
 * not count it as a user client. The action surface also refuses it the
 * secret-bearing actions (`isSecretBearingAdeAction`).
 */
export const CTO_REMOTE_CLIENT_NAME = "ade-cto-remote";

export function isCtoRemoteClientName(name: string | null | undefined): boolean {
  return name === CTO_REMOTE_CLIENT_NAME;
}

/**
 * The `ade/initialize` params the CTO's action caller sends, in process and
 * over the paired channel alike, so both are the same caller to the dispatcher.
 *
 * Role `cto` with no chat session: a chat-bound claim would be clamped to
 * `agent`, and the brain clamps `cto` to its own ceiling anyway. No chat id
 * travels, so a target cannot mistake this caller for one of its own agents.
 */
export function ctoCallerInitializeParams(version: string): Record<string, unknown> {
  return {
    protocolVersion: "2025-06-18",
    clientName: CTO_REMOTE_CLIENT_NAME,
    clientInfo: { name: CTO_REMOTE_CLIENT_NAME, version },
    identity: { role: "cto", callerId: syntheticCallerId(CTO_REMOTE_CLIENT_NAME) },
  };
}
