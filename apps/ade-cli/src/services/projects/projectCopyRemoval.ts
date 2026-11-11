import os from "node:os";
import type {
  ProjectCopySessions,
  ProjectRemovalOutcome,
  ProjectRemovalReport,
  ProjectRemovalRequest,
} from "../../../../desktop/src/shared/projectRemoval";
import { copyFolderRefusal, inspectCopy, recheckCopy } from "../../../../desktop/src/main/services/projects/projectCopyCheck";
import {
  LaneFolderBusyError,
  moveLaneFolderAsideWhenReleased,
  removeWorktreeDirectoryWithRecovery,
} from "../../../../desktop/src/main/services/lanes/laneFolderRemoval";
import type { ProjectId, ProjectRecord, ProjectRegistry } from "./projectRegistry";
import type { ProjectScopeRegistry } from "./projectScope";

/**
 * Removing a project from this machine, with its folder when the person asks
 * (`projects.inspectRemoval` and `projects.removeCopy`).
 *
 * The order is fixed: read the copy's state again (never a cache) and refuse
 * when it no longer matches what the person saw and accepted, check that the
 * folder is one ADE may delete at all, stop the project, delete, and only then
 * drop the entry. A folder that ADE could not move out of its place is left
 * with its entry; a folder that moved but did not finish deleting is reported
 * by the path where the rest of its files remain.
 *
 * This machine has no trash: a delete here is permanent. The desktop's own
 * computer asks with `folderMode: "caller"`, and moves the folder to the Trash
 * itself once the brain has checked and stopped the project.
 */

/** The brain's answer when the desktop deletes (to the Trash) itself. */
export type ProjectRemovalClearance = {
  status: "cleared";
  /** The real folder to move to the Trash. */
  folderPath: string;
  outsideLaneFolders: string[];
};

export type ProjectCopyRemovalDeps = {
  projectRegistry: ProjectRegistry;
  scopeRegistry: ProjectScopeRegistry;
  /** Stops the project's runtime and forgets what would reopen. Never touches the entry or the folder. */
  stopProject: (projectId: ProjectId) => Promise<void>;
  adeHome: string | null;
};

const SESSION_READ_TIMEOUT_MS = 10_000;

/** Removals running in this brain, across every connection (two windows ask the same brain). */
const removalsInFlight = new Set<ProjectId>();

/** What runs in the project now; null when the project is starting and could not be read in time. */
async function readSessions(scopeRegistry: ProjectScopeRegistry, projectId: ProjectId): Promise<ProjectCopySessions | null> {
  const booted = scopeRegistry.getIfBooted(projectId);
  if (!booted) return { chats: 0, terminals: 0 };
  let timer: ReturnType<typeof setTimeout> | null = null;
  const scope = await Promise.race([
    booted.catch(() => null),
    new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), SESSION_READ_TIMEOUT_MS);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
  if (scope === "timeout") return null;
  const runtime = scope?.runtime;
  if (!runtime) return { chats: 0, terminals: 0 };
  return {
    chats: runtime.agentChatService?.listBusyFacts?.().length ?? 0,
    terminals: runtime.ptyService.list({ status: "running", limit: 500 }).length,
  };
}

/** Why this host never deletes the project's folder, or null when it may. */
function folderRefusal(deps: ProjectCopyRemovalDeps, record: ProjectRecord): Promise<{ reason: string } | { folderPath: string }> {
  return copyFolderRefusal({
    rootPath: record.rootPath,
    registeredRoots: deps.projectRegistry.list().map((entry) => entry.rootPath),
    homeDir: os.homedir(),
    adeHome: deps.adeHome,
    runtimePaths: [process.cwd(), process.execPath, process.argv[1] ?? ""].filter(Boolean),
  });
}

type PermanentDelete =
  | { kind: "deleted" }
  | { kind: "untouched"; code: "folder_in_use" | "delete_failed"; reason: string }
  | { kind: "partial"; remainingPath: string; reason: string };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Deletes a folder for good. It first moves the folder aside in one rename
 * (on Windows the rename waits for programs to let go of its files, and a
 * refusal changes nothing), so the project's place is either intact or empty;
 * then it removes the moved folder, in a separate process with the retries
 * lane deletes use.
 */
async function deleteFolderPermanently(folderPath: string): Promise<PermanentDelete> {
  let movedTo: string;
  try {
    movedTo = await moveLaneFolderAsideWhenReleased(folderPath);
  } catch (error) {
    if (error instanceof LaneFolderBusyError) {
      return {
        kind: "untouched",
        code: "folder_in_use",
        reason: "Some files in the folder are in use by another program. Close it and try again.",
      };
    }
    return { kind: "untouched", code: "delete_failed", reason: `ADE couldn't delete the folder: ${errorText(error)}` };
  }
  try {
    await removeWorktreeDirectoryWithRecovery(movedTo);
    return { kind: "deleted" };
  } catch (error) {
    return {
      kind: "partial",
      remainingPath: movedTo,
      reason: `ADE removed the project but couldn't delete every file: ${errorText(error)}`,
    };
  }
}

export function createProjectCopyRemoval(deps: ProjectCopyRemovalDeps) {
  const requireRecord = (projectId: ProjectId): ProjectRecord => {
    const record = deps.projectRegistry.get(projectId);
    if (!record) throw new Error(`Unknown projectId: ${projectId}`);
    return record;
  };

  return {
    async inspect(projectId: ProjectId): Promise<ProjectRemovalReport> {
      const record = requireRecord(projectId);
      const sessions = await readSessions(deps.scopeRegistry, projectId);
      const copy = await inspectCopy(record.rootPath, sessions);
      const refusal = copy.state.folder === "present" ? await folderRefusal(deps, record) : null;
      return {
        projectId,
        rootPath: record.rootPath,
        displayName: record.displayName,
        ...copy,
        deleteMode: "permanent",
        deleteRefusal: refusal && "reason" in refusal ? refusal.reason : null,
      };
    },

    async remove(
      projectId: ProjectId,
      request: ProjectRemovalRequest,
      folderMode: "delete" | "caller",
    ): Promise<ProjectRemovalOutcome | ProjectRemovalClearance> {
      const record = deps.projectRegistry.get(projectId);
      // Another window removed it first.
      if (!record) return { status: "removed", folder: "kept", outsideLaneFolders: [], alreadyRemoved: true };
      if (removalsInFlight.has(projectId)) {
        return { status: "refused", code: "busy", reason: "This project is already being removed on this machine." };
      }
      removalsInFlight.add(projectId);
      try {
        const forget = async (): Promise<void> => {
          await deps.stopProject(projectId);
          deps.projectRegistry.remove(projectId);
        };
        if (!request.deleteFolder) {
          await forget();
          return { status: "removed", folder: "kept", outsideLaneFolders: [] };
        }
        const sessions = await readSessions(deps.scopeRegistry, projectId);
        if (!sessions) {
          return {
            status: "refused",
            code: "work_running",
            reason: "The project is still starting on this machine. ADE kept the folder; try again in a moment.",
          };
        }
        const recheck = await recheckCopy(record.rootPath, sessions, request);
        if (recheck.kind === "missing") {
          await forget();
          return { status: "removed", folder: "missing", outsideLaneFolders: [] };
        }
        if (recheck.kind === "refused") return { status: "refused", code: recheck.code, reason: recheck.reason };
        const refusal = await folderRefusal(deps, record);
        if ("reason" in refusal) return { status: "refused", code: "unsafe_path", reason: refusal.reason };
        const outside = recheck.outsideLaneFolders;
        // Nothing may hold the folder while it goes: the project stops first.
        await deps.stopProject(projectId);
        if (folderMode === "caller") return { status: "cleared", folderPath: refusal.folderPath, outsideLaneFolders: outside };
        const deleted = await deleteFolderPermanently(refusal.folderPath);
        if (deleted.kind === "untouched") return { status: "refused", code: deleted.code, reason: deleted.reason };
        // The folder is out of its place: the entry goes with it.
        deps.projectRegistry.remove(projectId);
        if (deleted.kind === "partial") {
          return { status: "partial", reason: deleted.reason, remainingPath: deleted.remainingPath };
        }
        return { status: "removed", folder: "deleted", outsideLaneFolders: outside };
      } finally {
        removalsInFlight.delete(projectId);
      }
    },
  };
}

export type ProjectCopyRemoval = ReturnType<typeof createProjectCopyRemoval>;
