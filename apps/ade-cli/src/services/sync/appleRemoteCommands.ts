import type { SyncRemoteCommandAction, SyncRemoteCommandPolicy } from "../../../../desktop/src/shared/types/sync";
import { isAllowedAdeAction } from "../../../../desktop/src/main/services/adeActions/actionPolicy";

/**
 * `apple.*` remote commands — the Apple device environment, as a phone or a
 * hosted web tab reaches it.
 *
 * The rules this file encodes, rather than the plumbing:
 *
 * - **Ownership is checked here, not in the service.** `tap`/`type`/`drag` on
 *   the service are unguarded by design: an agent's own tool call is already
 *   scoped to its chat. A remote viewer is not, so a web client driving a lane
 *   another chat claimed must be refused with the ordinary cooperative error
 *   rather than silently stealing the device.
 * - **The phone never sends input.** `apple.input` is `controllerAllowed` and
 *   not `viewerAllowed`; the phone is a viewer, so the policy alone makes the
 *   view-only rule true on the wire instead of only in the iOS UI.
 * - **Status carries no secret.** The stream address and token exist only
 *   inside `apple.streamTicket`, which mints a fresh single-use pair per
 *   viewer. `apple.status` is polled into transcripts and must stay printable.
 */

/** The slice of the simulator service these commands need. */
export type AppleDeviceRemoteService = {
  getStatus(args: { laneId?: string | null }): Promise<unknown>;
  startStream(args: {
    laneId?: string | null;
    chatSessionId?: string | null;
    bitrateKbps?: number | null;
  }): Promise<unknown>;
  stopStream(args: { laneId?: string | null }): Promise<unknown>;
  tap(args: { laneId?: string | null; chatSessionId?: string | null; x: number; y: number }): Promise<unknown>;
  typeText(args: { laneId?: string | null; chatSessionId?: string | null; text: string }): Promise<unknown>;
  drag(args: {
    laneId?: string | null;
    chatSessionId?: string | null;
    startX: number;
    startY: number;
    endX: number;
    endY: number;
    durationMs?: number | null;
  }): Promise<unknown>;
  scroll(args: {
    laneId?: string | null;
    chatSessionId?: string | null;
    direction: string;
    amount?: number | null;
    anchorX?: number | null;
    anchorY?: number | null;
  }): Promise<unknown>;
  tapElement(args: { laneId?: string | null; chatSessionId?: string | null; ref?: string; label?: string }): Promise<unknown>;
  openUrl(args: { laneId?: string | null; chatSessionId?: string | null; url: string }): Promise<unknown>;
  deviceCreate(args: { laneId: string; from?: string | null; name?: string | null }): Promise<unknown>;
  deviceAttach(args: { laneId: string; simulator: string }): Promise<unknown>;
  deviceList(args: { laneId?: string | null; installed?: boolean; disk?: boolean }): Promise<unknown>;
  recordStart(args: { laneId?: string | null; chatSessionId?: string | null; label?: string | null }): Promise<unknown>;
  recordStop(args: { laneId?: string | null; chatSessionId?: string | null; keep?: boolean }): Promise<unknown>;
  recordList(args: { laneId?: string | null }): Promise<unknown>;
} & Record<string, unknown>;

/** The slice of `appleStreamRelay` these commands need. */
export type AppleStreamTicketIssuer = {
  issue(args: { laneId: string; codec?: string | null; width?: number | null; height?: number | null }): {
    url: string | null;
    path: string;
    token: string;
    ticket: string;
    codec: string | null;
    width: number | null;
    height: number | null;
    expiresAt: string;
  };
};

export const APPLE_OWNED_BY_OTHER_SESSION_CODE = "APPLE_OWNED_BY_OTHER_SESSION" as const;

export class AppleOwnedByOtherSessionError extends Error {
  readonly code = APPLE_OWNED_BY_OTHER_SESSION_CODE;
  readonly currentChatSessionId: string | null;

  constructor(owner: string | null) {
    super(
      `${APPLE_OWNED_BY_OTHER_SESSION_CODE}: the device is owned by chat session ${owner ?? "unknown"}. Watch it instead, or take it over from the owning chat.`,
    );
    this.name = "AppleOwnedByOtherSessionError";
    this.currentChatSessionId = owner;
  }
}

/** The per-lane snapshot the phone and the web client render. */
export type AppleStatusPayload = {
  laneId: string;
  unavailable: string | null;
  device: {
    udid: string;
    name: string;
    family: "iphone" | "ipad" | "watch";
    runtime: string | null;
    origin: "clone" | "attached" | null;
    state: string | null;
  } | null;
  app: { bundleId: string | null; name: string | null; state: string | null } | null;
  stream: {
    running: boolean;
    codec: string | null;
    width: number | null;
    height: number | null;
    bitrateKbps: number | null;
    fps: number | null;
    lastError: string | null;
  };
  recording: { active: boolean; id: string | null; startedAt: string | null; mode: "auto" | "manual" | null } | null;
  /**
   * The device this lane itself holds, or null.
   *
   * `device` can be the host's fallback (any booted simulator) when the lane
   * holds none. The phone's simulator chip shows only when this names the same
   * udid, so it never offers another lane's device as this lane's.
   */
  laneDevice: { udid: string } | null;
  /**
   * The claiming chat.
   *
   * `chatTitle` is resolved by the host, not by the viewer: a phone enters the
   * tools sheet with a laneId and no chat roster, so without this the ownership
   * ribbon can only say "some chat in this lane". Null when the lookup fails or
   * the chat has no title yet — never a fabricated name.
   */
  owner: { chatSessionId: string | null; chatTitle: string | null } | null;
  /**
   * The service's own status, for a caller that renders the desktop column.
   *
   * Only when the caller asks (`full: true`): the raw status carries the whole
   * installed-simulator list, which the phone would pay for on cellular and
   * never read.
   */
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
  if (parsed === null) throw new Error(`apple.input requires a finite ${field}.`);
  return parsed;
}

/** iPad/Watch are named in the device type; everything else reads as iPhone. */
export function appleDeviceFamily(name: string | null): "iphone" | "ipad" | "watch" {
  const lower = (name ?? "").toLowerCase();
  if (lower.includes("ipad")) return "ipad";
  if (lower.includes("watch")) return "watch";
  return "iphone";
}

/**
 * Flatten `IosSimulatorStatus` into the wire shape.
 *
 * Deliberately a projection rather than a pass-through: the service's status
 * carries tool availability, preview capability, and a device list that a
 * viewer has no use for, and the phone parses this on a cellular link.
 */
export function buildAppleStatusPayload(laneId: string, status: unknown): AppleStatusPayload {
  const source = isRecord(status) ? status : {};
  const activeDevice = isRecord(source.activeDevice) ? source.activeDevice : null;
  const laneDevice = isRecord(source.laneDevice) ? source.laneDevice : null;
  const activeSession = isRecord(source.activeSession) ? source.activeSession : null;
  const deviceSession = isRecord(source.deviceSession) ? source.deviceSession : null;
  const stream = isRecord(source.stream) ? source.stream : {};
  const recording = isRecord(source.recording) ? source.recording : null;
  const udid = asString(activeDevice?.udid)
    ?? asString(laneDevice?.udid)
    ?? asString(activeSession?.deviceUdid)
    ?? asString(deviceSession?.deviceUdid);
  const name = asString(activeDevice?.name) ?? asString(laneDevice?.name);
  const origin = asString(laneDevice?.origin);
  // A chat can hold the device through either an app session or a bare device
  // session (`open-device`); an owner that only read `activeSession` reported a
  // device-session claim as unclaimed, which let any remote caller drive it.
  const ownerSessionId = asString(activeSession?.chatSessionId) ?? asString(deviceSession?.chatSessionId);
  return {
    laneId,
    unavailable: source.supported === false
      ? "This machine cannot run Apple simulators."
      : null,
    device: udid
      ? {
        udid,
        name: name ?? udid,
        family: appleDeviceFamily(asString(laneDevice?.family) ?? name),
        runtime: asString(activeDevice?.runtime) ?? asString(laneDevice?.runtime),
        origin: origin === "clone" || origin === "attached" ? origin : null,
        state: asString(activeDevice?.state),
      }
      : null,
    app: activeSession
      ? {
        bundleId: asString(activeSession.bundleId),
        name: asString(activeSession.appName) ?? asString(activeSession.bundleId),
        state: asString(activeSession.state),
      }
      : null,
    stream: {
      running: stream.running === true,
      codec: asString(stream.codec),
      width: asNumber(stream.width),
      height: asNumber(stream.height),
      bitrateKbps: asNumber(stream.bitrateKbps),
      fps: asNumber(stream.fps),
      lastError: asString(stream.lastError),
    },
    recording: recording
      ? {
        active: recording.endedAt == null,
        id: asString(recording.id),
        startedAt: asString(recording.startedAt),
        mode: recording.mode === "manual" ? "manual" : recording.mode === "auto" ? "auto" : null,
      }
      : null,
    laneDevice: asString(laneDevice?.udid) ? { udid: asString(laneDevice?.udid)! } : null,
    owner: ownerSessionId
      ? { chatSessionId: ownerSessionId, chatTitle: null }
      : null,
  };
}

/**
 * The cooperative guard, applied to a remote caller.
 *
 * An unclaimed device is drivable by anyone — that is what makes a web tab
 * useful before any chat has touched the lane. A claimed one answers only to
 * the chat that claimed it, and an anonymous remote caller is refused rather
 * than treated as the owner.
 */
export function assertAppleInputAllowed(
  status: AppleStatusPayload,
  chatSessionId: string | null,
): void {
  const owner = status.owner?.chatSessionId ?? null;
  if (!owner) return;
  if (chatSessionId && chatSessionId === owner) return;
  throw new AppleOwnedByOtherSessionError(owner);
}

/**
 * Methods a watcher may call on a device another chat owns.
 *
 * Everything else routed through `apple.invoke` goes through the cooperative
 * guard — including the ones that only *look* passive, like `startStream`,
 * which changes the encoder settings for every viewer.
 */
const APPLE_UNGUARDED_METHODS: ReadonlySet<string> = new Set([
  "getStatus",
  "listDevices",
  "listLaunchTargets",
  "getStreamStatus",
  "getDeviceSession",
  "getDeviceSettings",
  "getAppState",
  "getForegroundApp",
  "getEventLog",
  "getInspectorSnapshot",
  "getScreenSnapshot",
  "screenshot",
  "deviceList",
  "recordList",
  "findElement",
  "assertVisible",
  "resolvePreviewMatch",
  "listPreviewTargets",
  "getPreviewCapability",
]);

export type AppleRemoteCommandHandler = (payload: Record<string, unknown>) => Promise<unknown>;

export type AppleRemoteCommandEntry = {
  action: SyncRemoteCommandAction;
  policy: SyncRemoteCommandPolicy;
  handler: AppleRemoteCommandHandler;
};

export function createAppleRemoteCommandHandlers(deps: {
  service: AppleDeviceRemoteService;
  streamRelay: AppleStreamTicketIssuer | null;
  /** `apple.remoteBitrateKbpsCap`, read at ticket time so a settings change lands. */
  remoteBitrateKbpsCap?: () => number | null;
  /** Names the claiming chat for the ownership ribbon. Optional and failure-safe. */
  resolveChatTitle?: (chatSessionId: string) => Promise<string | null>;
}): AppleRemoteCommandEntry[] {
  const { service, streamRelay } = deps;

  /**
   * Decorate the owner with a readable name.
   *
   * Never allowed to fail the status read: a chat lookup that throws during a
   * runtime restart must cost the ribbon its name, not the phone its whole
   * device card.
   *
   * Normalised through `asString` like every other string in this projection,
   * so a whitespace-only title arrives as null rather than as a name each
   * client has to re-trim. An untitled claim is the NORMAL state for the first
   * seconds of every chat — titles are written asynchronously — so the null
   * branch is the one that ships, and it has to mean the same thing on every
   * surface.
   */
  const withOwnerTitle = async (status: AppleStatusPayload): Promise<AppleStatusPayload> => {
    const chatSessionId = status.owner?.chatSessionId;
    if (!chatSessionId || !deps.resolveChatTitle) return status;
    try {
      const chatTitle = asString(await deps.resolveChatTitle(chatSessionId));
      return { ...status, owner: { chatSessionId, chatTitle } };
    } catch {
      return status;
    }
  };

  const statusFor = async (laneId: string): Promise<AppleStatusPayload> =>
    buildAppleStatusPayload(laneId, await service.getStatus({ laneId }));

  const laneOf = (payload: Record<string, unknown>, action: string): string =>
    requireString(payload.laneId, `${action} requires laneId.`);

  const guarded = async (
    payload: Record<string, unknown>,
    action: string,
  ): Promise<{ laneId: string; chatSessionId: string | null }> => {
    const laneId = laneOf(payload, action);
    const chatSessionId = asString(payload.chatSessionId);
    assertAppleInputAllowed(await statusFor(laneId), chatSessionId);
    return { laneId, chatSessionId };
  };

  return [
    {
      action: "apple.status" as SyncRemoteCommandAction,
      policy: { viewerAllowed: true },
      handler: async (payload) => {
        const laneId = laneOf(payload, "apple.status");
        const raw = await service.getStatus({ laneId });
        const status = await withOwnerTitle(buildAppleStatusPayload(laneId, raw));
        return payload.full === true ? { ...status, raw } : status;
      },
    },
    {
      action: "apple.streamTicket" as SyncRemoteCommandAction,
      policy: { viewerAllowed: true },
      handler: async (payload) => {
        const laneId = laneOf(payload, "apple.streamTicket");
        if (!streamRelay) {
          throw new Error("The Apple device stream relay is not available in this runtime.");
        }
        // A remote viewer always gets the capped encode. Starting the capture
        // here rather than on attach means the ticket can carry the real
        // geometry, so the viewer sizes its canvas before the first frame.
        // No `boot`: a phone or web tab opening the viewer is WATCHING, and
        // watching never powers the Mac's simulator on. A device that is off
        // rejects with `APPLE_DEVICE_OFF`, which the viewer shows as
        // "{name} is off on your Mac."
        const started = await service.startStream({
          laneId,
          chatSessionId: asString(payload.chatSessionId),
          bitrateKbps: deps.remoteBitrateKbpsCap?.() ?? null,
        });
        const transport = isRecord(started) && isRecord(started.transport) ? started.transport : {};
        return streamRelay.issue({
          laneId,
          codec: asString(transport.codec),
          width: asNumber(transport.width),
          height: asNumber(transport.height),
        });
      },
    },
    {
      action: "apple.input" as SyncRemoteCommandAction,
      policy: { viewerAllowed: false, controllerAllowed: true },
      handler: async (payload) => {
        const { laneId, chatSessionId } = await guarded(payload, "apple.input");
        const kind = requireString(payload.kind, "apple.input requires a kind.");
        switch (kind) {
          case "tap":
            await service.tap({
              laneId,
              chatSessionId,
              x: requireFiniteNumber(payload.x, "x"),
              y: requireFiniteNumber(payload.y, "y"),
            });
            return { ok: true };
          case "type":
            await service.typeText({
              laneId,
              chatSessionId,
              text: requireString(payload.text, "apple.input type requires text."),
            });
            return { ok: true };
          case "drag":
            await service.drag({
              laneId,
              chatSessionId,
              startX: requireFiniteNumber(payload.startX, "startX"),
              startY: requireFiniteNumber(payload.startY, "startY"),
              endX: requireFiniteNumber(payload.endX, "endX"),
              endY: requireFiniteNumber(payload.endY, "endY"),
              durationMs: asNumber(payload.durationMs),
            });
            return { ok: true };
          case "scroll":
            await service.scroll({
              laneId,
              chatSessionId,
              direction: requireString(payload.direction, "apple.input scroll requires a direction."),
              amount: asNumber(payload.amount),
              anchorX: asNumber(payload.anchorX),
              anchorY: asNumber(payload.anchorY),
            });
            return { ok: true };
          case "tap-element":
            await service.tapElement({
              laneId,
              chatSessionId,
              ...(asString(payload.ref) ? { ref: asString(payload.ref)! } : {}),
              ...(asString(payload.label) ? { label: asString(payload.label)! } : {}),
            });
            return { ok: true };
          case "open-url":
            await service.openUrl({
              laneId,
              chatSessionId,
              url: requireString(payload.url, "apple.input open-url requires url."),
            });
            return { ok: true };
          default:
            throw new Error(`apple.input does not support '${kind}'.`);
        }
      },
    },
    {
      // The remaining `iosSimulator.*` surface, behind the SAME allowlist the
      // `ios_simulator` ADE action domain uses. One action rather than thirty
      // names on the wire: the web client renders the desktop column verbatim
      // and needs every button on it, while the allowlist — not this file — is
      // still the single place that says what a remote caller may reach.
      action: "apple.invoke" as SyncRemoteCommandAction,
      policy: { viewerAllowed: false, controllerAllowed: true },
      handler: async (payload) => {
        const method = requireString(payload.method, "apple.invoke requires a method.");
        if (!isAllowedAdeAction("ios_simulator", method)) {
          throw new Error(`apple.invoke does not allow '${method}'.`);
        }
        const call = (service as Record<string, unknown>)[method];
        if (typeof call !== "function") {
          throw new Error(`apple.invoke: '${method}' is not available in this runtime.`);
        }
        const invoke = call as (args: Record<string, unknown>) => Promise<unknown>;
        const chatSessionId = asString(payload.chatSessionId);
        // A guarded (mutating) method must name its lane. Without one it used to
        // run against whatever device was active, bypassing the cooperative chat
        // lock entirely; unguarded reads may still omit it.
        const guardedMethod = !APPLE_UNGUARDED_METHODS.has(method);
        const laneId = guardedMethod
          ? requireString(payload.laneId, `apple.invoke '${method}' requires laneId.`)
          : asString(payload.laneId);
        if (laneId && guardedMethod) {
          assertAppleInputAllowed(await statusFor(laneId), chatSessionId);
        }
        const methodArgs = isRecord(payload.args) ? payload.args : {};
        return invoke({
          ...methodArgs,
          ...(laneId ? { laneId } : {}),
          ...(chatSessionId ? { chatSessionId } : {}),
        });
      },
    },
    {
      action: "apple.deviceList" as SyncRemoteCommandAction,
      policy: { viewerAllowed: true },
      handler: async (payload) => service.deviceList({
        laneId: asString(payload.laneId),
        installed: payload.installed !== false,
        // Opt-in, so the phone's list paints before the `du` and the web
        // picker reports disk the same way the desktop one does.
        disk: payload.disk === true,
      }),
    },
    {
      action: "apple.deviceCreate" as SyncRemoteCommandAction,
      policy: { viewerAllowed: false, controllerAllowed: true },
      handler: async (payload) => service.deviceCreate({
        laneId: laneOf(payload, "apple.deviceCreate"),
        from: asString(payload.from),
        name: asString(payload.name),
      }),
    },
    {
      action: "apple.deviceAttach" as SyncRemoteCommandAction,
      policy: { viewerAllowed: false, controllerAllowed: true },
      handler: async (payload) => service.deviceAttach({
        laneId: laneOf(payload, "apple.deviceAttach"),
        simulator: requireString(payload.simulator, "apple.deviceAttach requires simulator."),
      }),
    },
    {
      action: "apple.recordList" as SyncRemoteCommandAction,
      policy: { viewerAllowed: true },
      handler: async (payload) => service.recordList({ laneId: laneOf(payload, "apple.recordList") }),
    },
    {
      action: "apple.recordStart" as SyncRemoteCommandAction,
      policy: { viewerAllowed: false, controllerAllowed: true },
      handler: async (payload) => {
        const { laneId, chatSessionId } = await guarded(payload, "apple.recordStart");
        return service.recordStart({ laneId, chatSessionId, label: asString(payload.label) });
      },
    },
    {
      action: "apple.recordStop" as SyncRemoteCommandAction,
      policy: { viewerAllowed: false, controllerAllowed: true },
      handler: async (payload) => {
        const { laneId, chatSessionId } = await guarded(payload, "apple.recordStop");
        return service.recordStop({ laneId, chatSessionId, keep: payload.keep !== false });
      },
    },
  ];
}

export const APPLE_REMOTE_COMMAND_ACTIONS = [
  "apple.status",
  "apple.streamTicket",
  "apple.input",
  "apple.invoke",
  "apple.deviceList",
  "apple.deviceCreate",
  "apple.deviceAttach",
  "apple.recordList",
  "apple.recordStart",
  "apple.recordStop",
] as const;
