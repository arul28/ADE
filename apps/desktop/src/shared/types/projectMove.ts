/**
 * Moving a project to a new folder, usually on another drive. The main
 * process copies the project, rewrites every path inside the copy, verifies
 * it, then switches over. The original is kept, renamed, until the person
 * deletes it. See docs/features/onboarding-and-settings/project-move.md.
 */

export type ProjectMoveVolume = {
  /** Where the volume is mounted, e.g. `/` or `/Volumes/Dev`. */
  mountPath: string;
  /** The name Finder shows, e.g. "Macintosh HD" or "Dev". */
  name: string;
  /** APFS/HFS volume UUID. A different drive mounted under the same name has a different one. */
  uuid: string | null;
  freeBytes: number;
  totalBytes: number;
  internal: boolean;
  /** e.g. "apfs", "hfs", "smbfs". */
  fileSystem: string;
  caseSensitive: boolean;
  /** Where a project would usually go on this drive: `~/Projects` here, `<drive>/Projects` elsewhere. */
  suggestedFolder: string;
};

export type ProjectMoveCheckStatus = "ok" | "warning" | "blocked";

export type ProjectMoveCheck = {
  id:
    | "destination"
    | "space"
    | "drive"
    | "access"
    | "quiet"
    | "git"
    | "lanes";
  status: ProjectMoveCheckStatus;
  /** One short line, e.g. "Enough space on Dev". */
  title: string;
  /** What it means or what to do, in plain words. */
  detail?: string;
  /** Named items behind the line (lanes with a rebase in progress, running chats). */
  items?: string[];
};

/** Something ADE leaves for the person, shown before and after the move. */
export type ProjectMoveNote = {
  id: string;
  title: string;
  detail: string;
};

export type ProjectMoveAgentHistory = {
  /** Provider id, e.g. "claude", "cursor". */
  provider: string;
  label: string;
  /** How many folders or sessions of this project the tool keeps. */
  count: number;
  /** "move": ADE can point it at the new location. "nothing": it keeps working. "report": ADE can't fix it. */
  handling: "move" | "nothing" | "report";
  /** ADE's own chats: always moved, never offered as a choice. */
  adeOwned?: boolean;
  detail: string;
};

export type ProjectMovePreflight = {
  projectName: string;
  sourceRoot: string;
  destinationRoot: string;
  sourceVolume: ProjectMoveVolume | null;
  destinationVolume: ProjectMoveVolume | null;
  /** Bytes copied (everything except dependency folders). */
  copyBytes: number;
  /** Bytes of `node_modules`, reinstalled instead of copied. */
  dependencyBytes: number;
  laneCount: number;
  checks: ProjectMoveCheck[];
  canMove: boolean;
  notes: ProjectMoveNote[];
  agentHistory: ProjectMoveAgentHistory[];
};

export type ProjectMoveStepId = "prepare" | "copy" | "git" | "data" | "verify" | "switch";

export const PROJECT_MOVE_STEPS: ReadonlyArray<{ id: ProjectMoveStepId; label: string }> = [
  { id: "prepare", label: "Close the project" },
  { id: "copy", label: "Copy files" },
  { id: "git", label: "Update git links" },
  { id: "data", label: "Update ADE data" },
  { id: "verify", label: "Check the copy" },
  { id: "switch", label: "Switch over" },
];

export type ProjectMoveProgress = {
  moveId: string;
  step: ProjectMoveStepId;
  /** One line about what is happening right now. */
  message: string;
  /** 0..1 for the current step, when it can be measured. */
  fraction?: number;
};

export type ProjectMoveCleanupChoice = "pending" | "remind" | "keep" | "deleted";

export type ProjectMoveRecord = {
  moveId: string;
  projectName: string;
  sourceRoot: string;
  destinationRoot: string;
  /** Where the original was parked after the switch-over. */
  originalParkedAt: string | null;
  /** Where the original is about to be parked: journaled before the rename, so a crash in between can put it back. */
  parkingAt?: string | null;
  /** The move created `<destination>.ade-moving`; only then may a failure or a restart remove it. */
  copyCreated?: boolean;
  /** The copy is in place at the destination: from here the move only ever finishes, never rolls back. */
  switched?: boolean;
  originalBytes: number;
  destinationVolumeUuid: string | null;
  destinationVolumeName: string | null;
  /** The destination is this Mac's internal disk. */
  destinationInternal: boolean;
  startedAt: number;
  finishedAt: number | null;
  state: "running" | "failed" | "done";
  failedStep?: ProjectMoveStepId;
  /** Plain-words reason when the move failed. The original is untouched then. */
  error?: string;
  cleanup: {
    choice: ProjectMoveCleanupChoice;
    remindAt?: number;
    deletedAt?: number;
  };
  /** What ADE did after the switch-over. */
  followUps: string[];
  /** What ADE could not do after the switch-over; the move itself succeeded. */
  problems: string[];
  /** The process running the move, so a restart can tell an interrupted move from a live one. */
  pid?: number;
  /** When this Mac last booted (minutes since the epoch): a pid from before a reboot is someone else's. */
  bootMinute?: number;
  /** What a restart needs to finish an interrupted switch-over. */
  resume?: {
    sourceSpellings: string[];
    knownPaths: string[];
    moveAgentHistory: boolean;
    outsideLanes: Array<{ name: string; lanePath: string }>;
  };
};

export type ProjectMoveStartArgs = {
  projectRoot: string;
  destinationRoot: string;
  /** Also point Claude Code, Cursor and other tools' history for this project at the new location. */
  moveAgentHistory: boolean;
};

export type ProjectMoveResult =
  | { ok: true; record: ProjectMoveRecord }
  | { ok: false; record: ProjectMoveRecord | null; error: string };

export type ProjectMoveCleanupArgs =
  | { moveId: string; choice: "delete" }
  | { moveId: string; choice: "remind"; remindInMs: number }
  | { moveId: string; choice: "keep" };

/** Kept originals that want a decision now, and when the next reminder falls due. */
export type ProjectMoveAttention = {
  records: ProjectMoveRecord[];
  nextReminderAt: number | null;
};
