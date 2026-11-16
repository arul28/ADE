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
   * The setup filled the disk and the host made room (an ADE Cloud computer
   * grows its disk, which restarts it): resume this launch's setup after a
   * restart. Written when the grow is asked for, kept while setup runs again
   * (a grow may restart the computer more than once), and cleared once the
   * environment stage settles, on Cancel and on Retry. `at` is when this
   * grow's mark was written; `resumes` counts the restarts it resumed after.
   */
  roomMark?: ChatLaunchRoomMark | null;
  /** Written by beta.34 (one resume, then cleared): read once as a mark of its own. */
  awaitingRoom?: boolean;
};

/**
 * `kind`: what the host is making room in. Absent is the disk (a grow);
 * `memory` is an ADE Cloud computer moving up a size for its setup
 * (`cloudSetupUpsize.ts`). Either restarts the computer.
 */
export type ChatLaunchRoomMark = { at: string; resumes: number; kind?: "memory" };

/** A launch waiting for room is resumed after this many restarts at most; the next one reads as interrupted. */
export const CHAT_LAUNCH_ROOM_MAX_RESUMES = 3;
/** Nor once its mark is this old: a computer asleep for days doesn't rerun a stale setup when it wakes. */
export const CHAT_LAUNCH_ROOM_MAX_AGE_MS = 60 * 60_000;

/**
 * The record's mark; null when none. An older ADE's `awaitingRoom` reads as a mark
 * dated at the record's last update (not now), so a beta.34 record whose brain
 * never booted again after the grow is held to the same age cap.
 */
function roomMarkOf(record: ChatLaunchRecord): ChatLaunchRoomMark | null {
  const mark = record.roomMark;
  if (mark && typeof mark.at === "string" && typeof mark.resumes === "number") {
    return { at: mark.at, resumes: mark.resumes, ...(mark.kind === "memory" ? { kind: "memory" as const } : {}) };
  }
  if (record.awaitingRoom === true) return { at: record.snapshot.updatedAt, resumes: 0 };
  return null;
}

/**
 * Whether a reloaded record goes on after a restart: `resume` while its setup
 * waits for room within the bound, `cap` or `age` when the bound turns it
 * into an interrupted launch, null when it has no mark (or isn't running).
 */
export function chatLaunchRoomVerdict(record: ChatLaunchRecord, nowMs: number): { kind: "resume" | "cap" | "age"; mark: ChatLaunchRoomMark; ageMs: number } | null {
  if (record?.snapshot?.phase !== "running") return null;
  const mark = roomMarkOf(record);
  if (!mark) return null;
  const at = Date.parse(mark.at);
  const ageMs = Number.isFinite(at) ? nowMs - at : Number.POSITIVE_INFINITY;
  if (!(ageMs >= 0 && ageMs < CHAT_LAUNCH_ROOM_MAX_AGE_MS)) return { kind: "age", mark, ageMs };
  if (mark.resumes >= CHAT_LAUNCH_ROOM_MAX_RESUMES) return { kind: "cap", mark, ageMs };
  return { kind: "resume", mark, ageMs };
}

function roomRefused(kind: "cap" | "age", mark: ChatLaunchRoomMark): { stage: string; launch: string } {
  const after = mark.kind === "memory" ? "after ADE moved the computer to a bigger size" : "after the disk grew";
  return kind === "cap"
    ? {
      stage: `Interrupted: ADE restarted ${CHAT_LAUNCH_ROOM_MAX_RESUMES + 1} times while setup ran again ${after}.`,
      launch: `Setup kept being interrupted by restarts ${after}. Retry to set up again.`,
    }
    : {
      stage: `Interrupted: setup was waiting to run again ${after}, and the computer was off too long.`,
      launch: `Setup was waiting to run again ${after}, but too much time went by. Retry to set up again.`,
    };
}

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
  const room = chatLaunchRoomVerdict(record, Date.parse(nowIso));
  record.roomMark = room?.kind === "resume" ? room.mark : null;
  delete record.awaitingRoom;
  if (room?.kind !== "resume" && (snapshot.phase === "running" || snapshot.phase === "awaiting-client")) {
    // The process that ran it is gone. Say so instead of spinning forever.
    const refused = room ? roomRefused(room.kind, room.mark) : null;
    const running = snapshot.stages.find((stage) => stage.status === "running");
    if (running) {
      running.status = "failed";
      running.endedAt = nowIso;
      running.error = refused?.stage ?? "Interrupted when ADE restarted.";
    }
    snapshot.phase = "failed";
    snapshot.error = refused?.launch ?? "Setup was interrupted when ADE restarted.";
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
 * filled it, and the host grew it: `roomMark`). A brain opens such a
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
      const record = JSON.parse(fs.readFileSync(path.join(launchesDir, entry), "utf8")) as ChatLaunchRecord;
      // Past its bound too: opening the project is what reads it as interrupted.
      if (chatLaunchRoomVerdict(record, Date.now())) return true;
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
        const raw = JSON.parse(fs.readFileSync(file, "utf8")) as ChatLaunchRecord;
        const room = chatLaunchRoomVerdict(raw, Date.parse(nowIso));
        if (room && room.kind !== "resume") {
          logger.warn("chat_launch.environment_resume_refused", {
            launchId: raw.snapshot.launchId,
            reason: room.kind,
            resumes: room.mark.resumes,
            ageMs: Number.isFinite(room.ageMs) ? Math.round(room.ageMs) : null,
          });
        }
        const record = reviveChatLaunchRecord(raw, nowIso);
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
