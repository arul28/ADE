import path from "node:path";
import type {
  ProjectRemovalOutcome,
  ProjectRemovalReport,
  ProjectRemovalRequest,
} from "../../../shared/projectRemoval";
import type { ProjectRemovalClearance } from "../../../../../ade-cli/src/services/projects/projectCopyRemoval";
import type { LocalRuntimeConnectionPool } from "../localRuntime/localRuntimeConnectionPool";
import { pathsEqual } from "../shared/pathCompare";
import { copyFolderRefusal, inspectCopy, realpathOr, recheckCopy } from "./projectCopyCheck";

/**
 * Removing a project from this computer (the remove dialog). The background
 * service knows what runs in the project and reads the copy's state; this
 * process adds its own folder check (ADE itself may run from the folder)
 * and moves the folder to the Trash, so the person can get it back.
 */

type RemovalPool = Pick<LocalRuntimeConnectionPool, "projects" | "callSync" | "removeProject">;

export type DesktopProjectRemovalDeps = {
  /** The background service, or null when it does not run. */
  pool: () => RemovalPool | null;
  /** Local roots in this computer's recent list. */
  recentLocalRoots: () => string[];
  forgetRecentProject: (rootPath: string) => Promise<void>;
  closeProjectByPath: (rootPath: string) => Promise<void>;
  trashItem: (folderPath: string) => Promise<void>;
  folderExists: (folderPath: string) => boolean;
  /**
   * The folders a copy may never be (home, ADE's own, the running app).
   * Read when a folder is checked, never while the IPC handlers register:
   * Electron's path calls are not for import or registration time.
   */
  protectedPaths: () => { homeDir: string; adeHome: string; runtimePaths: readonly string[] };
  logger: { warn(event: string, fields?: Record<string, unknown>): void };
};

const BRAIN_CALL_TIMEOUT_MS = 110_000;

export function createDesktopProjectRemoval(deps: DesktopProjectRemovalDeps) {
  const findBrainProject = async (pool: RemovalPool | null, rootPath: string) => {
    if (!pool) return null;
    const projects = await pool.projects();
    return projects.find((entry) => pathsEqual(entry.rootPath, rootPath)) ?? null;
  };

  /**
   * Forgets the recent once the folder is gone (trashed, or already missing).
   * The folder move is the result: a failed Home catalog write must not undo
   * the brain cleanup after it or report the removal as failed.
   */
  const forgetRemovedFolder = async (rootPath: string): Promise<void> => {
    try {
      await deps.forgetRecentProject(rootPath);
    } catch (error) {
      deps.logger.warn("project.remove_copy_forget_failed", { error: error instanceof Error ? error.message : String(error) });
    }
  };

  /** Why this computer never deletes the folder, or null when it may. */
  const folderRefusal = async (rootPath: string, pool: RemovalPool | null): Promise<string | null> => {
    const brainRoots = pool
      ? (await pool.projects().catch((error: unknown) => {
        // No list from the service: the recent list still names every root this computer knows.
        deps.logger.warn("project.remove_copy_roots_unread", { error: error instanceof Error ? error.message : String(error) });
        return [];
      })).map((entry) => entry.rootPath)
      : [];
    const refusal = await copyFolderRefusal({
      rootPath,
      registeredRoots: [...brainRoots, ...deps.recentLocalRoots()],
      ...deps.protectedPaths(),
    });
    return "reason" in refusal ? refusal.reason : null;
  };

  async function inspect(rootPath: string): Promise<ProjectRemovalReport> {
    const pool = deps.pool();
    const record = await findBrainProject(pool, rootPath);
    let report: ProjectRemovalReport;
    if (pool && record) {
      report = await pool.callSync<ProjectRemovalReport>(
        "projects.inspectRemoval",
        { projectId: record.projectId },
        { timeoutMs: BRAIN_CALL_TIMEOUT_MS },
      );
    } else {
      // Not in the service's list: nothing of it runs there. With no service
      // at all, what runs is unknown, and a delete is refused later.
      report = {
        projectId: rootPath,
        rootPath,
        displayName: path.basename(rootPath),
        ...(await inspectCopy(rootPath, pool ? { chats: 0, terminals: 0 } : null)),
        deleteMode: "trash",
        deleteRefusal: null,
      };
    }
    const desktopRefusal = report.state.folder === "present" ? await folderRefusal(rootPath, pool) : null;
    return {
      ...report,
      rootPath,
      deleteMode: "trash",
      deleteRefusal: report.deleteRefusal ?? desktopRefusal,
    };
  }

  async function remove(rootPath: string, request: ProjectRemovalRequest): Promise<ProjectRemovalOutcome> {
    if (!request.deleteFolder) {
      await deps.forgetRecentProject(rootPath);
      return { status: "removed", folder: "kept", outsideLaneFolders: [] };
    }
    if (!request.stateToken) {
      return { status: "refused", code: "changed", reason: "ADE hasn't checked this copy yet. Check it again." };
    }
    const pool = deps.pool();
    if (!pool) {
      return {
        status: "refused",
        code: "work_running",
        reason: "ADE's background service isn't running, so it can't check what runs in this project. ADE kept the folder.",
      };
    }
    const record = await findBrainProject(pool, rootPath);
    let folderPath: string;
    let outside: string[];
    if (record) {
      // The service checks the copy again, checks the folder, and stops
      // the project; the Trash move is this process's.
      const answer = await pool.callSync<ProjectRemovalOutcome | ProjectRemovalClearance>(
        "projects.removeCopy",
        {
          projectId: record.projectId,
          deleteFolder: true,
          stateToken: request.stateToken,
          acceptWork: request.acceptWork,
          folderMode: "caller",
        },
        { timeoutMs: BRAIN_CALL_TIMEOUT_MS },
      );
      if (answer.status === "removed") {
        // Its folder was already gone, or another window removed it first.
        await forgetRemovedFolder(rootPath);
        return answer;
      }
      if (answer.status !== "cleared") return answer;
      folderPath = answer.folderPath;
      outside = answer.outsideLaneFolders;
    } else {
      const recheck = await recheckCopy(rootPath, { chats: 0, terminals: 0 }, request);
      if (recheck.kind === "missing") {
        await forgetRemovedFolder(rootPath);
        return { status: "removed", folder: "missing", outsideLaneFolders: [] };
      }
      if (recheck.kind === "refused") return { status: "refused", code: recheck.code, reason: recheck.reason };
      folderPath = await realpathOr(rootPath);
      outside = recheck.outsideLaneFolders;
    }
    const refusal = await folderRefusal(rootPath, pool);
    if (refusal) return { status: "refused", code: "unsafe_path", reason: refusal };
    try {
      await deps.closeProjectByPath(rootPath);
    } catch (error) {
      // The service already stopped the project; this window's teardown is best effort.
      deps.logger.warn("project.remove_copy_close_failed", { error: error instanceof Error ? error.message : String(error) });
    }
    try {
      await deps.trashItem(folderPath);
    } catch (error) {
      if (deps.folderExists(folderPath)) {
        return {
          status: "refused",
          code: "delete_failed",
          reason: `ADE couldn't move the folder to the Trash (${error instanceof Error ? error.message : String(error)}). It kept the folder and the project.`,
        };
      }
    }
    await forgetRemovedFolder(rootPath);
    if (record) {
      try {
        await pool.removeProject(rootPath, record.projectId);
      } catch (error) {
        deps.logger.warn("project.remove_copy_entry_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { status: "removed", folder: "trashed", outsideLaneFolders: outside };
  }

  return { inspect, remove };
}
