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
  ANDROID_HARDWARE_KEYS,
  ANDROID_ORIENTATIONS,
  type AndroidEmulatorServiceApi,
  type AndroidTouchEvent,
} from "../../../shared/types/androidEmulator";
import { createDomainArgReaders } from "../adeActions/domainArgs";

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

export function buildAndroidDomainService(runtime: AndroidActionRuntime): OpaqueService | null {
  const service: AndroidEmulatorServiceApi | null = runtime.androidEmulatorService ?? null;
  // A chat-only brain, or a host that built no service: the domain is absent.
  if (!service) return null;
  return {
    getStatus: (args?: unknown) => service.getStatus(optionalLaneId(args)),
    listDevices: (args?: unknown) => service.listDevices(optionalLaneId(args)),
    createDevice: (args?: unknown) => service.createDevice({
      ...laneArgs(args, "createDevice"),
      profileId: requiredString(args, "profileId", "createDevice"),
      systemImage: optionalString(args, "systemImage"),
      displayName: optionalString(args, "displayName"),
      start: optionalBoolean(args, "start"),
    }),
    attachDevice: (args?: unknown) => service.attachDevice({
      ...laneArgs(args, "attachDevice"),
      avdName: requiredString(args, "avdName", "attachDevice"),
      start: optionalBoolean(args, "start"),
    }),
    start: (args?: unknown) => service.start(laneArgs(args, "start")),
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
    }),
  };
}
