import type {
  AndroidAppState,
  AndroidForegroundApp,
  AndroidForegroundArgs,
  AndroidIntentExtra,
  AndroidIntentExtraInput,
  AndroidIntentExtraType,
  AndroidLaunchExtrasArgs,
  AndroidPackageArgs,
} from "../../../shared/types/androidEmulator";
import { ANDROID_INTENT_EXTRA_KEY, ANDROID_INTENT_EXTRA_TYPES, androidIntentExtraWords } from "../../../shared/types/androidEmulator";
import { sleep } from "../shared/utils";
import { runDeviceScript, runDeviceShell, type BootedDevice } from "./androidDeviceShell";
import { readAndroidForeground } from "./androidDeviceSettings";
import { AndroidEmulatorFailure, requireLaneId } from "./androidEmulatorErrors";

/*
 * Parity with `ade apple`: an app's state, the app in front (with a wait),
 * and the launch words for arguments and intent extras. `relaunchApp` lives
 * in the agent suite, which owns the launch.
 *
 * Every read is one or two device shells, so it works the same on every
 * host (macOS, Windows, a headless Linux VM).
 *
 * Node built-ins and relative imports only, so it runs under `tsx`.
 */

const FOREGROUND_WAIT_MAX_MS = 30_000;
const FOREGROUND_POLL_MS = 400;
/** The words a launch may carry: no shell is involved (each is quoted for the device), so only size is checked. */
const LAUNCH_WORDS_MAX = 64;

/** `am start` words for the caller's launch arguments and extras, checked. */
export function androidLaunchWords(args: AndroidLaunchExtrasArgs | null | undefined): string[] {
  const raw: readonly unknown[] = Array.isArray(args?.arguments) ? args.arguments : [];
  const words = raw.filter((word): word is string => typeof word === "string");
  if (words.length !== raw.length) throw new Error("arguments must be a list of strings.");
  const given: readonly unknown[] = Array.isArray(args?.extras) ? args.extras : [];
  const extras: AndroidIntentExtra[] = given.map((entry) => {
    const extra = (entry && typeof entry === "object" ? entry : {}) as Partial<AndroidIntentExtraInput>;
    const { key, type, value } = extra;
    if (typeof key !== "string" || !ANDROID_INTENT_EXTRA_KEY.test(key)) {
      throw new Error("Each extra needs a key name (letters, digits, `.`, `_`, `$`, `-`).");
    }
    if (typeof type !== "string" || !(ANDROID_INTENT_EXTRA_TYPES as readonly string[]).includes(type)) {
      throw new Error(`An extra's type must be ${ANDROID_INTENT_EXTRA_TYPES.join(", ")}.`);
    }
    if (typeof value !== "string") throw new Error(`The extra ${key} needs a value.`);
    // `am start --ei k ""` fails with an unclear message; only a string may be empty.
    if (type !== "string" && value.trim() === "") {
      throw new Error(`The extra ${key} is a${type === "int" ? "n" : ""} ${type}, so it needs a value.`);
    }
    return { key, type: type as AndroidIntentExtraType, value };
  });
  const all = [...words, ...androidIntentExtraWords(extras)];
  if (all.length > LAUNCH_WORDS_MAX) throw new Error(`A launch takes at most ${LAUNCH_WORDS_MAX} extra words.`);
  // `-n` names the component; a second one would start another app than the one asked for.
  if (words.some((word) => word === "-n" || word === "--user")) {
    throw new Error("arguments cannot name another component (-n) or user (--user); pass --package and --activity instead.");
  }
  return all;
}

/** `pidof` prints the pids space-separated; the first is the main process. */
function firstPid(text: string): number | null {
  const pid = Number(text.trim().split(/\s+/u)[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export function createAndroidAppState(deps: {
  requireBooted: (laneId: string) => Promise<BootedDevice>;
  assertPackageName: (value: unknown) => string;
  signal: AbortSignal;
  now: () => Date;
}) {
  const { signal } = deps;

  const readFront = async (booted: BootedDevice) => {
    const front = await readAndroidForeground(booted, signal);
    return { packageName: front.foregroundPackage, activity: front.activity };
  };

  return {
    async getAppState(args: AndroidPackageArgs): Promise<AndroidAppState> {
      const laneId = requireLaneId(args?.laneId);
      const packageName = deps.assertPackageName(args.packageName);
      const booted = await deps.requireBooted(laneId);
      // One shell: installed, version, pid. `dumpsys package` prints nothing for an unknown package.
      const script = [
        `pm path ${packageName} >/dev/null 2>&1 && echo installed=1 || echo installed=0`,
        `dumpsys package ${packageName} 2>/dev/null | grep -m2 -E 'versionName=|versionCode='`,
        `echo "pid=$(pidof ${packageName})"`,
      ].join("; ");
      const [state, front] = await Promise.all([
        runDeviceScript(booted, script, { timeoutMs: 15_000, signal }),
        readFront(booted),
      ]);
      const text = state.stdout;
      const installed = /installed=1/u.test(text);
      const versionName = /versionName=(\S+)/u.exec(text)?.[1] ?? null;
      const versionCodeRaw = /versionCode=(\d+)/u.exec(text)?.[1];
      const pid = firstPid(/pid=(.*)$/mu.exec(text)?.[1] ?? "");
      return {
        laneId,
        packageName,
        installed,
        running: pid !== null,
        foreground: front.packageName === packageName,
        pid,
        versionName: installed ? versionName : null,
        versionCode: installed && versionCodeRaw ? Number(versionCodeRaw) : null,
        checkedAt: deps.now().toISOString(),
      };
    },

    async getForegroundApp(args: AndroidForegroundArgs): Promise<AndroidForegroundApp> {
      const laneId = requireLaneId(args?.laneId);
      const wanted = args.packageName?.trim() ? deps.assertPackageName(args.packageName) : null;
      const waitMs = Math.min(Math.max(Number(args.waitMs) || 0, 0), FOREGROUND_WAIT_MAX_MS);
      const booted = await deps.requireBooted(laneId);
      const startedAt = Date.now();
      let last: { packageName: string | null; activity: string | null } = { packageName: null, activity: null };
      for (;;) {
        last = await readFront(booted);
        const done = wanted ? last.packageName === wanted : last.packageName !== null;
        if (done || Date.now() - startedAt >= waitMs || signal.aborted) break;
        await sleep(Math.min(FOREGROUND_POLL_MS, Math.max(0, waitMs - (Date.now() - startedAt))));
      }
      const waitedMs = waitMs > 0 ? Date.now() - startedAt : null;
      if (wanted && last.packageName !== wanted) {
        throw new AndroidEmulatorFailure(
          "ANDROID_WAIT_TIMEOUT",
          `${wanted} was not in front after ${Math.round((waitedMs ?? 0) / 100) / 10} s; ${last.packageName ?? "the home screen (no app)"} is.`,
        );
      }
      if (!last.packageName) return null;
      const pid = firstPid((await runDeviceShell(booted.adbPath, booted.serial, ["pidof", last.packageName], { timeoutMs: 10_000, signal })).stdout);
      return { laneId, packageName: last.packageName, activity: last.activity, pid, checkedAt: deps.now().toISOString(), waitedMs };
    },
  };
}
