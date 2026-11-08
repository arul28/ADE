import fs from "node:fs";
import type {
  StorageLifecycleLaneOutcome,
  StorageLifecyclePolicy,
  StorageLifecycleRunReport,
} from "../../../shared/types/storage";
import type { ArchiveAndReclaimLaneArgs, ArchiveAndReclaimLaneResult } from "../../../shared/types/lanes";
import { archivedForDays, laneCleanupChecksOn, laneFreeUpStatus } from "../../../shared/laneCleanup";
import type { LaneAutoArchiveFacts } from "../lanes/laneService";
import { LaneUnsavedWorkError } from "../lanes/laneFolderRemoval";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";

/**
 * The lane cleanup rules, run by the storage doctor: archive idle, finished
 * lanes; delete archived lanes and free up their folders when due; and finish
 * Archive & Reclaims kept because the folder was in use.
 */

// The lane cleanup rules are checked this often while any of them is on.
const LIFECYCLE_SCAN_INTERVAL_MS = 60 * 60_000;
// A lifecycle scan that stopped with an error waits this long before the next
// try, instead of the next minute's tick.
const LIFECYCLE_RETRY_AFTER_FAILURE_MS = 60 * 60_000;
// Archive & Reclaims kept because the folder was in use: tried again this
// often, this many times.
const PENDING_REMOVAL_RETRY_MS = 10 * 60_000;
const PENDING_REMOVAL_MAX_ATTEMPTS = 12;

const STARTED_DURING_CHECK = "Kept: something started in it during the check.";
const FOLDER_IN_USE = "Folder kept: files in it are still in use. ADE will try again.";

export type LaneLifecycleBackend = {
  list: (options: { includeArchived: boolean; includeStatus: boolean }) => Promise<Array<{
    id: string;
    laneType: "primary" | "worktree" | "attached";
    isEditProtected: boolean;
  }>>;
  /** Local git facts the archive rules decide on; no network, no folder walk. */
  getAutoArchiveFacts: (laneId: string) => Promise<LaneAutoArchiveFacts>;
  archive: (args: { laneId: string }, opts?: { autoArchive?: { reason: string } }) => Promise<void>;
  /**
   * Frees up an archived lane's folder ("Automatically"), and finishes a
   * reclaim kept because its folder was in use (`keptForRetry`).
   */
  archiveAndReclaim?: (args: ArchiveAndReclaimLaneArgs) => Promise<ArchiveAndReclaimLaneResult>;
  /** The lane delete, with its own guards; the automatic delete of archived lanes calls it. */
  delete?: (args: { laneId: string; deleteBranch?: boolean; deleteRemoteBranch?: boolean; force?: boolean }) => Promise<unknown>;
  pruneDeletedLanes?: () => Promise<void>;
  /** Open chats, live terminals and watchers in the lane; null when not known yet. */
  getLiveWorkCounts?: (laneId: string) => {
    activeChatCount: number;
    activePtyCount: number;
    activeWatcherCount: number;
  } | null;
};

export type LifecycleLaneRow = {
  id: string;
  name: string;
  worktree_path: string;
  archived_at: string | null;
  created_at: string;
  lane_type: string;
  is_edit_protected: number;
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** "40 minutes", "5 hours", "3 days". */
function formatAge(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  const days = Math.floor(hours / 24);
  return `${days} days`;
}

/**
 * Whether a lane's work is finished, so the archive rules may archive it.
 * ADE's PR record wins when it says merged (a squash merge never makes the
 * branch an ancestor of its base); a lane with no commits of its own is not
 * finished, though git calls a branch that never moved merged.
 */
function finishedBy(facts: LaneAutoArchiveFacts): { done: true; prMerged: boolean } | { done: false; why: string } {
  if (!facts.hasBranch) return { done: false, why: "Kept: it has no branch." };
  // A later PR still in review keeps the lane, whatever an earlier one did.
  if (facts.prOpen) return { done: false, why: "Kept: its PR is still open." };
  // Squash-merged: its commits sit on no remote once GitHub deletes the
  // branch, but the merged PR's head is the branch, so they all went in.
  if (facts.mergedPrHasHead) return { done: true, prMerged: true };
  if (facts.unpushedCommitCount > 0) return { done: false, why: "Kept: its branch has commits that aren't pushed." };
  if (facts.prMerged) return { done: true, prMerged: true };
  if (!facts.hasOwnCommits) return { done: false, why: "Kept: no commits yet." };
  if (!facts.mergedIntoBase) return { done: false, why: "Kept: its branch has work that isn't merged." };
  return { done: true, prMerged: false };
}

/** What a reclaim the cleanup started came to: removed, or kept until its files are let go. */
function reclaimOutcome(
  row: { id: string; name: string },
  result: ArchiveAndReclaimLaneResult,
  freedDetail: string,
): StorageLifecycleLaneOutcome {
  return result.keptForRetry
    ? { laneId: row.id, laneName: row.name, outcome: "kept", detail: FOLDER_IN_USE }
    : { laneId: row.id, laneName: row.name, outcome: "freed", detail: freedDetail };
}

export function createLaneLifecycleScan(options: {
  db: AdeDb;
  logger: Logger;
  projectId: string | null | undefined;
  projectRoot: string;
  laneService: LaneLifecycleBackend | null | undefined;
  /** False without a project config to read the rules from: nothing runs. */
  hasConfig: boolean;
  policy: () => StorageLifecyclePolicy;
  listLanes: () => LifecycleLaneRow[];
  latestLaneActivityMs: (laneId: string, createdAt: string) => number;
  hasActiveLaneWorktreeLock: (laneId: string) => boolean;
  releaseLaneRuntimeResources?: ((laneId: string) => void | Promise<void>) | null;
  /** A run's report was written: anything cached from the old one is out of date. */
  onReportChanged: () => void;
}) {
  let flight: Promise<void> | null = null;

  /** Chats or terminals the database records as running in the lane, loaded into memory or not. */
  const hasPersistedRunningSession = (laneId: string): boolean => Boolean(options.db.get<{ found: number }>(
    "select 1 as found from terminal_sessions where lane_id = ? and status = 'running' and ended_at is null limit 1",
    [laneId],
  ));

  const readLastRun = (projectId: string): StorageLifecycleRunReport | null => {
    const row = options.db.get<{ last_run_json: string | null }>(
      "select last_run_json from local_storage_lifecycle_runs where project_id = ?",
      [projectId],
    );
    if (!row?.last_run_json) return null;
    try {
      return JSON.parse(row.last_run_json) as StorageLifecycleRunReport;
    } catch {
      return null;
    }
  };

  const writeLastRun = (projectId: string, report: StorageLifecycleRunReport): void => {
    const now = new Date().toISOString();
    options.db.run(
      `insert into local_storage_lifecycle_runs(project_id, last_run_json, updated_at)
       values(?, ?, ?)
       on conflict(project_id) do update set
         last_run_json = excluded.last_run_json,
         updated_at = excluded.updated_at`,
      [projectId, JSON.stringify(report), now],
    );
    options.onReportChanged();
  };

  /**
   * Finishes Archive & Reclaims that found the lane's folder still in use
   * (`pending_removal_at`): the lane is archived, the person already
   * confirmed the removal, and nothing was removed yet. Each is tried again
   * at most every 10 minutes and given up after a dozen tries, quietly; the
   * outcome replaces that lane's line in "Last run".
   */
  const finishPendingRemovals = async (): Promise<StorageLifecycleLaneOutcome[]> => {
    const laneService = options.laneService;
    const projectId = options.projectId?.trim();
    if (!laneService?.archiveAndReclaim || !projectId) return [];
    let pending: Array<{ lane_id: string; name: string; attempts: number; updated_at: string }>;
    try {
      pending = options.db.all(
        `select s.lane_id, l.name, s.attempts, s.updated_at
           from local_lane_storage_state s
           join lanes l on l.id = s.lane_id
          where s.project_id = ? and s.reclaim_state = 'kept'
            and s.pending_removal_at is not null and l.archived_at is not null`,
        [projectId],
      );
    } catch (error) {
      options.logger.warn("storage.lifecycle_pending_removals_read_failed", { error: errorText(error) });
      return [];
    }
    const outcomes: StorageLifecycleLaneOutcome[] = [];
    for (const row of pending) {
      const lastTry = Date.parse(row.updated_at);
      if (Number.isFinite(lastTry) && Date.now() - lastTry < PENDING_REMOVAL_RETRY_MS) continue;
      if (options.hasActiveLaneWorktreeLock(row.lane_id)) continue;
      if (row.attempts >= PENDING_REMOVAL_MAX_ATTEMPTS) {
        options.db.run(
          `update local_lane_storage_state
              set reclaim_state = 'failed', pending_removal_at = null,
                  last_error = 'Files in the folder stayed in use. Close what uses them, then reclaim the lane again.',
                  updated_at = ?
            where project_id = ? and lane_id = ?`,
          [new Date().toISOString(), projectId, row.lane_id],
        );
        outcomes.push({
          laneId: row.lane_id,
          laneName: row.name,
          outcome: "failed",
          detail: "Its folder stayed in use, so ADE stopped trying. Close what uses it and reclaim the lane again.",
        });
        continue;
      }
      try {
        // Without `forceDirty`, even when the person gave it the first time:
        // files changed since are not theirs to have confirmed.
        const result = await laneService.archiveAndReclaim({ laneId: row.lane_id, confirmation: "RECLAIM" });
        outcomes.push(reclaimOutcome({ id: row.lane_id, name: row.name }, result, "Removed its folder, which was in use earlier."));
      } catch (error) {
        const message = errorText(error);
        if (error instanceof LaneUnsavedWorkError) {
          // The retry stops here and waits for the person, with the reason.
          const reason = "It has work saved nowhere else, and ADE doesn't remove that on its own. Use Free up space again to confirm it may be lost.";
          options.db.run(
            `update local_lane_storage_state
                set reclaim_state = 'failed', pending_removal_at = null, last_error = ?, updated_at = ?
              where project_id = ? and lane_id = ?`,
            [reason, new Date().toISOString(), projectId, row.lane_id],
          );
          outcomes.push({ laneId: row.lane_id, laneName: row.name, outcome: "failed", detail: reason });
          continue;
        }
        outcomes.push({
          laneId: row.lane_id,
          laneName: row.name,
          outcome: "failed",
          detail: `Couldn't remove its folder: ${message}`,
        });
      }
    }
    if (outcomes.length === 0) return outcomes;
    const previous = readLastRun(projectId);
    const finishedAt = new Date().toISOString();
    const replaced = new Set(outcomes.map((entry) => entry.laneId));
    writeLastRun(projectId, {
      startedAt: previous?.startedAt ?? finishedAt,
      finishedAt,
      durationMs: previous?.durationMs ?? 0,
      ...(previous?.error ? { error: previous.error } : {}),
      recentlyUsedCount: previous?.recentlyUsedCount ?? 0,
      lanes: [...outcomes, ...(previous?.lanes ?? []).filter((entry) => !replaced.has(entry.laneId))],
    });
    return outcomes;
  };

  /**
   * The lane cleanup rules: archive idle, finished lanes; then, for archived
   * lanes, delete the ones due and free up the folders due when "Free up
   * space" is set to Automatically. "Ask me" removes nothing and needs no
   * check: what is due follows from `archived_at` (`laneFreeUpStatus`).
   *
   * Runs about hourly while any rule is on. The attempt is recorded before
   * any work, so a scan that throws backs off
   * (`LIFECYCLE_RETRY_AFTER_FAILURE_MS`) instead of running again on the next
   * minute's tick. Each lane is checked on its own: one that fails (deleted
   * mid-scan, git refusing) is reported in "Last run" and the others still
   * run. The checks are cheap first: database activity, the lane's lease and
   * what runs in it; git only for the lanes a rule would act on, and then
   * local git only (`getAutoArchiveFacts`).
   */
  const run = (carried: StorageLifecycleLaneOutcome[] = []): Promise<void> => {
    if (flight) return flight;
    flight = (async () => {
      const laneService = options.laneService;
      const projectId = options.projectId?.trim();
      if (!laneService || !options.hasConfig || !projectId) return;
      // Saved lane work expires whether or not any cleanup rule is on.
      await laneService.pruneDeletedLanes?.();
      const policy = options.policy();
      if (!laneCleanupChecksOn(policy)) return;
      const previous = options.db.get<{ last_scan_at: string | null; last_attempt_at: string | null }>(
        "select last_scan_at, last_attempt_at from local_storage_lifecycle_runs where project_id = ?",
        [projectId],
      );
      const lastScanMs = previous?.last_scan_at ? Date.parse(previous.last_scan_at) : 0;
      const lastAttemptMs = previous?.last_attempt_at ? Date.parse(previous.last_attempt_at) : 0;
      const intervalMs = LIFECYCLE_SCAN_INTERVAL_MS;
      if (Number.isFinite(lastScanMs) && lastScanMs > 0 && Date.now() - lastScanMs < intervalMs) return;
      if (
        Number.isFinite(lastAttemptMs) && lastAttemptMs > lastScanMs
        && Date.now() - lastAttemptMs < LIFECYCLE_RETRY_AFTER_FAILURE_MS
      ) return;

      const startedAtMs = Date.now();
      const startedAt = new Date(startedAtMs).toISOString();
      options.db.run(
        `insert into local_storage_lifecycle_runs(project_id, last_attempt_at, updated_at)
         values(?, ?, ?)
         on conflict(project_id) do update set
           last_attempt_at = excluded.last_attempt_at,
           updated_at = excluded.updated_at`,
        [projectId, startedAt, startedAt],
      );
      // Removals finished just before this scan stay in its report.
      const outcomes: StorageLifecycleLaneOutcome[] = [...carried];
      let recentlyUsedCount = 0;
      let archivedAutomatically = 0;
      const report = (error?: string): StorageLifecycleRunReport => ({
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAtMs,
        ...(error ? { error } : {}),
        recentlyUsedCount,
        lanes: outcomes,
      });
      /** Something runs in the lane, or ADE can't tell yet; the reason to keep it, or null. */
      const busyReason = (laneId: string): string | null => {
        if (options.hasActiveLaneWorktreeLock(laneId)) return "Kept: another operation is using it.";
        // In memory and in the database: right after ADE starts, chats are
        // not loaded yet and the in-memory count reads 0 for a lane whose
        // chat is about to resume.
        const live = laneService.getLiveWorkCounts?.(laneId) ?? null;
        if (!live) return "Kept: ADE hasn't loaded its chats and terminals yet.";
        if (live.activeChatCount + live.activePtyCount + live.activeWatcherCount > 0 || hasPersistedRunningSession(laneId)) {
          return "Kept: a chat or terminal is running in it.";
        }
        return null;
      };
      /**
       * The gate every automatic action passes before it touches a lane; the
       * reason to keep it, or null. Without `facts`, the cheap part (no git):
       * protected, or something runs in it. With them: its folder is not a
       * working checkout (`folderMustBeCheckout`), or has uncommitted files.
       */
      const laneSafeToTouch = (
        row: LifecycleLaneRow,
        facts: LaneAutoArchiveFacts | null,
        folderMustBeCheckout = true,
      ): string | null => {
        if (!facts) {
          if (row.is_edit_protected) return "Kept: it is protected.";
          return busyReason(row.id);
        }
        if (folderMustBeCheckout && !facts.worktreeUsable) return "Kept: its folder isn't a working git checkout right now.";
        if (facts.dirty) return "Kept: it has uncommitted files.";
        return null;
      };
      /** Checked again right before acting: a chat may have started meanwhile. */
      const startedMeanwhile = (laneId: string): string | null => (busyReason(laneId) ? STARTED_DURING_CHECK : null);
      try {
        const rows = options.listLanes();
        const rowById = new Map(rows.map((row) => [row.id, row] as const));
        const idleMs = policy.archiveIdleAfterDays * 24 * 60 * 60_000;
        const candidates = policy.archiveIdleAfterDays > 0
          ? (await laneService.list({ includeArchived: false, includeStatus: false }))
            .filter((lane) => lane.laneType === "worktree" && rowById.has(lane.id))
          : [];
        for (const lane of candidates) {
          const row = rowById.get(lane.id)!;
          const keep = (detail: string) => outcomes.push({ laneId: lane.id, laneName: row.name, outcome: "skipped", detail });
          // Database activity only: a commit can only make the lane more recent.
          let activityMs = options.latestLaneActivityMs(lane.id, row.created_at);
          if (Date.now() - activityMs < idleMs) {
            recentlyUsedCount += 1;
            continue;
          }
          try {
            // The lane list's protection flag: the row read above may be older.
            const blocked = laneSafeToTouch({ ...row, is_edit_protected: lane.isEditProtected ? 1 : 0 }, null);
            if (blocked) {
              keep(blocked);
              continue;
            }
            const facts = await laneService.getAutoArchiveFacts(lane.id);
            if (facts.lastCommitAtMs != null && facts.lastCommitAtMs > activityMs) activityMs = facts.lastCommitAtMs;
            if (Date.now() - activityMs < idleMs) {
              keep(`Kept: a commit ${formatAge(Date.now() - activityMs)} ago.`);
              continue;
            }
            const unsafe = laneSafeToTouch(row, facts);
            if (unsafe) {
              keep(unsafe);
              continue;
            }
            const doneBy = finishedBy(facts);
            if (!doneBy.done) {
              keep(doneBy.why);
              continue;
            }
            const because = `${doneBy.prMerged ? "PR merged, " : ""}idle ${formatAge(Date.now() - activityMs)}`;
            const started = startedMeanwhile(lane.id);
            if (started) {
              keep(started);
              continue;
            }
            // Await before the lease release: the lane's processes have to be
            // gone before their ports are handed back.
            await laneService.archive({ laneId: lane.id }, { autoArchive: { reason: because } });
            await options.releaseLaneRuntimeResources?.(lane.id);
            archivedAutomatically += 1;
            outcomes.push({ laneId: lane.id, laneName: row.name, outcome: "archived", detail: `Archived: ${because}.` });
          } catch (error) {
            // Deleted while the scan ran: nothing to report.
            if (!options.db.get("select 1 as found from lanes where id = ?", [lane.id])) continue;
            options.logger.warn("storage.lifecycle_auto_archive_failed", {
              laneId: lane.id,
              error: errorText(error),
            });
            outcomes.push({ laneId: lane.id, laneName: row.name, outcome: "failed", detail: `Couldn't check or archive it: ${errorText(error)}` });
          }
        }

        // Archived lanes. A lane is deleted or freed up only on proof that
        // nothing is lost: no uncommitted files, no commit only this machine
        // has, nothing running in it; a delete also waits for an open PR and
        // never touches the remote branch. The primary lane is never either.
        const freeUpAutomatically = policy.freeUpSpaceMode === "auto" && policy.freeUpSpaceAfterDays > 0;
        if (policy.deleteArchivedAfterDays > 0 || freeUpAutomatically) {
          const removalStates = new Map(options.db.all<{ lane_id: string; reclaim_state: string; pending_removal_at: string | null }>(
            "select lane_id, reclaim_state, pending_removal_at from local_lane_storage_state where project_id = ?",
            [projectId],
          ).map((entry) => [entry.lane_id, entry] as const));
          const nowMs = Date.now();
          for (const row of options.listLanes()) {
            if (!row.archived_at || row.lane_type === "primary") continue;
            const archivedFor = formatAge(nowMs - Date.parse(row.archived_at));
            const deleteDue = Boolean(laneService.delete)
              && archivedForDays(row.archived_at, policy.deleteArchivedAfterDays, nowMs);
            const state = removalStates.get(row.id);
            const folderPresent = fs.existsSync(row.worktree_path);
            // A removal waiting on files in use is `finishPendingRemovals`'s to
            // finish; one that failed waits for a person to try it again.
            const freeUpDue = freeUpAutomatically && Boolean(laneService.archiveAndReclaim)
              && laneFreeUpStatus({
                archivedAt: row.archived_at,
                laneType: row.lane_type,
                folderPresent,
                reclaimState: state?.reclaim_state ?? null,
                pendingRemoval: Boolean(state?.pending_removal_at),
              }, policy, nowMs) === "due";
            if (!deleteDue && !freeUpDue) continue;
            const keep = (detail: string) => outcomes.push({ laneId: row.id, laneName: row.name, outcome: "skipped", detail });
            try {
              const blocked = laneSafeToTouch(row, null);
              if (blocked) {
                keep(blocked);
                continue;
              }
              const facts = await laneService.getAutoArchiveFacts(row.id);
              // A lane whose folder is already gone has no checkout to read.
              const unsafe = laneSafeToTouch(row, facts, folderPresent);
              if (unsafe) {
                keep(unsafe);
                continue;
              }
              if (facts.unpushedCommitCount > 0 && !facts.mergedPrHasHead) {
                keep(`Kept: ${facts.unpushedCommitCount === 1 ? "1 commit" : `${facts.unpushedCommitCount} commits`} no remote has.`);
                continue;
              }
              if (deleteDue && facts.prOpen) {
                if (!freeUpDue) {
                  keep("Kept: its PR is still open.");
                  continue;
                }
              } else if (deleteDue) {
                const started = startedMeanwhile(row.id);
                if (started) {
                  keep(started);
                  continue;
                }
                const withBranch = policy.deleteLocalBranchOnAutoDelete && facts.hasBranch;
                await laneService.delete!({
                  laneId: row.id,
                  deleteBranch: policy.deleteLocalBranchOnAutoDelete,
                  deleteRemoteBranch: false,
                  force: false,
                });
                await options.releaseLaneRuntimeResources?.(row.id);
                outcomes.push({
                  laneId: row.id,
                  laneName: row.name,
                  outcome: "deleted",
                  detail: `Deleted: archived ${archivedFor} ago${withBranch ? ", with its local branch" : "; its branch is kept"}. Chats it had are in Recently deleted.`,
                });
                continue;
              }
              const started = startedMeanwhile(row.id);
              if (started) {
                keep(started);
                continue;
              }
              const result = await laneService.archiveAndReclaim!({ laneId: row.id, confirmation: "RECLAIM" });
              outcomes.push(reclaimOutcome(
                row,
                result,
                `Freed up space: archived ${archivedFor} ago, so its folder was removed. Its branch and chats are kept.`,
              ));
            } catch (error) {
              if (!options.db.get("select 1 as found from lanes where id = ?", [row.id])) continue;
              options.logger.warn("storage.lifecycle_archived_cleanup_failed", {
                laneId: row.id,
                action: deleteDue ? "delete" : "free_up",
                error: errorText(error),
              });
              outcomes.push({
                laneId: row.id,
                laneName: row.name,
                outcome: "failed",
                detail: `Couldn't ${deleteDue ? "delete" : "free up"} it: ${errorText(error)}`,
              });
            }
          }
        }
      } catch (error) {
        // The whole scan stopped (the lane list could not be read). Recorded
        // once; the attempt time above keeps the next tick from repeating it.
        options.logger.warn("storage.lifecycle_scan_failed", { projectRoot: options.projectRoot, error: errorText(error) });
        writeLastRun(projectId, report(`The check stopped: ${errorText(error)}`));
        return;
      }

      const now = new Date().toISOString();
      const nextScanAt = new Date(Date.now() + intervalMs).toISOString();
      options.db.run(
        `insert into local_storage_lifecycle_runs(
           project_id, last_scan_at, next_scan_at, archived_automatically, last_run_json, updated_at
         ) values(?, ?, ?, ?, ?, ?)
         on conflict(project_id) do update set
           last_scan_at = excluded.last_scan_at,
           next_scan_at = excluded.next_scan_at,
           archived_automatically = local_storage_lifecycle_runs.archived_automatically + excluded.archived_automatically,
           last_run_json = excluded.last_run_json,
           updated_at = excluded.updated_at`,
        [projectId, now, nextScanAt, archivedAutomatically, JSON.stringify(report()), now],
      );
      options.logger.info("storage.lifecycle_scan_completed", {
        archived: archivedAutomatically,
        freed: outcomes.filter((entry) => entry.outcome === "freed").length,
        deleted: outcomes.filter((entry) => entry.outcome === "deleted").length,
        failed: outcomes.filter((entry) => entry.outcome === "failed").length,
        checked: outcomes.length,
        durationMs: Date.now() - startedAtMs,
      });
      options.onReportChanged();
    })().finally(() => {
      flight = null;
    });
    return flight;
  };

  return {
    run,
    finishPendingRemovals,
    readLastRun,
    inProgress: (): boolean => flight != null,
  };
}
