import fs from "node:fs/promises";
import path from "node:path";
import type {
  ProjectCopySessions,
  ProjectCopyState,
  ProjectRemovalRefusalCode,
  ProjectRemovalRequest,
} from "../../../shared/projectRemoval";
import { decideProjectFolderDeletion, decideRemovalRecheck, projectCopyStateToken } from "./projectRemovalGuard";
import { outsideLaneFolders, readProjectCopyState } from "./projectRemovalState";

/**
 * The checks of a project copy that the brain (`projectCopyRemoval.ts`) and
 * the desktop (`desktopProjectRemoval.ts`) share: what the copy holds when
 * the remove dialog asks, the same read again right before a delete, and
 * whether ADE may delete the folder at all.
 */

const NO_SESSIONS: ProjectCopySessions = { chats: 0, terminals: 0 };

export async function realpathOr(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch {
    return path.resolve(target);
  }
}

/** What the remove dialog shows. `sessions` null: what runs is unknown, so a delete is refused later. */
export async function inspectCopy(
  rootPath: string,
  sessions: ProjectCopySessions | null,
): Promise<{ state: ProjectCopyState; stateToken: string; outsideLaneFolders: string[] }> {
  const state = await readProjectCopyState(rootPath, sessions ?? NO_SESSIONS);
  if (!sessions) state.unreadable.push("sessions");
  return { state, stateToken: projectCopyStateToken(state), outsideLaneFolders: outsideLaneFolders(state) };
}

export type CopyRecheck =
  | { kind: "missing" }
  | { kind: "refused"; code: ProjectRemovalRefusalCode; reason: string }
  | { kind: "ok"; outsideLaneFolders: string[] };

/** The read right before a delete (never a cache), checked against what the person saw and accepted. */
export async function recheckCopy(
  rootPath: string,
  sessions: ProjectCopySessions,
  request: Pick<ProjectRemovalRequest, "stateToken" | "acceptWork">,
): Promise<CopyRecheck> {
  const state = await readProjectCopyState(rootPath, sessions);
  if (state.folder === "missing") return { kind: "missing" };
  const decision = decideRemovalRecheck({
    current: state,
    currentToken: projectCopyStateToken(state),
    shownToken: request.stateToken,
    acceptWork: request.acceptWork,
  });
  if (!decision.ok) return { kind: "refused", code: decision.code, reason: decision.reason };
  return { kind: "ok", outsideLaneFolders: outsideLaneFolders(state) };
}

/**
 * Why ADE never deletes this folder (a link, a registered root's parent, the
 * home folder, ADE's own files), or the real folder to delete.
 */
export async function copyFolderRefusal(args: {
  rootPath: string;
  registeredRoots: readonly string[];
  homeDir: string;
  adeHome: string | null;
  runtimePaths: readonly string[];
}): Promise<{ reason: string } | { folderPath: string }> {
  try {
    if ((await fs.lstat(args.rootPath)).isSymbolicLink()) {
      return { reason: `The project folder is a link to ${await realpathOr(args.rootPath)}. ADE doesn't delete through links.` };
    }
  } catch {
    // A folder that is gone has nothing to delete; the caller handles it.
  }
  const target = await realpathOr(args.rootPath);
  const decision = decideProjectFolderDeletion({
    target,
    registeredRoots: await Promise.all(args.registeredRoots.map(realpathOr)),
    homeDir: args.homeDir,
    adeHome: args.adeHome ? await realpathOr(args.adeHome) : null,
    runtimePaths: [...args.runtimePaths],
  });
  return decision.ok ? { folderPath: target } : { reason: decision.reason };
}
