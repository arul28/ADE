/**
 * "Move it to my computer" for a kept ADE Cloud lane (its computer was
 * deleted: `CloudLaneWithoutComputer`). The brain of the person's own
 * machine restores the lane from the account's server copies, with no ADE
 * Cloud computer (shared/cloudKeptLaneRestore.ts has the calls).
 *
 * The order is the data-safety contract:
 *
 * 1. **Lane.** The lane's branch comes in as a normal lane, with the SAME lane
 *    id when it is free here, and its saved work (the newest lane backup from
 *    another machine key) is applied when the lane lacks it. Nothing is
 *    pushed, and newer local work is never overwritten
 *    (`restoreLaneBackupIfNeeded`): a lane with other work keeps it, and the
 *    backup then stays on the server for the person.
 * 2. **Chats.** Each saved chat and CLI of the lane whose copy is on a
 *    deleted computer comes back with its own id (`restoreCloudChat`): a
 *    chat's saved copy moves to this machine's key BEFORE it restores, so it
 *    never lists twice; a CLI's copy moves once it runs here.
 * 3. **Cleanup.** Only when 1 and 2 worked for every chat, the kept-lane
 *    record is forgotten (`POST …/without-computer/:lane/moved`), which keeps
 *    everything that moved to this machine's key.
 *
 * A lane whose computer is asleep (`fromComputer`) first goes through step 0:
 *
 * 0. **Release.** The computer is deleted and its lane kept
 *    (`DELETE /cloud/instances/:id { keepLane: { onlyIfSaved } }`), with no
 *    wake, and only while it rests with every lane's work saved. The server
 *    checks that again right before the delete. A refusal deletes nothing:
 *    the record fails with `wakeInstead`, and the person moves it live. Then
 *    steps 1 to 3 run on the kept lane. This order is safe because the saved
 *    copy already holds everything the restore uses: the computer adds
 *    nothing to it, and nothing can wake a deleted computer during the move.
 *    A later failure leaves a kept lane, which the next start goes on with.
 *
 * Any failure leaves the record `failed` and the kept lane on the server. A
 * new `start` for the lane goes on: a lane that is here is used, and a chat
 * already here (its copy under this key, its session on this machine) is not
 * restored again.
 *
 * One machine-wide store (`setKeptLaneRestores`, installed by the brain on a
 * machine that is not an ADE Cloud computer); records live in memory, so
 * after a restart the kept lane still shows and a new start goes on.
 */

import { randomUUID } from "node:crypto";
import type {
  CloudChatRow,
  CloudIgnoredFiles,
  CloudInstance,
  CloudLaneWithoutComputer,
  CloudSessionRow,
} from "../../../../account-directory/src/cloud/contract";
import { CLOUD_BACKUP_NEVER_SAVED_SENTENCE, CLOUD_BACKUP_NOT_SAVED_SENTENCE } from "../../../../account-directory/src/cloud/contract";
import { CloudApiError, type CloudApiClient } from "../../../../desktop/src/shared/cloudApiClient";
import { CLOUD_LANE_BRANCH_METADATA, cloudMachineLaneFactsOf } from "../../../../desktop/src/shared/cloudLaneLaunch";
import { CLOUD_MACHINE_KEY_METADATA } from "../../../../desktop/src/shared/cloudMachineOfInstance";
import { isRestingStatus } from "../../../../account-directory/src/cloud/plans";
import type {
  CloudKeptLaneRestoreArgs,
  CloudKeptLaneRestoreFromComputer,
  CloudKeptLaneRestoreGetArgs,
  CloudKeptLaneRestoreHistory,
  CloudKeptLaneRestorePreview,
  CloudKeptLaneRestorePreviewArgs,
  CloudKeptLaneRestoreRecord,
} from "../../../../desktop/src/shared/cloudKeptLaneRestore";
import { normalizeGitRemoteIdentity } from "../../../../desktop/src/shared/crossMachineHandoff";
import { AdeExpectedError } from "../../../../desktop/src/shared/expectedError";
import { runGitWithGithubAuthFallback } from "../../../../desktop/src/main/services/git/gitTransportAuth";
import { restoreCloudChat, type CloudChatRestoreDeps, type CloudChatRestoreResult } from "./cloudChatRestore";
import { prepareLaneBranchFromBackup, restoreLaneBackupIfNeeded } from "./cloudLaneBackup";

type Logger = {
  info: (event: string, meta?: Record<string, unknown>) => void;
  warn: (event: string, meta?: Record<string, unknown>) => void;
};

const LANE_ID = /^[A-Za-z0-9._:-]{1,160}$/;
const RESTORE_ID = /^[A-Za-z0-9-]{1,80}$/;
const INSTANCE_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** After the release, the kept lane shows within seconds; this long at most. */
const RELEASE_LIST_WAIT_MS = 30_000;
const RELEASE_LIST_POLL_MS = 2_000;
/** The server's codes for a release it refused, with nothing deleted. */
const RELEASE_REFUSED_CODES: ReadonlySet<string> = new Set(["computer_awake", "backup_not_current", "backup_never_saved"]);
/** A branch name git accepts and no git command reads as an option. */
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]{1,250}$/;
const LIST_PAGES = 10;
/** The most chats and CLIs one restore brings back. */
const LANE_ROWS_MAX = 100;
/** Finished records kept for a late status read. */
const RECORDS_KEPT = 50;

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const sameKey = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** One project on this machine: where the lane comes back, and its chats. */
export type KeptLaneRestoreProject = {
  projectRoot: string;
  /** This project's `origin` URL, or null. */
  originUrl: string | null;
  /** Step 1: the lane's branch and saved work here (`restoreKeptLaneBranch`). */
  restoreLane: (args: { api: CloudApiClient; machineKey: string; kept: CloudLaneWithoutComputer; branchRef: string }) => Promise<{
    localLaneId: string;
    /** The lane here has other work than its backup, so the backup stays on the server. */
    keepBackups: boolean;
  }>;
  /** Whether a chat or CLI with this id exists on this machine. */
  hasSession: (sessionId: string) => Promise<boolean>;
  restore: CloudChatRestoreDeps["restore"];
  restoreCli: NonNullable<CloudChatRestoreDeps["restoreCli"]>;
  adopt: CloudChatRestoreDeps["adopt"];
  hold: CloudChatRestoreDeps["hold"];
  release: CloudChatRestoreDeps["release"];
};

export type KeptLaneRestoresDeps = {
  /** The account server as this brain's signed-in account; null signed out. */
  api: () => Promise<CloudApiClient | null>;
  /** This machine's account machine key. */
  machineKey: () => string | null;
  logger: Logger;
  now?: () => Date;
};

export type KeptLaneRestores = {
  preview(project: KeptLaneRestoreProject, args: CloudKeptLaneRestorePreviewArgs): Promise<CloudKeptLaneRestorePreview>;
  /** Returns at once with a running record; a second start for a lane that runs returns that one. */
  start(project: KeptLaneRestoreProject, args: CloudKeptLaneRestoreArgs): Promise<CloudKeptLaneRestoreRecord>;
  get(args: CloudKeptLaneRestoreGetArgs): CloudKeptLaneRestoreRecord | null;
};

/**
 * One of the lane's saved chats or CLIs. `here`: it came back on this machine
 * already. `elsewhere`: its copy is under another machine that is no deleted
 * computer (a move to another of the person's computers that didn't finish):
 * it can't come here, and the forget would delete it, so it keeps the lane.
 */
type LaneRow = {
  chatId: string;
  title: string | null;
  provider: string | null;
  kind: "chat" | "cli";
  fromMachineKey: string;
  here: boolean;
  elsewhere: boolean;
};

/** The lane's saved chats and CLIs to bring back, newest first. */
async function laneRows(
  api: CloudApiClient,
  machineKey: string,
  kept: CloudLaneWithoutComputer,
  hasSession: (sessionId: string) => Promise<boolean>,
): Promise<LaneRow[]> {
  // The kept lane's own computer: gone, or (a preview of a release) asleep and about to go.
  const formerKey = kept.formerMachineKey?.toLowerCase() ?? null;
  const fromSource = (key: string, deleted: boolean) => deleted || key.toLowerCase() === formerKey;
  const chats = new Map<string, CloudChatRow>();
  let cursor: string | null = null;
  for (let page = 0; page < LIST_PAGES; page += 1) {
    const listed = await api.savedChats({ limit: 500, cursor });
    for (const row of listed.chats) {
      if (row.laneId !== kept.laneId) continue;
      const current = chats.get(row.chatId);
      if (!current || row.updatedAt > current.updatedAt) chats.set(row.chatId, row);
    }
    cursor = listed.nextCursor;
    if (!cursor) break;
  }
  // The keys of the lane's deleted computers: a CLI copy has no computer state of its own.
  const goneKeys = new Set<string>();
  if (kept.formerMachineKey) goneKeys.add(kept.formerMachineKey.toLowerCase());
  for (const row of chats.values()) if (row.computer?.state === "deleted") goneKeys.add(row.machineKey.toLowerCase());
  const clis = new Map<string, CloudSessionRow>();
  cursor = null;
  for (let page = 0; page < LIST_PAGES; page += 1) {
    const listed = await api.savedSessions({ cursor });
    if (!listed) break;
    for (const row of listed.sessions) {
      if (row.laneId !== kept.laneId || row.kind !== "cli" || chats.has(row.sessionId)) continue;
      const current = clis.get(row.sessionId);
      if (!current || row.updatedAt > current.updatedAt) clis.set(row.sessionId, row);
    }
    cursor = listed.nextCursor;
    if (!cursor) break;
  }
  const rows: Array<LaneRow & { updatedAt: number }> = [];
  // Under this machine's key: moved here by an earlier run; it is here once its session is.
  // On a deleted computer: it comes back. Anywhere else: it stays there and keeps the lane.
  for (const row of chats.values()) {
    const own = sameKey(row.machineKey, machineKey);
    rows.push({
      chatId: row.chatId, title: row.title ?? null, provider: row.provider ?? null, kind: "chat",
      fromMachineKey: row.machineKey, here: own && await hasSession(row.chatId),
      elsewhere: !own && !fromSource(row.machineKey, row.computer?.state === "deleted"), updatedAt: row.updatedAt,
    });
  }
  for (const row of clis.values()) {
    const own = sameKey(row.machineKey, machineKey);
    rows.push({
      chatId: row.sessionId, title: row.title ?? null, provider: row.toolType ?? null, kind: "cli",
      fromMachineKey: row.machineKey, here: own && await hasSession(row.sessionId),
      elsewhere: !own && !goneKeys.has(row.machineKey.toLowerCase()), updatedAt: row.updatedAt,
    });
  }
  return rows.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, LANE_ROWS_MAX).map(({ updatedAt: _updatedAt, ...row }) => row);
}

const historyOf = (restoredWith: CloudChatRestoreResult["restoredWith"]): CloudKeptLaneRestoreHistory | null =>
  restoredWith === "capsule" ? "full" : restoredWith === "replay" ? "transcript" : restoredWith === "fresh" ? "fresh" : null;

function sameRepository(kept: CloudLaneWithoutComputer, originUrl: string | null): boolean {
  const theirs = normalizeGitRemoteIdentity(kept.projectOrigin);
  return theirs != null && theirs === normalizeGitRemoteIdentity(originUrl);
}

function fromComputerOf(args: unknown): CloudKeptLaneRestoreFromComputer | null {
  const raw = (args as { fromComputer?: unknown } | null)?.fromComputer;
  if (raw == null) return null;
  const instanceId = typeof (raw as { instanceId?: unknown }).instanceId === "string" ? (raw as { instanceId: string }).instanceId.trim() : "";
  if (!INSTANCE_ID.test(instanceId)) throw new AdeExpectedError("ADE doesn't know that ADE Cloud computer.", "user");
  return { instanceId };
}

/** A lane whose ADE Cloud computer is asleep, as the kept lane its release makes, and whether its saved copy is complete. */
type AsleepSource = {
  kept: CloudLaneWithoutComputer;
  saved: boolean;
  /** Why the saved copy can't be used, when `saved` is false. */
  reason: string | null;
  ignored: CloudIgnoredFiles | null;
};

async function asleepSource(api: CloudApiClient, laneId: string, from: CloudKeptLaneRestoreFromComputer): Promise<AsleepSource> {
  let instance: CloudInstance;
  try {
    instance = await api.computer(from.instanceId);
  } catch (error) {
    if (error instanceof CloudApiError && error.status === 404) {
      throw new AdeExpectedError("This lane's ADE Cloud computer is gone already. Open the lane again to move it from its saved copy.", "user");
    }
    throw error;
  }
  const lane = cloudMachineLaneFactsOf(instance.metadata);
  if (!lane || lane.laneId !== laneId) throw new AdeExpectedError("That ADE Cloud computer doesn't hold this lane.", "user");
  const resting = isRestingStatus(instance.status);
  const saved = resting && instance.backups?.saved === true;
  const reason = saved
    ? null
    : !resting
      ? "This lane's ADE Cloud computer is awake, so ADE moves the lane from the computer itself."
      : instance.backups?.problems?.[0]?.reason
        ?? (instance.backups ? CLOUD_BACKUP_NOT_SAVED_SENTENCE : CLOUD_BACKUP_NEVER_SAVED_SENTENCE);
  return {
    kept: {
      laneId,
      laneName: lane.laneName,
      projectOrigin: lane.projectOrigin,
      branchRef: instance.metadata[CLOUD_LANE_BRANCH_METADATA]?.trim() || null,
      reason: "freed",
      type: instance.type === "vm" ? "vm" : "default",
      cpu: instance.resources?.cpu ?? 0,
      memoryGb: instance.resources?.memory ?? 0,
      formerInstanceId: instance.id,
      formerMachineKey: instance.metadata[CLOUD_MACHINE_KEY_METADATA]?.trim() || null,
      since: Date.now(),
    },
    saved,
    reason,
    ignored: instance.ignoredFiles ?? null,
  };
}

/** A release the server refused, with nothing deleted: the person wakes the computer and moves the lane live. */
class ReleaseRefusedError extends Error {}

function laneIdOf(args: unknown): string {
  const laneId = typeof (args as { laneId?: unknown } | null)?.laneId === "string" ? (args as { laneId: string }).laneId.trim() : "";
  if (!LANE_ID.test(laneId)) throw new AdeExpectedError("ADE doesn't know that lane.", "user");
  return laneId;
}

export function createKeptLaneRestores(deps: KeptLaneRestoresDeps): KeptLaneRestores {
  const { logger } = deps;
  const now = () => (deps.now ? deps.now() : new Date()).toISOString();
  const records = new Map<string, CloudKeptLaneRestoreRecord>();
  const runningByLane = new Map<string, string>();
  const starting = new Map<string, Promise<CloudKeptLaneRestoreRecord>>();
  const copy = (record: CloudKeptLaneRestoreRecord): CloudKeptLaneRestoreRecord => ({ ...record, chats: record.chats.map((chat) => ({ ...chat })) });

  const ready = async (): Promise<{ api: CloudApiClient; machineKey: string }> => {
    const api = await deps.api();
    if (!api) throw new AdeExpectedError("Sign in to your ADE account on this computer to move a lane here.", "user");
    const machineKey = deps.machineKey();
    if (!machineKey) throw new AdeExpectedError("This computer isn't set up with your ADE account yet. Open ADE on it once, then try again.", "user");
    return { api, machineKey };
  };
  const keptLane = async (api: CloudApiClient, laneId: string): Promise<CloudLaneWithoutComputer> => {
    const kept = (await api.lanesWithoutComputer()).find((lane) => lane.laneId === laneId);
    if (!kept) throw new AdeExpectedError("ADE Cloud has no kept lane like that any more. It may have moved already.", "user");
    return kept;
  };

  const forget = () => {
    if (records.size <= RECORDS_KEPT) return;
    for (const [restoreId, record] of records) {
      if (records.size <= RECORDS_KEPT) break;
      if (record.state !== "running") records.delete(restoreId);
    }
  };

  /**
   * Step 0: deletes the asleep computer and keeps its lane, only while it
   * rests with every lane's work saved. Returns the kept lane.
   */
  const release = async (api: CloudApiClient, instanceId: string, source: CloudLaneWithoutComputer): Promise<CloudLaneWithoutComputer> => {
    try {
      await api.deleteComputer(instanceId, { reason: "moved", keepLane: { branchRef: source.branchRef, onlyIfSaved: true } });
    } catch (error) {
      if (error instanceof CloudApiError && error.status === 409 && RELEASE_REFUSED_CODES.has(error.code)) {
        throw new ReleaseRefusedError(error.message);
      }
      // Gone already (an earlier run's release): its kept lane is read below.
      if (!(error instanceof CloudApiError && error.status === 404)) throw error;
    }
    const deadline = Date.now() + RELEASE_LIST_WAIT_MS;
    for (;;) {
      const kept = (await api.lanesWithoutComputer()).find((lane) => lane.laneId === source.laneId);
      if (kept) return kept;
      if (Date.now() >= deadline) {
        throw new Error("ADE Cloud deleted the computer but doesn't list the lane yet. Open the lane again to move it from its saved copy.");
      }
      await new Promise((resolve) => setTimeout(resolve, RELEASE_LIST_POLL_MS));
    }
  };

  const run = async (
    record: CloudKeptLaneRestoreRecord,
    project: KeptLaneRestoreProject,
    api: CloudApiClient,
    machineKey: string,
    source: CloudLaneWithoutComputer,
    releaseFrom: string | null,
  ): Promise<void> => {
    const touch = () => {
      record.updatedAt = now();
    };
    let kept = source;
    try {
      // 0. The asleep computer goes, its lane kept: everything below reads the saved copy.
      if (releaseFrom) {
        kept = await release(api, releaseFrom, source);
        record.step = "lane";
        touch();
        logger.info("cloud.kept_lane_released", { restoreId: record.restoreId });
      }
      // 1. The lane: nothing below runs until its branch and saved work are here.
      const lane = await project.restoreLane({ api, machineKey, kept, branchRef: kept.branchRef! });
      record.localLaneId = lane.localLaneId;
      record.step = "chats";
      touch();
      // 2. Each chat. One that fails doesn't stop the others; any failure keeps the kept lane.
      const rows = await laneRows(api, machineKey, kept, project.hasSession);
      record.chats = rows.map((row) => ({ chatId: row.chatId, title: row.title, state: row.here ? "restored" : "pending", history: null, error: null }));
      touch();
      for (const [index, row] of rows.entries()) {
        if (row.here) continue;
        const entry = record.chats[index]!;
        if (row.elsewhere) {
          entry.state = "failed";
          entry.error = "This chat is on another computer of yours now. Finish its move there, then try again.";
          continue;
        }
        try {
          const result = await restoreCloudChat({
            api,
            instanceId: null,
            machineKey,
            logger,
            restore: project.restore,
            restoreCli: project.restoreCli,
            adopt: project.adopt,
            hold: project.hold,
            release: project.release,
          }, {
            fromMachineKey: row.fromMachineKey,
            chatId: row.chatId,
            laneId: lane.localLaneId,
            modelId: null,
            // No message: the chat or CLI comes back and waits for the person.
            prompt: "",
            clientMessageId: `kept-lane-${row.chatId}`.slice(0, 128),
            kind: row.kind,
          });
          // A CLI's copy moves after it runs here; one still on the deleted computer would go with the forget.
          if (row.kind === "cli" && !sameKey(row.fromMachineKey, machineKey) && !result.moved) {
            throw new Error("ADE couldn't move this CLI's saved copy to this computer. Try again.");
          }
          entry.state = "restored";
          entry.history = historyOf(result.restoredWith);
        } catch (error) {
          entry.state = "failed";
          entry.error = errorText(error);
          logger.warn("cloud.kept_lane_chat_restore_failed", { restoreId: record.restoreId, kind: row.kind, error: errorText(error) });
        }
        touch();
      }
      const failed = record.chats.filter((chat) => chat.state === "failed").length;
      if (failed > 0) {
        record.state = "failed";
        record.error = failed === 1
          ? "One chat didn't come back. The lane stays on ADE Cloud too: try again to go on."
          : `${failed} chats didn't come back. The lane stays on ADE Cloud too: try again to go on.`;
        return;
      }
      // 3. Everything is here: the kept lane goes, and what moved to this key stays.
      record.step = "cleanup";
      touch();
      try {
        await api.forgetMovedLaneWithoutComputer(kept.laneId, { toMachineKey: machineKey, keepBackups: lane.keepBackups });
      } catch (error) {
        if (error instanceof CloudApiError && error.status === 404) {
          throw new Error("ADE Cloud can't finish this move yet: the lane came back here, and it still shows on ADE Cloud. Try again later.");
        }
        throw error;
      }
      record.step = "done";
      record.state = "completed";
      logger.info("cloud.kept_lane_restored", { restoreId: record.restoreId, chats: record.chats.length, keptBackups: lane.keepBackups });
    } catch (error) {
      record.state = "failed";
      record.error = errorText(error);
      if (error instanceof ReleaseRefusedError) {
        record.wakeInstead = true;
        logger.info("cloud.kept_lane_release_refused", { restoreId: record.restoreId });
      } else {
        logger.warn("cloud.kept_lane_restore_failed", { restoreId: record.restoreId, step: record.step, error: errorText(error) });
      }
    } finally {
      touch();
    }
  };

  return {
    async preview(project, args) {
      const laneId = laneIdOf(args);
      const from = fromComputerOf(args);
      const { api, machineKey } = await ready();
      const asleep = from ? await asleepSource(api, laneId, from) : null;
      const kept = asleep?.kept ?? await keptLane(api, laneId);
      const backup = (await api.laneBackups(laneId))
        .filter((entry) => entry.laneId === laneId && !sameKey(entry.machineKey, machineKey))
        .sort((a, b) => b.savedAt - a.savedAt)[0];
      // What comes back: a chat on another computer of the person's stays there (the start then keeps the lane).
      const rows = (await laneRows(api, machineKey, kept, project.hasSession)).filter((row) => !row.here && !row.elsewhere);
      const chats: CloudKeptLaneRestorePreview["chats"] = [];
      for (const row of rows) {
        const manifest = await api.capsuleManifest(row.fromMachineKey, row.chatId).catch(() => null);
        const full = manifest?.sessionKind === row.kind;
        chats.push({
          chatId: row.chatId,
          title: row.title,
          provider: row.provider,
          kind: row.kind,
          history: full ? "full" : row.kind === "chat" ? "transcript" : "fresh",
        });
      }
      return {
        laneId,
        laneName: kept.laneName,
        branchRef: kept.branchRef,
        hasRepository: sameRepository(kept, project.originUrl),
        work: backup ? { unpushedCommits: backup.commits, changedFiles: backup.files, bytes: backup.bundleBytes } : null,
        chats,
        ...(asleep ? { fromComputer: { saved: asleep.saved, reason: asleep.reason, ignored: asleep.ignored } } : {}),
      };
    },

    async start(project, args) {
      const laneId = laneIdOf(args);
      const running = runningByLane.get(laneId);
      const current = running ? records.get(running) : undefined;
      if (current?.state === "running") return copy(current);
      // Two starts at once for one lane are one restore.
      const pending = starting.get(laneId);
      if (pending) return copy(await pending);
      const from = fromComputerOf(args);
      const begin = (async (): Promise<CloudKeptLaneRestoreRecord> => {
        const { api, machineKey } = await ready();
        // An earlier run may have released the computer already: its kept lane goes on.
        const already = from ? (await api.lanesWithoutComputer()).find((lane) => lane.laneId === laneId) ?? null : null;
        const asleep = from && !already ? await asleepSource(api, laneId, from) : null;
        if (asleep && !asleep.saved) throw new AdeExpectedError(asleep.reason ?? CLOUD_BACKUP_NOT_SAVED_SENTENCE, "user");
        const kept = asleep?.kept ?? already ?? await keptLane(api, laneId);
        if (!sameRepository(kept, project.originUrl)) {
          throw new AdeExpectedError("This project isn't the lane's repository. Open a clone of it on this computer, then move the lane there.", "user");
        }
        if (!kept.branchRef || !BRANCH.test(kept.branchRef.replace(/^refs\/heads\//, "").replace(/^origin\//, ""))) {
          throw new AdeExpectedError("ADE Cloud doesn't know this lane's branch, so ADE can't bring it here.", "user");
        }
        const at = now();
        const record: CloudKeptLaneRestoreRecord = {
          restoreId: randomUUID(),
          laneId,
          laneName: kept.laneName,
          state: "running",
          localLaneId: null,
          step: asleep ? "release" : "lane",
          chats: [],
          error: null,
          startedAt: at,
          updatedAt: at,
        };
        records.set(record.restoreId, record);
        forget();
        runningByLane.set(laneId, record.restoreId);
        void run(record, project, api, machineKey, kept, asleep ? from!.instanceId : null).finally(() => {
          if (runningByLane.get(laneId) === record.restoreId) runningByLane.delete(laneId);
        });
        return record;
      })();
      starting.set(laneId, begin);
      try {
        return copy(await begin);
      } finally {
        starting.delete(laneId);
      }
    },

    get(args) {
      const restoreId = typeof args?.restoreId === "string" ? args.restoreId.trim() : "";
      if (!RESTORE_ID.test(restoreId)) return null;
      const record = records.get(restoreId);
      return record ? copy(record) : null;
    },
  };
}

/** What `restoreKeptLaneBranch` needs of the project's lanes (`laneService`). */
export type KeptLaneLanes = {
  list: () => Promise<Array<{ id: string; branchRef: string; worktreePath: string; archived: boolean; primary: boolean }>>;
  importBranch: (args: { branchRef: string; name: string; publishUpstream: false }, options: { laneId?: string }) => Promise<{ id: string; worktreePath: string }>;
};

/**
 * Step 1 on this machine: the kept lane's branch as a lane here, then its
 * saved work. A lane here on the branch already (an earlier run, or the
 * person's own) is used as it is. Otherwise the branch comes from GitHub,
 * else from the lane's backup (`prepareLaneBranchFromBackup`), and is
 * imported unpublished under the kept lane's id when that id is free here.
 */
export async function restoreKeptLaneBranch(args: {
  api: CloudApiClient;
  machineKey: string;
  kept: CloudLaneWithoutComputer;
  branchRef: string;
  projectRoot: string;
  lanes: KeptLaneLanes;
  logger: Logger;
}): Promise<{ localLaneId: string; keepBackups: boolean }> {
  const { api, kept, projectRoot, logger } = args;
  const branch = args.branchRef.replace(/^refs\/heads\//, "").replace(/^origin\//, "");
  if (!BRANCH.test(branch)) throw new AdeExpectedError("ADE Cloud doesn't know this lane's branch, so ADE can't bring it here.", "user");
  const lanes = await args.lanes.list();
  const live = lanes.filter((lane) => !lane.archived && !lane.primary);
  let lane: { id: string; worktreePath: string } | null = live.find((entry) => entry.id === kept.laneId && entry.branchRef === branch)
    ?? live.find((entry) => entry.branchRef === branch)
    ?? null;
  if (!lane) {
    // The branch as GitHub has it now; a branch never pushed is not there, and the backup makes it below.
    const fetched = await runGitWithGithubAuthFallback(
      ["fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
      { cwd: projectRoot, timeoutMs: 120_000, env: { GIT_TERMINAL_PROMPT: "0" } },
    );
    if (fetched.exitCode !== 0) logger.info("cloud.kept_lane_branch_not_on_origin", { laneId: kept.laneId });
    const made = await prepareLaneBranchFromBackup({ api, machineKey: args.machineKey, laneId: kept.laneId, branchRef: branch, projectRoot, logger });
    const idFree = !lanes.some((entry) => entry.id === kept.laneId);
    // Never published: ADE pushes nothing on its own, and a branch made here from the backup was never on GitHub.
    lane = await args.lanes.importBranch(
      { branchRef: made.created && made.branch ? made.branch : branch, name: kept.laneName, publishUpstream: false },
      idFree ? { laneId: kept.laneId } : {},
    );
  }
  // The backups are filed under the kept lane's id, whatever this lane's id is.
  const outcome = await restoreLaneBackupIfNeeded({
    api,
    instanceId: null,
    machineKey: args.machineKey,
    laneId: kept.laneId,
    worktreePath: lane.worktreePath,
    projectRoot,
    logger,
  });
  if (outcome === "failed") throw new Error("ADE couldn't read the lane's branch on this computer.");
  return { localLaneId: lane.id, keepBackups: outcome === "kept_newer_local_work" || outcome === "kept_branch_differs" };
}

let installed: KeptLaneRestores | null = null;

/** The brain installs the store once, on a machine that is not an ADE Cloud computer (`cli.ts`). */
export function setKeptLaneRestores(store: KeptLaneRestores | null): void {
  installed = store;
}

/** This machine's store, or null where none was installed (an ADE Cloud computer, the CLI's in-process runtime). */
export function keptLaneRestores(): KeptLaneRestores | null {
  return installed;
}
