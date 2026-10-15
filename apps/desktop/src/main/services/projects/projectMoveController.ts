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

export type ProjectMoveControllerDeps = {
  logger: Logger;
  /** Running agent turns and open terminals in a project, from whichever runtime hosts it. */
  getActivity: (projectRoot: string) => Promise<ProjectActivity>;
  /** Close the project in every window and in the background service. */
  releaseProject: (projectRoot: string) => Promise<void>;
  /** After a successful move: update recent projects and open the new location. */
  afterMove: (record: ProjectMoveRecord, windowId: number | null) => Promise<void>;
  /** After a failed move: reopen the untouched original. */
  afterFailedMove: (record: ProjectMoveRecord, windowId: number | null) => Promise<void>;
  emitProgress: (progress: ProjectMoveProgress) => void;
};

/**
 * Moves one project at a time on this machine. macOS only: the engine refuses
 * elsewhere, and the Settings row is hidden off macOS.
 */
export function createProjectMoveController(deps: ProjectMoveControllerDeps) {
  let running: string | null = null;

  return {
    listVolumes(): Promise<ProjectMoveVolume[]> {
      return listMoveVolumes();
    },

    async preflight(args: { projectRoot: string; destinationRoot: string }): Promise<ProjectMovePreflight> {
      const activity = await deps.getActivity(args.projectRoot).catch((error) => {
        deps.logger.warn("project_move.activity_failed", { error: error instanceof Error ? error.message : String(error) });
        return { runningChats: [], openTerminals: [] } satisfies ProjectActivity;
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
        const record = await runProjectMove({
          sourceRoot: args.projectRoot,
          destinationRoot: args.destinationRoot,
          moveAgentHistory: args.moveAgentHistory,
          hooks: {
            closeProject: deps.releaseProject,
            onProgress: deps.emitProgress,
          },
        });
        if (record.state !== "done") {
          deps.logger.warn("project_move.failed", { step: record.failedStep, error: record.error });
          await deps.afterFailedMove(record, windowId).catch(() => undefined);
          return { ok: false, record, error: record.error ?? "The move failed. Your project wasn't changed." };
        }
        deps.logger.info("project_move.done", { moveId: record.moveId, followUps: record.followUps.length });
        await deps.afterMove(record, windowId);
        return { ok: true, record };
      } finally {
        running = null;
      }
    },

    /** The latest finished move into this project, for the Location row and the cleanup choice. */
    status(projectRoot: string): ProjectMoveRecord | null {
      return findMoveInto(path.resolve(projectRoot));
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

    /** Settles moves a crash or quit interrupted. Called once at startup. */
    async recover(): Promise<ProjectMoveRecord[]> {
      try {
        const settled = await recoverInterruptedMoves();
        for (const record of settled) deps.logger.info("project_move.recovered", { moveId: record.moveId, state: record.state });
        return settled;
      } catch (error) {
        deps.logger.warn("project_move.recover_failed", { error: error instanceof Error ? error.message : String(error) });
        return [];
      }
    },
  };
}

export type ProjectMoveController = ReturnType<typeof createProjectMoveController>;
