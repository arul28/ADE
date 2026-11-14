import fs from "node:fs";
import path from "node:path";
import type { ChatLaunchChatArgs, ChatLaunchLaneConfig, ChatLaunchSnapshot } from "../../../shared/types";
import { normalizeLaneStart, type LaneStart } from "../../../shared/laneStart";
import { isChatLaunchTerminal } from "../../../shared/chatLaunch";
import { normalizeChatLaunchLaneMode } from "./chatLaunchArgs";
import type { Logger } from "../logging/logger";
import { getErrorMessage } from "../shared/utils";

/**
 * On-disk records for the chat-launch service (`.ade/cache/chat-launches/`),
 * so a restart mid-launch surfaces an honest "interrupted" failure with Retry
 * instead of a spinner that never ends.
 */

export type ChatLaunchRecord = {
  snapshot: ChatLaunchSnapshot;
  chat: ChatLaunchChatArgs | null;
  /**
   * Where the new lane starts, fixed when the launch began (the config's own
   * start, else the project's default then). Null for an existing branch.
   */
  start: LaneStart | null;
  /** Explicit lane recipe (start/existing branch/template/color), or null for the project's defaults. */
  laneConfig: ChatLaunchLaneConfig | null;
  provider: string | null;
  templateId: string | null;
  messageSent: boolean;
  startNowRequested: boolean;
  /** A checkout already ran once, so a retry must first clear its leftovers. */
  checkoutAttempted: boolean;
  /**
   * The setup filled the disk and the host is making room (an ADE Cloud
   * computer grows its disk, which restarts it). Revived still running, and
   * its setup runs again (`makeRoomForEnvironment` in chatLaunchService.ts).
   */
  awaitingRoom?: boolean;
};

/**
 * Progress publishes skip the disk write, so the persisted `sequence` can trail
 * what clients already hold by however many progress ticks ran. A reloaded
 * record jumps this far ahead so its "interrupted" snapshot is not dropped by
 * the clients' merge-by-sequence.
 */
const RELOAD_SEQUENCE_JUMP = 1_000_000;

/**
 * Bring a persisted record back after a restart, or return null to drop it.
 * Finished launches are dropped unless they still owe the chat a queued
 * message; one that was mid-flight is marked failed ("interrupted"), except
 * one waiting for room on the disk, which goes on.
 */
function reviveChatLaunchRecord(record: ChatLaunchRecord, nowIso: string): ChatLaunchRecord | null {
  const snapshot = record?.snapshot;
  if (!snapshot || typeof snapshot.launchId !== "string") return null;
  const owesMessages = snapshot.phase === "completed" && (snapshot.queuedMessages?.length ?? 0) > 0;
  if (isChatLaunchTerminal(snapshot.phase) && !owesMessages) return null;
  const awaitingRoom = record.awaitingRoom === true && snapshot.phase === "running";
  record.awaitingRoom = awaitingRoom;
  if (!awaitingRoom && (snapshot.phase === "running" || snapshot.phase === "awaiting-client")) {
    // The process that ran it is gone. Say so instead of spinning forever.
    const running = snapshot.stages.find((stage) => stage.status === "running");
    if (running) {
      running.status = "failed";
      running.endedAt = nowIso;
      running.error = "Interrupted when ADE restarted.";
    }
    snapshot.phase = "failed";
    snapshot.error = "Setup was interrupted when ADE restarted.";
    snapshot.updatedAt = nowIso;
  }
  snapshot.sequence += RELOAD_SEQUENCE_JUMP;
  record.checkoutAttempted = record.checkoutAttempted === true;
  // Records written by an earlier ADE named the modes root/import and carried
  // no start. An adopted branch must stay "existing": its cleanup keeps the
  // user's branch.
  if (record.laneConfig) {
    record.laneConfig = { ...record.laneConfig, mode: normalizeChatLaunchLaneMode(record.laneConfig.mode) ?? "new" };
  }
  record.start = record.laneConfig?.mode === "existing" ? null : normalizeLaneStart(record.start);
  return record;
}

/**
 * Whether a launch in `launchesDir` waits for room on the disk (its setup
 * filled it, and the host grew it: `awaitingRoom`). A brain opens such a
 * project at start, so the launch goes on after the restart with nobody
 * watching. A read of a few small files, once per brain start.
 */
export function hasChatLaunchAwaitingRoom(launchesDir: string): boolean {
  let entries: string[];
  try {
    entries = fs.readdirSync(launchesDir);
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const record = JSON.parse(fs.readFileSync(path.join(launchesDir, entry), "utf8")) as Partial<ChatLaunchRecord>;
      if (record.awaitingRoom === true && record.snapshot?.phase === "running") return true;
    } catch {
      // Unreadable: the service's own load says so.
    }
  }
  return false;
}

export function createChatLaunchRecordStore(args: { launchesDir: string; logger: Logger }) {
  const { launchesDir, logger } = args;
  const recordPath = (launchId: string) => path.join(launchesDir, `${launchId}.json`);

  /** Writes the record (whole, by rename); false when it couldn't (a full disk), and the old copy stays. */
  const persist = (record: ChatLaunchRecord): boolean => {
    const target = recordPath(record.snapshot.launchId);
    const tmp = `${target}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(launchesDir, { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(record));
      fs.renameSync(tmp, target);
      return true;
    } catch (error) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
      logger.warn("chat_launch.persist_failed", { launchId: record.snapshot.launchId, error: getErrorMessage(error) });
      return false;
    }
  };

  const unpersist = (launchId: string): void => {
    try {
      fs.rmSync(recordPath(launchId), { force: true });
    } catch {
      // best effort
    }
  };

  /** Every record worth keeping, revived (and re-persisted); the rest are deleted. */
  const loadAll = (nowIso: string): ChatLaunchRecord[] => {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(launchesDir);
    } catch {
      return [];
    }
    const loaded: ChatLaunchRecord[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const file = path.join(launchesDir, entry);
      try {
        const record = reviveChatLaunchRecord(JSON.parse(fs.readFileSync(file, "utf8")) as ChatLaunchRecord, nowIso);
        if (!record) {
          fs.rmSync(file, { force: true });
          continue;
        }
        persist(record);
        loaded.push(record);
      } catch (error) {
        logger.warn("chat_launch.load_failed", { file, error: getErrorMessage(error) });
      }
    }
    return loaded;
  };

  return { persist, unpersist, loadAll };
}
