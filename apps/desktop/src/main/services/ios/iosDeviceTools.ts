import {
  IOS_SIMULATOR_CONTENT_SIZES,
  IOS_SIMULATOR_PRIVACY_SERVICES,
} from "../../../shared/types/iosSimulator";
import type {
  IosSimulatorAccessibilityOption,
  IosSimulatorAppState,
  IosSimulatorAppearance,
  IosSimulatorContentSize,
  IosSimulatorDeviceSettings,
  IosSimulatorLocation,
  IosSimulatorPrivacyService,
  IosSimulatorPushArgs,
  IosSimulatorSetPermissionArgs,
  IosSimulatorStatusBarArgs,
} from "../../../shared/types/iosSimulator";

export type IosDeviceToolsRunCommand = (
  file: string,
  args: string[],
  options?: { timeoutMs?: number },
) => Promise<{ stdout: string; stderr: string }>;

export type IosDeviceToolsDeps = {
  run: IosDeviceToolsRunCommand;
  /** Writes a temp file and returns its path. The caller owns deletion. */
  writeTempFile: (contents: string, extension: string) => Promise<string>;
  removeFile: (filePath: string) => Promise<void>;
  now?: () => Date;
};

/** Every simctl call is short. A longer call is a hung device, not slow work. */
const DEFAULT_TIMEOUT_MS = 20_000;
/** An uninstall deletes the container, so it needs more time than the rest. */
const UNINSTALL_TIMEOUT_MS = 30_000;
/** A cold app start waits on the runtime, not just on simctl. */
const LAUNCH_TIMEOUT_MS = 60_000;

const ACCESSIBILITY_DEFAULTS_DOMAIN = "com.apple.Accessibility";

/**
 * The accessibility toggles that `simctl ui` does not know.
 *
 * `simctl ui` supports appearance, increase_contrast and content_size, and
 * nothing else. The other toggles live in the device's own
 * `com.apple.Accessibility` preferences. A preference write alone changes
 * nothing that a human can see: the running apps keep the old value until they
 * relaunch. `notifyutil -p <notification>` posts the Darwin notification that
 * UIKit listens for, so the change applies immediately. Always write, then
 * post.
 */
export const IOS_ACCESSIBILITY_PREFERENCES: Record<
  Exclude<IosSimulatorAccessibilityOption, "increase-contrast">,
  { key: string; notification: string }
> = {
  "reduce-motion": {
    key: "ReduceMotionEnabled",
    notification: "com.apple.Accessibility.ReduceMotionEnabledChanged",
  },
  "reduce-transparency": {
    key: "ReduceTransparencyEnabled",
    notification: "com.apple.Accessibility.ReduceTransparencyEnabledChanged",
  },
  "bold-text": {
    key: "BoldTextEnabled",
    notification: "com.apple.Accessibility.BoldTextEnabledChanged",
  },
  "invert-colors": {
    key: "InvertColorsEnabled",
    notification: "com.apple.Accessibility.InvertColorsEnabledChanged",
  },
  grayscale: {
    key: "GrayscaleEnabled",
    notification: "com.apple.Accessibility.GrayscaleEnabledChanged",
  },
  "voice-over": {
    key: "VoiceOverTouchEnabled",
    notification: "com.apple.Accessibility.VoiceOverTouchEnabledChanged",
  },
};

const ACCESSIBILITY_PREFERENCE_OPTIONS = Object.keys(IOS_ACCESSIBILITY_PREFERENCES) as Array<
  Exclude<IosSimulatorAccessibilityOption, "increase-contrast">
>;

type WithDeviceUdid<T> = Omit<T, "deviceUdid"> & { deviceUdid: string };

export type IosDeviceToolsPermissionArgs = WithDeviceUdid<IosSimulatorSetPermissionArgs>;
export type IosDeviceToolsPushArgs = WithDeviceUdid<IosSimulatorPushArgs>;
export type IosDeviceToolsStatusBarArgs = WithDeviceUdid<IosSimulatorStatusBarArgs>;

export type IosDeviceTools = {
  readSettings: (deviceUdid: string) => Promise<IosSimulatorDeviceSettings>;
  setAppearance: (deviceUdid: string, appearance: IosSimulatorAppearance) => Promise<void>;
  setContentSize: (deviceUdid: string, contentSize: IosSimulatorContentSize) => Promise<void>;
  setAccessibilityOption: (
    deviceUdid: string,
    option: IosSimulatorAccessibilityOption,
    enabled: boolean,
  ) => Promise<void>;
  setLocation: (deviceUdid: string, location: IosSimulatorLocation) => Promise<void>;
  clearLocation: (deviceUdid: string) => Promise<void>;
  setPermission: (args: IosDeviceToolsPermissionArgs) => Promise<void>;
  sendPush: (args: IosDeviceToolsPushArgs) => Promise<void>;
  openUrl: (deviceUdid: string, url: string) => Promise<void>;
  launchApp: (deviceUdid: string, bundleId: string) => Promise<void>;
  terminateApp: (deviceUdid: string, bundleId: string) => Promise<void>;
  uninstallApp: (deviceUdid: string, bundleId: string) => Promise<void>;
  setStatusBar: (args: IosDeviceToolsStatusBarArgs) => Promise<void>;
  clearStatusBar: (deviceUdid: string) => Promise<void>;
  getAppState: (deviceUdid: string, bundleId: string) => Promise<IosSimulatorAppState>;
};

function assertDeviceUdid(deviceUdid: string): string {
  const trimmed = typeof deviceUdid === "string" ? deviceUdid.trim() : "";
  if (!trimmed) {
    throw new Error("A device udid is required.");
  }
  return trimmed;
}

function assertBundleId(bundleId: string | null | undefined, label = "bundle id"): string {
  const trimmed = typeof bundleId === "string" ? bundleId.trim() : "";
  if (!trimmed) {
    throw new Error(`A ${label} is required.`);
  }
  return trimmed;
}

function assertAppearance(appearance: string): IosSimulatorAppearance {
  if (appearance !== "light" && appearance !== "dark") {
    throw new Error(`Unsupported appearance "${appearance}". Allowed values: light, dark.`);
  }
  return appearance;
}

function assertContentSize(contentSize: string): IosSimulatorContentSize {
  if (!(IOS_SIMULATOR_CONTENT_SIZES as readonly string[]).includes(contentSize)) {
    throw new Error(
      `Unsupported content size "${contentSize}". Allowed values: ${IOS_SIMULATOR_CONTENT_SIZES.join(", ")}.`,
    );
  }
  return contentSize as IosSimulatorContentSize;
}

function assertPrivacyService(service: string): IosSimulatorPrivacyService {
  if (!(IOS_SIMULATOR_PRIVACY_SERVICES as readonly string[]).includes(service)) {
    throw new Error(
      `Unsupported privacy service "${service}". Allowed values: ${IOS_SIMULATOR_PRIVACY_SERVICES.join(", ")}.`,
    );
  }
  return service as IosSimulatorPrivacyService;
}

function assertNumberInRange(value: number, min: number, max: number, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`Invalid ${label} "${String(value)}". Allowed range: ${min} to ${max}.`);
  }
  return value;
}

function assertIntegerInRange(value: number, min: number, max: number, label: string): number {
  assertNumberInRange(value, min, max, label);
  if (!Number.isInteger(value)) {
    throw new Error(`Invalid ${label} "${String(value)}". Allowed range: ${min} to ${max}.`);
  }
  return value;
}

function assertUrl(url: string): string {
  const trimmed = typeof url === "string" ? url.trim() : "";
  if (!trimmed) {
    throw new Error("A url is required.");
  }
  try {
    new URL(trimmed);
  } catch {
    throw new Error(`Invalid url "${url}". Allowed values: an absolute url such as https://example.com.`);
  }
  return trimmed;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/**
 * Maps what the device printed onto the set ADE can set.
 *
 * `simctl ui content_size` can answer `unsupported` or a category a future
 * runtime added. Reporting the raw string let the drawer render a select with
 * no matching option, which looks like a blank setting rather than an unknown
 * one.
 */
export function normalizeContentSize(value: string): IosSimulatorContentSize | "unknown" {
  const trimmed = value.trim();
  return (IOS_SIMULATOR_CONTENT_SIZES as readonly string[]).includes(trimmed)
    ? trimmed as IosSimulatorContentSize
    : "unknown";
}

/**
 * Builds the APNs dictionary that `simctl push` reads.
 *
 * `Simulator Target Bundle` is always set. simctl accepts that key next to the
 * explicit bundle id argument, and it keeps the payload file valid on its own.
 */
export function buildPushPayload(args: {
  payload?: Record<string, unknown> | null;
  title?: string | null;
  body?: string | null;
  bundleId: string;
}): Record<string, unknown> {
  const bundleId = assertBundleId(args.bundleId);
  const title = typeof args.title === "string" && args.title.length > 0 ? args.title : null;
  const body = typeof args.body === "string" && args.body.length > 0 ? args.body : null;

  if (args.payload !== undefined && args.payload !== null) {
    if (!isPlainObject(args.payload)) {
      throw new Error("Invalid push payload. Allowed values: a plain JSON object.");
    }
    const payload: Record<string, unknown> = { ...args.payload };
    if (payload.aps === undefined && (title !== null || body !== null)) {
      const alert: Record<string, unknown> = {};
      if (title !== null) {
        alert.title = title;
      }
      if (body !== null) {
        alert.body = body;
      }
      payload.aps = { alert };
    }
    payload["Simulator Target Bundle"] = bundleId;
    return payload;
  }

  if (title === null && body === null) {
    throw new Error("A push needs a payload, a title, or a body.");
  }

  const alert: Record<string, unknown> = {};
  if (title !== null) {
    alert.title = title;
  }
  if (body !== null) {
    alert.body = body;
  }
  return {
    aps: { alert, sound: "default" },
    "Simulator Target Bundle": bundleId,
  };
}

/**
 * Reads the pid out of `launchctl list` output for one foreground app.
 *
 * A foreground app runs under a label such as
 * `UIKitApplication:com.example.app[0x9a1b][rb-legacy]`. The first column holds
 * the pid, or `-` when the service is loaded but not running.
 */
export function parseAppStateFromLaunchctlList(stdout: string, bundleId: string): { running: boolean; pid: number | null } {
  const prefix = `UIKitApplication:${bundleId}`;
  for (const line of stdout.split("\n")) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 3) {
      continue;
    }
    const label = columns[columns.length - 1] ?? "";
    if (label !== prefix && !label.startsWith(`${prefix}[`)) {
      continue;
    }
    const rawPid = columns[0] ?? "-";
    const pid = Number.parseInt(rawPid, 10);
    if (!Number.isFinite(pid) || pid <= 0) {
      return { running: false, pid: null };
    }
    return { running: true, pid };
  }
  return { running: false, pid: null };
}

function parseToggleOutput(stdout: string): boolean | null {
  const value = stdout.trim().toLowerCase();
  if (value === "enabled") {
    return true;
  }
  if (value === "disabled") {
    return false;
  }
  return null;
}

function parseDefaultsBoolean(stdout: string): boolean | null {
  const value = stdout.trim().toLowerCase();
  if (value === "1" || value === "true" || value === "yes") {
    return true;
  }
  if (value === "0" || value === "false" || value === "no") {
    return false;
  }
  return null;
}

export function createIosDeviceTools(deps: IosDeviceToolsDeps): IosDeviceTools {
  const now = deps.now ?? (() => new Date());

  async function simctl(args: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
    const result = await deps.run("xcrun", ["simctl", ...args], { timeoutMs });
    return result.stdout;
  }

  async function readAppearance(deviceUdid: string): Promise<IosSimulatorDeviceSettings["appearance"]> {
    try {
      const value = (await simctl(["ui", deviceUdid, "appearance"])).trim().toLowerCase();
      if (value === "light" || value === "dark" || value === "unsupported") {
        return value;
      }
      return "unknown";
    } catch {
      return "unknown";
    }
  }

  async function readContentSize(deviceUdid: string): Promise<string> {
    try {
      const value = (await simctl(["ui", deviceUdid, "content_size"])).trim();
      return value.length > 0 ? value : "unknown";
    } catch {
      return "unknown";
    }
  }

  /**
   * Reads `increase_contrast`. An older runtime prints `unsupported`, which is
   * not an error and not a value: it reads as null.
   */
  async function readIncreaseContrast(deviceUdid: string): Promise<boolean | null> {
    try {
      return parseToggleOutput(await simctl(["ui", deviceUdid, "increase_contrast"]));
    } catch {
      return null;
    }
  }

  /**
   * Reads one `com.apple.Accessibility` preference.
   *
   * `defaults read` exits non-zero when the key was never written. That is the
   * normal state of a toggle that nobody turned on, so it reads as false.
   */
  async function readAccessibilityPreference(deviceUdid: string, key: string): Promise<boolean | null> {
    try {
      const stdout = await simctl(["spawn", deviceUdid, "defaults", "read", ACCESSIBILITY_DEFAULTS_DOMAIN, key]);
      return parseDefaultsBoolean(stdout);
    } catch {
      return false;
    }
  }

  async function readSettings(deviceUdid: string): Promise<IosSimulatorDeviceSettings> {
    const udid = assertDeviceUdid(deviceUdid);

    // Every read is independent, so one failure must not hide the rest.
    const [core, preferenceResults] = await Promise.all([
      Promise.allSettled([readAppearance(udid), readContentSize(udid), readIncreaseContrast(udid)] as const),
      Promise.allSettled(
        ACCESSIBILITY_PREFERENCE_OPTIONS.map((option) =>
          readAccessibilityPreference(udid, IOS_ACCESSIBILITY_PREFERENCES[option].key),
        ),
      ),
    ]);
    const [appearanceResult, contentSizeResult, contrastResult] = core;

    const accessibility = {
      "increase-contrast": contrastResult.status === "fulfilled" ? contrastResult.value : null,
    } as Record<IosSimulatorAccessibilityOption, boolean | null>;
    ACCESSIBILITY_PREFERENCE_OPTIONS.forEach((option, index) => {
      const result = preferenceResults[index];
      accessibility[option] = result?.status === "fulfilled" ? result.value : null;
    });

    return {
      deviceUdid: udid,
      appearance: appearanceResult.status === "fulfilled" ? appearanceResult.value : "unknown",
      contentSize: contentSizeResult.status === "fulfilled"
        ? normalizeContentSize(contentSizeResult.value)
        : "unknown",
      accessibility,
      // The service that owns the device record fills these in. simctl cannot
      // read a location or a status bar override back.
      location: null,
      statusBarOverridden: false,
      readAt: now().toISOString(),
    };
  }

  async function setAppearance(deviceUdid: string, appearance: IosSimulatorAppearance): Promise<void> {
    const udid = assertDeviceUdid(deviceUdid);
    await simctl(["ui", udid, "appearance", assertAppearance(appearance)]);
  }

  async function setContentSize(deviceUdid: string, contentSize: IosSimulatorContentSize): Promise<void> {
    const udid = assertDeviceUdid(deviceUdid);
    await simctl(["ui", udid, "content_size", assertContentSize(contentSize)]);
  }

  async function setAccessibilityOption(
    deviceUdid: string,
    option: IosSimulatorAccessibilityOption,
    enabled: boolean,
  ): Promise<void> {
    const udid = assertDeviceUdid(deviceUdid);
    if (option === "increase-contrast") {
      await simctl(["ui", udid, "increase_contrast", enabled ? "enabled" : "disabled"]);
      return;
    }
    const preference = IOS_ACCESSIBILITY_PREFERENCES[option];
    if (!preference) {
      throw new Error(
        `Unsupported accessibility option "${String(option)}". Allowed values: increase-contrast, ${ACCESSIBILITY_PREFERENCE_OPTIONS.join(", ")}.`,
      );
    }
    await simctl([
      "spawn",
      udid,
      "defaults",
      "write",
      ACCESSIBILITY_DEFAULTS_DOMAIN,
      preference.key,
      "-bool",
      enabled ? "true" : "false",
    ]);
    // The write alone changes nothing on screen. The notification applies it.
    await simctl(["spawn", udid, "notifyutil", "-p", preference.notification]);
  }

  async function setLocation(deviceUdid: string, location: IosSimulatorLocation): Promise<void> {
    const udid = assertDeviceUdid(deviceUdid);
    const latitude = assertNumberInRange(location.latitude, -90, 90, "latitude");
    const longitude = assertNumberInRange(location.longitude, -180, 180, "longitude");
    await simctl(["location", udid, "set", `${latitude},${longitude}`]);
  }

  async function clearLocation(deviceUdid: string): Promise<void> {
    const udid = assertDeviceUdid(deviceUdid);
    await simctl(["location", udid, "clear"]);
  }

  async function setPermission(args: IosDeviceToolsPermissionArgs): Promise<void> {
    const udid = assertDeviceUdid(args.deviceUdid);
    const service = assertPrivacyService(args.service);
    const action = args.action;
    if (action !== "grant" && action !== "revoke" && action !== "reset") {
      throw new Error(`Unsupported privacy action "${String(action)}". Allowed values: grant, revoke, reset.`);
    }
    // `reset` takes a whole service back to its default state, so it has no
    // bundle id. `grant` and `revoke` act on one app and need one.
    if (action === "reset") {
      await simctl(["privacy", udid, action, service]);
      return;
    }
    const bundleId = assertBundleId(args.bundleId, `bundle id for a "${action}"`);
    await simctl(["privacy", udid, action, service, bundleId]);
  }

  async function sendPush(args: IosDeviceToolsPushArgs): Promise<void> {
    const udid = assertDeviceUdid(args.deviceUdid);
    const bundleId = assertBundleId(args.bundleId);
    const payload = buildPushPayload({
      payload: args.payload,
      title: args.title,
      body: args.body,
      bundleId,
    });
    const filePath = await deps.writeTempFile(JSON.stringify(payload, null, 2), ".json");
    try {
      await simctl(["push", udid, bundleId, filePath]);
    } finally {
      // The payload can hold user text, so it never stays on disk.
      await deps.removeFile(filePath);
    }
  }

  async function openUrl(deviceUdid: string, url: string): Promise<void> {
    const udid = assertDeviceUdid(deviceUdid);
    await simctl(["openurl", udid, assertUrl(url)]);
  }

  /** Starts an app that is already installed. Does not build anything. */
  async function launchApp(deviceUdid: string, bundleId: string): Promise<void> {
    const udid = assertDeviceUdid(deviceUdid);
    await simctl(["launch", udid, assertBundleId(bundleId)], LAUNCH_TIMEOUT_MS);
  }

  async function terminateApp(deviceUdid: string, bundleId: string): Promise<void> {
    const udid = assertDeviceUdid(deviceUdid);
    await simctl(["terminate", udid, assertBundleId(bundleId)]);
  }

  async function uninstallApp(deviceUdid: string, bundleId: string): Promise<void> {
    const udid = assertDeviceUdid(deviceUdid);
    await simctl(["uninstall", udid, assertBundleId(bundleId)], UNINSTALL_TIMEOUT_MS);
  }

  async function setStatusBar(args: IosDeviceToolsStatusBarArgs): Promise<void> {
    const udid = assertDeviceUdid(args.deviceUdid);
    const flags: string[] = [];

    if (args.time !== undefined && args.time !== null) {
      const time = args.time.trim();
      if (!time) {
        throw new Error("Invalid status bar time \"\". Allowed values: a non-empty time such as 9:41.");
      }
      flags.push("--time", time);
    }
    if (args.dataNetwork !== undefined && args.dataNetwork !== null) {
      const dataNetwork = args.dataNetwork.trim();
      if (!dataNetwork) {
        throw new Error("Invalid status bar dataNetwork \"\". Allowed values: a non-empty network such as wifi or 5g.");
      }
      flags.push("--dataNetwork", dataNetwork);
    }
    if (args.wifiBars !== undefined && args.wifiBars !== null) {
      flags.push("--wifiBars", String(assertIntegerInRange(args.wifiBars, 0, 3, "wifiBars")));
    }
    if (args.cellularBars !== undefined && args.cellularBars !== null) {
      flags.push("--cellularBars", String(assertIntegerInRange(args.cellularBars, 0, 4, "cellularBars")));
    }
    if (args.batteryState !== undefined && args.batteryState !== null) {
      const batteryState = args.batteryState;
      if (batteryState !== "charging" && batteryState !== "charged" && batteryState !== "discharging") {
        throw new Error(
          `Invalid batteryState "${String(batteryState)}". Allowed values: charging, charged, discharging.`,
        );
      }
      flags.push("--batteryState", batteryState);
    }
    if (args.batteryLevel !== undefined && args.batteryLevel !== null) {
      flags.push("--batteryLevel", String(assertIntegerInRange(args.batteryLevel, 0, 100, "batteryLevel")));
    }

    if (flags.length === 0) {
      throw new Error("A status bar override needs at least one field. Allowed fields: time, dataNetwork, wifiBars, cellularBars, batteryState, batteryLevel.");
    }

    await simctl(["status_bar", udid, "override", ...flags]);
  }

  async function clearStatusBar(deviceUdid: string): Promise<void> {
    const udid = assertDeviceUdid(deviceUdid);
    await simctl(["status_bar", udid, "clear"]);
  }

  async function getAppState(deviceUdid: string, bundleId: string): Promise<IosSimulatorAppState> {
    const udid = assertDeviceUdid(deviceUdid);
    const app = assertBundleId(bundleId);
    const checkedAt = now().toISOString();
    let stdout = "";
    try {
      stdout = await simctl(["spawn", udid, "launchctl", "list"]);
    } catch {
      // A shut down device answers nothing. Report "not running" rather than
      // failing the whole tools panel.
      return { bundleId: app, running: false, pid: null, checkedAt };
    }
    const parsed = parseAppStateFromLaunchctlList(stdout, app);
    return { bundleId: app, running: parsed.running, pid: parsed.pid, checkedAt };
  }

  return {
    readSettings,
    setAppearance,
    setContentSize,
    setAccessibilityOption,
    setLocation,
    clearLocation,
    setPermission,
    sendPush,
    openUrl,
    launchApp,
    terminateApp,
    uninstallApp,
    setStatusBar,
    clearStatusBar,
    getAppState,
  };
}
