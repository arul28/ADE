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
  type AndroidElementQuery,
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

function installArgs(args: unknown) {
  return { apkPath: optionalString(args, "apkPath"), gradle: gradleTarget(args) };
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
    }),
    attachDevice: (args?: unknown) => service.attachDevice({
      ...laneArgs(args, "attachDevice"),
      avdName: requiredString(args, "avdName", "attachDevice"),
      start: optionalBoolean(args, "start"),
    }),
    start: (args?: unknown) => service.start({ ...laneArgs(args, "start"), ...(readBoolean(args, "force") === true ? { force: true } : {}) }),
    stop: (args?: unknown) => service.stop(laneArgs(args, "stop")),
    releaseDevice: (args?: unknown) => service.releaseDevice({
      ...laneArgs(args, "releaseDevice"),
      deleteCreated: optionalBoolean(args, "deleteCreated"),
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
    }),
    stopStream: (args?: unknown) => service.stopStream(laneArgs(args, "stopStream")),
    getStreamStatus: (args?: unknown) => service.getStreamStatus(laneArgs(args, "getStreamStatus")),
    // User-only: a viewer's live finger. An agent taps and swipes.
    sendTouch: (args?: unknown) => service.sendTouch({
      ...laneArgs(args, "sendTouch"),
      events: touchEvents(args),
    }),
    tap: (args?: unknown) => service.tap({
      ...laneArgs(args, "tap"),
      x: requiredNumber(args, "x", "tap"),
      y: requiredNumber(args, "y", "tap"),
    }),
    swipe: (args?: unknown) => service.swipe({
      ...laneArgs(args, "swipe"),
      fromX: requiredNumber(args, "fromX", "swipe"),
      fromY: requiredNumber(args, "fromY", "swipe"),
      toX: requiredNumber(args, "toX", "swipe"),
      toY: requiredNumber(args, "toY", "swipe"),
      durationMs: optionalNumber(args, "durationMs"),
    }),
    sendKey: (args?: unknown) => service.sendKey({
      ...laneArgs(args, "sendKey"),
      key: enumOf(optionalString(args, "key"), "key", ANDROID_HARDWARE_KEYS, "sendKey"),
    }),
    rotate: (args?: unknown) => service.rotate({
      ...laneArgs(args, "rotate"),
      orientation: enumOf(optionalString(args, "orientation"), "orientation", ANDROID_ORIENTATIONS, "rotate"),
    }),
    sendText: (args?: unknown) => {
      // Not trimmed: a leading or trailing space is part of what is typed.
      const text = objectArgs(args).text;
      if (typeof text !== "string" || text.length === 0) {
        throw new Error("androidEmulator.sendText requires text.");
      }
      return service.sendText({ ...laneArgs(args, "sendText"), text });
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
    openUrl: (args?: unknown) => service.openUrl({ ...laneArgs(args, "openUrl"), url: requiredString(args, "url", "openUrl") }),
    longPress: (args?: unknown) => service.longPress({
      ...laneArgs(args, "longPress"),
      x: requiredNumber(args, "x", "longPress"),
      y: requiredNumber(args, "y", "longPress"),
      durationMs: optionalNumber(args, "durationMs"),
    }),
    drag: (args?: unknown) => service.drag({
      ...laneArgs(args, "drag"),
      fromX: requiredNumber(args, "fromX", "drag"),
      fromY: requiredNumber(args, "fromY", "drag"),
      toX: requiredNumber(args, "toX", "drag"),
      toY: requiredNumber(args, "toY", "drag"),
      durationMs: optionalNumber(args, "durationMs"),
    }),
    scroll: (args?: unknown) => service.scroll({
      ...laneArgs(args, "scroll"),
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
      query: elementQuery(args, "tapElement"),
      holdMs: optionalNumber(args, "holdMs"),
    }),
    fillElement: (args?: unknown) => {
      // Not trimmed: a leading or trailing space is part of what is typed.
      const text = objectArgs(args).text;
      if (typeof text !== "string" || text.length === 0) throw new Error("androidEmulator.fillElement requires text.");
      return service.fillElement({
        ...laneArgs(args, "fillElement"),
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
    }),
    recordStop: (args?: unknown) => service.recordStop({
      ...laneArgs(args, "recordStop"),
      chatSessionId: optionalString(args, "chatSessionId"),
      discard: optionalBoolean(args, "discard"),
      proof: optionalBoolean(args, "proof"),
    }),
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
    getDeviceSettings: (args?: unknown) => service.getDeviceSettings({
      ...laneArgs(args, "getDeviceSettings"),
      fields: optionalString(args, "fields") === "foreground" ? "foreground" : "all",
    }),
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
