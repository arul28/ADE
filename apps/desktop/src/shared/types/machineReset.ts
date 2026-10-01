/**
 * The hard reset: everything ADE put on this computer, removed, so the next
 * launch is a first install.
 *
 * Shared by the CLI engine (`ade reset --all`), which does the work, and the
 * desktop, which shows the plan, takes the person's choices, hands off to the
 * engine and quits. The engine never needs a running brain: a reset is what
 * people reach for when there is no brain to talk to.
 */

/** One lane worktree ADE created inside a project. */
export type MachineResetLane = {
  /** Folder name of the worktree, which is what the person recognises. */
  name: string;
  path: string;
  branch: string | null;
  /** Files with changes that are not committed (tracked or untracked). */
  uncommittedFiles: number;
  /** Commits on the lane's branch that no remote has. */
  unpushedCommits: number;
};

/** A project ADE was used on, and what ADE keeps inside it. */
export type MachineResetProject = {
  rootPath: string;
  displayName: string;
  /** The project folder is still on disk. A missing one only loses its registry entry. */
  exists: boolean;
  lanes: MachineResetLane[];
};

export type MachineResetItemKind =
  | "process"
  | "background_service"
  | "directory"
  | "file"
  | "keychain"
  | "config_entry";

/** One thing the reset removes, as the confirm screen lists it. */
export type MachineResetItem = {
  kind: MachineResetItemKind;
  /** Plain words: "ADE's data folder", "Background service (launchd)". */
  label: string;
  /** Path, label or identifier; shown in the details list only. */
  target: string;
};

export type MachineResetPlan = {
  generatedAt: string;
  platform: NodeJS.Platform;
  projects: MachineResetProject[];
  items: MachineResetItem[];
  /** Lanes with uncommitted files or unpushed commits: the work a reset could lose. */
  lanesWithWork: number;
  /** Things the reset cannot do from here, said plainly (for example macOS's own Background Items record). */
  notes: string[];
};

/**
 * What happens to lane work before the wipe.
 *  - `none`: every lane is deleted with the rest.
 *  - `commit`: uncommitted work is committed on the lane's own branch, and the
 *    branch is kept in the project's repository. The folder is removed.
 *  - `move`: the lane folder is moved with `git worktree move` to a folder the
 *    person picked, so git still tracks it and nothing is copied.
 */
export type MachineResetRescueMode = "none" | "commit" | "move";

export type MachineResetOptions = {
  rescue: MachineResetRescueMode;
  /** Required for `move`: where rescued lane folders go, one subfolder per project. */
  rescueDir?: string | null;
};

export type MachineResetRescuedLane = {
  projectRoot: string;
  lane: string;
  mode: Exclude<MachineResetRescueMode, "none">;
  /** The branch the work is on, and for `move` the folder it now lives in. */
  branch: string | null;
  location: string | null;
};

export type MachineResetFailure = {
  target: string;
  error: string;
};

/**
 * What the reset did. Written once the wipe is done to a file outside every
 * folder the reset removes, so the relaunched app can say what happened.
 */
export type MachineResetReceipt = {
  version: 1;
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  removed: string[];
  rescued: MachineResetRescuedLane[];
  failed: MachineResetFailure[];
  notes: string[];
};
