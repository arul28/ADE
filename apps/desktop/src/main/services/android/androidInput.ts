import { isAndroidHardwareKey, type AndroidEmulatorServiceApi, type AndroidTouchEvent } from "../../../shared/types/androidEmulator";
import { sleep } from "../shared/utils";
import { runAdb } from "./adb";
import { runAdbOutput } from "./androidDeviceShell";
import { AndroidEmulatorFailure, requireLaneId } from "./androidEmulatorErrors";
import { asStreamFailure, type AndroidStreamHub } from "./androidStream";
import { ANDROID_HARDWARE_KEYCODES } from "./scrcpyControl";

/*
 * Input to the lane's emulator: touch, tap, swipe, keys, text and rotation.
 *
 * While a viewer's stream runs, input goes through its scrcpy control socket.
 * With no stream (an agent and no viewer), it goes through `adb shell input`.
 * The live finger (`sendTouch`) needs the stream.
 *
 * Node built-ins and relative imports only, so it runs under `tsx`.
 */

const SWIPE_DEFAULT_MS = 300;
const SWIPE_STEP_MS = 16;
/** How long `rotate` waits for the display to turn before it returns anyway. */
const ROTATE_SETTLE_MS = 2_000;
/** A window manager still at the old rotation this long after the lock means the app keeps its orientation. */
const ROTATE_REFUSED_AFTER_MS = 400;

type AndroidInputDeps = {
  streams: AndroidStreamHub;
  /** The lane's booted emulator, or `ANDROID_NOT_RUNNING`. */
  requireBooted: (laneId: string) => Promise<{ serial: string; adbPath: string }>;
  /** The serial of the lane's live stream, when one runs. */
  liveStreamSerial: (laneId: string) => string | null;
  /** Ends every adb call on dispose. */
  signal: AbortSignal;
};

type AndroidInputApi = Pick<AndroidEmulatorServiceApi, "sendTouch" | "tap" | "swipe" | "sendKey" | "sendText" | "rotate">;

function finiteNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be a number.`);
  return value;
}

/** `adb shell input text` takes one shell word; spaces are `%s`. */
function shellInputText(text: string): string {
  return `'${text.replace(/ /gu, "%s").replace(/'/gu, "'\\''")}'`;
}

export function createAndroidInput(deps: AndroidInputDeps): AndroidInputApi {
  const { streams, requireBooted, liveStreamSerial, signal } = deps;

  const touch = async (serial: string, events: readonly AndroidTouchEvent[]) => {
    for (const event of events) await streams.sendTouch(serial, event).catch(asStreamFailure);
  };

  const adbInput = async (adbPath: string, serial: string, args: string[]) => {
    await runAdb(adbPath, ["shell", "input", ...args], { serial, timeoutMs: 15_000, signal });
  };

  return {
    async sendTouch(args) {
      const laneId = requireLaneId(args.laneId);
      if (!Array.isArray(args.events) || args.events.length === 0) return;
      const serial = liveStreamSerial(laneId);
      if (!serial) throw new AndroidEmulatorFailure("ANDROID_NOT_RUNNING", "No live view is running for this lane.");
      await touch(serial, args.events);
    },

    async tap(args) {
      const laneId = requireLaneId(args.laneId);
      const x = finiteNumber(args.x, "x");
      const y = finiteNumber(args.y, "y");
      const serial = liveStreamSerial(laneId);
      if (serial) {
        await touch(serial, [{ action: "down", x, y }, { action: "up", x, y }]);
        return;
      }
      // No viewer is open: an agent's tap goes through `adb shell input`.
      const booted = await requireBooted(laneId);
      await adbInput(booted.adbPath, booted.serial, ["tap", String(Math.round(x)), String(Math.round(y))]);
    },

    async swipe(args) {
      const laneId = requireLaneId(args.laneId);
      const fromX = finiteNumber(args.fromX, "fromX");
      const fromY = finiteNumber(args.fromY, "fromY");
      const toX = finiteNumber(args.toX, "toX");
      const toY = finiteNumber(args.toY, "toY");
      const durationMs = Math.min(10_000, Math.max(0, typeof args.durationMs === "number" && Number.isFinite(args.durationMs) ? args.durationMs : SWIPE_DEFAULT_MS));
      const serial = liveStreamSerial(laneId);
      if (!serial) {
        const booted = await requireBooted(laneId);
        await adbInput(booted.adbPath, booted.serial, [
          "swipe",
          String(Math.round(fromX)), String(Math.round(fromY)),
          String(Math.round(toX)), String(Math.round(toY)),
          String(Math.round(durationMs)),
        ]);
        return;
      }
      const steps = Math.max(1, Math.round(durationMs / SWIPE_STEP_MS));
      await touch(serial, [{ action: "down", x: fromX, y: fromY }]);
      try {
        for (let step = 1; step <= steps; step += 1) {
          await sleep(durationMs / steps);
          const t = step / steps;
          await touch(serial, [{ action: "move", x: fromX + (toX - fromX) * t, y: fromY + (toY - fromY) * t }]);
        }
      } finally {
        // Always lift the finger, or the device keeps a pointer down.
        await touch(serial, [{ action: "up", x: toX, y: toY }]).catch(() => undefined);
      }
    },

    async sendKey(args) {
      const laneId = requireLaneId(args.laneId);
      const key: unknown = args.key;
      if (!isAndroidHardwareKey(key)) throw new Error(`Unknown Android key ${String(key)}.`);
      const serial = liveStreamSerial(laneId);
      if (serial) {
        await streams.sendKey(serial, key).catch(asStreamFailure);
        return;
      }
      const booted = await requireBooted(laneId);
      await adbInput(booted.adbPath, booted.serial, ["keyevent", String(ANDROID_HARDWARE_KEYCODES[key])]);
    },

    async sendText(args) {
      const laneId = requireLaneId(args.laneId);
      const text = typeof args.text === "string" ? args.text : "";
      if (!text) return;
      const serial = liveStreamSerial(laneId);
      if (serial) {
        await streams.sendText(serial, text).catch(asStreamFailure);
        return;
      }
      const booted = await requireBooted(laneId);
      await adbInput(booted.adbPath, booted.serial, ["text", shellInputText(text)]);
    },

    async rotate(args) {
      const laneId = requireLaneId(args.laneId);
      const orientation = args.orientation;
      if (orientation !== "portrait" && orientation !== "landscape") throw new Error("orientation must be portrait or landscape.");
      const booted = await requireBooted(laneId);
      const { serial } = booted;
      const shell = (command: string[]) => runAdbOutput(booted, ["shell", ...command], { timeoutMs: 15_000, signal });
      // Rotation 0 is the display's natural orientation: portrait on a phone,
      // landscape on most tablets.
      const size = /Physical size:\s*(\d+)x(\d+)/u.exec((await shell(["wm", "size"])).text);
      const naturalLandscape = size ? Number(size[1]) > Number(size[2]) : false;
      const rotation = (orientation === "landscape") === naturalLandscape ? "0" : "1";
      // Absolute and headless; `adb emu rotate` only turns 90° from wherever
      // the sensor is. Measured on Windows: the stream shows the new size
      // 0.8–1.2 s after the call starts.
      const locked = await shell(["cmd", "window", "user-rotation", "lock", rotation]);
      if (locked.exitCode !== 0 || /unknown|error|exception/iu.test(locked.text)) {
        // Android 10 and older have no `cmd window user-rotation`.
        await shell(["settings", "put", "system", "accelerometer_rotation", "0"]);
        const set = await shell(["settings", "put", "system", "user_rotation", rotation]);
        if (set.exitCode !== 0) throw new Error(`The emulator ${serial} did not rotate: ${set.text || locked.text}`);
      }
      // The display turns after the lock returns (measured on Windows: the
      // first screenshot after it still had the old size). Wait until a
      // capture has the new shape, so a screenshot or tap that follows sees
      // it. An app that fixes its own orientation never turns: stop once the
      // window manager has kept the old rotation for a moment.
      const lockedAt = Date.now();
      while (Date.now() - lockedAt < ROTATE_SETTLE_MS && !signal.aborted) {
        const header = /(\d+)\s+(\d+)/u.exec((await shell(["screencap | head -c 8 | od -An -tu4"])).text);
        if (header && (Number(header[1]) > Number(header[2])) === (orientation === "landscape")) return;
        if (Date.now() - lockedAt >= ROTATE_REFUSED_AFTER_MS) {
          const current = /mRotation=(\d)/u.exec((await shell(["dumpsys window | grep -m1 -oE 'mRotation=[0-9]'"])).text);
          if (current && current[1] !== rotation) return;
        }
        await sleep(50);
      }
    },
  };
}
