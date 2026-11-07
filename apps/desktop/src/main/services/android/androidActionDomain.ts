/**
 * The `android_emulator` action domain: one Android emulator per lane, reached
 * by agents and by `ade android` through the action bus, and by a viewing
 * client on another machine through the same bus.
 *
 * Only argument reading lives here. Every method is one call on
 * `AndroidEmulatorServiceApi`; who may call what is `actionPolicy.ts`'s job
 * (and the RPC server's lane scoping), and nothing here touches adb.
 *
 * There is no platform gate in front of the methods, unlike Mac Desktop. The
 * service refuses with its own coded error (`ANDROID_SDK_NOT_FOUND: …`,
 * `ANDROID_NOT_RUNNING: …`) from `AndroidEmulatorFailure`, which already has
 * the `CODE: message` shape the CLI hint table keys on, and a `getStatus`
 * read in front of every `sendTouch` would double the cost of each pointer
 * move a viewer sends.
 */

import {
  ANDROID_FOLD_POSES,
  ANDROID_HARDWARE_KEYS,
  ANDROID_LOG_LEVELS,
  ANDROID_ORIENTATIONS,
  ANDROID_SCROLL_DIRECTIONS,
  ANDROID_SDK_CONSENT_SURFACES,
  ANDROID_STATUS_BAR_BATTERY_STATES,
  ANDROID_WINDOW_LAYOUT_ACTIONS,
  type AndroidElementQuery,
  type AndroidIntentExtraInput,
  type AndroidLaunchExtrasArgs,
  type AndroidEmulatorServiceApi,
  type AndroidGradleTarget,
  type AndroidTouchEvent,
} from "../../../shared/types/androidEmulator";
import { createDomainArgReaders } from "../adeActions/domainArgs";
import { readAndroidDeviceSetting } from "./androidDeviceSettings";

/** What the registry passes in. Exactly the one field this domain reads. */
export type AndroidActionRuntime = {
  androidEmulatorService?: AndroidEmulatorServiceApi | null;
};

/**
 * The registry's opaque service shape: a bag of methods taking unknown args.
 * Re-declared rather than imported to keep this module free of the registry.
 */
type OpaqueService = Record<string, (args?: unknown) => unknown>;

const TOUCH_ACTIONS = ["down", "move", "up"] as const;

const {
  objectArgs,
  optionalString,
  requiredString,
  optionalNumber,
  requiredNumber,
  optionalBoolean: readBoolean,
  enumValue: enumOf,
  requiredLaneId,
  optionalLaneId: readOptionalLaneId,
} = createDomainArgReaders("androidEmulator");

function laneArgs(args: unknown, action: string): { laneId: string } {
  return { laneId: requiredLaneId(args, action) };
}

function optionalLaneId(args: unknown): { laneId: string | null } {
  return { laneId: readOptionalLaneId(args) };
}

/** Omitted stays omitted: the service applies its own default (true for `start`). */
function optionalBoolean(args: unknown, key: string): boolean | undefined {
  return readBoolean(args, key) ?? undefined;
}

/** `fqns`: a list of strings, or omitted (every preview). */
function previewFqns(args: unknown): string[] | null {
  const raw = objectArgs(args).fqns;
  if (raw == null) return null;
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string")) {
    throw new Error("androidEmulator.renderComposePreviews: fqns must be a list of strings.");
  }
  return raw as string[];
}

function touchEvents(args: unknown): AndroidTouchEvent[] {
  const raw = objectArgs(args).events;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("androidEmulator.sendTouch requires events (a non-empty list).");
  }
  return raw.map((entry) => {
    const event = objectArgs(entry);
    const pointerId = optionalNumber(event, "pointerId");
    return {
      action: enumOf(event.action, "action", TOUCH_ACTIONS, "sendTouch"),
      x: requiredNumber(event, "x", "sendTouch"),
      y: requiredNumber(event, "y", "sendTouch"),
      ...(pointerId == null ? {} : { pointerId }),
    };
  });
}

/** The element query of an element verb (`query: {ref, identifier, label, text, role, index}`). */
function elementQuery(args: unknown, action: string): AndroidElementQuery {
  const raw = objectArgs(args).query;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`androidEmulator.${action} requires query (ref, identifier, label, text or role).`);
  }
  const index = optionalNumber(raw, "index");
  return {
    ref: optionalString(raw, "ref"),
    identifier: optionalString(raw, "identifier"),
    label: optionalString(raw, "label"),
    // Not trimmed away to nothing by the reader: a text query is matched as given.
    text: optionalString(raw, "text"),
    role: optionalString(raw, "role"),
    ...(index == null ? {} : { index }),
  };
}

/** `gradle: {module?, variant?}`, or `gradle: true` for the defaults (`app`, `debug`). */
function gradleTarget(args: unknown): AndroidGradleTarget | null {
  const raw = objectArgs(args).gradle;
  if (raw == null || raw === false) return null;
  if (raw === true) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("androidEmulator.installApp gradle must be an object ({module, variant}).");
  return { module: optionalString(raw, "module"), variant: optionalString(raw, "variant") };
}

/**
 * Rec: who drove an input and whether it may start an automatic recording.
 * The desktop preload sends `source: "user"` for the pane; the RPC server
 * sets `chatSessionId` for an agent. Absent fields stay absent.
 */
export function inputRecordArgs(args: unknown): { source?: "user" | "agent"; noRecord?: boolean; chatSessionId?: string } {
  const source = optionalString(args, "source");
  const noRecord = readBoolean(args, "noRecord");
  const chatSessionId = optionalString(args, "chatSessionId");
  return {
    ...(source === "user" || source === "agent" ? { source } : {}),
    ...(noRecord === true ? { noRecord: true } : {}),
    ...(chatSessionId ? { chatSessionId } : {}),
  };
}

/**
 * Parity: launch arguments (`arguments: string[]`) and intent extras
 * (`extras: [{key, type, value}]`). Only the shape is read here: the service
 * (`androidLaunchWords`) is the one validator of keys, types and values. A
 * JSON caller may send a number or a bool as the value; it becomes a string.
 */
function launchExtrasArgs(args: unknown, action: string): AndroidLaunchExtrasArgs {
  const raw = objectArgs(args);
  const out: AndroidLaunchExtrasArgs = {};
  if (raw.arguments != null) {
    if (!Array.isArray(raw.arguments)) throw new Error(`androidEmulator.${action} arguments must be a list of strings.`);
    out.arguments = raw.arguments;
  }
  if (raw.extras != null) {
    if (!Array.isArray(raw.extras)) throw new Error(`androidEmulator.${action} extras must be a list of {key, type, value}.`);
    out.extras = raw.extras.map((entry): AndroidIntentExtraInput => {
      const extra = objectArgs(entry);
      const value = extra.value;
      return {
        key: extra.key,
        type: optionalString(extra, "type") ?? "string",
        value: typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : "",
      };
    });
  }
  return out;
}

/** `device`: one of the lane's extra devices (AVD name or shown name); omitted = the lane's device. */
function deviceArg(args: unknown): { device?: string } {
  const device = optionalString(args, "device");
  return device ? { device } : {};
}

function installArgs(args: unknown) {
  return { apkPath: optionalString(args, "apkPath"), gradle: gradleTarget(args), ...deviceArg(args) };
}

export function buildAndroidDomainService(runtime: AndroidActionRuntime): OpaqueService | null {
  const service: AndroidEmulatorServiceApi | null = runtime.androidEmulatorService ?? null;
  // A chat-only brain, or a host that built no service: the domain is absent.
  if (!service) return null;
  return {
    getStatus: (args?: unknown) => service.getStatus(optionalLaneId(args)),
    listDevices: (args?: unknown) => service.listDevices({
      ...optionalLaneId(args),
      // P1 look: the picker's Storage section asks for sizes.
      ...(objectArgs(args).measureSizes === true ? { measureSizes: true } : {}),
    }),
    createDevice: (args?: unknown) => service.createDevice({
      ...laneArgs(args, "createDevice"),
      // P1 look: a catalog device names its own profile.
      profileId: optionalString(args, "catalogId") ? optionalString(args, "profileId") ?? "" : requiredString(args, "profileId", "createDevice"),
      systemImage: optionalString(args, "systemImage"),
      displayName: optionalString(args, "displayName"),
      start: optionalBoolean(args, "start"),
      catalogId: optionalString(args, "catalogId"),
      colorId: optionalString(args, "colorId"),
      // An extra device beside the lane's own (`device-create --extra`).
      ...(readBoolean(args, "extra") === true ? { extra: true } : {}),
    }),
    attachDevice: (args?: unknown) => service.attachDevice({
      ...laneArgs(args, "attachDevice"),
      avdName: requiredString(args, "avdName", "attachDevice"),
      start: optionalBoolean(args, "start"),
    }),
    start: (args?: unknown) => service.start({
      ...laneArgs(args, "start"),
      ...(readBoolean(args, "force") === true ? { force: true } : {}),
      ...(readBoolean(args, "restartAdb") === true ? { restartAdb: true } : {}),
      ...deviceArg(args),
    }),
    stop: (args?: unknown) => service.stop({ ...laneArgs(args, "stop"), ...deviceArg(args) }),
    releaseDevice: (args?: unknown) => service.releaseDevice({
      ...laneArgs(args, "releaseDevice"),
      deleteCreated: optionalBoolean(args, "deleteCreated"),
      ...deviceArg(args),
    }),
    // One of the lane's extras becomes its device. The RPC server sets the caller's chat (its own lease is no refusal).
    devicePromote: (args?: unknown) => service.devicePromote({
      ...laneArgs(args, "devicePromote"),
      device: requiredString(args, "device", "devicePromote"),
      chatSessionId: optionalString(args, "chatSessionId"),
    }),
    // User-only (`ANDROID_USER_ONLY_ACTIONS`): an agent releases its lane's
    // device instead, which deletes only the AVD ADE made for that lane.
    deleteDevice: (args?: unknown) => service.deleteDevice({
      avdName: requiredString(args, "avdName", "deleteDevice"),
    }),
    // P1 setup. An agent may read the plan and the install's progress;
    // `installSdk`, `cancelSdkInstall` and `setSdkPath` are user-only: a
    // licence is the user's to accept, and the SDK choice is theirs.
    getSdkSetupPlan: (args?: unknown) => service.getSdkSetupPlan({
      sdkRoot: optionalString(args, "sdkRoot"),
      includeAndroidCli: optionalBoolean(args, "includeAndroidCli"),
    }),
    installSdk: (args?: unknown) => {
      const raw = objectArgs(args).acceptedLicenseIds;
      const surfaceArg = optionalString(args, "surface");
      if (!Array.isArray(raw) || raw.some((id) => typeof id !== "string")) {
        throw new Error("androidEmulator.installSdk requires acceptedLicenseIds (a list of licence ids).");
      }
      return service.installSdk({
        sdkRoot: optionalString(args, "sdkRoot"),
        includeAndroidCli: optionalBoolean(args, "includeAndroidCli"),
        acceptedLicenseIds: raw as string[],
        // Where the user accepted the licences, for the licence file.
        surface: surfaceArg == null ? null : enumOf(surfaceArg, "surface", ANDROID_SDK_CONSENT_SURFACES, "installSdk"),
      });
    },
    cancelSdkInstall: () => service.cancelSdkInstall(),
    getSdkInstallState: () => service.getSdkInstallState(),
    setSdkPath: (args?: unknown) => {
      const value = objectArgs(args).path;
      if (value !== null && typeof value !== "string") throw new Error("androidEmulator.setSdkPath requires path (a folder, or null).");
      return service.setSdkPath({ path: value });
    },
    // P3 system images. An agent may read the list. Install and remove are
    // the person's (`ANDROID_SDK_PERSON_ONLY_ACTIONS`): a licence to accept,
    // gigabytes on disk, and AVDs that can lose the image they boot.
    listSystemImages: (args?: unknown) => service.listSystemImages({
      ...optionalLaneId(args),
      ...(objectArgs(args).includeAvailable === false ? { includeAvailable: false } : {}),
    }),
    installSystemImage: (args?: unknown) => {
      const raw = objectArgs(args).acceptedLicenseIds;
      if (!Array.isArray(raw) || raw.some((id) => typeof id !== "string")) {
        throw new Error("androidEmulator.installSystemImage requires acceptedLicenseIds (a list of licence ids).");
      }
      return service.installSystemImage({
        ...optionalLaneId(args),
        id: requiredString(args, "id", "installSystemImage"),
        acceptedLicenseIds: raw as string[],
      });
    },
    removeSystemImage: (args?: unknown) => service.removeSystemImage({
      ...optionalLaneId(args),
      id: requiredString(args, "id", "removeSystemImage"),
      confirmedInUse: readBoolean(args, "confirmedInUse") === true,
    }),
    // User-only and secret-bearing: the one call that mints the loopback
    // stream token. An agent reads the redacted `getStreamStatus`.
    startStream: (args?: unknown) => service.startStream({
      ...laneArgs(args, "startStream"),
      maxSize: optionalNumber(args, "maxSize"),
      bitRateBps: optionalNumber(args, "bitRateBps"),
      maxFps: optionalNumber(args, "maxFps"),
      remoteViewer: optionalBoolean(args, "remoteViewer"),
    }),
    stopStream: (args?: unknown) => service.stopStream({
      ...laneArgs(args, "stopStream"),
      remoteViewer: optionalBoolean(args, "remoteViewer"),
    }),
    getStreamStatus: (args?: unknown) => service.getStreamStatus({
      ...laneArgs(args, "getStreamStatus"),
      remoteViewer: optionalBoolean(args, "remoteViewer"),
    }),
    // User-only: a viewer's live finger. An agent taps and swipes.
    sendTouch: (args?: unknown) => service.sendTouch({
      ...laneArgs(args, "sendTouch"),
      ...inputRecordArgs(args),
      events: touchEvents(args),
    }),
    tap: (args?: unknown) => service.tap({
      ...laneArgs(args, "tap"),
      ...inputRecordArgs(args),
      x: requiredNumber(args, "x", "tap"),
      y: requiredNumber(args, "y", "tap"),
    }),
    swipe: (args?: unknown) => service.swipe({
      ...laneArgs(args, "swipe"),
      ...inputRecordArgs(args),
      fromX: requiredNumber(args, "fromX", "swipe"),
      fromY: requiredNumber(args, "fromY", "swipe"),
      toX: requiredNumber(args, "toX", "swipe"),
      toY: requiredNumber(args, "toY", "swipe"),
      durationMs: optionalNumber(args, "durationMs"),
    }),
    sendKey: (args?: unknown) => service.sendKey({
      ...laneArgs(args, "sendKey"),
      ...inputRecordArgs(args),
      key: enumOf(optionalString(args, "key"), "key", ANDROID_HARDWARE_KEYS, "sendKey"),
    }),
    rotate: (args?: unknown) => service.rotate({
      ...laneArgs(args, "rotate"),
      orientation: enumOf(optionalString(args, "orientation"), "orientation", ANDROID_ORIENTATIONS, "rotate"),
    }),
    sendText: (args?: unknown) => {
      // Not trimmed: a leading or trailing space is part of what is typed.
      const text = objectArgs(args).text;
      // Parity: `type --submit` presses Enter after the text; with no text it presses Enter alone.
      const submit = readBoolean(args, "submit") === true;
      if (typeof text !== "string" || (text.length === 0 && !submit)) {
        throw new Error("androidEmulator.sendText requires text.");
      }
      return service.sendText({ ...laneArgs(args, "sendText"), ...inputRecordArgs(args), text, ...(submit ? { submit: true } : {}) });
    },
    screenshot: (args?: unknown) => service.screenshot({
      ...laneArgs(args, "screenshot"),
      outPath: optionalString(args, "outPath"),
      // P1 agent suite: the proof drawer. The RPC server sets the chat.
      chatSessionId: optionalString(args, "chatSessionId"),
      caption: optionalString(args, "caption"),
      proof: optionalBoolean(args, "proof"),
    }),
    /* ── P1 agent suite (`androidAgentSuite.ts`) ── */
    listApps: (args?: unknown) => service.listApps(laneArgs(args, "listApps")),
    installApp: (args?: unknown) => service.installApp({ ...laneArgs(args, "installApp"), ...installArgs(args) }),
    launchApp: (args?: unknown) => service.launchApp({
      ...laneArgs(args, "launchApp"),
      ...installArgs(args),
      packageName: optionalString(args, "packageName"),
      activity: optionalString(args, "activity"),
      ...launchExtrasArgs(args, "launchApp"),
    }),
    /* ── Parity (`androidEmulatorControl.ts`) ── */
    pressKey: (args?: unknown) => {
      const raw = objectArgs(args).modifiers;
      if (raw != null && (!Array.isArray(raw) || raw.some((name) => typeof name !== "string"))) {
        throw new Error("androidEmulator.pressKey modifiers must be a list of names (shift, ctrl, alt, meta).");
      }
      return service.pressKey({
        ...laneArgs(args, "pressKey"),
        ...inputRecordArgs(args),
        key: requiredString(args, "key", "pressKey"),
        ...(raw ? { modifiers: raw as string[] } : {}),
      });
    },
    relaunchApp: (args?: unknown) => service.relaunchApp({
      ...laneArgs(args, "relaunchApp"),
      packageName: requiredString(args, "packageName", "relaunchApp"),
      activity: optionalString(args, "activity"),
      ...launchExtrasArgs(args, "relaunchApp"),
    }),
    getAppState: (args?: unknown) => service.getAppState({
      ...laneArgs(args, "getAppState"),
      packageName: requiredString(args, "packageName", "getAppState"),
    }),
    getForegroundApp: (args?: unknown) => service.getForegroundApp({
      ...laneArgs(args, "getForegroundApp"),
      waitMs: optionalNumber(args, "waitMs"),
      packageName: optionalString(args, "packageName"),
    }),
    frame: (args?: unknown) => service.frame({ ...laneArgs(args, "frame"), outPath: optionalString(args, "outPath") }),
    inspectPoint: (args?: unknown) => service.inspectPoint({
      ...laneArgs(args, "inspectPoint"),
      x: requiredNumber(args, "x", "inspectPoint"),
      y: requiredNumber(args, "y", "inspectPoint"),
      ref: optionalString(args, "ref"),
      includeScreenshot: readBoolean(args, "includeScreenshot") === true,
    }),
    selectPoint: (args?: unknown) => service.selectPoint({
      ...laneArgs(args, "selectPoint"),
      ...inputRecordArgs(args),
      x: requiredNumber(args, "x", "selectPoint"),
      y: requiredNumber(args, "y", "selectPoint"),
      ref: optionalString(args, "ref"),
    }),
    // Lane-free: the pass is about the machine's lanes. An agent's power-off reaches its own lane only.
    deviceCleanup: (args?: unknown) => service.deviceCleanup({
      ...optionalLaneId(args),
      powerOffIdle: readBoolean(args, "powerOffIdle") === true,
      dryRun: readBoolean(args, "dryRun") === true,
      agentCaller: readBoolean(args, "agentCaller") === true,
    }),
    terminateApp: (args?: unknown) => service.terminateApp({
      ...laneArgs(args, "terminateApp"),
      packageName: requiredString(args, "packageName", "terminateApp"),
    }),
    uninstallApp: (args?: unknown) => service.uninstallApp({
      ...laneArgs(args, "uninstallApp"),
      packageName: requiredString(args, "packageName", "uninstallApp"),
    }),
    // P3: `ade android test`. The Gradle target reads as the install's does.
    runInstrumentationTests: (args?: unknown) => service.runInstrumentationTests({
      ...laneArgs(args, "runInstrumentationTests"),
      gradle: gradleTarget(args) ?? {},
      className: optionalString(args, "className"),
      method: optionalString(args, "method"),
    }),
    openUrl: (args?: unknown) => service.openUrl({ ...laneArgs(args, "openUrl"), ...inputRecordArgs(args), url: requiredString(args, "url", "openUrl") }),
    longPress: (args?: unknown) => service.longPress({
      ...laneArgs(args, "longPress"),
      ...inputRecordArgs(args),
      x: requiredNumber(args, "x", "longPress"),
      y: requiredNumber(args, "y", "longPress"),
      durationMs: optionalNumber(args, "durationMs"),
    }),
    drag: (args?: unknown) => service.drag({
      ...laneArgs(args, "drag"),
      ...inputRecordArgs(args),
      fromX: requiredNumber(args, "fromX", "drag"),
      fromY: requiredNumber(args, "fromY", "drag"),
      toX: requiredNumber(args, "toX", "drag"),
      toY: requiredNumber(args, "toY", "drag"),
      durationMs: optionalNumber(args, "durationMs"),
    }),
    scroll: (args?: unknown) => service.scroll({
      ...laneArgs(args, "scroll"),
      ...inputRecordArgs(args),
      direction: enumOf(optionalString(args, "direction"), "direction", ANDROID_SCROLL_DIRECTIONS, "scroll"),
      amount: optionalNumber(args, "amount"),
      anchorX: optionalNumber(args, "anchorX"),
      anchorY: optionalNumber(args, "anchorY"),
    }),
    getScreenSnapshot: (args?: unknown) => service.getScreenSnapshot({
      ...laneArgs(args, "getScreenSnapshot"),
      fresh: optionalBoolean(args, "fresh"),
    }),
    findElement: (args?: unknown) => service.findElement({ ...laneArgs(args, "findElement"), query: elementQuery(args, "findElement") }),
    tapElement: (args?: unknown) => service.tapElement({
      ...laneArgs(args, "tapElement"),
      ...inputRecordArgs(args),
      query: elementQuery(args, "tapElement"),
      holdMs: optionalNumber(args, "holdMs"),
    }),
    fillElement: (args?: unknown) => {
      // Not trimmed: a leading or trailing space is part of what is typed.
      const text = objectArgs(args).text;
      if (typeof text !== "string" || text.length === 0) throw new Error("androidEmulator.fillElement requires text.");
      return service.fillElement({
        ...laneArgs(args, "fillElement"),
        ...inputRecordArgs(args),
        query: elementQuery(args, "fillElement"),
        text,
        focusFirst: optionalBoolean(args, "focusFirst"),
      });
    },
    waitForElement: (args?: unknown) => {
      const state = optionalString(args, "state");
      return service.waitForElement({
        ...laneArgs(args, "waitForElement"),
        query: elementQuery(args, "waitForElement"),
        timeoutMs: optionalNumber(args, "timeoutMs"),
        state: state ? enumOf(state, "state", ["visible", "gone"] as const, "waitForElement") : null,
      });
    },
    assertVisible: (args?: unknown) => service.assertVisible({ ...laneArgs(args, "assertVisible"), query: elementQuery(args, "assertVisible") }),
    readLog: (args?: unknown) => {
      const level = optionalString(args, "level");
      return service.readLog({
        ...laneArgs(args, "readLog"),
        packageName: optionalString(args, "packageName"),
        level: level ? enumOf(level, "level", ANDROID_LOG_LEVELS, "readLog") : null,
        since: optionalString(args, "since"),
        lines: optionalNumber(args, "lines"),
      });
    },
    recordStart: (args?: unknown) => service.recordStart({
      ...laneArgs(args, "recordStart"),
      chatSessionId: optionalString(args, "chatSessionId"),
      label: optionalString(args, "label"),
      maxSeconds: optionalNumber(args, "maxSeconds"),
      plain: readBoolean(args, "plain") === true || readBoolean(args, "keepIdle") === true,
      zoom: readBoolean(args, "zoom") === true,
    }),
    recordStop: (args?: unknown) => service.recordStop({
      ...laneArgs(args, "recordStop"),
      chatSessionId: optionalString(args, "chatSessionId"),
      discard: optionalBoolean(args, "discard"),
      keep: optionalBoolean(args, "keep"),
      proof: optionalBoolean(args, "proof"),
    }),
    // Rec: the lane's auto-record switch, and the machine preferences (the write is the person's).
    getAutoRecord: (args?: unknown) => service.getAutoRecord(laneArgs(args, "getAutoRecord")),
    setAutoRecord: (args?: unknown) => {
      const enabled = readBoolean(args, "enabled");
      if (enabled == null) throw new Error("androidEmulator.setAutoRecord requires enabled (true or false).");
      return service.setAutoRecord({ ...laneArgs(args, "setAutoRecord"), enabled });
    },
    getMachinePreferences: () => service.getMachinePreferences({}),
    setMachinePreferences: (args?: unknown) => {
      const raw = objectArgs(args);
      const patch: Record<string, unknown> = {};
      for (const key of ["tapRings", "keyBadges", "autoRecordAgentInput"] as const) {
        if (raw[key] === undefined) continue;
        if (typeof raw[key] !== "boolean") throw new Error(`androidEmulator.setMachinePreferences ${key} must be true or false.`);
        patch[key] = raw[key];
      }
      for (const key of ["recordingsWarnBytes", "remoteBitrateKbpsCap"] as const) {
        if (raw[key] === undefined) continue;
        if (typeof raw[key] !== "number" || !Number.isFinite(raw[key])) throw new Error(`androidEmulator.setMachinePreferences ${key} must be a number.`);
        patch[key] = raw[key];
      }
      return service.setMachinePreferences(patch);
    },
    recordList: (args?: unknown) => service.recordList(laneArgs(args, "recordList")),
    recordDelete: (args?: unknown) => service.recordDelete({ ...laneArgs(args, "recordDelete"), id: requiredString(args, "id", "recordDelete") }),
    deviceLease: (args?: unknown) => {
      const signal = objectArgs(args).connectionSignal;
      return service.deviceLease({
        ...laneArgs(args, "deviceLease"),
        chatSessionId: optionalString(args, "chatSessionId"),
        holder: optionalString(args, "holder"),
        ttlMs: optionalNumber(args, "ttlMs"),
        waitMs: optionalNumber(args, "waitMs"),
        token: optionalString(args, "token"),
        distinct: optionalBoolean(args, "distinct"),
        // Set by the RPC server: a waiter whose caller went away leaves the line.
        ...(signal instanceof AbortSignal ? { connectionSignal: signal } : {}),
      });
    },
    deviceLeaseRelease: (args?: unknown) => service.deviceLeaseRelease({
      ...laneArgs(args, "deviceLeaseRelease"),
      token: requiredString(args, "token", "deviceLeaseRelease"),
      chatSessionId: optionalString(args, "chatSessionId"),
    }),
    deviceLeaseStatus: (args?: unknown) => service.deviceLeaseStatus(laneArgs(args, "deviceLeaseStatus")),
    setLocation: (args?: unknown) => service.setLocation({
      ...laneArgs(args, "setLocation"),
      latitude: requiredNumber(args, "latitude", "setLocation"),
      longitude: requiredNumber(args, "longitude", "setLocation"),
    }),
    setAppearance: (args?: unknown) => service.setAppearance({
      ...laneArgs(args, "setAppearance"),
      appearance: enumOf(optionalString(args, "appearance"), "appearance", ["light", "dark"] as const, "setAppearance"),
    }),
    setPermission: (args?: unknown) => service.setPermission({
      ...laneArgs(args, "setPermission"),
      action: enumOf(optionalString(args, "action"), "action", ["grant", "revoke"] as const, "setPermission"),
      packageName: requiredString(args, "packageName", "setPermission"),
      permission: requiredString(args, "permission", "setPermission"),
    }),
    // P3 fold.
    getPosture: (args?: unknown) => service.getPosture(laneArgs(args, "getPosture")),
    setPosture: (args?: unknown) => {
      const pose = optionalString(args, "pose");
      return service.setPosture({
        ...laneArgs(args, "setPosture"),
        angle: optionalNumber(args, "angle"),
        pose: pose ? enumOf(pose, "pose", ANDROID_FOLD_POSES, "setPosture") : null,
      });
    },
    // P3 Compose previews.
    listComposePreviews: (args?: unknown) => service.listComposePreviews({
      ...laneArgs(args, "listComposePreviews"),
      module: optionalString(args, "module"),
      all: optionalBoolean(args, "all"),
    }),
    renderComposePreviews: (args?: unknown) => service.renderComposePreviews({
      ...laneArgs(args, "renderComposePreviews"),
      module: optionalString(args, "module"),
      fqns: previewFqns(args),
      chatSessionId: optionalString(args, "chatSessionId"),
      proof: optionalBoolean(args, "proof"),
      inline: optionalBoolean(args, "inline"),
    }),
    captureProofBundle: (args?: unknown) => service.captureProofBundle({
      ...laneArgs(args, "captureProofBundle"),
      chatSessionId: optionalString(args, "chatSessionId"),
      outDir: optionalString(args, "outDir"),
      caption: optionalString(args, "caption"),
      includeElements: optionalBoolean(args, "includeElements"),
      logLines: optionalNumber(args, "logLines"),
      packageName: optionalString(args, "packageName"),
      proof: optionalBoolean(args, "proof"),
    }),
    getDeviceSettings: (args?: unknown) => {
      const fields = optionalString(args, "fields");
      return service.getDeviceSettings({
        ...laneArgs(args, "getDeviceSettings"),
        fields: fields === "foreground" || fields === "orientation" ? fields : "all",
      });
    },
    /* ── Parity (device track): status bar, Clear location, Play Store screenshots, windows ── */
    setStatusBar: (args?: unknown) => {
      const batteryState = optionalString(args, "batteryState");
      return service.setStatusBar({
        ...laneArgs(args, "setStatusBar"),
        time: optionalString(args, "time"),
        dataNetwork: optionalString(args, "dataNetwork"),
        wifiBars: optionalNumber(args, "wifiBars"),
        cellularBars: optionalNumber(args, "cellularBars"),
        batteryLevel: optionalNumber(args, "batteryLevel"),
        batteryState: batteryState ? enumOf(batteryState, "batteryState", ANDROID_STATUS_BAR_BATTERY_STATES, "setStatusBar") : null,
      });
    },
    clearStatusBar: (args?: unknown) => service.clearStatusBar(laneArgs(args, "clearStatusBar")),
    clearLocation: (args?: unknown) => service.clearLocation(laneArgs(args, "clearLocation")),
    storeScreenshots: (args?: unknown) => service.storeScreenshots({
      ...laneArgs(args, "storeScreenshots"),
      chatSessionId: optionalString(args, "chatSessionId"),
      proof: optionalBoolean(args, "proof"),
    }),
    windowLayout: (args?: unknown) => {
      const action = optionalString(args, "action");
      return service.windowLayout({
        ...laneArgs(args, "windowLayout"),
        action: action ? enumOf(action, "action", ANDROID_WINDOW_LAYOUT_ACTIONS, "windowLayout") : "status",
        packageName: optionalString(args, "packageName"),
        withPackage: optionalString(args, "withPackage"),
        width: optionalNumber(args, "width"),
        height: optionalNumber(args, "height"),
        x: optionalNumber(args, "x"),
        y: optionalNumber(args, "y"),
      });
    },
    setDeviceSetting: (args?: unknown) => {
      const setting = objectArgs(args).setting;
      if (!setting || typeof setting !== "object" || Array.isArray(setting)) {
        throw new Error("androidEmulator.setDeviceSetting setting must be an object ({kind, …}).");
      }
      // The kind is checked here; the service checks each value and names the bad one.
      return service.setDeviceSetting({ ...laneArgs(args, "setDeviceSetting"), setting: readAndroidDeviceSetting(setting) });
    },
    /* ── P1 look: the body colour and the render ── */
    // User-only: what the body looks like in the user's own windows.
    setDeviceColor: (args?: unknown) => service.setDeviceColor({
      ...laneArgs(args, "setDeviceColor"),
      colorId: requiredString(args, "colorId", "setDeviceColor"),
    }),
    // The spec is checked in the service (`normalizeAndroidRenderSpec`).
    requestRender: (args?: unknown) => service.requestRender({
      ...laneArgs(args, "requestRender"),
      chatSessionId: optionalString(args, "chatSessionId"),
      proof: optionalBoolean(args, "proof"),
      request: objectArgs(args).request,
    }),
    // User-only: the window side of a render.
    renderAck: (args?: unknown) => service.renderAck({ requestId: requiredString(args, "requestId", "renderAck") }),
    renderComplete: (args?: unknown) => service.renderComplete({
      requestId: requiredString(args, "requestId", "renderComplete"),
      error: optionalString(args, "error"),
    }),
    attachRenderProof: (args?: unknown) => service.attachRenderProof({
      ...laneArgs(args, "attachRenderProof"),
      requestId: optionalString(args, "requestId"),
      dataUrl: requiredString(args, "dataUrl", "attachRenderProof"),
      title: optionalString(args, "title"),
    }),
  };
}
