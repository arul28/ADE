import { createHash } from "node:crypto";
import { pathApiFor } from "../../../shared/pathContainment";
import {
  liveSessionCount,
  summarizeCopyWork,
  summarizeLiveSessions,
  type ProjectCopyState,
  type ProjectRemovalRefusalCode,
} from "../../../shared/projectRemoval";
import { isPathInside, pathKey } from "../shared/pathCompare";

/**
 * The two safety decisions of removing a project with its folder, kept pure
 * so every case can be tested on every platform from any host:
 *
 * - {@link decideProjectFolderDeletion}: may this host delete this folder at
 *   all? Only an exact registered project root, and never a folder that holds
 *   the home folder, ADE's own home, another project, or ADE itself.
 * - {@link decideRemovalRecheck}: right before the delete, does the copy still
 *   match what the person saw and accepted?
 *
 * The callers resolve symlinks before they ask (they touch the disk; these do
 * not), and the brain and the desktop main process both ask.
 */

export type FolderDeletionDecision = { ok: true } | { ok: false; reason: string };

/** Mount roots, lower case (the key folds case on macOS): deleting one deletes a whole volume. */
const POSIX_MOUNT_PARENTS: ReadonlyArray<readonly string[]> = [
  ["volumes"],
  ["mnt"],
  ["media"],
  ["run", "media"],
];

const WINDOWS_SYSTEM_FOLDERS = new Set([
  "users",
  "windows",
  "program files",
  "program files (x86)",
  "programdata",
]);

function segmentsBelowRoot(key: string, platform: NodeJS.Platform): string[] {
  const api = pathApiFor(platform);
  const root = api.parse(key).root;
  return key.slice(root.length).split(api.sep).filter(Boolean);
}

/** A volume or mount point: `/Volumes/X`, `/mnt/X`, `/media/X`, `/media/<user>/X`, `/run/media/<user>/X`. */
function isMountRoot(segments: readonly string[], platform: NodeJS.Platform): boolean {
  if (platform === "win32") return false;
  for (const parent of POSIX_MOUNT_PARENTS) {
    const head = segments.slice(0, parent.length);
    if (head.length !== parent.length || head.some((segment, index) => segment.toLowerCase() !== parent[index])) continue;
    const rest = segments.length - parent.length;
    // `/media/X` and `/media/<user>/X` (and the same under /run/media).
    if (parent[parent.length - 1] === "media" ? rest <= 2 : rest <= 1) return true;
  }
  return false;
}

export function decideProjectFolderDeletion(args: {
  /** The folder to delete, symlinks resolved. */
  target: string;
  /** Every registered project root on this host (the target among them), symlinks resolved. */
  registeredRoots: readonly string[];
  homeDir: string | null;
  /** ADE's own home on this host (`~/.ade` or `ADE_HOME`). */
  adeHome: string | null;
  /** Where the ADE that would delete runs from: its working folder, program and script. */
  runtimePaths: readonly string[];
  platform?: NodeJS.Platform;
}): FolderDeletionDecision {
  const platform = args.platform ?? process.platform;
  const target = pathKey(args.target, platform);
  if (!target) return { ok: false, reason: "ADE doesn't know this project's folder." };
  const same = (other: string | null | undefined) => Boolean(other) && pathKey(other!, platform) === target;
  if (!args.registeredRoots.some(same)) {
    return { ok: false, reason: "The folder is not a project folder ADE knows on this machine." };
  }
  const api = pathApiFor(platform);
  const segments = segmentsBelowRoot(target, platform);
  if (api.parse(target).root === target || segments.length === 0) {
    return { ok: false, reason: "ADE never deletes the top folder of a drive." };
  }
  if (isMountRoot(segments, platform)) {
    return { ok: false, reason: "ADE never deletes the top folder of a volume." };
  }
  // One level below the top: `/Users`, `/home`, `/opt` on macOS and Linux.
  // Windows projects often live at `D:\repo`, so there only the system
  // folders are refused.
  if (
    segments.length < 2
    && (platform !== "win32" || WINDOWS_SYSTEM_FOLDERS.has(segments[0]!.toLowerCase()))
  ) {
    return { ok: false, reason: "ADE never deletes a folder this close to the top of the drive." };
  }
  if (args.homeDir && isPathInside(args.homeDir, target, platform)) {
    return { ok: false, reason: "The folder is your home folder or holds it." };
  }
  if (args.adeHome && (isPathInside(args.adeHome, target, platform) || isPathInside(target, args.adeHome, platform))) {
    return { ok: false, reason: "The folder is part of ADE's own data." };
  }
  const nested = args.registeredRoots.find(
    (root) => root && !same(root) && isPathInside(root, target, platform),
  );
  if (nested) return { ok: false, reason: `The folder holds another project (${nested}).` };
  if (args.runtimePaths.some((runtimePath) => runtimePath && isPathInside(runtimePath, target, platform))) {
    return { ok: false, reason: "ADE itself runs from this folder." };
  }
  return { ok: true };
}

/**
 * The token of a copy's state: what the person saw. It covers every fact a
 * delete would lose or that blocks one, in a fixed order, so the same state
 * gives the same token on every read.
 */
export function projectCopyStateToken(state: ProjectCopyState): string {
  const facts = {
    folder: state.folder,
    git: state.isGitRepo,
    // The work itself: a second edit of a file that was already changed, or
    // an amended commit, keeps every count but changes these.
    repository: state.fingerprint,
    stashes: state.stashes,
    branches: state.unpushedOnBranches,
    sessions: [state.sessions.chats, state.sessions.terminals],
    unreadable: [...state.unreadable].sort(),
    checkouts: state.checkouts
      .map((checkout) => [
        checkout.path,
        checkout.branch,
        checkout.changedFiles,
        checkout.unpushedCommits,
        checkout.hasSubmodules,
        [...checkout.ignoredEnvFiles].sort(),
        checkout.fingerprint,
      ])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  };
  return createHash("sha256").update(JSON.stringify(facts)).digest("hex").slice(0, 32);
}

export type RemovalRecheckDecision =
  | { ok: true }
  | { ok: false; code: ProjectRemovalRefusalCode; reason: string };

/**
 * The check right before a delete, against the state the host just read
 * again (never a cache):
 * - anything running in the project refuses, with no override;
 * - a clean copy may go, whatever the person saw;
 * - a copy with work (files Git ignores such as `.env` included) goes only
 *   when the person accepted it for this machine AND it is still exactly what
 *   they saw.
 */
export function decideRemovalRecheck(args: {
  current: ProjectCopyState;
  currentToken: string;
  shownToken: string | null;
  acceptWork: boolean;
}): RemovalRecheckDecision {
  const running = summarizeLiveSessions(args.current);
  if (liveSessionCount(args.current) > 0) {
    return { ok: false, code: "work_running", reason: running ?? "Something is running in this project. Stop it first." };
  }
  const work = summarizeCopyWork(args.current);
  if (!work.hasWork) return { ok: true };
  if (!args.acceptWork) {
    return {
      ok: false,
      code: "unsaved_work",
      reason: `${work.summary ?? "This copy has work that is not pushed"}. ADE kept the folder.`,
    };
  }
  if (!args.shownToken || args.shownToken !== args.currentToken) {
    return {
      ok: false,
      code: "changed",
      reason: "The copy changed after the dialog checked it. ADE kept the folder; check it again.",
    };
  }
  return { ok: true };
}
