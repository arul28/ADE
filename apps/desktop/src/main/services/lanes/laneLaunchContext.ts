import fs from "node:fs";
import path from "node:path";
import type { createLaneService } from "./laneService";
import { resolvePathWithinRoot } from "../shared/utils";

export type LaneLaunchContext = {
  laneWorktreePath: string;
  cwd: string;
};

function ensureDirectoryExists(targetPath: string, message: string): string {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(targetPath);
  } catch {
    throw new Error(message);
  }
  if (!stat.isDirectory()) {
    throw new Error(message);
  }
  try {
    return fs.realpathSync(targetPath);
  } catch {
    throw new Error(message);
  }
}

export function resolveLaneLaunchContext(args: {
  laneService: ReturnType<typeof createLaneService>;
  laneId: string;
  requestedCwd?: string | null;
  purpose: string;
}): LaneLaunchContext {
  const laneId = String(args.laneId ?? "").trim();
  const purpose = args.purpose.trim() || "launch work";
  const { worktreePath } = args.laneService.getLaneBaseAndBranch(laneId);
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
    };
  }

  const requestedTarget = path.isAbsolute(requestedCwd)
    ? requestedCwd
    : path.resolve(laneRoot, requestedCwd);

  let resolvedCwd: string;
  try {
    resolvedCwd = resolvePathWithinRoot(laneRoot, requestedTarget);
  } catch (error) {
    if (error instanceof Error && error.message === "Path escapes root") {
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
  };
}
