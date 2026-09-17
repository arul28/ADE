/**
 * One private macOS screen per lane.
 *
 * The runtime half of the Mac Desktop feature: lane-to-display lifecycle,
 * window ownership, the input lease, idle release, the live stream, proof, and
 * teardown. The native `ade-desktop-driver` helper does everything that needs a
 * window server; this file decides what to ask it for and what to refuse.
 *
 * The platform gate is the same asymmetry `iosSimulatorService` uses, for the
 * same reason: `getStatus` answers everywhere, every other method rejects off
 * macOS, so a Windows desktop learns it cannot host a display by *reading*
 * rather than by catching a throw. `releaseIfOwnedBy` and `destroyForLane` are
 * the two exceptions, because a closing chat and a deleted lane must clean up
 * on any host.
 */

import type { Logger } from "../logging/logger";
import {
  MAC_DESKTOP_DEFAULT_RESOLUTION,
  MAC_DESKTOP_IDLE_RELEASE_MS,
  MAC_DESKTOP_MACOS_ONLY_MESSAGE,
  MAC_DESKTOP_RESOLUTION_PRESETS,
  macDesktopDisplayName,
  type MacDesktopActionResult,
  type DesktopSeatProvider,
  type MacDesktopClaimArgs,
  type MacDesktopClickArgs,
  type MacDesktopDisplay,
  type MacDesktopDisplayMode,
  type MacDesktopDragArgs,
  type MacDesktopEventPayload,
  type MacDesktopGetStatusArgs,
  type MacDesktopLeaseRequestArgs,
  type MacDesktopLeaseRequestResult,
  type MacDesktopLeaseState,
  type MacDesktopObservation,
  type MacDesktopObserveArgs,
  type MacDesktopOpenArgs,
  type MacDesktopOpenResult,
  type MacDesktopPermissions,
  type MacDesktopPressArgs,
  type MacDesktopPresentArgs,
  type MacDesktopRecordStartArgs,
  type MacDesktopRecordingStatus,
  type MacDesktopReleaseArgs,
  type MacDesktopResolutionPreset,
  type MacDesktopScreenshotArgs,
  type MacDesktopScreenshotResult,
  type MacDesktopScrollArgs,
  type MacDesktopServiceApi,
  type MacDesktopStartArgs,
  type MacDesktopStartStreamArgs,
  type MacDesktopStatus,
  type MacDesktopStopArgs,
  type MacDesktopStopResult,
  type MacDesktopStreamStatus,
  type MacDesktopTakeoverArgs,
  type MacDesktopTimeLapse,
  type MacDesktopTypeArgs,
  type MacDesktopWaitArgs,
  type MacDesktopWaitResult,
  type MacDesktopWindow,
} from "../../../shared/types/macDesktop";
import type {
  ComputerUseArtifactIngestionRequest,
  ComputerUseArtifactIngestionResult,
} from "../../../shared/types/computerUseArtifacts";
import { resolveMacDesktopDriverBinary } from "../native/nativeHelperPaths";
import {
  createMacDesktopDriverClient,
  MacDesktopDriverError,
  type MacDesktopDriverClient,
} from "./macDesktopDriverClient";
import { createMacDesktopLeaseRegistry } from "./macDesktopLease";
import { createMacDesktopLeaseFlow } from "./macDesktopLeaseFlow";
import {
  createMacDesktopOwnershipRegistry,
  MacDesktopOwnershipError,
} from "./macDesktopOwnership";
import { createMacDesktopObservations, MacDesktopObservationError } from "./macDesktopObservations";
import { createMacDesktopInput } from "./macDesktopInput";
import { createMacDesktopRecording } from "./macDesktopRecording";
import {
  asNullableString,
  asNumber,
  asRecord,
  asWindows,
  createMacVirtualDisplayProvider,
} from "./macDesktopSeatProvider";
import { createMacDesktopStreaming } from "./macDesktopStreaming";
import { createMacDesktopWindows } from "./macDesktopWindows";

/** KV key for the lane display size. Read on every `start`. */
export const MAC_DESKTOP_RESOLUTION_SETTING_KEY = "macDesktop.resolution";

/** How often the idle sweep runs. Cheap: it reads maps, never the driver. */
const IDLE_SWEEP_INTERVAL_MS = 30_000;

/**
 * A sweep that arrives this much later than scheduled means the machine was
 * asleep (or suspended).
 *
 * `powerMonitor` would say so directly, but it is Electron-only and this
 * service runs in the ADE runtime daemon too. A coarse wall-clock jump is the
 * honest stand-in, and the lease TTL is what actually guarantees the lease
 * cannot stick — this only makes the release immediate instead of eventual.
 */
const SLEEP_JUMP_FACTOR = 4;

export class MacDesktopError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    // `CODE: message`, the shape the unsupported-platform error already used.
    // The daemon flattens a thrown error to its message string, so the prefix
    // is the only part of the code that survives the wire — and the CLI's hint
    // table keys on exactly that. Without it every hint below the platform one
    // was unreachable. The CLI strips the prefix before printing the sentence.
    super(message.startsWith(`${code}:`) ? message : `${code}: ${message}`);
    this.name = "MacDesktopError";
    this.code = code;
  }
}

export type MacDesktopServiceDeps = {
  projectRoot: string;
  logger: Logger;
  /** Published on the runtime event stream as a `mac_desktop_event`. */
  onEvent?: ((payload: MacDesktopEventPayload) => void) | null;
  platform?: NodeJS.Platform;
  now?: () => number;
  resolveLaneWorktreePath?: ((laneId: string) => Promise<string | null> | string | null) | null;
  resolveLaneName?: ((laneId: string) => Promise<string | null> | string | null) | null;
  resolvePrimaryPrUrl?: ((laneId: string) => Promise<string | null> | string | null) | null;
  /** `computerUseArtifactBrokerService.ingest`. The one proof path. */
  ingestArtifacts?: ((request: ComputerUseArtifactIngestionRequest) => ComputerUseArtifactIngestionResult) | null;
  /**
   * The pending-input card. Wired to `agentChatService.requestChatInput`, the
   * same call `ade chat ask` and MCP elicitation resolve through, so the lease
   * question is one more card in the thread rather than a second channel.
   */
  requestChatInput?: ((args: {
    chatSessionId: string;
    title: string;
    body: string;
    questions?: Array<{
      id?: string;
      header?: string;
      question: string;
      options?: Array<{ label: string; value?: string; description?: string; recommended?: boolean }>;
      allowsFreeform?: boolean;
    }>;
    providerMetadata?: Record<string, unknown>;
    eventDescription?: string;
    eventDetail?: Record<string, unknown>;
  }) => Promise<{ decision: string; answers: Record<string, string[]>; responseText: string | null }>) | null;
  readSetting?: (<T>(key: string) => T | null) | null;
  writeSetting?: ((key: string, value: unknown) => void) | null;
  /** True when the ADE window asking is on this Mac. Defaults to true. */
  hostIsLocal?: (() => boolean) | null;
  /** Test seam: supply a fake driver client instead of spawning the helper. */
  createDriverClient?: ((args: {
    logger: Logger;
    platform: NodeJS.Platform;
    onHealthChanged: (health: import("../../../shared/types/macDesktop").MacDesktopDriverHealth) => void;
    onDriverLost: (reason: string) => void;
  }) => MacDesktopDriverClient) | null;
};

type DriverDisplayReply = MacDesktopDisplay & { displayId?: number };

/**
 * What the runtime actually holds.
 *
 * `MacDesktopServiceApi` is the cross-process contract every surface is built
 * against; these few extras are in-process only — a subscription for the Work
 * tools mirror, the turn-clip opener the chat runtime calls, and the resolution
 * setting — and they are named here rather than left implicit so a caller can
 * be typed against them.
 */
export type MacDesktopRuntimeService = MacDesktopServiceApi & {
  beginTurn(args: { laneId: string; chatSessionId: string; turnId: string }): Promise<void>;
  /**
   * Whether the lane has a display right now, answered from memory.
   *
   * `getDisplay` is async because it is part of the cross-process contract;
   * the two callers that need this answer on a hot path — the one-line prompt
   * directive and the per-turn clip gate — run inside the chat send path and
   * must not await a service call to decide to do nothing.
   */
  hasDisplaySync(laneId: string | null | undefined): boolean;
  readonly resolutionSettingKey: string;
  setResolution(preset: MacDesktopResolutionPreset): void;
  getResolution(): MacDesktopResolutionPreset;
};

export function createMacDesktopService(deps: MacDesktopServiceDeps): MacDesktopRuntimeService {
  const platform = deps.platform ?? process.platform;
  const now = deps.now ?? (() => Date.now());
  const isDarwin = platform === "darwin";

  const ownership = createMacDesktopOwnershipRegistry({ now });
  const leases = createMacDesktopLeaseRegistry({ now });
  const observations = createMacDesktopObservations({
    projectRoot: deps.projectRoot,
    now,
    ...(deps.resolveLaneWorktreePath ? { resolveLaneWorktreePath: deps.resolveLaneWorktreePath } : {}),
    ...(deps.ingestArtifacts ? { ingestArtifacts: deps.ingestArtifacts } : {}),
    ...(deps.resolvePrimaryPrUrl ? { resolvePrimaryPrUrl: deps.resolvePrimaryPrUrl } : {}),
  });

  let disposed = false;
  let permissions: MacDesktopPermissions = { screenRecording: "unknown", accessibility: "unknown" };
  let displayMode: MacDesktopDisplayMode = isDarwin ? "virtual" : "unavailable";
  /**
   * The driver process and the seat provider that wraps it.
   *
   * One handle rather than two nullables: they are minted together and cleared
   * together, and every reader wanted both. Two fields meant every use site
   * asserted one of them non-null off the other's check.
   */
  let backend: { client: MacDesktopDriverClient; provider: DesktopSeatProvider } | null = null;
  let driverEventUnsubscribe: (() => void) | null = null;
  let reconciled = false;
  const startLocks = new Map<string, Promise<MacDesktopStatus>>();
  /**
   * Lanes this process is tearing down right now.
   *
   * The helper emits `display-destroyed` for a `display.destroy` ADE asked for,
   * so without this the service published the event twice: once from the driver
   * with the generic reason `stopped`, and once from `destroyDisplay` with the
   * real one. The driver-originated copy is dropped while a destroy of ours is
   * in flight; a display that dies on its own still reaches clients.
   */
  const destroyingLanes = new Set<string>();
  let sweepTimer: ReturnType<typeof setInterval> | null = null;
  let lastSweepAtMs = now();

  /**
   * In-process subscribers, alongside `onEvent`.
   *
   * The Work tools mirror holds `Pick<MacDesktopServiceApi, "getStatus"> &
   * { subscribe }` so it can re-read lane state on a change without being able
   * to start a display or move a pointer.
   */
  const listeners = new Set<(payload: MacDesktopEventPayload) => void>();

  const emit = (payload: MacDesktopEventPayload): void => {
    try {
      deps.onEvent?.(payload);
    } catch (error) {
      deps.logger.debug("mac_desktop.event_listener_failed", {
        type: payload.type,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    for (const listener of [...listeners]) {
      try {
        listener(payload);
      } catch (error) {
        deps.logger.debug("mac_desktop.subscriber_failed", {
          type: payload.type,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  // -------------------------------------------------------------------------
  // Gates
  // -------------------------------------------------------------------------

  const assertSupported = (): void => {
    if (!isDarwin) {
      throw new MacDesktopError("MAC_DESKTOP_UNSUPPORTED_PLATFORM", MAC_DESKTOP_MACOS_ONLY_MESSAGE);
    }
  };

  const assertPermission = (which: "screenRecording" | "accessibility"): void => {
    if (permissions[which] !== "denied") return;
    throw new MacDesktopError(
      "MAC_DESKTOP_PERMISSION_REQUIRED",
      which === "screenRecording"
        ? "ADE needs Screen Recording permission to capture this display. Grant it in System Settings › Privacy & Security › Screen Recording, then try again."
        : "ADE needs Accessibility permission to drive windows on this display. Grant it in System Settings › Privacy & Security › Accessibility, then try again.",
    );
  };

  const requireDisplay = (laneId: string): MacDesktopDisplay => {
    const display = ownership.getDisplay(laneId);
    if (!display) {
      throw new MacDesktopError(
        "MAC_DESKTOP_NO_DISPLAY",
        `Lane ${laneId} has no Mac Desktop display. Start one first.`,
      );
    }
    return display;
  };

  const toServiceError = (error: unknown): Error => {
    if (error instanceof MacDesktopError) return error;
    if (error instanceof MacDesktopOwnershipError) return new MacDesktopError(error.code, error.message);
    if (error instanceof MacDesktopObservationError) return new MacDesktopError(error.code, error.message);
    if (error instanceof MacDesktopDriverError) return new MacDesktopError(error.code, error.message);
    return error instanceof Error ? error : new Error(String(error));
  };

  /**
   * The backend, started if it is not already.
   *
   * Everything the helper can do is reached through the provider; the client
   * itself is only used for what is not an operation on a seat — starting,
   * health, and the event stream.
   */
  const ensureProvider = async (): Promise<DesktopSeatProvider> => (await ensureDriver()).provider;

  /** The backend only when it is already running: teardown must not start one. */
  const activeProvider = (): DesktopSeatProvider | null =>
    (backend && backend.client.isRunning() ? backend.provider : null);

  const streaming = createMacDesktopStreaming({
    logger: deps.logger,
    now,
    isDarwin,
    emit,
    ensureProvider,
    activeProvider,
    requireDisplay: (laneId) => {
      requireDisplay(laneId);
    },
    assertPermission,
    touchDisplay: (laneId) => ownership.touchDisplay(laneId),
    driverUnavailable: (message) => new MacDesktopError("MAC_DESKTOP_DRIVER_UNAVAILABLE", message),
  });
  const streamServer = streaming.streamServer;

  const recording = createMacDesktopRecording({
    logger: deps.logger,
    now,
    isDarwin,
    emit,
    observations,
    ensureProvider,
    activeProvider,
    requireDisplay: (laneId) => {
      requireDisplay(laneId);
    },
    assertPermission,
    recordingNotRunning: (laneId) => new MacDesktopError(
      "MAC_DESKTOP_RECORDING_NOT_RUNNING",
      `Lane ${laneId} is not recording its desktop.`,
    ),
  });
  const recordings = recording.recordings;

  const input = createMacDesktopInput({
    now,
    emit,
    ensureProvider,
    requireDisplay,
    assertPermission,
    observations,
    ownership,
    leases,
    noteStreamActivity: (laneId) => streamServer.noteActivity(laneId),
    noteTurnActivity: (laneId, chatSessionId) => recording.noteTurnActivity(laneId, chatSessionId),
    toServiceError,
    serviceError: (code, message) => new MacDesktopError(code, message),
  });

  const windowLifecycle = createMacDesktopWindows({
    logger: deps.logger,
    isDarwin,
    emit,
    ensureProvider,
    activeProvider,
    requireDisplay: (laneId) => {
      requireDisplay(laneId);
    },
    assertPermission,
    ownership,
  });

  const leaseFlow = createMacDesktopLeaseFlow({
    logger: deps.logger,
    isDarwin,
    leases,
    emit,
    requireDisplay: (laneId) => {
      requireDisplay(laneId);
    },
    activeProvider,
    ...(deps.requestChatInput ? { requestChatInput: deps.requestChatInput } : {}),
  });
  const pushLease = leaseFlow.pushLease;

  // -------------------------------------------------------------------------
  // The driver
  // -------------------------------------------------------------------------

  const handleDriverEvent = (event: Record<string, unknown> & { event: string }): void => {
    const laneId = asNullableString(event.laneId);
    switch (event.event) {
      case "windows-changed": {
        if (!laneId) return;
        const windows = asWindows(event.windows);
        ownership.reconcileWindows(laneId, windows);
        for (const window of windows) {
          if (window.laneId !== laneId) continue;
          try {
            ownership.claimWindow({
              laneId,
              windowId: window.id,
              pid: window.pid,
              bundleId: window.bundleId,
              appName: window.appName,
              origin: window.origin,
              singleInstance: window.singleInstance,
            });
          } catch {
            // A window the driver parked for another lane's app is reported,
            // never re-owned here; `claim` is where that refusal belongs.
          }
        }
        ownership.touchDisplay(laneId);
        emit({ type: "windows-changed", laneId, windows });
        return;
      }
      case "permissions-changed":
      case "permission-changed": {
        const next = asRecord(event.permissions) as unknown as MacDesktopPermissions;
        applyPermissions(next);
        return;
      }
      case "stream-error": {
        if (!laneId) return;
        streaming.recordError(laneId, asNullableString(event.message) ?? "The desktop encoder failed.");
        return;
      }
      case "window-not-parked": {
        // The window is still on the user's own screen. Only the surface
        // watching the lane can say so, so this is forwarded rather than logged.
        if (!laneId) return;
        const windowId = asNumber(event.windowId, 0);
        if (!windowId) return;
        emit({
          type: "window-not-parked",
          laneId,
          windowId,
          reason: asNullableString(event.reason) ?? "The window could not be moved to this lane's display.",
        });
        return;
      }
      case "display-destroyed": {
        if (!laneId) return;
        // Our own `display.destroy` is echoed back as this event. `destroyDisplay`
        // publishes the real reason itself, so the echo is dropped rather than
        // publishing a second, vaguer copy of the same fact.
        if (destroyingLanes.has(laneId)) return;
        ownership.removeDisplay(laneId);
        leases.releaseLane(laneId);
        observations.forgetLane(laneId);
        streaming.forgetLane(laneId);
        recording.forgetLane(laneId);
        emit({ type: "display-destroyed", laneId, reason: "stopped" });
        return;
      }
      default:
        deps.logger.debug("mac_desktop.driver_event", { event: event.event, laneId });
    }
  };

  const applyPermissions = (next: Partial<MacDesktopPermissions> | null | undefined): void => {
    if (!next) return;
    const merged: MacDesktopPermissions = {
      screenRecording: next.screenRecording ?? permissions.screenRecording,
      accessibility: next.accessibility ?? permissions.accessibility,
    };
    if (merged.screenRecording === permissions.screenRecording && merged.accessibility === permissions.accessibility) {
      return;
    }
    permissions = merged;
    emit({ type: "permission-changed", permissions: merged });
    // A revoked grant is a health transition too: the card that says "grant
    // permission" is the only actionable thing left on this host.
    if (backend) emit({ type: "driver-health", health: backend.client.getHealth() });
  };

  const onDriverLost = (reason: string): void => {
    for (const laneId of ownership.laneIds()) {
      streaming.forgetLane(laneId);
      observations.forgetLane(laneId);
      leases.releaseLane(laneId);
      emit({ type: "display-destroyed", laneId, reason: "driver_lost" });
    }
    ownership.clear();
    recording.clear();
    streaming.clear();
    reconciled = false;
    deps.logger.warn("mac_desktop.driver_lost", { reason });
  };

  const ensureDriver = async (): Promise<{ client: MacDesktopDriverClient; provider: DesktopSeatProvider }> => {
    assertSupported();
    if (disposed) throw new MacDesktopError("MAC_DESKTOP_DRIVER_UNAVAILABLE", "The Mac Desktop service is disposed.");
    if (!backend) {
      const client = deps.createDriverClient
        ? deps.createDriverClient({
          logger: deps.logger,
          platform,
          onHealthChanged: (health) => emit({ type: "driver-health", health }),
          onDriverLost,
        })
        : createMacDesktopDriverClient({
          logger: deps.logger,
          platform,
          resolveExecutablePath: () => resolveMacDesktopDriverBinary({ platform, logger: deps.logger }),
          onHealthChanged: (health) => emit({ type: "driver-health", health }),
          onDriverLost,
        });
      backend = { client, provider: createMacVirtualDisplayProvider(client) };
      driverEventUnsubscribe = client.onEvent((event) => handleDriverEvent(event));
    }
    await backend.client.ensureStarted();
    await refreshDriverHealth(backend.client, backend.provider);
    return backend;
  };

  const refreshDriverHealth = async (client: MacDesktopDriverClient, seat: DesktopSeatProvider): Promise<void> => {
    try {
      const reply = await seat.health();
      client.setVersion(asNullableString(reply.version));
      applyPermissions(asRecord(reply.permissions) as Partial<MacDesktopPermissions>);
      const mode = asNullableString(reply.displayMode);
      if (mode === "virtual" || mode === "offscreen-region" || mode === "unavailable") displayMode = mode;
    } catch (error) {
      deps.logger.debug("mac_desktop.driver_health_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  /**
   * Destroys every ADE display no live lane claims.
   *
   * Runs once per driver start. A crashed run leaves its virtual displays
   * behind otherwise, and nothing else would ever notice them — only displays
   * ADE created, tracked by the exact id it received, are ever destroyed.
   */
  const reconcileDisplays = async (seat: DesktopSeatProvider): Promise<void> => {
    if (reconciled) return;
    reconciled = true;
    try {
      await seat.reconcile({ liveLaneIds: ownership.laneIds() });
    } catch (error) {
      deps.logger.debug("mac_desktop.reconcile_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  const buildStatus = async (args: MacDesktopGetStatusArgs = {}): Promise<MacDesktopStatus> => {
    const laneId = args.laneId?.trim() || null;
    const driverHealth = backend?.client.getHealth() ?? {
      state: isDarwin ? "starting" as const : "unsupported" as const,
      title: isDarwin ? "Mac Desktop is starting" : "Mac Desktop needs macOS",
      message: isDarwin ? "ADE is preparing the native desktop driver." : MAC_DESKTOP_MACOS_ONLY_MESSAGE,
      recovery: isDarwin ? "retry" as const : null,
      version: null,
    };
    const supported = isDarwin && driverHealth.state !== "missing" && driverHealth.state !== "unsupported";
    const display = laneId ? ownership.getDisplay(laneId) : null;
    const windows = laneId ? await windowLifecycle.listInternal(laneId).catch(() => []) : [];
    const streamStatus = laneId ? streaming.buildStreamStatus(laneId, { redacted: true }) : null;
    return {
      platform,
      supported,
      unsupportedReason: supported
        ? null
        : (isDarwin ? driverHealth.message : MAC_DESKTOP_MACOS_ONLY_MESSAGE),
      driver: driverHealth,
      permissions,
      displayMode: isDarwin ? displayMode : "unavailable",
      display,
      windows,
      lease: laneId ? leases.get(laneId) : null,
      stream: streamStatus && streamStatus.running
        ? {
          running: streamStatus.running,
          idle: streamStatus.idle,
          fps: streamStatus.fps,
          bitrateKbps: streamStatus.bitrateKbps,
          lastError: streamStatus.lastError,
        }
        : null,
      recording: laneId ? recordings.get(laneId) ?? null : null,
      lanes: ownership.laneSummaries((lane) => streamServer.isStreaming(lane)),
      hostIsLocal: deps.hostIsLocal ? deps.hostIsLocal() : true,
    };
  };

  // -------------------------------------------------------------------------
  // Display lifecycle
  // -------------------------------------------------------------------------

  const readResolution = (requested?: MacDesktopResolutionPreset | null): MacDesktopResolutionPreset => {
    if (requested && requested in MAC_DESKTOP_RESOLUTION_PRESETS) return requested;
    const stored = deps.readSetting?.<string>(MAC_DESKTOP_RESOLUTION_SETTING_KEY) ?? null;
    if (stored && stored in MAC_DESKTOP_RESOLUTION_PRESETS) return stored as MacDesktopResolutionPreset;
    return MAC_DESKTOP_DEFAULT_RESOLUTION;
  };

  const startInternal = async (args: MacDesktopStartArgs): Promise<MacDesktopStatus> => {
    const laneId = args.laneId.trim();
    if (!laneId) throw new MacDesktopError("MAC_DESKTOP_NO_DISPLAY", "start needs a laneId.");
    // An explicit resolution is a preference first: it is what the next start
    // on this host uses, whether or not a display is live right now.
    const requested = args.resolution && args.resolution in MAC_DESKTOP_RESOLUTION_PRESETS
      ? args.resolution
      : null;
    if (requested) deps.writeSetting?.(MAC_DESKTOP_RESOLUTION_SETTING_KEY, requested);
    const existing = ownership.getDisplay(laneId);
    if (existing) {
      const wanted = requested ? MAC_DESKTOP_RESOLUTION_PRESETS[requested] : null;
      const sameSize = !wanted
        || (existing.width === wanted.width && existing.height === wanted.height);
      if (sameSize) {
        ownership.touchDisplay(laneId);
        return await buildStatus({ laneId });
      }
      // The driver has no resize op, so a new size is a new display. Saying
      // "ok" and leaving the old size in place — which is what returning the
      // existing display did — made `ade mac-desktop display 1080p` a no-op
      // that reported success. The parked windows go back to the user's screen,
      // the same as `stop`, and the caller re-opens what it still needs.
      await destroyDisplay(laneId, "stopped");
    }
    const seat = await ensureProvider();
    await reconcileDisplays(seat);
    assertPermission("screenRecording");
    const laneName = args.laneName?.trim()
      || (await Promise.resolve(deps.resolveLaneName?.(laneId)).catch(() => null))
      || null;
    const preset = readResolution(args.resolution);
    const size = MAC_DESKTOP_RESOLUTION_PRESETS[preset];
    const reply = await seat.create({
      laneId,
      name: macDesktopDisplayName(laneName),
      width: size.width,
      height: size.height,
      scale: 2,
    }) as DriverDisplayReply;
    const display: MacDesktopDisplay = {
      laneId,
      displayId: asNumber(reply.displayId, 0),
      name: asNullableString(reply.name) ?? macDesktopDisplayName(laneName),
      mode: (reply.mode as MacDesktopDisplayMode) ?? displayMode,
      width: asNumber(reply.width, size.width),
      height: asNumber(reply.height, size.height),
      scale: asNumber(reply.scale, 2),
      origin: {
        x: asNumber(asRecord(reply.origin).x, 0),
        y: asNumber(asRecord(reply.origin).y, 0),
      },
      createdAt: asNullableString(reply.createdAt) ?? new Date(now()).toISOString(),
      windowCount: 0,
      lastActivityAt: new Date(now()).toISOString(),
    };
    displayMode = display.mode;
    const stored = ownership.setDisplay(display, laneName);
    emit({ type: "display-created", display: stored });
    ensureSweepTimer();
    return await buildStatus({ laneId });
  };

  const destroyDisplay = async (
    laneId: string,
    reason: "stopped" | "idle" | "lane_removed" | "driver_lost",
  ): Promise<{ destroyed: boolean; releasedWindows: number }> => {
    const had = ownership.hasDisplay(laneId);
    destroyingLanes.add(laneId);
    try {
      // Before the display goes: the helper has one recorder per lane, and a
      // turn clip still writing into it would be a file nobody ever closes.
      await recording.stopTurnClips(laneId);
      streaming.forgetLane(laneId);
      recording.forgetLane(laneId);
      observations.forgetLane(laneId);
      leases.releaseLane(laneId);
      let releasedWindows = ownership.windowCount(laneId);
      const seat = isDarwin ? activeProvider() : null;
      if (seat) {
        try {
          const reply = await seat.destroy({ laneId });
          releasedWindows = asNumber(reply.releasedWindows, releasedWindows);
        } catch (error) {
          deps.logger.debug("mac_desktop.destroy_display_failed", {
            laneId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      ownership.removeDisplay(laneId);
      if (had) emit({ type: "display-destroyed", laneId, reason });
      return { destroyed: had, releasedWindows };
    } finally {
      destroyingLanes.delete(laneId);
    }
  };

  // -------------------------------------------------------------------------
  // Idle release and the sleep stand-in
  // -------------------------------------------------------------------------

  const sweep = (): void => {
    const atMs = now();
    const elapsed = atMs - lastSweepAtMs;
    lastSweepAtMs = atMs;
    if (elapsed > IDLE_SWEEP_INTERVAL_MS * SLEEP_JUMP_FACTOR) {
      const dropped = leases.releaseAll();
      for (const lease of dropped) emit({ type: "lease-changed", laneId: lease.laneId, lease: null });
      if (dropped.length) {
        deps.logger.info("mac_desktop.leases_dropped_after_clock_jump", { elapsed, dropped: dropped.length });
      }
    }
    for (const expired of leases.sweep()) {
      emit({ type: "lease-changed", laneId: expired.laneId, lease: null });
    }
    for (const display of ownership.listDisplays()) {
      if (display.windowCount > 0) continue;
      if (streamServer.clientCount(display.laneId) > 0) continue;
      if (recordings.get(display.laneId)?.running) continue;
      const lastActivityMs = Date.parse(display.lastActivityAt);
      if (Number.isFinite(lastActivityMs) && atMs - lastActivityMs < MAC_DESKTOP_IDLE_RELEASE_MS) continue;
      void destroyDisplay(display.laneId, "idle").catch((error) => {
        deps.logger.debug("mac_desktop.idle_release_failed", {
          laneId: display.laneId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  };

  function ensureSweepTimer(): void {
    if (sweepTimer || disposed) return;
    lastSweepAtMs = now();
    sweepTimer = setInterval(sweep, IDLE_SWEEP_INTERVAL_MS);
    sweepTimer.unref?.();
  }

  // -------------------------------------------------------------------------
  // The API
  // -------------------------------------------------------------------------

  const api: MacDesktopServiceApi = {
    async getStatus(args: MacDesktopGetStatusArgs = {}): Promise<MacDesktopStatus> {
      // The one method that answers on every platform. It must never spawn,
      // probe, or throw: a Windows desktop reads this to learn the tab is not
      // available here, and a read that throws cannot say so.
      if (!isDarwin) return await buildStatus(args);
      if (!backend) {
        // Bring the helper up on the first read so the health card is real
        // rather than a permanent "starting". A failure to start is health,
        // not an exception.
        await ensureDriver().catch((error) => {
          deps.logger.debug("mac_desktop.status_driver_start_failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      } else if (backend.client.isRunning()) {
        await refreshDriverHealth(backend.client, backend.provider);
      }
      return await buildStatus(args);
    },

    async start(args: MacDesktopStartArgs): Promise<MacDesktopStatus> {
      assertSupported();
      const laneId = args.laneId.trim();
      // Two chats in one lane can ask at the same moment. Serialised per lane
      // so the second caller receives the first caller's display instead of
      // creating a second one on top of it.
      const inflight = startLocks.get(laneId);
      if (inflight) return await inflight;
      const pending = startInternal(args).finally(() => {
        if (startLocks.get(laneId) === pending) startLocks.delete(laneId);
      });
      startLocks.set(laneId, pending);
      return await pending;
    },

    async stop(args: MacDesktopStopArgs): Promise<MacDesktopStopResult> {
      assertSupported();
      const result = await destroyDisplay(args.laneId.trim(), "stopped");
      return { stopped: result.destroyed, releasedWindows: result.releasedWindows };
    },

    async getDisplay(args: { laneId: string }): Promise<MacDesktopDisplay | null> {
      assertSupported();
      return ownership.getDisplay(args.laneId.trim());
    },

    async listWindows(args: { laneId?: string | null } = {}): Promise<MacDesktopWindow[]> {
      assertSupported();
      await ensureDriver();
      return await windowLifecycle.listInternal(args.laneId ?? null);
    },

    async open(args: MacDesktopOpenArgs): Promise<MacDesktopOpenResult> {
      assertSupported();
      return await windowLifecycle.open(args);
    },

    async claimWindow(args: MacDesktopClaimArgs): Promise<MacDesktopWindow> {
      assertSupported();
      return await windowLifecycle.claimWindow(args);
    },

    async releaseWindow(args: MacDesktopReleaseArgs): Promise<{ released: number }> {
      assertSupported();
      return await windowLifecycle.releaseWindow(args);
    },

    async observe(args: MacDesktopObserveArgs): Promise<MacDesktopObservation> {
      assertSupported();
      return await input.observe(args);
    },

    async click(args: MacDesktopClickArgs): Promise<MacDesktopActionResult> {
      assertSupported();
      return await input.click(args);
    },

    async type(args: MacDesktopTypeArgs): Promise<MacDesktopActionResult> {
      assertSupported();
      return await input.type(args);
    },

    async press(args: MacDesktopPressArgs): Promise<MacDesktopActionResult> {
      assertSupported();
      return await input.press(args);
    },

    async scroll(args: MacDesktopScrollArgs): Promise<MacDesktopActionResult> {
      assertSupported();
      return await input.scroll(args);
    },

    async drag(args: MacDesktopDragArgs): Promise<MacDesktopActionResult> {
      assertSupported();
      return await input.drag(args);
    },

    async wait(args: MacDesktopWaitArgs): Promise<MacDesktopWaitResult> {
      assertSupported();
      return await input.wait(args);
    },

    async screenshot(args: MacDesktopScreenshotArgs): Promise<MacDesktopScreenshotResult> {
      assertSupported();
      return await input.screenshot(args);
    },

    async startRecording(args: MacDesktopRecordStartArgs): Promise<MacDesktopRecordingStatus> {
      assertSupported();
      return await recording.startRecording(args);
    },

    async stopRecording(args: { laneId: string; chatSessionId?: string | null }): Promise<MacDesktopRecordingStatus> {
      assertSupported();
      return await recording.stopRecording(args);
    },

    async startStream(args: MacDesktopStartStreamArgs): Promise<MacDesktopStreamStatus> {
      assertSupported();
      return await streaming.startStream(args);
    },

    async stopStream(args: { laneId: string }): Promise<MacDesktopStreamStatus> {
      assertSupported();
      return await streaming.stopStream(args.laneId.trim(), "stopped");
    },

    async getStreamStatus(args: { laneId: string }): Promise<MacDesktopStreamStatus> {
      assertSupported();
      // Redacted by construction: this read is on the agent action allowlist.
      return streaming.buildStreamStatus(args.laneId.trim(), { redacted: true });
    },

    async requestInputLease(args: MacDesktopLeaseRequestArgs): Promise<MacDesktopLeaseRequestResult> {
      assertSupported();
      return await leaseFlow.requestInputLease(args);
    },

    async takeControl(args: MacDesktopTakeoverArgs): Promise<MacDesktopLeaseState> {
      assertSupported();
      const laneId = args.laneId.trim();
      requireDisplay(laneId);
      const decision = leases.takeControl({
        laneId,
        controllerId: args.controllerId,
        controllerLabel: args.controllerLabel ?? null,
      });
      if (!decision.ok) throw new MacDesktopError(decision.code, decision.message);
      await pushLease(laneId, decision.lease);
      // A person who just took the pointer is watching; give them full rate.
      streamServer.noteActivity(laneId);
      ownership.touchDisplay(laneId);
      emit({ type: "lease-changed", laneId, lease: decision.lease });
      return decision.lease;
    },

    async returnControl(args: { laneId: string; controllerId: string }): Promise<MacDesktopLeaseState | null> {
      assertSupported();
      const laneId = args.laneId.trim();
      const result = leases.returnControl({ laneId, controllerId: args.controllerId });
      if (result.released) {
        await pushLease(laneId, null);
        emit({ type: "lease-changed", laneId, lease: null });
      }
      return result.lease;
    },

    async renewLease(args: { laneId: string; holderId: string }): Promise<MacDesktopLeaseState | null> {
      assertSupported();
      const laneId = args.laneId.trim();
      const lease = leases.renew({ laneId, holderId: args.holderId });
      if (lease) await pushLease(laneId, lease);
      else emit({ type: "lease-changed", laneId, lease: null });
      return lease;
    },

    async present(args: MacDesktopPresentArgs): Promise<{ moved: number }> {
      assertSupported();
      return await windowLifecycle.present(args);
    },

    async noteTurnEnded(args: {
      laneId: string;
      chatSessionId: string;
      turnId: string;
    }): Promise<MacDesktopTimeLapse | null> {
      return await recording.noteTurnEnded(args);
    },

    /** Runs on every platform: a closing chat must drop its lease anywhere. */
    async releaseIfOwnedBy(chatSessionId: string | null | undefined): Promise<{ released: boolean }> {
      const trimmed = chatSessionId?.trim();
      if (!trimmed) return { released: false };
      const dropped = leases.releaseHolder(trimmed);
      for (const lease of dropped) {
        emit({ type: "lease-changed", laneId: lease.laneId, lease: null });
        await pushLease(lease.laneId, null).catch(() => {
          // The driver refusing to hear about a cleared lease must not stop the
          // chat from closing; the helper's own TTL covers it.
        });
      }
      await streaming.stopOwnedBy(trimmed);
      // The chat that opened a turn clip is gone; the helper's one recorder per
      // lane must not stay held by a turn that can never end.
      for (const lease of dropped) await recording.stopTurnClips(lease.laneId);
      return { released: dropped.length > 0 };
    },

    /** Runs on every platform: the lane teardown step calls it unconditionally. */
    async destroyForLane(laneId: string): Promise<{ destroyed: boolean }> {
      const trimmed = laneId?.trim();
      if (!trimmed) return { destroyed: false };
      if (!isDarwin) return { destroyed: false };
      const result = await destroyDisplay(trimmed, "lane_removed").catch((error: unknown) => {
        deps.logger.debug("mac_desktop.destroy_for_lane_failed", {
          laneId: trimmed,
          error: error instanceof Error ? error.message : String(error),
        });
        return { destroyed: false, releasedWindows: 0 };
      });
      return { destroyed: result.destroyed };
    },

    /**
     * Subscribes to the same events `onEvent` publishes.
     *
     * The Work tools mirror holds this plus `getStatus` and nothing else, so a
     * read-only surface cannot start a display or move a pointer.
     */
    subscribe(listener: (payload: MacDesktopEventPayload) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = null;
      }
      streaming.dispose();
      driverEventUnsubscribe?.();
      driverEventUnsubscribe = null;
      backend?.client.dispose();
      backend = null;
      ownership.clear();
      startLocks.clear();
      recording.clear();
    },
  };

  return Object.assign(api, {
    /** The sync half of `getDisplay`, for the prompt gate and the turn clip. */
    hasDisplaySync(laneId: string | null | undefined): boolean {
      const trimmed = laneId?.trim();
      if (!trimmed || !isDarwin) return false;
      return ownership.hasDisplay(trimmed);
    },
    /** Opens the turn clip. Called by the chat runtime on the turn's first act. */
    beginTurn(args: { laneId: string; chatSessionId: string; turnId: string }): Promise<void> {
      if (!isDarwin) return Promise.resolve();
      return recording.startTurnClip(args.laneId.trim(), args.chatSessionId.trim(), args.turnId);
    },
    /** The KV key the resolution preset is stored under. */
    resolutionSettingKey: MAC_DESKTOP_RESOLUTION_SETTING_KEY,
    setResolution(preset: MacDesktopResolutionPreset): void {
      deps.writeSetting?.(MAC_DESKTOP_RESOLUTION_SETTING_KEY, preset);
    },
    getResolution(): MacDesktopResolutionPreset {
      return readResolution(null);
    },
  });
}

export type MacDesktopService = ReturnType<typeof createMacDesktopService>;
