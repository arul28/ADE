import {
  ANDROID_WINDOW_LAYOUT_ACTIONS,
  type AndroidWindow,
  type AndroidWindowFrame,
  type AndroidWindowLayoutAction,
  type AndroidWindowLayoutArgs,
  type AndroidWindowLayoutResult,
  type AndroidWindowMode,
} from "../../../shared/types/androidEmulator";
import { assertPackageName } from "./androidApps";
import { DEFAULT_DISPLAY_DUMP, runDeviceScript, type BootedDevice } from "./androidDeviceShell";
import { requireLaneId } from "./androidEmulatorErrors";
import { createAndroidLaneQueue } from "./androidLaneQueue";

/*
 * `ade android window`: the windows of a large screen, as `ade apple window`
 * lays out an iPad's. Android's own mechanisms, all from the device shell,
 * on Google APIs and Play images from Android 12L (API 32) on:
 *
 * - The list is `am stack list`: root tasks front first, each task with its
 *   component and bounds. A split task sits in a root that still says
 *   "fullscreen", so a task smaller than the screen and not free is split.
 * - Split screen is the window manager shell's own command
 *   (`dumpsys activity service SystemUIService WMShell splitscreen …`):
 *   `moveToSideStage <task> <0|1>` (0 is top or left) and
 *   `exitSplitScreen <task>` (Android 14 has none: an app opened full screen
 *   ends the split there). The front task fills the other side, so the
 *   moved task is put just behind it first (moving the front task itself
 *   fails on API 34). A task that is already split is never moved (SystemUI throws and
 *   restarts on API 37): the split ends first. `switchSplitPosition` does
 *   nothing on API 37, so a swap is an end and a new split. Android 15+ splits
 *   a large screen left and right even when it is portrait
 *   (`mIsLeftRightSplit` in the shell's dump); older images split by shape.
 * - A free window is `am start --windowingMode 5` (after
 *   `enable_freeform_support`), and `am task resize` sizes and moves it.
 *   `am start --windowingMode 1` makes it full screen again.
 * - Close is `am stack remove` of the task's root.
 *
 * Every action is checked against the list read back afterwards; `applied`
 * is false, with a reason, when the window did not end where it was asked to.
 * Node built-ins and relative imports only, so it runs under `tsx`.
 */

const WMSHELL = "dumpsys activity service SystemUIService WMShell";
const WINDOWING_FULLSCREEN = 1;
const WINDOWING_FREEFORM = 5;
const SPLIT_BUSY = "Android is still ending the split screen, so ADE did not move a window (a move then restarts SystemUI and closes both apps). Try again in a moment.";
/**
 * How long an action waits for the window manager to finish its change. A
 * split takes about 4 s to show on an API 34 emulator (under 1 s on API 37).
 */
const SETTLE_MS = 6_000;
/** How long the end of a split may take before ADE refuses to move a window. */
const END_SPLIT_MS = 10_000;
/** How long the home screen may take to cover a split (Android 14's way out of it). */
const HOME_MS = 3_000;
const POLL_MS = 150;
/** Pixels a frame may be off and still count as where it was asked. */
const TOLERANCE = 4;

export type AndroidWindowsDeps = {
  requireBooted: (laneId: string) => Promise<BootedDevice>;
  /** A layout change moves the screen: the lane's cached UI tree ends. */
  onScreenChanged: (laneId: string) => void;
  signal: AbortSignal;
  sleep: (ms: number) => Promise<void>;
  now?: () => number;
};

type ListedTask = AndroidWindow & { rootId: number; home: boolean };

/** The screen as it is turned now (`cur=WxH` of the default display). */
export function parseScreenSize(text: string): { width: number; height: number } | null {
  const match = /cur=(\d+)x(\d+)/u.exec(text);
  return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
}

/** `am stack list`, front first, with each task's mode worked out against the screen. */
export function parseStackList(text: string, screen: { width: number; height: number } | null): ListedTask[] {
  const tasks: ListedTask[] = [];
  let rootId = -1;
  let rootMode = "fullscreen";
  let rootType = "standard";
  for (const line of text.split(/\r?\n/u)) {
    const root = /^RootTask id=(\d+)/u.exec(line.trim());
    if (root) {
      rootId = Number(root[1]);
      rootMode = "fullscreen";
      rootType = "standard";
      continue;
    }
    const config = /mWindowingMode=([a-z-]+).*?mActivityType=([a-z]+)/u.exec(line);
    if (config && !line.trim().startsWith("taskId=")) {
      rootMode = config[1]!;
      rootType = config[2]!;
      continue;
    }
    const task = /^\s*taskId=(\d+):\s+([A-Za-z0-9_.]+)\/(\S+)\s+bounds=\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\].*?visible=(true|false)/u.exec(line);
    if (!task) continue;
    const [left, top, right, bottom] = [task[4], task[5], task[6], task[7]].map(Number) as [number, number, number, number];
    const frame: AndroidWindowFrame = { x: left, y: top, width: right - left, height: bottom - top };
    const full = screen ? frame.width >= screen.width - TOLERANCE && frame.height >= screen.height - TOLERANCE : true;
    const mode: AndroidWindowMode = rootMode === "freeform"
      ? "freeform"
      : rootMode === "pinned"
        ? "pip"
        : full ? "fullscreen" : rootMode === "fullscreen" || rootMode === "multi-window" ? "split" : "other";
    const activity = task[3]!;
    tasks.push({
      taskId: Number(task[1]),
      packageName: task[2]!,
      // The component as `am start -n` takes it: package/class.
      activity: `${task[2]}/${activity.startsWith(".") ? `${task[2]}${activity}` : activity}`,
      mode,
      frame,
      visible: task[8] === "true",
      rootId,
      home: rootType === "home",
    });
  }
  return tasks;
}

function near(a: number, b: number): boolean {
  return Math.abs(a - b) <= TOLERANCE;
}

export function createAndroidWindows(deps: AndroidWindowsDeps) {
  const { signal } = deps;
  const now = deps.now ?? Date.now;
  /** One layout at a time per lane: two calls would split each other's tasks. */
  const perLane = createAndroidLaneQueue();

  const sh = (booted: BootedDevice, script: string) => runDeviceScript(booted, script, { timeoutMs: 20_000, signal });

  /** Runs one command; a refusal on stdout or stderr stops the action with its first line. */
  const run = async (booted: BootedDevice, script: string, what: string) => {
    const result = await sh(booted, script);
    if (result.exitCode !== 0 || /Exception|Error:|Unknown command|Bad argument|not supported/iu.test(result.text)) {
      // `am` prints "Exception occurred while executing 'start':" and the real cause on a later line.
      const lines = result.text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
      const cause = lines.find((line) => /(Exception|Error)\b.*:/u.test(line) && !/^Exception occurred while executing/u.test(line)) ?? lines[0];
      throw new Error(`The emulator did not ${what}: ${cause?.slice(0, 240) || `exit ${result.exitCode}`}`);
    }
    return result;
  };

  const list = async (booted: BootedDevice) => {
    const result = await sh(booted, `${DEFAULT_DISPLAY_DUMP} | grep -m1 -oE 'cur=[0-9]+x[0-9]+'; echo ---; am stack list`);
    const [head = "", body = ""] = result.stdout.split("---");
    const screen = parseScreenSize(head);
    const tasks = parseStackList(body, screen).filter((task) => !task.home);
    return { screen, tasks };
  };

  /** The launcher activity of a package, as `am start -n` takes it. */
  const launcherOf = async (booted: BootedDevice, packageName: string): Promise<string> => {
    const text = (await sh(booted, `cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER ${packageName} | tail -n 1`)).stdout.trim();
    if (!/^[A-Za-z0-9_.]+\/\S+$/u.test(text)) {
      throw new Error(`${packageName} has no launcher activity on this emulator. Install it first (ade android install), or name another app.`);
    }
    return text;
  };

  /**
   * Brings the app to the front full screen, as a tap on its icon does (its
   * own task comes back), opening it when it has none. Only a window that is
   * not full screen gets `--windowingMode 1`: that flag can open a new task.
   */
  const toFront = async (booted: BootedDevice, packageName: string) => {
    const found = (await list(booted)).tasks.find((task) => task.packageName === packageName);
    const component = await launcherOf(booted, packageName);
    const mode = found && found.mode !== "fullscreen" ? ` --windowingMode ${WINDOWING_FULLSCREEN}` : "";
    await run(booted, `am start -W${mode} -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n ${component} >/dev/null`, `open ${packageName}`);
  };

  /** Waits until `done` holds on the list, or the settle time runs out; answers the last list. */
  const settle = async (booted: BootedDevice, done: (tasks: ListedTask[]) => boolean, waitMs = SETTLE_MS) => {
    const deadline = now() + waitMs;
    let state = await list(booted);
    while (!done(state.tasks) && now() < deadline && !signal.aborted) {
      await deps.sleep(POLL_MS);
      state = await list(booted);
    }
    return state;
  };

  /**
   * Ends the split screen with `keepTaskId` on top, the other side behind it.
   * `moveToSideStage` on a task that is already split throws in SystemUI
   * ("taskId is in split", API 37) and SystemUI restarts, closing both apps,
   * so every move ends the split first.
   */
  const endSplit = async (booted: BootedDevice, keepTaskId: number) => {
    const keep = (await list(booted)).tasks.find((task) => task.taskId === keepTaskId);
    const rootId = keep?.rootId;
    const exit = await run(booted, `${WMSHELL} splitscreen exitSplitScreen ${keepTaskId}`, "end the split screen");
    if (/Invalid command/u.test(exit.stdout) && keep) {
      // Android 14 and older have no exitSplitScreen. There an app opened
      // full screen from the home screen leaves the split (opened while the
      // split shows, it does nothing). Each app of the split opens full
      // screen, the kept one last, so it ends on top. (Some apps, Chrome
      // among them, come back in a new task: callers find apps by package.)
      const mates = (await list(booted)).tasks.filter((task) => task.mode === "split" && task.rootId === rootId && task.packageName !== keep.packageName);
      await run(booted, "input keyevent KEYCODE_HOME", "go to the home screen");
      await settle(booted, (tasks) => !tasks.some((task) => task.visible && task.mode === "split"), HOME_MS);
      for (const mate of mates) await toFront(booted, mate.packageName);
      await toFront(booted, keep.packageName);
    }
    // Done when neither side of this split is split any more (a hidden split
    // pair elsewhere, behind a full-screen app, is not this one).
    const ended = (tasks: ListedTask[]) => !tasks.some((task) => task.mode === "split" && (task.taskId === keepTaskId || (rootId !== undefined && task.rootId === rootId)));
    const state = await settle(booted, ended, END_SPLIT_MS);
    if (!ended(state.tasks)) throw new Error(SPLIT_BUSY);
    return state;
  };

  /** `moveToSideStage`, never on a task that is still split (that restarts SystemUI). */
  const moveToSide = async (booted: BootedDevice, taskId: number, position: 0 | 1, what: string) => {
    const current = (await list(booted)).tasks.find((task) => task.taskId === taskId);
    if (current?.mode === "split") throw new Error(SPLIT_BUSY);
    await run(booted, `${WMSHELL} splitscreen moveToSideStage ${taskId} ${position} >/dev/null`, what);
  };

  const layout = async (laneId: string, args: AndroidWindowLayoutArgs): Promise<AndroidWindowLayoutResult> => {
    const action: AndroidWindowLayoutAction = args.action ?? "status";
    if (!(ANDROID_WINDOW_LAYOUT_ACTIONS as readonly string[]).includes(action)) {
      throw new Error(`action must be one of ${ANDROID_WINDOW_LAYOUT_ACTIONS.join(", ")}.`);
    }
    const booted = await deps.requireBooted(laneId);
    const initial = await list(booted);
    const answer = (state: { screen: AndroidWindowLayoutResult["screen"]; tasks: ListedTask[] }, packageName: string | null, applied: boolean, reason?: string): AndroidWindowLayoutResult => ({
      laneId,
      action,
      screen: state.screen,
      packageName,
      windows: state.tasks.map(({ rootId: _root, home: _home, ...window }) => window),
      applied,
      ...(reason ? { reason } : {}),
    });
    if (action === "status") return answer(initial, null, true);

    if (action === "swap") {
      const split = initial.tasks.filter((task) => task.mode === "split" && task.visible);
      if (split.length < 2) return answer(initial, null, false, "No split screen is showing.");
      // `switchSplitPosition` does nothing on API 37, so the swap ends the
      // split with the first side on top and moves the second side to the start.
      const [first, second] = [...split].sort((a, b) => a.frame.x + a.frame.y - (b.frame.x + b.frame.y)) as [ListedTask, ListedTask];
      const ended = await endSplit(booted, first.taskId);
      // Found again by package: on Android 14 an app can come back in a new task.
      const secondNow = ended.tasks.find((task) => task.packageName === second.packageName);
      if (!secondNow) return answer(ended, null, false, `${second.packageName} closed when the split ended.`);
      await moveToSide(booted, secondNow.taskId, 0, "swap the split screen");
      deps.onScreenChanged(laneId);
      const moved = (tasks: ListedTask[]) => {
        const swapped = tasks.find((task) => task.packageName === second.packageName && task.mode === "split");
        const other = tasks.find((task) => task.packageName === first.packageName && task.mode === "split");
        return Boolean(swapped && other && near(swapped.frame.x, 0) && near(swapped.frame.y, 0));
      };
      const state = await settle(booted, moved);
      return moved(state.tasks) ? answer(state, null, true) : answer(state, null, false, "The two sides did not change over.");
    }

    // Every other action places one app: the one named, or the one in front.
    const named = args.packageName?.trim() ? assertPackageName(args.packageName.trim()) : null;
    const front = initial.tasks.find((task) => task.visible) ?? null;
    const packageName = named ?? front?.packageName ?? null;
    if (!packageName) return answer(initial, null, false, "No app is open. Name one with packageName (--package).");
    const screen = initial.screen;
    const portrait = screen ? screen.height > screen.width : true;

    if (action === "split" || action === "left" || action === "right" || action === "top" || action === "bottom") {
      // A large screen (a foldable open) splits left and right even when it
      // is portrait (Android 15+, `mIsLeftRightSplit`); older images split by
      // the screen's shape.
      const flag = /mIsLeftRightSplit=(true|false)/u.exec(
        (await sh(booted, `${WMSHELL} | grep -m1 -oE 'mIsLeftRightSplit=(true|false)'`)).stdout,
      )?.[1];
      const leftRight = flag ? flag === "true" : !portrait;
      const side = action === "split" ? (leftRight ? "right" : "bottom") : action;
      if (!leftRight && (side === "left" || side === "right")) {
        return answer(initial, packageName, false, "Android splits this screen top and bottom. Use top or bottom.");
      }
      if (leftRight && (side === "top" || side === "bottom")) {
        return answer(initial, packageName, false, "Android splits this screen left and right. Use left or right.");
      }
      const withPackage = args.withPackage?.trim() ? assertPackageName(args.withPackage.trim()) : null;
      if (withPackage === packageName) return answer(initial, packageName, false, "Name two different apps to split.");
      const position = side === "left" || side === "top" ? 0 : 1;
      const atStartOf = (frame: AndroidWindowFrame) => (leftRight ? near(frame.x, 0) : near(frame.y, 0));
      const splitNow = initial.tasks.filter((entry) => entry.mode === "split" && entry.visible);
      const mineNow = splitNow.find((entry) => entry.packageName === packageName)
        ?? initial.tasks.find((entry) => entry.packageName === packageName && entry.mode === "split");
      // The other side shares this app's root task; with no root to go by, the other visible side.
      const partnerNow = mineNow
        ? initial.tasks.find((entry) => entry !== mineNow && entry.mode === "split" && entry.rootId === mineNow.rootId)
          ?? splitNow.find((entry) => entry !== mineNow)
        : undefined;
      if (mineNow && partnerNow && (!withPackage || partnerNow.packageName === withPackage)
        && (position === 0) === atStartOf(mineNow.frame)) {
        return answer(initial, packageName, true); // already there
      }
      // A move of a task that is already split crashes SystemUI, so the split ends first.
      let task: ListedTask;
      if (mineNow && partnerNow && (!withPackage || partnerNow.packageName === withPackage)) {
        // Same two apps, other side: the partner stays on top and fills the
        // other side again when this app moves (the swap's way).
        const ended = await endSplit(booted, partnerNow.taskId);
        const mineAgain = ended.tasks.find((entry) => entry.packageName === packageName);
        if (!mineAgain) return answer(ended, packageName, false, `${packageName} closed when the split ended.`);
        task = mineAgain;
      } else {
        if (mineNow || splitNow.length > 0) await endSplit(booted, (mineNow ?? splitNow[0]!).taskId);
        // The front app fills the other side, and the moved app must be behind
        // it (moving the front app itself fails on API 34: "didn't receive 2
        // tasks in transition"). So the app comes up first, then the partner
        // over it: the named one, or the front-most other app.
        const partnerPackage = withPackage
          ?? (await list(booted)).tasks.find((entry) => entry.packageName !== packageName)?.packageName
          ?? null;
        if (!partnerPackage) {
          return answer(await list(booted), packageName, false, "No other app is open to fill the other side. Name one with withPackage (--with).");
        }
        // An app already open full screen is only covered (opening it again
        // would give Chrome a second task).
        const own = (await list(booted)).tasks.find((entry) => entry.packageName === packageName);
        if (own?.mode !== "fullscreen") await toFront(booted, packageName);
        await toFront(booted, partnerPackage);
        const behind = (await list(booted)).tasks.find((entry) => entry.packageName === packageName);
        if (!behind) throw new Error(`${packageName} did not open a window.`);
        task = behind;
      }
      await moveToSide(booted, task.taskId, position, "split the screen");
      deps.onScreenChanged(laneId);
      const placed = (tasks: ListedTask[]) => {
        const mine = tasks.find((entry) => entry.taskId === task.taskId);
        if (!mine || mine.mode !== "split" || !screen) return false;
        const other = tasks.some((entry) => entry.taskId !== task.taskId && entry.mode === "split" && entry.visible);
        return other && (position === 0) === atStartOf(mine.frame);
      };
      const state = await settle(booted, placed);
      return placed(state.tasks)
        ? answer(state, packageName, true)
        : answer(state, packageName, false, "Android did not split the screen. The app may not be resizable, or no other app is open to fill the other side.");
    }

    if (action === "freeform") {
      const support = (await sh(booted, "settings get global enable_freeform_support")).stdout.trim();
      if (support !== "1") await run(booted, "settings put global enable_freeform_support 1", "allow free windows");
      const splitTask = initial.tasks.find((task) => task.packageName === packageName && task.mode === "split");
      if (splitTask) await endSplit(booted, splitTask.taskId);
      const component = initial.tasks.find((task) => task.packageName === packageName)?.activity ?? await launcherOf(booted, packageName);
      await run(booted, `am start -W --windowingMode ${WINDOWING_FREEFORM} -n ${component} >/dev/null`, `open ${packageName} in a free window`);
      deps.onScreenChanged(laneId);
      const free = (tasks: ListedTask[]) => tasks.some((task) => task.packageName === packageName && task.mode === "freeform");
      const state = await settle(booted, free);
      return free(state.tasks)
        ? answer(state, packageName, true)
        : answer(state, packageName, false, "Android kept the app full screen. This screen may not allow free windows, or the app is not resizable.");
    }

    const task = initial.tasks.find((entry) => entry.packageName === packageName);
    if (!task) return answer(initial, packageName, false, `${packageName} has no open window.`);

    if (action === "size" || action === "move") {
      if (task.mode !== "freeform") {
        return answer(initial, packageName, false, `${packageName} is not in a free window. Run the freeform action first.`);
      }
      const { x, y, width, height } = task.frame;
      const want = action === "size"
        ? { x, y, width: whole(args.width, "width"), height: whole(args.height, "height") }
        : { x: whole(args.x, "x", true), y: whole(args.y, "y", true), width, height };
      if (screen && (want.x + want.width > screen.width || want.y + want.height > screen.height)) {
        return answer(initial, packageName, false, `That frame runs past the ${screen.width}x${screen.height} screen. Choose a smaller size or a point nearer the top left.`);
      }
      await run(booted, `am task resize ${task.taskId} ${want.x} ${want.y} ${want.x + want.width} ${want.y + want.height}`, "resize the window");
      deps.onScreenChanged(laneId);
      const landed = (tasks: ListedTask[]) => {
        const mine = tasks.find((entry) => entry.taskId === task.taskId);
        return Boolean(mine && near(mine.frame.x, want.x) && near(mine.frame.y, want.y)
          && near(mine.frame.width, want.width) && near(mine.frame.height, want.height));
      };
      const state = await settle(booted, landed);
      return landed(state.tasks)
        ? answer(state, packageName, true)
        : answer(state, packageName, false, "The window did not take that frame. Android keeps a free window inside the screen and above its smallest size.");
    }

    if (action === "fill") {
      if (task.mode === "split") {
        await endSplit(booted, task.taskId);
      } else if (task.mode !== "fullscreen" && task.activity) {
        await run(booted, `am start -W --windowingMode ${WINDOWING_FULLSCREEN} -n ${task.activity} >/dev/null`, "make the window full screen");
      }
      deps.onScreenChanged(laneId);
      // Some apps (Chrome) open a new task for the new mode, so the app counts, not the task id.
      const full = (tasks: ListedTask[]) => tasks.some((entry) => (entry.taskId === task.taskId || entry.packageName === packageName) && entry.mode === "fullscreen" && entry.visible);
      const state = await settle(booted, full);
      if (full(state.tasks)) return answer(state, packageName, true);
      const still = state.tasks.find((entry) => entry.taskId === task.taskId);
      return answer(state, packageName, false, still?.mode === "freeform"
        ? "Android kept the free window (Android 14 and older do not change the mode of an open window). Close it with the close action and open the app again."
        : "The window is not full screen.");
    }

    // close: a split task shares its root with the other side, so the split
    // ends first (with `endSplit`'s Android 14 fallback and its wait), or
    // removing the root would close both windows.
    let closing = task;
    if (task.mode === "split") {
      const other = initial.tasks.find((entry) => entry.taskId !== task.taskId && entry.rootId === task.rootId);
      if (other) {
        const ended = await endSplit(booted, other.taskId);
        // Found again by package when its task is gone: on Android 14 an app can come back in a new task.
        closing = ended.tasks.find((entry) => entry.taskId === task.taskId)
          ?? ended.tasks.find((entry) => entry.packageName === task.packageName)
          ?? task;
      }
    }
    const target = closing;
    const rootNow = (await list(booted)).tasks.find((entry) => entry.taskId === target.taskId)?.rootId ?? target.rootId;
    await run(booted, `am stack remove ${rootNow}`, "close the window");
    deps.onScreenChanged(laneId);
    const gone = (tasks: ListedTask[]) => !tasks.some((entry) => entry.taskId === target.taskId);
    const state = await settle(booted, gone);
    return gone(state.tasks) ? answer(state, packageName, true) : answer(state, packageName, false, "The window is still open.");
  };

  return {
    windowLayout: (args: AndroidWindowLayoutArgs) => {
      const laneId = requireLaneId(args?.laneId);
      return perLane(laneId, () => layout(laneId, args));
    },
  };
}

function whole(value: unknown, name: string, allowZero = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (!allowZero && value === 0)) {
    throw new Error(`${name} must be a positive number of pixels.`);
  }
  return Math.round(value);
}
