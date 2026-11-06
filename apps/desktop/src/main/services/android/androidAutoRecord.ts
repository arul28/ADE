import type {
  AndroidAutoRecordState,
  AndroidInputRecordArgs,
  AndroidMachinePreferences,
} from "../../../shared/types/androidEmulator";
import { demoTypingPlan } from "../demoVideo/demoPacing";
import type { Logger } from "../logging/logger";
import { getErrorMessage, sleep } from "../shared/utils";
import type { AndroidRecordingInput, createAndroidRecordingSessions } from "./androidRecordingSession";

/*
 * Auto-record for the lane's emulator, Apple's contract
 * (`ios/recording/simRecordingService.ts`):
 *
 * - An AGENT's input starts an automatic recording when none runs. A
 *   person's input (the pane, the phone, a web viewer: `source: "user"`)
 *   never starts one; it is still drawn on a recording that runs.
 * - Opt-outs: `--no-record` on the call (`noRecord`), `ade android
 *   auto-record off` on the lane (the project's KV,
 *   `android.autoRecord.lane.<lane>`), and the machine preference "Record
 *   agent input" (`autoRecordAgentInput`).
 * - It stops when that agent's turn ends (`notifyAndroidRecordingTurnEnded`,
 *   called where every chat turn settles), or after two minutes with
 *   nothing happening.
 * - The start runs before the input, so the first tap is in the video, but
 *   it waits at most {@link AUTO_START_WAIT_MS}: an input never waits long
 *   on a recording, and never fails because of one.
 *
 * Node built-ins and relative imports only, so it runs under `tsx`.
 */

/** The longest an agent's input waits for its automatic recording to start. */
const AUTO_START_WAIT_MS = 5_000;
/** Typed text is paced only up to this length; longer text goes in at once. */
const PACED_TEXT_MAX_CHARS = 200;

type Sessions = ReturnType<typeof createAndroidRecordingSessions>;

export type AndroidAutoRecordDeps = {
  sessions: Sessions;
  readPreferences: () => AndroidMachinePreferences;
  /** The project's KV (`db.getJson`); absent = the lane switch is always on. */
  readSetting?: (<T>(key: string) => T | null) | null;
  writeSetting?: ((key: string, value: unknown) => void) | null;
  logger: Logger | null;
};

export function androidAutoRecordKey(laneId: string): string {
  return `android.autoRecord.lane.${laneId}`;
}

/**
 * The services the chat turn lifecycle talks to: one per open project. A
 * chat session belongs to at most one of them, and each ignores a session it
 * has no recording for, so all are told.
 */
const turnEndTargets = new Set<(chatSessionId: string) => Promise<void>>();

/**
 * Tell Android recording that a chat turn finished. Fire-and-forget and
 * never throws: a turn settles whether or not a video got filed.
 */
export function notifyAndroidRecordingTurnEnded(chatSessionId: string | null | undefined): void {
  if (!chatSessionId) return;
  for (const target of turnEndTargets) {
    try {
      void target(chatSessionId).catch(() => undefined);
    } catch {
      // A synchronous throw must not reach the turn-settle path.
    }
  }
}

export function createAndroidAutoRecord(deps: AndroidAutoRecordDeps) {
  const { sessions, logger } = deps;

  const laneSwitch = (laneId: string): boolean => {
    if (!deps.readSetting) return true;
    try {
      return deps.readSetting<{ enabled?: unknown }>(androidAutoRecordKey(laneId))?.enabled !== false;
    } catch (error) {
      // Unreadable reads as on, the default.
      logger?.warn("android.auto_record_read_failed", { laneId, error: getErrorMessage(error) });
      return true;
    }
  };

  const machineSwitch = (): boolean => {
    try {
      return deps.readPreferences().autoRecordAgentInput !== false;
    } catch (error) {
      logger?.warn("android.auto_record_read_failed", { setting: "machine", error: getErrorMessage(error) });
      return true;
    }
  };

  const state = (laneId: string): AndroidAutoRecordState => {
    const lane = laneSwitch(laneId);
    const machine = machineSwitch();
    return { laneId, lane, machine, enabled: lane && machine };
  };

  const onTurnEnded = (chatSessionId: string) => sessions.onTurnEnded(chatSessionId);
  turnEndTargets.add(onTurnEnded);

  return {
    getAutoRecord(laneId: string): AndroidAutoRecordState {
      return state(laneId);
    },

    setAutoRecord(laneId: string, enabled: boolean): AndroidAutoRecordState {
      if (!deps.writeSetting) throw new Error("This runtime has no project database, so it cannot keep a lane setting.");
      deps.writeSetting(androidAutoRecordKey(laneId), { enabled, at: new Date().toISOString() });
      logger?.info("android.auto_record_set", { laneId, enabled });
      return state(laneId);
    },

    /**
     * Before an input: start an automatic recording when this input may.
     * Waits at most a few seconds; never throws.
     */
    async beforeInput(laneId: string, args: AndroidInputRecordArgs | null | undefined): Promise<void> {
      if (args?.source === "user" || args?.noRecord === true) return;
      if (sessions.isRecording(laneId)) return;
      if (!laneSwitch(laneId) || !machineSwitch()) return;
      let timer: ReturnType<typeof setTimeout> | null = null;
      await Promise.race([
        sessions.startAuto(laneId, args?.chatSessionId?.trim() || null),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, AUTO_START_WAIT_MS);
          (timer as { unref?: () => void }).unref?.();
        }),
      ]);
      if (timer) clearTimeout(timer);
    },

    /** After an input: draw it on the running recording. Fire-and-forget. */
    note(input: Omit<AndroidRecordingInput, "by"> & { source?: AndroidInputRecordArgs["source"] }): void {
      if (!sessions.isRecording(input.laneId)) return;
      const { source, ...rest } = input;
      void sessions.noteInput({ ...rest, by: source === "user" ? "user" : "agent" });
    },

    /**
     * Types `text`, a few characters at a time while the lane records, so a
     * video shows it typed rather than pasted. Answers when it began and
     * how long it ran, for the demo track.
     */
    async typePaced(laneId: string, text: string, send: (piece: string) => Promise<void>): Promise<{ atMs: number; seconds: number }> {
      const atMs = Date.now();
      if (!sessions.isDemoRecording(laneId) || Array.from(text).length > PACED_TEXT_MAX_CHARS) {
        await send(text);
        return { atMs, seconds: 0 };
      }
      const plan = demoTypingPlan(text);
      for (const [index, piece] of plan.pieces.entries()) {
        if (index > 0) await sleep(plan.stepMs);
        await send(piece);
      }
      return { atMs, seconds: (Date.now() - atMs) / 1000 };
    },

    dispose(): void {
      turnEndTargets.delete(onTurnEnded);
    },
  };
}

export type AndroidAutoRecord = ReturnType<typeof createAndroidAutoRecord>;
