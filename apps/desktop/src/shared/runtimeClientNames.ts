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

/**
 * The name a brain connects with when an ordinary agent on that machine runs
 * an `ade` command against another machine (`ade chat list --machine …`).
 *
 * Unlike the CTO's caller, many agents share one connection, so the identity
 * of each call travels per request in `REMOTE_CALLER_PARAM`. The target turns
 * that claim into a foreign session id bound to the paired device it
 * authenticated (`foreignCallerSessionId`), so one machine's agent can never
 * pass as a local chat, nor as another machine's.
 */
export const AGENT_REMOTE_CLIENT_NAME = "ade-agent-remote";

export function isAgentRemoteClientName(name: string | null | undefined): boolean {
  return name === AGENT_REMOTE_CLIENT_NAME;
}

/** A model on another machine is driving this caller: the CTO's or an agent's. */
export function isRemoteBrainCallerClientName(name: string | null | undefined): boolean {
  return isCtoRemoteClientName(name) || isAgentRemoteClientName(name);
}

/** Per-request caller claim an `AGENT_REMOTE_CLIENT_NAME` connection attaches. */
export const REMOTE_CALLER_PARAM = "remoteCaller";

export type RemoteCallerClaim = {
  /** The calling chat on the calling machine; null for a person's terminal. */
  chatSessionId: string | null;
  /**
   * The calling machine's account key and name, so a child started here can
   * wake its parent there. A claim: a forged key can only aim a wake at a
   * machine that then refuses it, because that machine did not start the child.
   */
  machineKey?: string | null;
  machineName?: string | null;
  /**
   * The calling chat's permission level, the ceiling for any child it starts
   * here. Absent means unknown, and a child falls to the cautious default.
   */
  permissionLevel?: string | null;
};

/**
 * Role `agent` with no chat session: the chat is per request. The target
 * clamps it to `agent` regardless; asking for less is the honest claim.
 */
export function agentCallerInitializeParams(version: string): Record<string, unknown> {
  return {
    protocolVersion: "2025-06-18",
    clientName: AGENT_REMOTE_CLIENT_NAME,
    clientInfo: { name: AGENT_REMOTE_CLIENT_NAME, version },
    identity: { role: "agent", callerId: syntheticCallerId(AGENT_REMOTE_CLIENT_NAME) },
  };
}

const FOREIGN_CALLER_PREFIX = "remote:";
const FOREIGN_SEGMENT = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * The session id a target records for a caller on another machine:
 * `remote:<paired device id>:<calling chat id | "terminal">`. It cannot collide
 * with a local chat id (those are UUIDs) and names the machine it came from.
 */
export function foreignCallerSessionId(peerDeviceId: string, chatSessionId: string | null): string | null {
  const device = peerDeviceId.trim();
  const chat = chatSessionId?.trim() || "terminal";
  if (!FOREIGN_SEGMENT.test(device) || !FOREIGN_SEGMENT.test(chat)) return null;
  return `${FOREIGN_CALLER_PREFIX}${device}:${chat}`;
}

export function parseForeignCallerSessionId(
  value: string | null | undefined,
): { peerDeviceId: string; chatSessionId: string | null } | null {
  const raw = value?.trim() ?? "";
  if (!raw.startsWith(FOREIGN_CALLER_PREFIX)) return null;
  const [device, chat, ...rest] = raw.slice(FOREIGN_CALLER_PREFIX.length).split(":");
  if (rest.length || !device || !chat || !FOREIGN_SEGMENT.test(device) || !FOREIGN_SEGMENT.test(chat)) return null;
  return { peerDeviceId: device, chatSessionId: chat === "terminal" ? null : chat };
}
