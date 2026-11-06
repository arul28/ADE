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
import { runDeviceScript, type BootedDevice } from "./androidDeviceShell";
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
 *   `moveToSideStage <task> <0|1>` (0 is top or left), `switchSplitPosition`,
 *   `exitSplitScreen <task>`. The task behind the moved one fills the other side.
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
/** How long an action waits for the window manager to finish its change. */
const SETTLE_MS = 3_000;
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
      activity: activity.startsWith(".") ? `${task[2]}${activity}` : activity,
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

  const sh = async (booted: BootedDevice, script: string) => {
    const result = await runDeviceScript(booted, script, { timeoutMs: 20_000, signal });
    return result;
  };

  /** Runs one command; a refusal on stdout or stderr stops the action with its first line. */
  const run = async (booted: BootedDevice, script: string, what: string) => {
    const result = await sh(booted, script);
    if (result.exitCode !== 0 || /Exception|Error:|Unknown command|Bad argument|not supported/iu.test(result.text)) {
      throw new Error(`The emulator did not ${what}: ${result.text.split(/\r?\n/u).find((line) => line.trim())?.slice(0, 240) || `exit ${result.exitCode}`}`);
    }
    return result;
  };

  const list = async (booted: BootedDevice) => {
    const result = await sh(booted, "dumpsys window displays | grep -m1 -oE 'cur=[0-9]+x[0-9]+'; echo ---; am stack list");
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

  /** The app's front task, opening the app when it has none. */
  const taskOf = async (booted: BootedDevice, packageName: string, mode?: number): Promise<ListedTask> => {
    const found = (await list(booted)).tasks.find((task) => task.packageName === packageName);
    if (found && mode === undefined) return found;
    const component = found?.activity ?? await launcherOf(booted, packageName);
    await run(booted, `am start -W${mode === undefined ? "" : ` --windowingMode ${mode}`} -n ${component} >/dev/null`, `open ${packageName}`);
    const opened = (await list(booted)).tasks.find((task) => task.packageName === packageName);
    if (!opened) throw new Error(`${packageName} did not open a window.`);
    return opened;
  };

  /** Waits until `done` holds on the list, or the settle time runs out; answers the last list. */
  const settle = async (booted: BootedDevice, done: (tasks: ListedTask[]) => boolean) => {
    const deadline = now() + SETTLE_MS;
    let state = await list(booted);
    while (!done(state.tasks) && now() < deadline && !signal.aborted) {
      await deps.sleep(POLL_MS);
      state = await list(booted);
    }
    return state;
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
      const before = new Map(split.map((task) => [task.taskId, task.frame]));
      await run(booted, `${WMSHELL} splitscreen switchSplitPosition >/dev/null`, "swap the split screen");
      deps.onScreenChanged(laneId);
      const moved = (tasks: ListedTask[]) => tasks.some((task) => {
        const was = before.get(task.taskId);
        return was !== undefined && (!near(was.x, task.frame.x) || !near(was.y, task.frame.y));
      });
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
      const side = action === "split" ? (portrait ? "bottom" : "right") : action;
      if (portrait && (side === "left" || side === "right")) {
        return answer(initial, packageName, false, "This screen is portrait, so Android splits it top and bottom. Use top or bottom.");
      }
      if (!portrait && (side === "top" || side === "bottom")) {
        return answer(initial, packageName, false, "This screen is landscape, so Android splits it left and right. Use left or right.");
      }
      const withPackage = args.withPackage?.trim() ? assertPackageName(args.withPackage.trim()) : null;
      if (withPackage === packageName) return answer(initial, packageName, false, "Name two different apps to split.");
      // The other side is the task behind: open the partner first, then the app.
      if (withPackage) await taskOf(booted, withPackage, WINDOWING_FULLSCREEN);
      const task = withPackage || named ? await taskOf(booted, packageName, WINDOWING_FULLSCREEN) : await taskOf(booted, packageName);
      const position = side === "left" || side === "top" ? 0 : 1;
      await run(booted, `${WMSHELL} splitscreen moveToSideStage ${task.taskId} ${position} >/dev/null`, "split the screen");
      deps.onScreenChanged(laneId);
      const placed = (tasks: ListedTask[]) => {
        const mine = tasks.find((entry) => entry.taskId === task.taskId);
        if (!mine || mine.mode !== "split" || !screen) return false;
        const other = tasks.some((entry) => entry.taskId !== task.taskId && entry.mode === "split" && entry.visible);
        const atStart = portrait ? near(mine.frame.y, 0) : near(mine.frame.x, 0);
        return other && (position === 0 ? atStart : !atStart);
      };
      const state = await settle(booted, placed);
      return placed(state.tasks)
        ? answer(state, packageName, true)
        : answer(state, packageName, false, "Android did not split the screen. The app may not be resizable, or no other app is open to fill the other side.");
    }

    if (action === "freeform") {
      const support = (await sh(booted, "settings get global enable_freeform_support")).stdout.trim();
      if (support !== "1") await run(booted, "settings put global enable_freeform_support 1", "allow free windows");
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
        await run(booted, `${WMSHELL} splitscreen exitSplitScreen ${task.taskId} >/dev/null`, "end the split screen");
      } else if (task.mode !== "fullscreen" && task.activity) {
        await run(booted, `am start -W --windowingMode ${WINDOWING_FULLSCREEN} -n ${task.activity} >/dev/null`, "make the window full screen");
      }
      deps.onScreenChanged(laneId);
      const full = (tasks: ListedTask[]) => tasks.some((entry) => entry.taskId === task.taskId && entry.mode === "fullscreen");
      const state = await settle(booted, full);
      return full(state.tasks) ? answer(state, packageName, true) : answer(state, packageName, false, "The window is not full screen.");
    }

    // close: a split task shares its root with the other side, so the split ends first.
    if (task.mode === "split") {
      const other = initial.tasks.find((entry) => entry.taskId !== task.taskId && entry.rootId === task.rootId);
      if (other) await run(booted, `${WMSHELL} splitscreen exitSplitScreen ${other.taskId} >/dev/null`, "end the split screen");
    }
    const rootNow = (await list(booted)).tasks.find((entry) => entry.taskId === task.taskId)?.rootId ?? task.rootId;
    await run(booted, `am stack remove ${rootNow}`, "close the window");
    deps.onScreenChanged(laneId);
    const gone = (tasks: ListedTask[]) => !tasks.some((entry) => entry.taskId === task.taskId);
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
