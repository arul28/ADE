import fs from "node:fs/promises";
import type { SyncRemoteCommandAction, SyncRemoteCommandPolicy } from "../../../../desktop/src/shared/types/sync";
import { isAllowedAdeAction, isSecretBearingAdeAction } from "../../../../desktop/src/main/services/adeActions/actionPolicy";
import { buildAndroidDomainService } from "../../../../desktop/src/main/services/android/androidActionDomain";
import type {
  AndroidEmulatorServiceApi,
  AndroidHardwareKey,
  AndroidTouchEvent,
} from "../../../../desktop/src/shared/types/androidEmulator";
import type { AppleStreamTicketIssuer } from "./appleRemoteCommands";
import { externalChatContext } from "../../../../desktop/src/main/services/chat/externalChats";
import {
  parseForeignCallerSessionId,
  remoteAgentHolderLabel,
} from "../../../../desktop/src/shared/runtimeClientNames";
import {
  ANDROID_HARDWARE_KEYS,
  ANDROID_LANE_FREE_ACTIONS,
  ANDROID_SDK_PERSON_ONLY_ACTIONS,
} from "../../../../desktop/src/shared/types/androidEmulator";

/**
 * `android.*` remote commands: the lane's Android emulator, as a phone or a
 * hosted web tab reaches it. The pattern of `appleRemoteCommands.ts`.
 *
 * - **Every call names its lane.** The Android service has no "first booted
 *   device" fallback: each call acts on the lane's own emulator or refuses,
 *   so a remote caller can never drive another lane's screen.
 * - **Input is a person's.** `android.input`, `android.invoke` and the
 *   recording verbs are `controllerAllowed` and not `viewerAllowed`: the
 *   owner's phone and a hosted web tab may drive the emulator; a desktop
 *   pairing at viewer role may not.
 * - **Status carries no secret.** The stream token stays out of every answer
 *   here. A remote viewer gets the picture through `android.streamTicket`, a
 *   single-use relay ticket, as `apple.streamTicket`.
 * - **No licence from afar.** `android.invoke` refuses the SDK install, its
 *   cancel and the SDK folder: the setup card on the machine is where a
 *   person reads and accepts Google's licences.
 */

/**
 * The Android emulator service these commands reach. `android.invoke` goes
 * through the `android_emulator` action domain (`buildAndroidDomainService`),
 * which reads every method, so this is the whole service and not a slice.
 */
export type AndroidDeviceRemoteService = AndroidEmulatorServiceApi;

/** The per-lane snapshot a phone or a web tab renders. */
export type AndroidStatusPayload = {
  laneId: string;
  unavailable: string | null;
  sdkFound: boolean;
  device: {
    avdName: string;
    origin: string | null;
    profileId: string | null;
    state: string;
    serial: string | null;
    width: number | null;
    height: number | null;
  } | null;
  error: { code: string | null; message: string | null } | null;
  /** P2 crash pin: the lane's app's last crash while the emulator runs (no stack: `android.invoke readLog` has it). */
  appCrash: { id: string; packageName: string | null; summary: string | null } | null;
  /** What the machine can do now (record, UI tree, Gradle); null from an older brain. */
  capabilities: unknown;
  /** True when this brain serves `android.streamTicket` (it has the stream relay). */
  liveView: boolean;
  /** The lane's recording now, while the emulator runs; null when none runs or it cannot be read. */
  recording: { active: true; id: string; startedAt: string | null; chatSessionId: string | null } | null;
  /**
   * Who holds the emulator's lease (`ade android lease`): an agent says it is
   * driving. `chatTitle` is resolved here, null when there is no name to give.
   */
  owner: { holder: string; chatSessionId: string | null; chatTitle: string | null; expiresAt: string | null } | null;
  raw?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function requireString(value: unknown, message: string): string {
  const trimmed = asString(value);
  if (!trimmed) throw new Error(message);
  return trimmed;
}

function requireFiniteNumber(value: unknown, field: string): number {
  const parsed = asNumber(value);
  if (parsed === null) throw new Error(`android.input requires a finite ${field}.`);
  return parsed;
}

/** `AndroidEmulatorStatus` reduced to what a viewer draws: no SDK paths, no tool list. */
export function buildAndroidStatusPayload(laneId: string, status: unknown, liveView = false): AndroidStatusPayload {
  const source = isRecord(status) ? status : {};
  const sdk = isRecord(source.sdk) ? source.sdk : {};
  const lane = isRecord(source.lane) ? source.lane : null;
  const device = lane && isRecord(lane.device) ? lane.device : null;
  const avd = lane && isRecord(lane.avd) ? lane.avd : null;
  const running = avd && isRecord(avd.running) ? avd.running : null;
  const error = lane && isRecord(lane.error) ? lane.error : null;
  const crash = lane && isRecord(lane.appCrash) ? lane.appCrash : null;
  const crashId = asString(crash?.id);
  const avdName = asString(device?.avdName) ?? asString(avd?.name);
  return {
    laneId,
    unavailable: source.platformSupported === false
      ? asString(source.unsupportedReason) ?? "This machine cannot run the Android emulator."
      : null,
    sdkFound: sdk.found === true,
    device: avdName
      ? {
        avdName,
        origin: asString(device?.origin),
        profileId: asString(device?.profileId) ?? asString(avd?.profileId),
        state: asString(lane?.state) ?? "none",
        serial: asString(running?.serial),
        width: asNumber(avd?.lcdWidth),
        height: asNumber(avd?.lcdHeight),
      }
      : null,
    error: error ? { code: asString(error.code), message: asString(error.message) } : null,
    appCrash: crashId ? { id: crashId, packageName: asString(crash?.packageName), summary: asString(crash?.summary) } : null,
    capabilities: source.capabilities ?? null,
    liveView,
    recording: null,
    owner: null,
  };
}

/** The recording and the lease, read only while the emulator runs. A failed read leaves the field null. */
async function readAndroidActivity(
  service: AndroidDeviceRemoteService,
  laneId: string,
  resolveChatTitle: ((chatSessionId: string) => Promise<string | null>) | undefined,
): Promise<Pick<AndroidStatusPayload, "recording" | "owner">> {
  const [records, lease] = await Promise.all([
    service.recordList({ laneId }).catch(() => null),
    service.deviceLeaseStatus({ laneId }).catch(() => null),
  ]);
  const active = records?.recordings.find((recording) => recording.active) ?? null;
  const recording = active
    ? { active: true as const, id: active.id, startedAt: asString(active.startedAt), chatSessionId: asString(active.chatSessionId) }
    : null;
  const current = lease?.held ? lease.current : null;
  if (!current) return { recording, owner: null };
  // An agent's lease names its chat (the holder defaults to the chat id).
  const holder = current.holder;
  let chatSessionId: string | null = null;
  let chatTitle: string | null = null;
  if (parseForeignCallerSessionId(holder)) {
    chatSessionId = holder;
    chatTitle = remoteAgentHolderLabel(externalChatContext(holder)?.machineName);
  } else if (resolveChatTitle && holder !== "agent") {
    const title = await resolveChatTitle(holder).catch(() => null);
    if (title !== null) {
      chatSessionId = holder;
      chatTitle = asString(title);
    }
  }
  return { recording, owner: { holder, chatSessionId, chatTitle, expiresAt: asString(current.expiresAt) } };
}

/**
 * `android.invoke` methods a remote person may not reach: the ones whose
 * answer carries a secret (the stream token), and the SDK setup writes.
 */
const ANDROID_INVOKE_REFUSED: ReadonlySet<string> = new Set([
  ...ANDROID_SDK_PERSON_ONLY_ACTIONS,
  // The remote live view goes through a relay ticket, never the local token,
  // and its finger through `android.input` kind `touch`.
  "startStream",
  "stopStream",
  "sendTouch",
]);

/** `android.invoke` methods that need no lane (the machine's AVDs, its SDK plan). */
const ANDROID_INVOKE_LANE_FREE: ReadonlySet<string> = new Set(ANDROID_LANE_FREE_ACTIONS);

const ANDROID_BUTTONS: ReadonlySet<string> = new Set(ANDROID_HARDWARE_KEYS);

export type AndroidRemoteCommandHandler = (payload: Record<string, unknown>) => Promise<unknown>;

export type AndroidRemoteCommandEntry = {
  action: SyncRemoteCommandAction;
  policy: SyncRemoteCommandPolicy;
  handler: AndroidRemoteCommandHandler;
};

/** One finger event of a live touch, from a phone or a web tab. */
function touchEvent(value: unknown): AndroidTouchEvent {
  const event = isRecord(value) ? value : {};
  const action = event.action;
  if (action !== "down" && action !== "move" && action !== "up") {
    throw new Error("android.input touch events need an action of down, move or up.");
  }
  const pointerId = asNumber(event.pointerId);
  return {
    action,
    x: requireFiniteNumber(event.x, "x"),
    y: requireFiniteNumber(event.y, "y"),
    ...(pointerId !== null && pointerId >= 0 ? { pointerId: Math.trunc(pointerId) } : {}),
  };
}

/** Most finger events one `android.input touch` call may carry. */
const MAX_TOUCH_EVENTS = 64;

export function createAndroidRemoteCommandHandlers(deps: {
  service: AndroidDeviceRemoteService;
  /** The brain's stream relay for Android; null hides the live view (screenshots only). */
  streamRelay?: AppleStreamTicketIssuer | null;
  /** A chat's title, for the owner ribbon; null when the id names no chat here. */
  resolveChatTitle?: (chatSessionId: string) => Promise<string | null>;
}): AndroidRemoteCommandEntry[] {
  const { service } = deps;
  const streamRelay = deps.streamRelay ?? null;
  // The same argument readers as `ade actions run android_emulator.*`.
  const domain = buildAndroidDomainService({ androidEmulatorService: service });
  const laneOf = (payload: Record<string, unknown>, action: string): string =>
    requireString(payload.laneId, `${action} requires laneId.`);
  const direction = (value: unknown): "up" | "down" | "left" | "right" => {
    const text = requireString(value, "android.input scroll requires a direction.");
    if (text !== "up" && text !== "down" && text !== "left" && text !== "right") {
      throw new Error("android.input scroll direction must be up, down, left or right.");
    }
    return text;
  };

  return [
    {
      action: "android.status",
      policy: { viewerAllowed: true },
      handler: async (payload) => {
        const laneId = laneOf(payload, "android.status");
        const raw = await service.getStatus({ laneId });
        const base = buildAndroidStatusPayload(laneId, raw, streamRelay !== null);
        // The recording dot and the owner ribbon, as on the simulator viewer.
        const status = base.device?.state === "booted"
          ? { ...base, ...(await readAndroidActivity(service, laneId, deps.resolveChatTitle)) }
          : base;
        return payload.full === true ? { ...status, raw } : status;
      },
    },
    {
      action: "android.streamTicket",
      policy: { viewerAllowed: true },
      handler: async (payload) => {
        const laneId = laneOf(payload, "android.streamTicket");
        if (!streamRelay) throw new Error("The Android stream relay is not available in this runtime.");
        // The relay starts the stream when the viewer's socket attaches; a
        // start here would mark a viewer on this machine and keep the stream
        // up after the phone leaves. Watching never boots the emulator.
        const status = await service.getStatus({ laneId });
        const lane = isRecord(status.lane) ? status.lane : null;
        const state = asString(lane?.state) ?? "none";
        if (state !== "booted") {
          throw new Error(`ANDROID_NOT_RUNNING: the lane's emulator is ${state === "none" ? "not set up" : state}.`);
        }
        // Touch goes in device pixels. The point size is the portrait screen;
        // a viewer turns it when the picture is landscape. The picture's own
        // size comes with its first config record.
        const avd = isRecord(lane?.avd) ? lane.avd : null;
        const lcdWidth = asNumber(avd?.lcdWidth);
        const lcdHeight = asNumber(avd?.lcdHeight);
        const sized = lcdWidth !== null && lcdHeight !== null;
        const ticket = streamRelay.issue({
          laneId,
          codec: "h264",
          pointWidth: sized ? Math.min(lcdWidth, lcdHeight) : null,
          pointHeight: sized ? Math.max(lcdWidth, lcdHeight) : null,
        });
        // The viewer may send a live finger (`android.input` kind `touch`).
        return { ...ticket, liveTouch: true };
      },
    },
    {
      action: "android.input",
      policy: { viewerAllowed: false, controllerAllowed: true },
      handler: async (payload) => {
        // A phone or a web tab is a person: every input here is stamped
        // `source: "user"` by this path, never read from the payload, so it
        // never starts an agent's auto-recording (Apple's `appleRemoteCommands.ts`).
        // A live finger (`touch`) is always the person's already.
        const laneId = laneOf(payload, "android.input");
        const source = "user" as const;
        const kind = requireString(payload.kind, "android.input requires a kind.");
        switch (kind) {
          case "touch": {
            // A live finger: down, moves, up, in device pixels. Needs the
            // lane's stream (the viewer that sends it is reading it).
            const events = Array.isArray(payload.events) ? payload.events : [];
            if (events.length === 0) throw new Error("android.input touch requires events.");
            if (events.length > MAX_TOUCH_EVENTS) {
              throw new Error(`android.input touch takes at most ${MAX_TOUCH_EVENTS} events.`);
            }
            await service.sendTouch({ laneId, events: events.map(touchEvent) });
            return { ok: true };
          }
          case "tap":
            await service.tap({ laneId, source, x: requireFiniteNumber(payload.x, "x"), y: requireFiniteNumber(payload.y, "y") });
            return { ok: true };
          case "long-press":
            await service.longPress({
              laneId,
              source,
              x: requireFiniteNumber(payload.x, "x"),
              y: requireFiniteNumber(payload.y, "y"),
              durationMs: asNumber(payload.durationMs),
            });
            return { ok: true };
          case "swipe":
          case "drag": {
            const stroke = {
              laneId,
              source,
              fromX: requireFiniteNumber(payload.fromX, "fromX"),
              fromY: requireFiniteNumber(payload.fromY, "fromY"),
              toX: requireFiniteNumber(payload.toX, "toX"),
              toY: requireFiniteNumber(payload.toY, "toY"),
              durationMs: asNumber(payload.durationMs),
            };
            await (kind === "drag" ? service.drag(stroke) : service.swipe(stroke));
            return { ok: true };
          }
          case "scroll":
            await service.scroll({
              laneId,
              source,
              direction: direction(payload.direction),
              amount: asNumber(payload.amount),
              anchorX: asNumber(payload.anchorX),
              anchorY: asNumber(payload.anchorY),
            });
            return { ok: true };
          case "type":
            await service.sendText({ laneId, source, text: requireString(payload.text, "android.input type requires text.") });
            return { ok: true };
          case "key": {
            const key = requireString(payload.key, "android.input key requires a key.");
            if (!ANDROID_BUTTONS.has(key)) throw new Error(`android.input key must be one of ${ANDROID_HARDWARE_KEYS.join(", ")}.`);
            await service.sendKey({ laneId, source, key: key as AndroidHardwareKey });
            return { ok: true };
          }
          case "tap-element":
            await service.tapElement({
              laneId,
              source,
              query: {
                ...(asString(payload.ref) ? { ref: asString(payload.ref) } : {}),
                ...(asString(payload.label) ? { label: asString(payload.label) } : {}),
                ...(asString(payload.text) ? { text: asString(payload.text) } : {}),
              },
            });
            return { ok: true };
          case "open-url":
            await service.openUrl({ laneId, source, url: requireString(payload.url, "android.input open-url requires url.") });
            return { ok: true };
          default:
            throw new Error(`android.input does not support '${kind}'.`);
        }
      },
    },
    {
      // The rest of `androidEmulator.*`, behind the same allowlist as the
      // `android_emulator` ADE action domain, so the allowlist (not this file)
      // stays the one place that says what a remote caller may reach.
      action: "android.invoke",
      policy: { viewerAllowed: false, controllerAllowed: true },
      handler: async (payload) => {
        const method = requireString(payload.method, "android.invoke requires a method.");
        if (
          !isAllowedAdeAction("android_emulator", method)
          || isSecretBearingAdeAction("android_emulator", method)
          || ANDROID_INVOKE_REFUSED.has(method)
        ) {
          throw new Error(`android.invoke does not allow '${method}'.`);
        }
        const call = domain?.[method];
        if (typeof call !== "function") throw new Error(`android.invoke: '${method}' is not available in this runtime.`);
        const laneId = ANDROID_INVOKE_LANE_FREE.has(method)
          ? asString(payload.laneId)
          : requireString(payload.laneId, `android.invoke '${method}' requires laneId.`);
        const chatSessionId = asString(payload.chatSessionId);
        const methodArgs = isRecord(payload.args) ? payload.args : {};
        return call({
          ...methodArgs,
          ...(laneId ? { laneId } : {}),
          ...(chatSessionId ? { chatSessionId } : {}),
          // A person's call, as on `android.input`; the payload cannot change it.
          source: "user",
        });
      },
    },
    {
      action: "android.deviceList",
      policy: { viewerAllowed: true },
      handler: async (payload) => service.listDevices({ laneId: asString(payload.laneId) }),
    },
    {
      action: "android.recordList",
      policy: { viewerAllowed: true },
      handler: async (payload) => service.recordList({ laneId: laneOf(payload, "android.recordList") }),
    },
    {
      action: "android.recordStart",
      policy: { viewerAllowed: false, controllerAllowed: true },
      handler: async (payload) => service.recordStart({
        laneId: laneOf(payload, "android.recordStart"),
        chatSessionId: asString(payload.chatSessionId),
        label: asString(payload.label),
      }),
    },
    {
      action: "android.recordStop",
      policy: { viewerAllowed: false, controllerAllowed: true },
      handler: async (payload) => service.recordStop({
        laneId: laneOf(payload, "android.recordStop"),
        chatSessionId: asString(payload.chatSessionId),
        discard: payload.discard === true,
      }),
    },
    {
      // The phone's Live Inspect: one still and the elements on it, in the
      // shape of `apple.invoke getScreenSnapshot`, so the phone's frozen
      // inspector reads both. Controller-only, as Apple's: the UI tree read
      // can wake the device's accessibility service.
      action: "android.inspectSnapshot",
      policy: { viewerAllowed: false, controllerAllowed: true },
      handler: async (payload) => buildAndroidInspectSnapshot(service, laneOf(payload, "android.inspectSnapshot")),
    },
  ];
}

/** The PNG bytes past this are not sent: the sync channel carries the picture inline. */
const MAX_INSPECT_PNG_BYTES = 8 * 1024 * 1024;

/**
 * One screenshot (no proof row: nobody asked for one) and one fresh UI tree.
 * The PNG goes inline as a data URL and its file is removed after the read.
 * Element frames are device pixels, the screenshot's own space.
 */
export async function buildAndroidInspectSnapshot(service: AndroidDeviceRemoteService, laneId: string) {
  const shot = await service.screenshot({ laneId, proof: false });
  let png: Buffer;
  try {
    png = await fs.readFile(shot.path);
  } finally {
    await fs.rm(shot.path, { force: true }).catch(() => undefined);
  }
  if (png.byteLength > MAX_INSPECT_PNG_BYTES) {
    throw new Error(`The emulator's screenshot is ${Math.round(png.byteLength / 1_048_576)} MB, too large to send for inspect.`);
  }
  const tree = await service.getScreenSnapshot({ laneId, fresh: true });
  return {
    screenshot: { dataUrl: `data:image/png;base64,${png.toString("base64")}`, width: shot.width, height: shot.height },
    screen: { width: tree.width ?? shot.width, height: tree.height ?? shot.height, scale: 1 },
    foregroundPackage: tree.foregroundPackage,
    elements: tree.elements.map((element) => ({
      id: element.ref,
      label: element.label,
      value: element.text,
      role: element.role,
      elementType: element.className,
      identifier: element.identifier ?? element.resourceId,
      componentId: element.resourceId,
      frame: element.bounds,
      pixelFrame: element.bounds,
    })),
  };
}

