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
  MAC_DESKTOP_OBSERVATION_ELEMENT_LIMIT,
  MAC_DESKTOP_RESOLUTION_PRESETS,
  macDesktopDisplayName,
  type MacDesktopActionResult,
  type DesktopSeatProvider,
  type MacDesktopClaimArgs,
  type MacDesktopClickArgs,
  type MacDesktopDisplay,
  type MacDesktopDisplayMode,
  type MacDesktopDragArgs,
  type MacDesktopElement,
  type MacDesktopEventPayload,
  type MacDesktopGetStatusArgs,
  type MacDesktopInputMode,
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
  type MacDesktopTarget,
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
import { createMacDesktopRecording } from "./macDesktopRecording";
import { createMacVirtualDisplayProvider } from "./macDesktopSeatProvider";
import { createMacDesktopStreaming } from "./macDesktopStreaming";

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

/** An observation asking for more than this is clamped. */
const MAX_OBSERVATION_LIMIT = MAC_DESKTOP_OBSERVATION_ELEMENT_LIMIT;

const DEFAULT_WAIT_TIMEOUT_MS = 10_000;
const MAX_WAIT_TIMEOUT_MS = 120_000;

export class MacDesktopError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
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

const asRecord = (value: unknown): Record<string, unknown> =>
  (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});

const asNumber = (value: unknown, fallback: number): number =>
  (typeof value === "number" && Number.isFinite(value) ? value : fallback);

const asNullableString = (value: unknown): string | null =>
  (typeof value === "string" && value.trim().length ? value.trim() : null);

const asWindows = (value: unknown): MacDesktopWindow[] =>
  (Array.isArray(value) ? value as MacDesktopWindow[] : []);

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
  let driver: MacDesktopDriverClient | null = null;
  /** The one backend. Minted with the driver client it wraps. */
  let provider: DesktopSeatProvider | null = null;
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
  const ensureProvider = async (): Promise<DesktopSeatProvider> => {
    await ensureDriver();
    return provider!;
  };

  /** The backend only when it is already running: teardown must not start one. */
  const activeProvider = (): DesktopSeatProvider | null =>
    (driver && driver.isRunning() ? provider : null);

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
    if (driver) emit({ type: "driver-health", health: driver.getHealth() });
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

  const ensureDriver = async (): Promise<MacDesktopDriverClient> => {
    assertSupported();
    if (disposed) throw new MacDesktopError("MAC_DESKTOP_DRIVER_UNAVAILABLE", "The Mac Desktop service is disposed.");
    if (!driver) {
      driver = deps.createDriverClient
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
      provider = createMacVirtualDisplayProvider(driver);
      driverEventUnsubscribe = driver.onEvent((event) => handleDriverEvent(event));
    }
    await driver.ensureStarted();
    await refreshDriverHealth(driver, provider!);
    return driver;
  };

  const refreshDriverHealth = async (client: MacDesktopDriverClient, seat: DesktopSeatProvider): Promise<void> => {
    try {
      const reply = asRecord(await seat.health());
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
    const driverHealth = driver?.getHealth() ?? {
      state: isDarwin ? "starting" as const : "unsupported" as const,
      title: isDarwin ? "Mac Desktop is starting" : "Mac Desktop needs macOS",
      message: isDarwin ? "ADE is preparing the native desktop driver." : MAC_DESKTOP_MACOS_ONLY_MESSAGE,
      recovery: isDarwin ? "retry" as const : null,
      version: null,
    };
    const supported = isDarwin && driverHealth.state !== "missing" && driverHealth.state !== "unsupported";
    const display = laneId ? ownership.getDisplay(laneId) : null;
    const windows = laneId ? await listWindowsInternal(laneId).catch(() => []) : [];
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
    const existing = ownership.getDisplay(laneId);
    if (existing) {
      ownership.touchDisplay(laneId);
      return await buildStatus({ laneId });
    }
    const seat = await ensureProvider();
    await reconcileDisplays(seat);
    assertPermission("screenRecording");
    const laneName = args.laneName?.trim()
      || (await Promise.resolve(deps.resolveLaneName?.(laneId)).catch(() => null))
      || null;
    const preset = readResolution(args.resolution);
    const size = MAC_DESKTOP_RESOLUTION_PRESETS[preset];
    const reply = asRecord(await seat.create({
      laneId,
      name: macDesktopDisplayName(laneName),
      width: size.width,
      height: size.height,
      scale: 2,
    })) as unknown as DriverDisplayReply;
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
          const reply = asRecord(await seat.destroy({ laneId }));
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
  // Windows
  // -------------------------------------------------------------------------

  const listWindowsInternal = async (laneId?: string | null): Promise<MacDesktopWindow[]> => {
    const seat = isDarwin ? activeProvider() : null;
    if (!seat) return [];
    const windows = await seat.listWindows({ laneId: laneId ?? null });
    if (laneId) ownership.reconcileWindows(laneId, windows);
    return windows;
  };

  // -------------------------------------------------------------------------
  // Observation and input
  // -------------------------------------------------------------------------

  const observeInternal = async (args: MacDesktopObserveArgs & { caption?: string | null }): Promise<MacDesktopObservation> => {
    const laneId = args.laneId.trim();
    const display = requireDisplay(laneId);
    const seat = await ensureProvider();
    assertPermission("screenRecording");
    const limit = Math.max(1, Math.min(MAX_OBSERVATION_LIMIT, Math.round(args.limit ?? MAX_OBSERVATION_LIMIT)));
    // Frames go to the one root `workToolsStateService.readObservationPreview`
    // will serve from, per lane, with the sidecar that binds the frame to its
    // lane — a frame written anywhere else is a frame the phone cannot show.
    const stem = `${now()}-${Math.random().toString(36).slice(2, 8)}`;
    const screenshotPath = observations.observationPath(laneId, stem, "png");
    const mapPath = args.map ? observations.observationPath(laneId, `${stem}-map`, "png") : null;
    const reply = asRecord(await seat.observe({
      laneId,
      windowId: args.windowId ?? null,
      limit,
      map: Boolean(args.map),
      screenshotPath,
      ...(mapPath ? { mapPath } : {}),
      ...(args.caption ? { caption: args.caption } : {}),
    }));
    const elements = Array.isArray(reply.elements) ? reply.elements as MacDesktopElement[] : [];
    const observation: MacDesktopObservation = {
      id: asNullableString(reply.id) ?? `obs-${Math.random().toString(36).slice(2, 10)}`,
      laneId,
      capturedAt: asNullableString(reply.capturedAt) ?? new Date(now()).toISOString(),
      screenshotPath: asNullableString(reply.screenshotPath) ?? screenshotPath,
      mapPath: asNullableString(reply.mapPath),
      display: {
        width: asNumber(asRecord(reply.display).width, display.width),
        height: asNumber(asRecord(reply.display).height, display.height),
        scale: asNumber(asRecord(reply.display).scale, display.scale),
      },
      windows: asWindows(reply.windows),
      elements,
      elementCount: asNumber(reply.elementCount, elements.length),
      truncated: reply.truncated === true || asNumber(reply.elementCount, elements.length) > elements.length,
      caption: asNullableString(reply.caption) ?? args.caption?.trim() ?? null,
    };
    observations.writeObservationSidecar({
      imagePath: observation.screenshotPath,
      laneId,
      capturedAt: observation.capturedAt,
      caption: observation.caption,
    });
    if (observation.mapPath) {
      observations.writeObservationSidecar({
        imagePath: observation.mapPath,
        laneId,
        capturedAt: observation.capturedAt,
        caption: observation.caption,
      });
    }
    observations.remember(observation);
    ownership.touchDisplay(laneId);
    ownership.reconcileWindows(laneId, observation.windows);
    emit({ type: "observation", laneId, observation });
    return observation;
  };

  /**
   * Turns a target into a driver payload.
   *
   * `handle` resolves locally, because only this process knows which
   * observation a handle belongs to and a stale one must be refused before the
   * driver is asked to click anything.
   */
  const resolveTarget = (laneId: string, target: MacDesktopTarget): {
    payload: Record<string, unknown>;
    element: MacDesktopElement | null;
    needsReal: boolean;
  } => {
    const handle = target.handle?.trim();
    if (handle) {
      const { element } = observations.resolveHandle(laneId, handle);
      return {
        payload: { handle, index: element.index, windowId: element.windowId, pid: element.pid },
        element,
        needsReal: false,
      };
    }
    const text = target.text?.trim();
    if (text) {
      return {
        payload: { text, ...(target.windowId != null ? { windowId: target.windowId } : {}) },
        element: null,
        needsReal: false,
      };
    }
    if (typeof target.x === "number" && typeof target.y === "number") {
      return {
        payload: { x: target.x, y: target.y, ...(target.windowId != null ? { windowId: target.windowId } : {}) },
        element: null,
        // A bare point has no element to act on, so it can only be delivered as
        // a real pointer event.
        needsReal: true,
      };
    }
    if (target.windowId != null) {
      return { payload: { windowId: target.windowId }, element: null, needsReal: false };
    }
    return { payload: {}, element: null, needsReal: false };
  };

  const leaseHolderId = (chatSessionId: string | null | undefined): string =>
    chatSessionId?.trim() || "anonymous-agent";

  /**
   * Who this call claims to be, for the lease check.
   *
   * A human takeover holds the lease under the controller id the viewing client
   * minted (`ade-window:<uuid>`), never under a chat session id — so a panel
   * that sent only its `chatSessionId` was refused with
   * `MAC_DESKTOP_USER_HAS_CONTROL` for the very input the user had taken
   * control to perform. `controllerId` authorizes nothing by itself: an id that
   * does not hold the lease is refused exactly as before.
   */
  const inputHolderId = (args: { controllerId?: string | null; chatSessionId?: string | null }): string =>
    args.controllerId?.trim() || leaseHolderId(args.chatSessionId);

  const assertRealInputAllowed = (laneId: string, holderId: string): void => {
    const decision = leases.checkRealInput({ laneId, holderId });
    if (decision.ok) return;
    throw new MacDesktopError(decision.code, decision.message);
  };

  const runAction = async (args: {
    laneId: string;
    action: string;
    command: string;
    mode: MacDesktopInputMode;
    payload: Record<string, unknown>;
    resolved: MacDesktopElement | null;
    chatSessionId?: string | null;
    controllerId?: string | null;
    caption: string;
    target: Record<string, unknown> | null;
  }): Promise<MacDesktopActionResult> => {
    const laneId = args.laneId;
    requireDisplay(laneId);
    const seat = await ensureProvider();
    // Both modes drive the accessibility API: `real` posts a `CGEvent` at a
    // point this process resolved through that same tree.
    assertPermission("accessibility");
    const holderId = inputHolderId(args);
    if (args.mode === "real") assertRealInputAllowed(laneId, holderId);
    const startedAt = new Date(now()).toISOString();
    const startedMs = now();
    let resolvedIndex: number | null = null;
    let failure: Error | null = null;
    try {
      const reply = asRecord(await seat.input({
        laneId,
        command: args.command,
        mode: args.mode,
        payload: args.payload,
        // The helper keeps its own lease and refuses a `CGEvent` post rather
        // than trusting its caller. Telling it which holder this process just
        // authorized is what lets the two agree instead of racing.
        ...(args.mode === "real" ? { lease: { holderId } } : {}),
      }));
      resolvedIndex = typeof reply.resolvedIndex === "number" ? reply.resolvedIndex : null;
    } catch (error) {
      failure = toServiceError(error);
    }
    streamServer.noteActivity(laneId);
    ownership.touchDisplay(laneId);
    recording.noteTurnActivity(laneId, args.chatSessionId);
    if (failure) throw failure;
    const observation = await observeInternal({
      laneId,
      chatSessionId: args.chatSessionId ?? null,
      caption: args.caption,
    });
    const endedAt = new Date(now()).toISOString();
    const resolved = args.resolved
      ?? (resolvedIndex != null
        ? observation.elements.find((element) => element.index === resolvedIndex) ?? null
        : null);
    return {
      ok: true,
      action: args.action,
      mode: args.mode,
      resolved,
      observation,
      trace: {
        id: `${observation.id}:${args.action}`,
        sessionId: args.chatSessionId?.trim() || null,
        action: args.action,
        status: "ok",
        startedAt,
        endedAt,
        durationMs: Math.max(0, now() - startedMs),
        before: { url: null, title: null },
        after: { url: null, title: null },
        target: args.target,
        observationId: observation.id,
        error: null,
      },
    };
  };

  const resolveMode = (
    requested: MacDesktopInputMode | null | undefined,
    needsReal: boolean,
  ): MacDesktopInputMode => (needsReal ? "real" : requested ?? "accessibility");

  // -------------------------------------------------------------------------
  // The API
  // -------------------------------------------------------------------------

  const api: MacDesktopServiceApi = {
    async getStatus(args: MacDesktopGetStatusArgs = {}): Promise<MacDesktopStatus> {
      // The one method that answers on every platform. It must never spawn,
      // probe, or throw: a Windows desktop reads this to learn the tab is not
      // available here, and a read that throws cannot say so.
      if (!isDarwin) return await buildStatus(args);
      if (!driver) {
        // Bring the helper up on the first read so the health card is real
        // rather than a permanent "starting". A failure to start is health,
        // not an exception.
        await ensureDriver().catch((error) => {
          deps.logger.debug("mac_desktop.status_driver_start_failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      } else if (driver.isRunning() && provider) {
        await refreshDriverHealth(driver, provider);
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
      return await listWindowsInternal(args.laneId ?? null);
    },

    async open(args: MacDesktopOpenArgs): Promise<MacDesktopOpenResult> {
      assertSupported();
      const laneId = args.laneId.trim();
      requireDisplay(laneId);
      const seat = await ensureProvider();
      assertPermission("accessibility");
      const reply = asRecord(await seat.launch({
        laneId,
        target: args.target,
        args: args.args ?? [],
      }));
      const windows = asWindows(reply.windows);
      const bundleId = asNullableString(reply.bundleId);
      const pid = typeof reply.pid === "number" ? reply.pid : null;
      for (const window of windows) {
        ownership.claimWindow({
          laneId,
          windowId: window.id,
          pid: window.pid,
          bundleId: window.bundleId,
          appName: window.appName,
          origin: "ade_launched",
          singleInstance: window.singleInstance,
        });
      }
      if (pid != null) {
        ownership.watchLaunch({
          laneId,
          pid,
          target: args.target,
          bundleId,
          chatSessionId: args.chatSessionId ?? null,
        });
      }
      ownership.touchDisplay(laneId);
      emit({ type: "windows-changed", laneId, windows });
      return {
        laneId,
        pid,
        appName: asNullableString(reply.appName),
        bundleId,
        windows,
        watching: reply.watching === true,
      };
    },

    async claimWindow(args: MacDesktopClaimArgs): Promise<MacDesktopWindow> {
      assertSupported();
      const laneId = args.laneId.trim();
      requireDisplay(laneId);
      const seat = await ensureProvider();
      assertPermission("accessibility");
      const existing = ownership.getWindow(args.windowId);
      if (existing && existing.laneId !== laneId && existing.singleInstance && existing.bundleId) {
        ownership.assertSingleInstanceAvailable({
          laneId,
          bundleId: existing.bundleId,
          singleInstance: true,
          appName: existing.appName,
        });
      }
      const window = await seat.park({ laneId, windowId: args.windowId });
      ownership.claimWindow({
        laneId,
        windowId: window.id ?? args.windowId,
        pid: window.pid,
        bundleId: window.bundleId,
        appName: window.appName,
        origin: "claimed",
        singleInstance: window.singleInstance,
      });
      ownership.touchDisplay(laneId);
      emit({ type: "windows-changed", laneId, windows: await listWindowsInternal(laneId) });
      return window;
    },

    async releaseWindow(args: MacDesktopReleaseArgs): Promise<{ released: number }> {
      assertSupported();
      const laneId = args.laneId.trim();
      const seat = await ensureProvider();
      const targets = args.windowId != null
        ? [args.windowId]
        : ownership.listWindowRecords(laneId).map((record) => record.windowId);
      let released = 0;
      for (const windowId of targets) {
        try {
          await seat.unpark({ windowId });
          ownership.releaseWindow(windowId);
          released += 1;
        } catch (error) {
          deps.logger.debug("mac_desktop.release_window_failed", {
            laneId,
            windowId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (released) emit({ type: "windows-changed", laneId, windows: await listWindowsInternal(laneId) });
      return { released };
    },

    async observe(args: MacDesktopObserveArgs): Promise<MacDesktopObservation> {
      assertSupported();
      return await observeInternal(args);
    },

    async click(args: MacDesktopClickArgs): Promise<MacDesktopActionResult> {
      assertSupported();
      const laneId = args.laneId.trim();
      const target = resolveTarget(laneId, args);
      const mode = resolveMode(args.mode, target.needsReal);
      const label = target.element?.title ?? target.element?.label ?? args.text ?? "point";
      return await runAction({
        laneId,
        action: "click",
        command: "click",
        mode,
        payload: {
          ...target.payload,
          button: args.button ?? "left",
          count: Math.max(1, Math.min(3, Math.round(args.count ?? 1))),
        },
        resolved: target.element,
        chatSessionId: args.chatSessionId ?? null,
        controllerId: args.controllerId ?? null,
        caption: `click · ${label}`,
        target: { ...target.payload },
      });
    },

    async type(args: MacDesktopTypeArgs): Promise<MacDesktopActionResult> {
      assertSupported();
      const laneId = args.laneId.trim();
      const target = args.target ? resolveTarget(laneId, args.target) : { payload: {}, element: null, needsReal: false };
      const mode = resolveMode(args.mode, target.needsReal);
      return await runAction({
        laneId,
        action: "type",
        command: "type",
        mode,
        payload: { ...target.payload, text: args.text, clear: args.clear === true },
        resolved: target.element,
        chatSessionId: args.chatSessionId ?? null,
        controllerId: args.controllerId ?? null,
        caption: `type · ${args.text.slice(0, 40)}`,
        target: { ...target.payload },
      });
    },

    async press(args: MacDesktopPressArgs): Promise<MacDesktopActionResult> {
      assertSupported();
      const laneId = args.laneId.trim();
      return await runAction({
        laneId,
        action: "press",
        command: "press",
        mode: args.mode ?? "accessibility",
        payload: { key: args.key, modifiers: args.modifiers ?? [] },
        resolved: null,
        chatSessionId: args.chatSessionId ?? null,
        controllerId: args.controllerId ?? null,
        caption: `press · ${[...(args.modifiers ?? []), args.key].join("+")}`,
        target: { key: args.key, modifiers: args.modifiers ?? [] },
      });
    },

    async scroll(args: MacDesktopScrollArgs): Promise<MacDesktopActionResult> {
      assertSupported();
      const laneId = args.laneId.trim();
      const target = resolveTarget(laneId, args);
      const mode = resolveMode(args.mode, target.needsReal);
      return await runAction({
        laneId,
        action: "scroll",
        command: "scroll",
        mode,
        payload: {
          ...target.payload,
          direction: args.direction,
          amount: Math.max(1, Math.min(50, Math.round(args.amount ?? 3))),
        },
        resolved: target.element,
        chatSessionId: args.chatSessionId ?? null,
        controllerId: args.controllerId ?? null,
        caption: `scroll · ${args.direction}`,
        target: { ...target.payload, direction: args.direction },
      });
    },

    async drag(args: MacDesktopDragArgs): Promise<MacDesktopActionResult> {
      assertSupported();
      const laneId = args.laneId.trim();
      const from = resolveTarget(laneId, args.from);
      const to = resolveTarget(laneId, args.to);
      // A drag has no accessibility action anywhere in AppKit, so it is always
      // a real pointer sequence and always behind the lease.
      return await runAction({
        laneId,
        action: "drag",
        command: "drag",
        mode: "real",
        payload: {
          from: from.payload,
          to: to.payload,
          durationMs: Math.max(0, Math.min(10_000, Math.round(args.durationMs ?? 500))),
        },
        resolved: from.element,
        chatSessionId: args.chatSessionId ?? null,
        controllerId: args.controllerId ?? null,
        caption: "drag",
        target: { from: from.payload, to: to.payload },
      });
    },

    async wait(args: MacDesktopWaitArgs): Promise<MacDesktopWaitResult> {
      assertSupported();
      const laneId = args.laneId.trim();
      requireDisplay(laneId);
      const seat = await ensureProvider();
      const timeoutMs = Math.max(0, Math.min(MAX_WAIT_TIMEOUT_MS, Math.round(args.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS)));
      const startedMs = now();
      const reply = asRecord(await seat.input({
        laneId,
        command: "wait",
        mode: "accessibility",
        payload: {
          text: args.text ?? null,
          gone: args.gone ?? null,
          windowTitle: args.windowTitle ?? null,
          timeoutMs,
        },
        timeoutMs: timeoutMs + 5_000,
      }));
      const observation = await observeInternal({
        laneId,
        chatSessionId: args.chatSessionId ?? null,
        caption: "wait",
      });
      const matchedIndex = typeof reply.resolvedIndex === "number" ? reply.resolvedIndex : null;
      return {
        // The driver answers `ok` itself: a `gone` or `windowTitle` wait
        // succeeds with no element, so an index is evidence of a match rather
        // than the definition of success.
        ok: reply.ok === true,
        waitedMs: Math.max(0, now() - startedMs),
        matched: matchedIndex != null
          ? observation.elements.find((element) => element.index === matchedIndex) ?? null
          : null,
        observation,
      };
    },

    async screenshot(args: MacDesktopScreenshotArgs): Promise<MacDesktopScreenshotResult> {
      assertSupported();
      const laneId = args.laneId.trim();
      const display = requireDisplay(laneId);
      const seat = await ensureProvider();
      assertPermission("screenRecording");
      const filePath = args.out
        ? await observations.resolveOutPath({ laneId, out: args.out })
        : observations.scratchPath(`mac-desktop-${laneId}`, "png");
      const reply = asRecord(await seat.screenshot({
        laneId,
        windowId: args.windowId ?? null,
        path: filePath,
      }));
      ownership.touchDisplay(laneId);
      return {
        laneId,
        filePath: asNullableString(reply.filePath) ?? filePath,
        width: asNumber(reply.width, display.width),
        height: asNumber(reply.height, display.height),
        capturedAt: asNullableString(reply.capturedAt) ?? new Date(now()).toISOString(),
      };
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
      const laneId = args.laneId.trim();
      requireDisplay(laneId);
      const seat = await ensureProvider();
      const reply = asRecord(await seat.present({ laneId, destination: args.destination }));
      ownership.touchDisplay(laneId);
      emit({ type: "windows-changed", laneId, windows: await listWindowsInternal(laneId) });
      return { moved: asNumber(reply.moved, 0) };
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
      driver?.dispose();
      driver = null;
      provider = null;
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
