import path from "node:path";
import type {
  ProjectMoveAttention,
  ProjectMoveCleanupArgs,
  ProjectMovePreflight,
  ProjectMoveProgress,
  ProjectMoveRecord,
  ProjectMoveResult,
  ProjectMoveStartArgs,
  ProjectMoveVolume,
} from "../../../shared/types/projectMove";
import type { Logger } from "../logging/logger";
import type { GlobalState } from "../state/globalState";
import {
  deleteParkedOriginal,
  recoverInterruptedMoves,
  runProjectMove,
} from "../../../../../ade-cli/src/services/projects/projectMove/projectMoveEngine";
import {
  findMoveInto,
  listMoveRecords,
  readMoveRecord,
  writeMoveRecord,
} from "../../../../../ade-cli/src/services/projects/projectMove/moveJournal";
import {
  preflightProjectMove,
  type ProjectActivity,
} from "../../../../../ade-cli/src/services/projects/projectMove/projectMovePreflight";
import { listMoveVolumes } from "../../../../../ade-cli/src/services/projects/projectMove/moveVolumes";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Sorts a project's live sessions into what blocks a move (an agent at work,
 * whether a chat turn or an agent CLI in a terminal) and what the move closes
 * (a shell or a run).
 */
export function classifyProjectActivity(chatTitles: string[], sessions: unknown): ProjectActivity {
  const runningChats = chatTitles.map((title) => title || "Untitled chat");
  const openTerminals: string[] = [];
  for (const session of Array.isArray(sessions) ? (sessions as Array<Record<string, unknown>>) : []) {
    if (session.status !== "running" || typeof session.ptyId !== "string" || !session.ptyId) continue;
    const toolType = typeof session.toolType === "string" ? session.toolType : "shell";
    if (toolType.endsWith("-chat")) continue; // counted as a chat above
    const label = [session.title, session.laneName].filter((part) => typeof part === "string" && part).join(" — ") || toolType;
    if (toolType === "shell" || toolType === "run") openTerminals.push(label);
    else runningChats.push(label);
  }
  return { runningChats, openTerminals };
}

/** `root` mapped to where a finished move put it; any other root unchanged. */
function movedRoot(root: string, record: ProjectMoveRecord, normalize: (root: string) => string): string {
  const spellings = record.resume?.sourceSpellings ?? [record.sourceRoot];
  return spellings.includes(root) || spellings.includes(normalize(root)) ? record.destinationRoot : root;
}

/** Recent projects, the last project and the update workspace, pointed at the moved project's new folder. */
export function remapGlobalStateForMove(state: GlobalState, record: ProjectMoveRecord, normalize: (root: string) => string): GlobalState {
  const move = (root: string) => movedRoot(root, record, normalize);
  return {
    ...state,
    recentProjects: (state.recentProjects ?? []).map((entry) => (entry.remote ? entry : { ...entry, rootPath: move(entry.rootPath) })),
    lastProjectRoot: state.lastProjectRoot ? move(state.lastProjectRoot) : state.lastProjectRoot,
    ...(state.updateWorkspace
      ? {
          updateWorkspace: {
            localRoots: state.updateWorkspace.localRoots.map(move),
            activeLocalRoot: state.updateWorkspace.activeLocalRoot ? move(state.updateWorkspace.activeLocalRoot) : null,
          },
        }
      : {}),
  };
}

/** Replaces, in place, every root in `roots` that the move took elsewhere with its new folder. */
export function replaceMovedRoots(roots: Set<string>, record: ProjectMoveRecord, normalize: (root: string) => string): void {
  let moved = false;
  for (const root of [...roots]) {
    if (root !== record.destinationRoot && movedRoot(root, record, normalize) === record.destinationRoot) {
      roots.delete(root);
      moved = true;
    }
  }
  if (moved) roots.add(record.destinationRoot);
}

export type ProjectMoveControllerDeps = {
  logger: Logger;
  /** Running agent turns and open terminals in a project, from whichever runtime hosts it. */
  getActivity: (projectRoot: string) => Promise<ProjectActivity>;
  /** Close the project in every window and in the background service. */
  releaseProject: (projectRoot: string) => Promise<void>;
  /** After a successful move: update recent projects and open the new location. */
  afterMove: (record: ProjectMoveRecord, windowId: number | null) => Promise<void>;
  /** After a failed move: reopen the untouched original. */
  afterFailedMove: (sourceRoot: string, windowId: number | null) => Promise<void>;
  emitProgress: (progress: ProjectMoveProgress) => void;
};

/**
 * Moves one project at a time on this machine. macOS only: the engine refuses
 * elsewhere, and the Settings row is disabled off macOS.
 */
export function createProjectMoveController(deps: ProjectMoveControllerDeps) {
  let running: string | null = null;

  return {
    listVolumes(): Promise<ProjectMoveVolume[]> {
      return listMoveVolumes();
    },

    async preflight(args: { projectRoot: string; destinationRoot: string }): Promise<ProjectMovePreflight> {
      const activity = await deps.getActivity(args.projectRoot).catch((error): ProjectActivity => {
        deps.logger.warn("project_move.activity_failed", { error: errorText(error) });
        return { runningChats: [], openTerminals: [], unknownReason: "ADE's background service didn't answer." };
      });
      return preflightProjectMove({
        sourceRoot: args.projectRoot,
        destinationRoot: args.destinationRoot,
        activity,
      });
    },

    async start(args: ProjectMoveStartArgs, windowId: number | null): Promise<ProjectMoveResult> {
      if (running) return { ok: false, record: null, error: "Another project is being moved. Wait for it to finish." };
      running = args.projectRoot;
      try {
        // Checked again right before starting: the person may have started an
        // agent or filled the drive since the checks were shown.
        const preflight = await this.preflight({ projectRoot: args.projectRoot, destinationRoot: args.destinationRoot });
        const blocked = preflight.checks.find((check) => check.status === "blocked");
        if (blocked) return { ok: false, record: null, error: `${blocked.title}. ${blocked.detail ?? ""}`.trim() };
        deps.logger.info("project_move.started", { projectRoot: args.projectRoot, destinationRoot: args.destinationRoot });
        const reopenOriginal = () => deps.afterFailedMove(args.projectRoot, windowId).catch((error) => {
          deps.logger.warn("project_move.reopen_original_failed", { error: errorText(error) });
        });
        let record: ProjectMoveRecord;
        try {
          record = await runProjectMove({
            sourceRoot: args.projectRoot,
            destinationRoot: args.destinationRoot,
            moveAgentHistory: args.moveAgentHistory,
            hooks: {
              closeProject: deps.releaseProject,
              onProgress: deps.emitProgress,
            },
          });
        } catch (error) {
          // Only the journal itself failing reaches here; the project was
          // closed, so open it again wherever it is.
          deps.logger.warn("project_move.crashed", { error: errorText(error) });
          await reopenOriginal();
          return { ok: false, record: null, error: `The move stopped: ${errorText(error)}` };
        }
        if (record.state !== "done") {
          deps.logger.warn("project_move.failed", { step: record.failedStep, error: record.error });
          await reopenOriginal();
          return { ok: false, record, error: record.error ?? "The move failed. Your project wasn't changed." };
        }
        deps.logger.info("project_move.done", { moveId: record.moveId, problems: record.problems.length });
        // The move is done whatever happens now: a failed reopen is reported,
        // never turned into "the move failed".
        try {
          await deps.afterMove(record, windowId);
        } catch (error) {
          deps.logger.warn("project_move.reopen_failed", { error: errorText(error) });
          record.problems.push(`ADE couldn't open the project at its new folder: ${errorText(error)}. Open it from the project list.`);
          writeMoveRecord(record);
        }
        return { ok: true, record };
      } finally {
        running = null;
      }
    },

    /** The latest finished move into this project, for the Location row and the cleanup choice. */
    status(projectRoot: string): ProjectMoveRecord | null {
      return findMoveInto(path.resolve(projectRoot));
    },

    /** Where a move's kept original, or the moved project, is now. */
    revealTarget(moveId: string, which: "original" | "moved"): string | null {
      const record = readMoveRecord(moveId);
      return (which === "original" ? record?.originalParkedAt : record?.destinationRoot) ?? null;
    },

    /**
     * Kept originals that want a decision now (none made yet, or a reminder
     * that is due), newest first, and when the next reminder falls due so the
     * window can wake for it instead of polling.
     */
    attention(now = Date.now()): ProjectMoveAttention {
      const kept = listMoveRecords().filter((record) => record.state === "done" && Boolean(record.originalParkedAt));
      const records = kept.filter((record) =>
        record.cleanup.choice === "pending"
        || (record.cleanup.choice === "remind" && (record.cleanup.remindAt ?? 0) <= now));
      const upcoming = kept
        .filter((record) => record.cleanup.choice === "remind" && (record.cleanup.remindAt ?? 0) > now)
        .map((record) => record.cleanup.remindAt ?? 0);
      return { records, nextReminderAt: upcoming.length ? Math.min(...upcoming) : null };
    },

    async cleanup(args: ProjectMoveCleanupArgs): Promise<ProjectMoveRecord> {
      const record = readMoveRecord(args.moveId);
      if (!record || record.state !== "done") throw new Error("ADE has no finished move with that id.");
      if (args.choice === "delete") {
        await deleteParkedOriginal(record);
        record.cleanup = { choice: "deleted", deletedAt: Date.now() };
        record.originalParkedAt = null;
        deps.logger.info("project_move.original_deleted", { moveId: record.moveId, bytes: record.originalBytes });
      } else if (args.choice === "remind") {
        const remindInMs = Math.max(60_000, Math.min(args.remindInMs, 90 * 24 * 60 * 60_000));
        record.cleanup = { choice: "remind", remindAt: Date.now() + remindInMs };
      } else {
        record.cleanup = { choice: "keep" };
      }
      writeMoveRecord(record);
      return record;
    },

    /** Settles moves a crash or quit interrupted. Called once at startup, before the last project reopens. */
    async recover(): Promise<ProjectMoveRecord[]> {
      try {
        const { settled, tidyUp } = await recoverInterruptedMoves();
        for (const record of settled) deps.logger.info("project_move.recovered", { moveId: record.moveId, state: record.state });
        void tidyUp.catch((error) => deps.logger.warn("project_move.recover_tidy_up_failed", { error: errorText(error) }));
        return settled;
      } catch (error) {
        deps.logger.warn("project_move.recover_failed", { error: errorText(error) });
        return [];
      }
    },
  };
}

export type ProjectMoveController = ReturnType<typeof createProjectMoveController>;
