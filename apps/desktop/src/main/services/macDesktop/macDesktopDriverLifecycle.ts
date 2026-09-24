import type { Logger } from "../logging/logger";
import {
  type MacDesktopDisplay,
  type MacDesktopDisplayMode,
  type MacDesktopDriverHealth,
  type DesktopSeatProvider,
  type MacDesktopEventPayload,
  type MacDesktopPermissions,
  type MacDesktopRequestPermissionArgs,
  type MacDesktopRecheckPermissionsArgs,
} from "../../../shared/types/macDesktop";
import { resolveMacDesktopDriverBinary } from "../native/nativeHelperPaths";
import {
  createMacDesktopDriverClient,
  MAC_DESKTOP_DRIVER_OPS,
  type MacDesktopDriverClient,
} from "./macDesktopDriverClient";
import {
  asDisplayLaneIds,
  asNullableString,
  asRecord,
  createMacVirtualDisplayProvider,
} from "./macDesktopSeatProvider";

const STATUS_DRIVER_READ_TIMEOUT_MS = 4_000;

type DriverBackend = {
  client: MacDesktopDriverClient;
  provider: DesktopSeatProvider;
};

type MacDesktopDisplayDestroyedReason = Extract<MacDesktopEventPayload, { type: "display-destroyed" }>["reason"];

export type MacDesktopDriverLifecycleDeps = {
  logger: Logger;
  platform: NodeJS.Platform;
  createDriverClient?: ((args: {
    logger: Logger;
    platform: NodeJS.Platform;
    onHealthChanged: (health: MacDesktopDriverHealth) => void;
    onDriverLost: (reason: string) => void;
  }) => MacDesktopDriverClient) | null;
  assertSupported: () => void;
  serviceError: (code: string, message: string) => Error;
  permissionError: (which: "screenRecording" | "accessibility") => Error;
  emit: (payload: MacDesktopEventPayload) => void;
  handleDriverEvent: (event: Record<string, unknown> & { event: string }) => void;
  onDriverLost: (reason: string) => void;
  listDisplays: () => MacDesktopDisplay[];
  laneIds: () => string[];
  forgetDisplay: (laneId: string, reason: MacDesktopDisplayDestroyedReason) => void;
  isDestroyingLane: (laneId: string) => boolean;
  hostIsLocal: () => boolean;
};

export type MacDesktopDriverLifecycle = {
  readonly displayMode: MacDesktopDisplayMode;
  readonly permissions: MacDesktopPermissions;
  setDisplayMode(mode: MacDesktopDisplayMode): void;
  applyPermissions(next: Partial<MacDesktopPermissions> | null | undefined): void;
  assertPermission(which: "screenRecording" | "accessibility"): void;
  ensureDriver(): Promise<DriverBackend>;
  ensureProvider(): Promise<DesktopSeatProvider>;
  activeProvider(): DesktopSeatProvider | null;
  hasDriver(): boolean;
  isDriverRunning(): boolean;
  driverHealth(): MacDesktopDriverHealth | null;
  refreshDriverHealth(): Promise<void>;
  reconcileDisplays(seat: DesktopSeatProvider): Promise<void>;
  recheckPermissions(args?: MacDesktopRecheckPermissionsArgs): Promise<MacDesktopPermissions>;
  requestPermission(args: MacDesktopRequestPermissionArgs): Promise<MacDesktopPermissions>;
  addPermissionWatcher(): void;
  removePermissionWatcher(): void;
  dispose(): void;
};

/** Owns the driver process, permission probes, and their health reconciliation. */
export function createMacDesktopDriverLifecycle(
  deps: MacDesktopDriverLifecycleDeps,
): MacDesktopDriverLifecycle {
  const isDarwin = deps.platform === "darwin";
  let permissions: MacDesktopPermissions = { screenRecording: "unknown", accessibility: "unknown" };
  let displayMode: MacDesktopDisplayMode = isDarwin ? "virtual" : "unavailable";
  let backend: DriverBackend | null = null;
  let driverEventUnsubscribe: (() => void) | null = null;
  /**
   * How many status subscribers are watching, and what the helper was last
   * told about it.
   *
   * The probe has to run while a pane is open even with no display: that is
   * exactly the stuck first-run state, where a grant made in System Settings
   * never reaches the already-running helper. The driver refcounts this with
   * "a display exists"; off with neither is what keeps an idle helper idle.
   * The initial value matches a freshly spawned helper, so the first
   * `getStatus` does not send a redundant `watch:false`.
   */
  let permissionWatchers = 0;
  let permissionWatchSent = false;
  let reconciled = false;
  let disposed = false;

  const onDriverLost = (reason: string): void => {
    reconciled = false;
    deps.onDriverLost(reason);
  };

  const syncPermissionWatch = async (): Promise<void> => {
    const desired = permissionWatchers > 0;
    if (desired === permissionWatchSent) return;
    const client = backend?.client;
    if (!client || !client.isRunning()) return;
    try {
      await client.request(
        MAC_DESKTOP_DRIVER_OPS.watchPermissions,
        { watch: desired },
        { timeoutMs: STATUS_DRIVER_READ_TIMEOUT_MS },
      );
      permissionWatchSent = desired;
    } catch (error) {
      // Leave the recorded state disagreeing with the ask so the next sync
      // retries it; the helper is still serving one-shot probes meanwhile.
      permissionWatchSent = !desired;
      deps.logger.debug("mac_desktop.permission_watch_failed", {
        watch: desired,
        error: error instanceof Error ? error.message : String(error),
      });
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
    deps.emit({ type: "permission-changed", permissions: merged });
    // A revoked grant is a health transition too: the card that says "grant
    // permission" is the only actionable thing left on this host.
    if (backend) deps.emit({ type: "driver-health", health: backend.client.getHealth() });
  };

  const assertPermission = (which: "screenRecording" | "accessibility"): void => {
    if (permissions[which] !== "denied") return;
    throw deps.permissionError(which);
  };

  const reconcileWithDriver = (driverLaneIds: Set<string>, before: Map<string, MacDesktopDisplay>): void => {
    for (const [laneId, earlier] of before) {
      if (driverLaneIds.has(laneId)) continue;
      if (deps.isDestroyingLane(laneId)) continue;
      const current = deps.listDisplays().find((display) => display.laneId === laneId);
      if (!current || current.createdAt !== earlier.createdAt || current.displayId !== earlier.displayId) continue;
      deps.logger.warn("mac_desktop.display_missing_from_driver", { laneId, displayId: current.displayId });
      deps.forgetDisplay(laneId, "driver_lost");
    }
  };

  const refreshDriverHealth = async (target: DriverBackend | null = backend): Promise<void> => {
    if (!target) return;
    const before = new Map(deps.listDisplays().map((display) => [display.laneId, display]));
    try {
      const reply = await target.provider.health();
      const driverLaneIds = asDisplayLaneIds(reply.displays);
      if (driverLaneIds) reconcileWithDriver(driverLaneIds, before);
      target.client.setVersion(asNullableString(reply.version));
      applyPermissions(asRecord(reply.permissions) as Partial<MacDesktopPermissions>);
      const mode = asNullableString(reply.displayMode);
      if (mode === "virtual" || mode === "offscreen-region" || mode === "unavailable") displayMode = mode;
    } catch (error) {
      deps.logger.debug("mac_desktop.driver_health_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const ensureDriver = async (): Promise<DriverBackend> => {
    deps.assertSupported();
    if (disposed) throw deps.serviceError("MAC_DESKTOP_DRIVER_UNAVAILABLE", "The Mac Desktop service is disposed.");
    if (!backend) {
      const onHealthChanged = (health: MacDesktopDriverHealth) => deps.emit({ type: "driver-health", health });
      const client = deps.createDriverClient
        ? deps.createDriverClient({ logger: deps.logger, platform: deps.platform, onHealthChanged, onDriverLost })
        : createMacDesktopDriverClient({
          logger: deps.logger,
          platform: deps.platform,
          resolveExecutablePath: () => resolveMacDesktopDriverBinary({ platform: deps.platform, logger: deps.logger }),
          onHealthChanged,
          onDriverLost,
        });
      backend = { client, provider: createMacVirtualDisplayProvider(client) };
      driverEventUnsubscribe = client.onEvent(deps.handleDriverEvent);
    }
    await backend.client.ensureStarted();
    // A fresh child knows nothing about the last one's watch state: it starts
    // with the probe off, whatever this process last told the old helper.
    permissionWatchSent = false;
    await syncPermissionWatch();
    await refreshDriverHealth(backend);
    return backend;
  };

  const reconcileDisplays = async (seat: DesktopSeatProvider): Promise<void> => {
    if (reconciled) return;
    reconciled = true;
    try {
      await seat.reconcile({ liveLaneIds: deps.laneIds() });
    } catch (error) {
      deps.logger.warn("mac_desktop.reconcile_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const recheckPermissions = async (
    args: MacDesktopRecheckPermissionsArgs = {},
  ): Promise<MacDesktopPermissions> => {
    deps.assertSupported();
    const { client } = await ensureDriver();
    if (args.restartDriver !== false) {
      await client.restart();
      // The helper died with every display it owned. Nothing is parked on a
      // display that no longer exists, so a lane map that still claimed one
      // would report a screen that is gone.
      if (deps.laneIds().length > 0) onDriverLost("restarted");
    }
    permissionWatchSent = false;
    await syncPermissionWatch();
    await refreshDriverHealth();
    return permissions;
  };

  const requestPermission = async (
    args: MacDesktopRequestPermissionArgs,
  ): Promise<MacDesktopPermissions> => {
    deps.assertSupported();
    // The one place `allowPrompt` is decided. It is true only when the ADE
    // window asking is on this Mac; an agent cannot reach this method (it is
    // CTO-only) and the helper ignores the ask when it arrives false.
    const allowPrompt = deps.hostIsLocal();
    const { provider } = await ensureDriver();
    const reply = await provider.requestPermission({
      which: args.which === "accessibility" ? "accessibility" : "screenRecording",
      allowPrompt,
    });
    applyPermissions(asRecord(reply.permissions) as Partial<MacDesktopPermissions>);
    await refreshDriverHealth();
    return permissions;
  };

  return {
    get displayMode() { return displayMode; },
    get permissions() { return permissions; },
    setDisplayMode(mode) { displayMode = mode; },
    applyPermissions,
    assertPermission,
    ensureDriver,
    async ensureProvider() { return (await ensureDriver()).provider; },
    activeProvider() { return backend && backend.client.isRunning() ? backend.provider : null; },
    hasDriver() { return backend !== null; },
    isDriverRunning() { return Boolean(backend?.client.isRunning()); },
    driverHealth() { return backend?.client.getHealth() ?? null; },
    refreshDriverHealth: async () => refreshDriverHealth(),
    reconcileDisplays,
    recheckPermissions,
    requestPermission,
    addPermissionWatcher() {
      permissionWatchers += 1;
      void syncPermissionWatch();
    },
    removePermissionWatcher() {
      permissionWatchers = Math.max(0, permissionWatchers - 1);
      void syncPermissionWatch();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      driverEventUnsubscribe?.();
      driverEventUnsubscribe = null;
      backend?.client.dispose();
      backend = null;
    },
  };
}
