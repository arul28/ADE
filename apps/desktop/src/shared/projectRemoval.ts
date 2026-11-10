/**
 * Removing a project from one machine: the state report a machine gives about
 * its own copy, the request to remove it (entry only, or with its folder), and
 * the answer. The host (the brain on any machine, and the desktop main process
 * for this computer's trash) and the renderer share these shapes and the plain
 * summary of a copy's work, so the dialog says what the host decides on.
 *
 * Pure: no Node, no DOM.
 */

/** One checkout of the project: the main folder, or a lane. */
export type ProjectCopyCheckoutState = {
  /** Absolute path on the host. */
  path: string;
  isMain: boolean;
  /** Inside the project folder, so deleting the folder deletes it too. */
  insideProject: boolean;
  /** Null for a detached HEAD or when git could not tell. */
  branch: string | null;
  /** Changed, added and untracked files git reports. Null when git could not read them. */
  changedFiles: number | null;
  /** Commits on HEAD that no remote branch has (all of them when there is no remote). Null when unknown. */
  unpushedCommits: number | null;
  /** Ignored `.env` style files, by relative name only (never their contents). At most 20. */
  ignoredEnvFiles: string[];
  hasSubmodules: boolean;
};

export type ProjectCopySessions = {
  /** Chats with a turn running or waiting on the person. */
  chats: number;
  /** Live terminals and CLI sessions, idle shells included. */
  terminals: number;
};

export type ProjectCopyState = {
  /** The project's registered folder on the host. */
  rootPath: string;
  folder: "present" | "missing";
  isGitRepo: boolean;
  checkouts: ProjectCopyCheckoutState[];
  /** Stashes in the repository (shared by every lane). Null when unknown. */
  stashes: number | null;
  /** Commits on any local branch that no remote has, across the repository. Null when unknown. */
  unpushedOnBranches: number | null;
  sessions: ProjectCopySessions;
  /** What the host could not read. Unknown state counts as work. */
  unreadable: string[];
};

/** How a host deletes a folder: this computer moves it to the Trash; another machine deletes it for good. */
export type ProjectFolderDeleteMode = "trash" | "permanent";

export type ProjectRemovalReport = {
  projectId: string;
  rootPath: string;
  displayName: string;
  state: ProjectCopyState;
  /** Opaque. Sent back with a delete so the host can tell whether the copy changed since. */
  stateToken: string;
  deleteMode: ProjectFolderDeleteMode;
  /** Null when the host may delete the folder; else why it never will. */
  deleteRefusal: string | null;
  /** Lane folders outside the project folder. They stay on disk. */
  outsideLaneFolders: string[];
};

export type ProjectRemovalRequest = {
  deleteFolder: boolean;
  /** The token of the report the person saw; required with `deleteFolder`. */
  stateToken: string | null;
  /** The person ticked this machine by name while it showed work that is not pushed. */
  acceptWork: boolean;
};

export type ProjectRemovalRefusalCode =
  | "work_running"
  | "unsaved_work"
  | "changed"
  | "unsafe_path"
  | "folder_in_use"
  | "delete_failed"
  | "busy"
  | "unsupported"
  | "offline";

export type ProjectRemovalOutcome =
  /** The entry is gone. `folder` says what happened to the folder. */
  | {
    status: "removed";
    folder: "kept" | "trashed" | "deleted" | "missing";
    outsideLaneFolders: string[];
    /** Set when the entry was already gone (another window removed it). */
    alreadyRemoved?: boolean;
  }
  /** Nothing changed: the entry and the folder are where they were. */
  | { status: "refused"; code: ProjectRemovalRefusalCode; reason: string }
  /**
   * The entry is gone and the folder left its place, but some files remain
   * at `remainingPath` (a renamed-aside folder ADE could not finish deleting).
   */
  | { status: "partial"; reason: string; remainingPath: string };

/** The answer of `inspectProjectRemoval` for a machine on another computer. */
export type RemoteProjectRemovalInspection =
  | { supported: true; report: ProjectRemovalReport }
  /** The machine runs an ADE without these actions. Entry-only removal may still work. */
  | { supported: false; entryOnly: boolean };

/** Live work that blocks a delete: no override. */
export function liveSessionCount(state: ProjectCopyState): number {
  return state.sessions.chats + state.sessions.terminals;
}

export type ProjectCopyWork = {
  /**
   * Something a delete would lose and the person must accept by name: changes,
   * unpushed commits, stashes, files Git ignores such as `.env`, or state ADE
   * could not read.
   */
  hasWork: boolean;
  /** One plain line for the row, or null for a clean copy. */
  summary: string | null;
  /** Ignored files like `.env` that a delete removes, by name. */
  ignoredEnvFiles: string[];
};

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

const MAX_NAMED_ENV_FILES = 4;

/** What a delete of this copy would lose, in one line. */
export function summarizeCopyWork(state: ProjectCopyState): ProjectCopyWork {
  if (state.folder === "missing") return { hasWork: false, summary: null, ignoredEnvFiles: [] };
  const parts: string[] = [];
  const withWork = state.checkouts.filter(
    (checkout) => (checkout.changedFiles ?? 0) > 0 || (checkout.unpushedCommits ?? 0) > 0,
  );
  if (withWork.length > 0) {
    parts.push(`${plural(withWork.length, "lane", "lanes")} with changes that are not pushed`);
  }
  const headUnpushed = state.checkouts.reduce((sum, checkout) => sum + (checkout.unpushedCommits ?? 0), 0);
  if ((state.unpushedOnBranches ?? 0) > headUnpushed) {
    parts.push("commits on other branches that are not pushed");
  }
  if ((state.stashes ?? 0) > 0) parts.push(plural(state.stashes ?? 0, "stash", "stashes"));
  if (state.checkouts.some((checkout) => checkout.hasSubmodules)) parts.push("submodules ADE can't check");
  const unknown = state.unreadable.length > 0
    || state.stashes === null
    || state.unpushedOnBranches === null
    || state.checkouts.some((checkout) => checkout.changedFiles === null || checkout.unpushedCommits === null);
  if (unknown && state.isGitRepo) parts.push("some changes ADE couldn't check");
  if (!state.isGitRepo) parts.push("not a git folder, so nothing in it is saved elsewhere");
  // Only files inside the folder a delete removes. Names only, never contents.
  const ignoredEnvFiles = [
    ...new Set(state.checkouts.filter((checkout) => checkout.insideProject).flatMap((checkout) => checkout.ignoredEnvFiles)),
  ];
  if (ignoredEnvFiles.length > 0) {
    const shown = ignoredEnvFiles.slice(0, MAX_NAMED_ENV_FILES).join(", ");
    const more = ignoredEnvFiles.length - MAX_NAMED_ENV_FILES;
    parts.push(`${plural(ignoredEnvFiles.length, "file", "files")} Git ignores: ${shown}${more > 0 ? ` and ${more} more` : ""}`);
  }
  if (parts.length === 0) return { hasWork: false, summary: null, ignoredEnvFiles };
  const line = parts.join(", ");
  return { hasWork: true, summary: line.charAt(0).toUpperCase() + line.slice(1), ignoredEnvFiles };
}

/** One line naming what runs in the copy, or null when nothing does. */
export function summarizeLiveSessions(state: ProjectCopyState): string | null {
  const { chats, terminals } = state.sessions;
  const parts: string[] = [];
  if (chats > 0) parts.push(plural(chats, "chat", "chats"));
  if (terminals > 0) parts.push(plural(terminals, "terminal or CLI", "terminals or CLIs"));
  if (parts.length === 0) return null;
  return `${parts.join(" and ")} running. Stop ${chats + terminals === 1 ? "it" : "them"} first.`;
}
