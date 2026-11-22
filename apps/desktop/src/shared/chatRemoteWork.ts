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

/**
 * A chat's remote-work entries read back from its saved state. Anything that
 * is not a well-formed entry is dropped, never guessed at.
 */
export function normalizeRemoteWorkUses(value: unknown): AgentChatRemoteWorkUse[] | null {
  if (!Array.isArray(value)) return null;
  const text = (raw: unknown): string | null => (typeof raw === "string" && raw.trim() ? raw : null);
  const uses: AgentChatRemoteWorkUse[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const machineKey = text(entry.machineKey);
    const machineName = text(entry.machineName);
    const lastStartedAt = text(entry.lastStartedAt);
    if (!machineKey || !machineName || !lastStartedAt) continue;
    uses.push({
      machineKey,
      machineName,
      machinePlatform: text(entry.machinePlatform),
      projectId: text(entry.projectId),
      projectRootPath: text(entry.projectRootPath),
      terminalIds: Array.isArray(entry.terminalIds) ? entry.terminalIds.filter((id): id is string => typeof id === "string" && id.length > 0) : [],
      workCopyLaneId: text(entry.workCopyLaneId),
      usesSimulator: entry.usesSimulator === true,
      ...(entry.usesAndroidEmulator === true ? { usesAndroidEmulator: true } : {}),
      ...(entry.usesDesktop === true ? { usesDesktop: true } : {}),
      ...(entry.usesAppControl === true ? { usesAppControl: true } : {}),
      lastStartedAt,
    });
  }
  return uses.length ? uses : null;
}

/** The same entry apart from when it was last used: nothing worth saving changed. */
export function sameRemoteWorkUse(a: AgentChatRemoteWorkUse, b: AgentChatRemoteWorkUse): boolean {
  return a.machineKey === b.machineKey
    && a.machineName === b.machineName
    && a.machinePlatform === b.machinePlatform
    && a.projectId === b.projectId
    && a.projectRootPath === b.projectRootPath
    && a.workCopyLaneId === b.workCopyLaneId
    && a.usesSimulator === b.usesSimulator
    && Boolean(a.usesAndroidEmulator) === Boolean(b.usesAndroidEmulator)
    && Boolean(a.usesDesktop) === Boolean(b.usesDesktop)
    && Boolean(a.usesAppControl) === Boolean(b.usesAppControl)
    && a.terminalIds.length === b.terminalIds.length
    && a.terminalIds.every((id, index) => id === b.terminalIds[index]);
}

/** A remote-work entry whose machine told us the work copy's lane. */
export type RemoteWorkCopyUse = AgentChatRemoteWorkUse & { workCopyLaneId: string };

/** Whether the entry's machine told us the work copy's lane (current ADE there). */
export function isRemoteWorkCopyUse(use: AgentChatRemoteWorkUse): use is RemoteWorkCopyUse {
  return typeof use.workCopyLaneId === "string" && use.workCopyLaneId.length > 0;
}

/** One machine (and project there) a chat ran work on, as a release names it. */
export type RemoteWorkMachineRef = { machineKey: string; machineName: string; projectId: string | null };

/** The machines a chat used in the turn that just settled, so their devices can be let go. */
export type RemoteWorkTurnRelease = {
  sessionId: string;
  /** The turn that ended (`RemoteCallerClaim.turnId` of its calls); null when unknown. */
  turnId: string | null;
  uses: RemoteWorkMachineRef[];
};

/**
 * A chat that used other machines was archived or deleted (on its own, or with
 * its lane): each machine is asked to remove what the chat added there (its
 * work copy and, with it, the simulator, emulator, screen and App Control app
 * it drove). `keepUnsynced`: a copy holding work nobody pushed stays, as the
 * hourly sweep keeps it (an archived chat can come back, a deleted one sits in
 * Recently deleted, and that work exists nowhere else). Always true from a
 * current brain; an older one sent false for a deleted chat.
 */
export type RemoteWorkChatEnded = {
  sessionId: string;
  keepUnsynced: boolean;
  uses: RemoteWorkMachineRef[];
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
    .filter((use): use is RemoteWorkCopyUse => use[kind] === true && isRemoteWorkCopyUse(use))
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
