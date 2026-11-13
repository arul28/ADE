import type { AgentChatRemoteWorkUse, AgentChatSessionSummary } from "./types/chat";

/** One key per remote-work entry: a chat keeps one per machine AND project there. */
export function remoteWorkUseKey(use: Pick<AgentChatRemoteWorkUse, "machineKey" | "projectId">): string {
  return `${use.machineKey}:${use.projectId ?? ""}`;
}

/**
 * The machines a chat is running commands on right now
 * (`ade shell start --machine`): those used since its current turn began.
 * Empty when the chat is not in a turn, so a mark shows only while the work
 * is happening there.
 */
export function activeRemoteWork(
  chat: Pick<AgentChatSessionSummary, "remoteWork" | "status" | "currentTurnStartedAt"> | null | undefined,
): AgentChatRemoteWorkUse[] {
  if (!chat?.remoteWork?.length || chat.status !== "active") return [];
  const turnStart = Date.parse(chat.currentTurnStartedAt ?? "");
  return chat.remoteWork.filter((use) =>
    !Number.isFinite(turnStart) || Date.parse(use.lastStartedAt) >= turnStart);
}

/** A remote-work entry whose machine told us the work copy's lane. */
export type RemoteWorkCopyUse = AgentChatRemoteWorkUse & { workCopyLaneId: string };

/** The machines a chat used in the turn that just settled, so their devices can be let go. */
export type RemoteWorkTurnRelease = {
  sessionId: string;
  /** The turn that ended (`RemoteCallerClaim.turnId` of its calls); null when unknown. */
  turnId: string | null;
  uses: Array<{ machineKey: string; machineName: string; projectId: string | null }>;
};

/** The `remoteWork` flags that say an entry drives a device on its machine. */
export type RemoteWorkDeviceFlag = "usesSimulator" | "usesAndroidEmulator" | "usesDesktop" | "usesAppControl";

/** Whether this entry drives any device on its machine (simulator, emulator, screen or App Control). */
export function remoteWorkUsesDevice(
  use: Pick<AgentChatRemoteWorkUse, RemoteWorkDeviceFlag>,
): boolean {
  return use.usesSimulator === true || use.usesAndroidEmulator === true || use.usesDesktop === true || use.usesAppControl === true;
}

/**
 * The machines whose simulator (`usesSimulator`), Android emulator
 * (`usesAndroidEmulator`), desktop screen (`usesDesktop`) or App Control
 * session (`usesAppControl`) this chat drives through its work copy, newest
 * first. Only those whose machine told us the copy's lane (current ADE there).
 */
export function remoteWorkUsesOf(
  session: { remoteWork?: AgentChatRemoteWorkUse[] | null } | null | undefined,
  kind: RemoteWorkDeviceFlag,
): RemoteWorkCopyUse[] {
  return (session?.remoteWork ?? [])
    .filter((use): use is RemoteWorkCopyUse =>
      use[kind] === true && typeof use.workCopyLaneId === "string" && use.workCopyLaneId.length > 0)
    .sort((a, b) => Date.parse(b.lastStartedAt) - Date.parse(a.lastStartedAt));
}

/** The machines whose simulator this chat drives through its work copy, newest first. */
export function remoteSimulatorUses(
  session: { remoteWork?: AgentChatRemoteWorkUse[] | null } | null | undefined,
): RemoteWorkCopyUse[] {
  return remoteWorkUsesOf(session, "usesSimulator");
}

/** The machines whose Android emulator this chat drives through its work copy, newest first. */
export function remoteAndroidEmulatorUses(
  session: { remoteWork?: AgentChatRemoteWorkUse[] | null } | null | undefined,
): RemoteWorkCopyUse[] {
  return remoteWorkUsesOf(session, "usesAndroidEmulator");
}

/**
 * Of a session row's remote work (`TerminalSessionSummary.remoteWork`), the
 * machines its current turn uses right now (`remoteWorkActiveMachineKeys`).
 */
export function activeRemoteWorkOnRow(
  row: { remoteWork?: AgentChatRemoteWorkUse[]; remoteWorkActiveMachineKeys?: string[] } | null | undefined,
): AgentChatRemoteWorkUse[] {
  const active = row?.remoteWorkActiveMachineKeys;
  if (!active?.length) return [];
  return (row?.remoteWork ?? []).filter((use) => active.includes(use.machineKey));
}
