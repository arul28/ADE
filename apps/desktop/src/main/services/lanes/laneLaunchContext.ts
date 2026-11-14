import fs from "node:fs";
import path from "node:path";
import type { createLaneService } from "./laneService";
import { isPathEscapeError, resolvePathWithinRoot } from "../shared/utils";
import { AdeExpectedError } from "../../../shared/expectedError";

export type LaneLaunchExecStrategy = "local";

export type LaneLaunchContext = {
  laneWorktreePath: string;
  cwd: string;
  execStrategy: LaneLaunchExecStrategy;
};

/**
 * The folder is gone (deleted or moved outside ADE) or a step of its path is
 * a file. Only these two codes are the person's files; EACCES, EMFILE and the
 * rest are faults on this machine and stay reported.
 */
function isMissingFolderError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * The folder, or a refusal that names it. A missing folder, or a path that is
 * a file and not a folder, is an answer about the person's files (the message
 * says to restore or recreate the lane), so that refusal is marked `user`.
 * The lane row does not say which machine owns the lane, so a call on the
 * wrong machine also reads as a missing folder here.
 */
function ensureDirectoryExists(targetPath: string, message: string): string {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(targetPath);
  } catch (error) {
    throw refusal(message, error);
  }
  if (!stat.isDirectory()) {
    throw new AdeExpectedError(message, "user");
  }
  try {
    return fs.realpathSync(targetPath);
  } catch (error) {
    throw refusal(message, error);
  }
}

function refusal(message: string, cause: unknown): Error {
  return isMissingFolderError(cause)
    ? new AdeExpectedError(message, "user", { cause })
    : new Error(message, { cause });
}

export function resolveLaneLaunchContext(args: {
  laneService: ReturnType<typeof createLaneService>;
  laneId: string;
  requestedCwd?: string | null;
  allowExternalCwd?: boolean;
  projectRoot?: string | null;
  purpose: string;
}): LaneLaunchContext {
  const laneId = String(args.laneId ?? "").trim();
  const purpose = args.purpose.trim() || "launch work";
  const lane = args.laneService.getLaneBaseAndBranch(laneId);

  const { worktreePath } = lane;
  const configuredRoot = typeof worktreePath === "string" ? worktreePath.trim() : "";
  if (!configuredRoot.length) {
    throw new Error(`Lane '${laneId}' has no worktree configured. ADE cannot ${purpose} outside the selected lane.`);
  }

  const unavailableMessage =
    `Lane '${laneId}' worktree is unavailable at '${configuredRoot}'. Restore or recreate the lane before trying to ${purpose}.`;
  const laneRoot = ensureDirectoryExists(path.resolve(configuredRoot), unavailableMessage);

  const requestedCwd = typeof args.requestedCwd === "string" ? args.requestedCwd.trim() : "";
  if (!requestedCwd.length) {
    return {
      laneWorktreePath: laneRoot,
      cwd: laneRoot,
      execStrategy: "local",
    };
  }

  if (args.allowExternalCwd === true && path.isAbsolute(requestedCwd)) {
    return {
      laneWorktreePath: laneRoot,
      cwd: ensureDirectoryExists(
        path.resolve(requestedCwd),
        `Requested cwd '${requestedCwd}' is not an existing directory.`,
      ),
      execStrategy: "local",
    };
  }

  const requestedTarget = path.isAbsolute(requestedCwd)
    ? requestedCwd
    : path.resolve(laneRoot, requestedCwd);

  let resolvedCwd: string;
  try {
    resolvedCwd = resolvePathWithinRoot(laneRoot, requestedTarget);
  } catch (error) {
    if (isPathEscapeError(error)) {
      throw new Error(
        `Requested cwd '${requestedCwd}' escapes lane '${laneId}'. ADE only launches work inside the selected lane worktree '${laneRoot}'.`,
      );
    }
    throw error;
  }

  ensureDirectoryExists(
    resolvedCwd,
    `Requested cwd '${requestedCwd}' is not an existing directory inside lane '${laneId}' worktree '${laneRoot}'.`,
  );

  return {
    laneWorktreePath: laneRoot,
    cwd: resolvedCwd,
    execStrategy: "local",
  };
}
