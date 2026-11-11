import fs from "node:fs";
import path from "node:path";
import type { ChatLaunchArgs, ChatLaunchSnapshot } from "../../../shared/types";
import type { CloudTier } from "../../../shared/cloudTiers";
import type { CloudAgentMaker } from "../../../shared/adeCloud";
import { isChatLaunchTerminal } from "../../../shared/chatLaunch";
import { getErrorMessage } from "../shared/utils";

/**
 * On-disk records for ADE Cloud lane launches, one JSON file per launch in
 * the app's own data folder (never a project folder: the launch belongs to no
 * project on this computer). A record outlives a quit so the launch goes on
 * when ADE opens again, and a cancel that could not delete its computer yet
 * tries again then.
 */

export type CloudLaneLaunchRecord = {
  v: 1;
  /** Always carries `cloud`. After the hand-off, the computer's brain's snapshot as last seen. */
  snapshot: ChatLaunchSnapshot & { cloud: NonNullable<ChatLaunchSnapshot["cloud"]> };
  /** What the computer's brain gets at the hand-off: the launch minus its cloud target. */
  launch: Omit<ChatLaunchArgs, "cloud" | "priorStages">;
  project: {
    /** `github.com/owner/repo`, as `normalizeGitRemoteIdentity` writes it. */
    identity: string;
    cloneUrl: string;
    repoName: string;
  };
  /** The size, read from the catalog once the `computer` stage starts. */
  tier: CloudTier | null;
  /** The computer's name on ADE Cloud and in the account. */
  computerName: string;
  /** This app's saved remote target for the computer, once paired. */
  targetId: string | null;
  /** Sign-ins started on the computer; a repeat needs a fresh code. */
  joinAttempts: number;
  /**
   * The local sequence at the hand-off. The brain counts its own sequence from
   * 1, so every brain snapshot is served above this to stay newer for clients.
   */
  sequenceBase: number;
  /**
   * Ids in `snapshot.queuedMessages` still only here, not yet given to the
   * computer's brain, in order. Before the hand-off that is every one; after
   * it, the brain's own queue shows the rest under its own ids.
   */
  pendingMessageIds: string[];
  /** A cancelled launch whose computer is deleted (or never existed). */
  cleanupDone: boolean;
  /** The agent's chat that started it, or null for a person's launch. Older records lack it. */
  madeByChat?: string | null;
  /** The kind of agent that started it (written on the computer for the daily limit); null for a person's. */
  madeByAgent?: CloudAgentMaker | null;
  /** Files from this computer already sent to the new one: local path to the path there. */
  carriedFiles?: Record<string, string>;
  /** The branch last written into the computer's metadata (`ade_lane_branch`). */
  branchRecorded?: string | null;
};

export function createCloudLaneLaunchRecordStore(args: {
  recordsDir: string;
  logger: { warn: (event: string, meta?: Record<string, unknown>) => void };
}) {
  const { recordsDir, logger } = args;
  const recordPath = (launchId: string) => path.join(recordsDir, `${launchId}.json`);

  const persist = (record: CloudLaneLaunchRecord): void => {
    const target = recordPath(record.snapshot.launchId);
    const tmp = `${target}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(recordsDir, { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(record));
      fs.renameSync(tmp, target);
    } catch (error) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
      logger.warn("cloud_lane_launch.persist_failed", { launchId: record.snapshot.launchId, error: getErrorMessage(error) });
    }
  };

  const unpersist = (launchId: string): void => {
    try {
      fs.rmSync(recordPath(launchId), { force: true });
    } catch (error) {
      // A leftover file is read, found finished, and removed at the next start.
      logger.warn("cloud_lane_launch.unpersist_failed", { launchId, error: getErrorMessage(error) });
    }
  };

  /** Every record still owed work or still worth showing; finished, cleaned-up ones are deleted. */
  const loadAll = (): CloudLaneLaunchRecord[] => {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(recordsDir);
    } catch (error) {
      // None yet is normal; anything else hides launches still owed a cleanup.
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        logger.warn("cloud_lane_launch.records_dir_read_failed", { error: getErrorMessage(error) });
      }
      return [];
    }
    const loaded: CloudLaneLaunchRecord[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const file = path.join(recordsDir, entry);
      try {
        const record = JSON.parse(fs.readFileSync(file, "utf8")) as CloudLaneLaunchRecord;
        if (record?.v !== 1 || typeof record.snapshot?.launchId !== "string" || !record.snapshot.cloud) {
          fs.rmSync(file, { force: true });
          continue;
        }
        const finished = isChatLaunchTerminal(record.snapshot.phase)
          && (record.snapshot.phase !== "cancelled" || record.cleanupDone)
          && (record.pendingMessageIds ?? []).length === 0;
        if (finished) {
          fs.rmSync(file, { force: true });
          continue;
        }
        record.pendingMessageIds ??= [];
        loaded.push(record);
      } catch (error) {
        logger.warn("cloud_lane_launch.load_failed", { file, error: getErrorMessage(error) });
      }
    }
    return loaded;
  };

  return { persist, unpersist, loadAll };
}
