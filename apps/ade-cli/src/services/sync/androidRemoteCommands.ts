import type { SyncRemoteCommandAction, SyncRemoteCommandPolicy } from "../../../../desktop/src/shared/types/sync";
import { isAllowedAdeAction, isSecretBearingAdeAction } from "../../../../desktop/src/main/services/adeActions/actionPolicy";
import { buildAndroidDomainService } from "../../../../desktop/src/main/services/android/androidActionDomain";
import type { AndroidEmulatorServiceApi, AndroidHardwareKey } from "../../../../desktop/src/shared/types/androidEmulator";
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
 *   here. P2 adds `android.streamTicket` (a single-use relay ticket, as
 *   `apple.streamTicket`); until then a remote viewer reads screenshots.
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
  /** What the machine can do now (record, UI tree, Gradle); null from an older brain. */
  capabilities: unknown;
  /** P2: true once this brain serves `android.streamTicket`. */
  liveView: boolean;
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
export function buildAndroidStatusPayload(laneId: string, status: unknown): AndroidStatusPayload {
  const source = isRecord(status) ? status : {};
  const sdk = isRecord(source.sdk) ? source.sdk : {};
  const lane = isRecord(source.lane) ? source.lane : null;
  const device = lane && isRecord(lane.device) ? lane.device : null;
  const avd = lane && isRecord(lane.avd) ? lane.avd : null;
  const running = avd && isRecord(avd.running) ? avd.running : null;
  const error = lane && isRecord(lane.error) ? lane.error : null;
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
    capabilities: source.capabilities ?? null,
    liveView: false,
  };
}

/**
 * `android.invoke` methods a remote person may not reach: the ones whose
 * answer carries a secret (the stream token), and the SDK setup writes.
 */
const ANDROID_INVOKE_REFUSED: ReadonlySet<string> = new Set([
  ...ANDROID_SDK_PERSON_ONLY_ACTIONS,
  // P2: the remote live view goes through a relay ticket, never the local token.
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

export function createAndroidRemoteCommandHandlers(deps: { service: AndroidDeviceRemoteService }): AndroidRemoteCommandEntry[] {
  const { service } = deps;
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
        const status = buildAndroidStatusPayload(laneId, raw);
        return payload.full === true ? { ...status, raw } : status;
      },
    },
    {
      action: "android.input",
      policy: { viewerAllowed: false, controllerAllowed: true },
      handler: async (payload) => {
        const laneId = laneOf(payload, "android.input");
        const kind = requireString(payload.kind, "android.input requires a kind.");
        switch (kind) {
          case "tap":
            await service.tap({ laneId, x: requireFiniteNumber(payload.x, "x"), y: requireFiniteNumber(payload.y, "y") });
            return { ok: true };
          case "long-press":
            await service.longPress({
              laneId,
              x: requireFiniteNumber(payload.x, "x"),
              y: requireFiniteNumber(payload.y, "y"),
              durationMs: asNumber(payload.durationMs),
            });
            return { ok: true };
          case "swipe":
          case "drag": {
            const stroke = {
              laneId,
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
              direction: direction(payload.direction),
              amount: asNumber(payload.amount),
              anchorX: asNumber(payload.anchorX),
              anchorY: asNumber(payload.anchorY),
            });
            return { ok: true };
          case "type":
            await service.sendText({ laneId, text: requireString(payload.text, "android.input type requires text.") });
            return { ok: true };
          case "key": {
            const key = requireString(payload.key, "android.input key requires a key.");
            if (!ANDROID_BUTTONS.has(key)) throw new Error(`android.input key must be one of ${ANDROID_HARDWARE_KEYS.join(", ")}.`);
            await service.sendKey({ laneId, key: key as AndroidHardwareKey });
            return { ok: true };
          }
          case "tap-element":
            await service.tapElement({
              laneId,
              query: {
                ...(asString(payload.ref) ? { ref: asString(payload.ref) } : {}),
                ...(asString(payload.label) ? { label: asString(payload.label) } : {}),
                ...(asString(payload.text) ? { text: asString(payload.text) } : {}),
              },
            });
            return { ok: true };
          case "open-url":
            await service.openUrl({ laneId, url: requireString(payload.url, "android.input open-url requires url.") });
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
  ];
}

