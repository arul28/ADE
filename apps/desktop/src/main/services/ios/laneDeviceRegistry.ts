import type {
  AppleDeviceCleanupResult,
  AppleDeviceDiskUsage,
  AppleDeviceListResult,
  AppleInstalledRuntime,
  AppleInstalledSimulator,
  AppleLaneDevice,
  AppleSimulatorOwner,
  AppleSimulatorOwnershipInfo,
} from "../../../shared/types/iosSimulator";
import { isAdeOwnedLaneDevice } from "../../../shared/types/iosSimulator";
import {
  AppleDeviceAttachedNotDeletableError,
  AppleDeviceExistsError,
  AppleDeviceNotLaneOwnedError,
  AppleDeviceOwnedByLaneError,
  AppleNoInstalledSimulatorsError,
  type AppleDeviceNotLaneOwnedReason,
} from "./appleDeviceErrors";
import {
  APPLE_DEVICE_MARKER_GRACE_MS,
  appleMarkerIsProject,
  listAppleDeviceMarkers,
  looksLikeAdeDeviceName,
  readAppleDeviceMarker,
  writeAppleDeviceMarker,
  type AppleDeviceMarker,
} from "./appleDeviceMarker";
import {
  appleDeviceDataRoot,
  appleDeviceFamily,
  matchesSimulatorName,
  parseAppleDeviceDiskUsage,
  parseAppleInstalledRuntimes,
  parseSimctlDevices,
  pickAppleDeviceSpec,
  type SimctlListedDevice,
} from "./appleSimulatorCatalog";
import { endLaneDeviceOnDisk, uninstallAdeApps } from "./laneDeviceRelease";
import {
  LANE_APPLE_DEVICES_TABLE,
  LANE_DEVICE_COLUMNS,
  readLaneAppleDevice,
  readLaneAppleDeviceRecord,
  rowToDevice,
  type LaneDeviceRow,
  type LaneDeviceStore,
} from "./laneDeviceRows";
import { deleteAppleSimulator } from "./simulatorPower";

/**
 * One simulator per lane, many per machine.
 *
 * A lane gets no device until it is asked for. The first ask makes a NEW,
 * empty device (`simctl create`) from an installed runtime and names it for
 * the lane, so two lanes never share a screen or each other's app data, and a
 * lane's device is recognisable in Xcode's own device list. Nothing is copied:
 * each lane builds and installs its own version of the app anyway, and a copy
 * of another device only carried that device's gigabytes of data and state.
 *
 * ADE writes a marker file into every device it makes (`appleDeviceMarkerPath`).
 * The marker, not only the database row, is what proves a device is ADE's: a
 * row can be lost, and without the marker a leaked device looks exactly like
 * the user's own and is kept forever. The cleanup pass (`reconcile`) deletes a
 * marked device that no live lane holds.
 *
 * A lane may instead ATTACH an existing simulator, which binds without making
 * one — and which is why delete has two behaviours: ADE deletes what it
 * created and never deletes what it did not.
 *
 * ADE never downloads a runtime. `simctl` will happily fetch several gigabytes
 * for a runtime that is merely *known*; a lane asking for a device must not
 * start that, so every runtime comes from the installed list and an empty list
 * is a refusal (`APPLE_NO_INSTALLED_SIMULATORS`) rather than a download.
 */

/** KV key holding the device type this project made its last lane device from. */
export const APPLE_LAST_DEVICE_TYPE_KEY = "apple:last-device-type" as const;

type RunCommand = (
  command: string,
  args: string[],
  options?: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

export type LaneDeviceRegistryDeps = {
  run: RunCommand;
  /**
   * Power a device off before `simctl delete`, which on a booted device leaves
   * CoreSimulator holding the data directory and reports success having
   * removed nothing. The host's `simulatorPower`, so the recording, the helper
   * session and the device list hear it. May throw; the delete goes ahead.
   */
  powerOffDevice: (udid: string) => Promise<unknown>;
  /** Every installed, available simulator on this Mac. */
  listInstalledSimulators: () => Promise<AppleInstalledSimulator[]>;
  /**
   * Every installed runtime and the device types it runs. Defaults to
   * `simctl list runtimes available --json`.
   */
  listInstalledRuntimes?: (() => Promise<AppleInstalledRuntime[]>) | null;
  /**
   * The project this registry serves. Written into each device's marker, and
   * the cleanup pass only deletes marked devices of this project. Another
   * project's devices are that project's to clean up; the storage view lists
   * them.
   */
  projectRoot?: string | null;
  /**
   * Stop every stream, hub session and recording that reads this device,
   * before the cleanup pass powers it off or deletes it. The host's; optional.
   */
  releaseDeviceHolds?: ((udid: string) => Promise<void>) | null;
  /** Human name for a lane, used in the device's name. Null falls back to the id. */
  resolveLaneName?: ((laneId: string) => string | null) | null;
  /** The lanes DB. Omitted in hosts that have none; the registry then keeps rows in memory. */
  store?: LaneDeviceStore | null;
  /**
   * Let go of a device a lane is about to LOSE to a takeover.
   *
   * The registry owns the binding and knows nothing about streams or chat
   * sessions, so the host hands in the release. Called with the losing lane's
   * device, before the binding moves, and allowed to fail: the move is what
   * must not be left half-done.
   */
  releaseLaneDevice?: ((device: AppleLaneDevice) => Promise<void> | void) | null;
  /**
   * CoreSimulator's device store. Defaults to the real one under `$HOME`.
   *
   * Injectable so the disk measurement is testable without a Mac and without
   * the test's answer depending on whose machine ran it.
   */
  deviceDataRoot?: string | null;
  logger: {
    info: (event: string, data?: Record<string, unknown>) => void;
    debug: (event: string, data?: Record<string, unknown>) => void;
    warn?: (event: string, data?: Record<string, unknown>) => void;
  };
  now?: () => Date;
};

export type LaneDeviceCreateArgs = {
  laneId: string;
  from?: string | null;
  runtime?: string | null;
  deviceType?: string | null;
  name?: string | null;
};

export type LaneDeviceRegistry = {
  deviceCreate(args: LaneDeviceCreateArgs): Promise<AppleLaneDevice>;
  /**
   * Bind an installed simulator to a lane.
   *
   * Three outcomes, and exactly one lane owns the device after all of them:
   * the lane already holds it (answered as-is), nobody holds it (a plain
   * attach), or another lane holds it (the binding MOVES — see `rebind`).
   *
   * With `agentCaller`, not the third: an agent may attach a simulator no lane
   * holds (the user named it), never one another lane holds, and never another
   * project's ADE device (`AppleDeviceNotLaneOwnedError`).
   */
  deviceAttach(args: { laneId: string; simulator: string; agentCaller?: boolean | null }): Promise<AppleLaneDevice>;
  deviceList(args?: {
    installed?: boolean | null;
    laneId?: string | null;
    disk?: boolean | null;
    runtimes?: boolean | null;
  }): Promise<AppleDeviceListResult>;
  /**
   * Delete the lane's ADE device. An attached device is always refused: ADE never
   * deletes a simulator it did not create. Detaching one is `deviceDetach`.
   *
   * With `udid`, only that device: when the lane holds another one by now,
   * nothing happens, so a caller never deletes a device it did not read.
   */
  deviceDelete(args: { laneId: string; udid?: string | null }): Promise<void>;
  /**
   * Forget the lane's device and touch no simulator: nothing is deleted and
   * nothing is powered off now. An ADE device's marker is stamped
   * `detachedAt`, so it becomes a leftover that the cleanup pass deletes after
   * the grace period unless a lane picks it again. Returns what was detached,
   * or null when the lane had no device.
   */
  deviceDetach(args: { laneId: string }): Promise<AppleLaneDevice | null>;
  /**
   * Delete an installed simulator by udid, for the picker's per-device menu.
   *
   * Separate from `deviceDelete`, which is "give up the device THIS lane
   * owns". This one is the owner clearing out a simulator they are not using,
   * usually for the disk, so it refuses any device a lane holds rather than
   * silently unbinding that lane. Removing a lane's own device is still
   * `deviceDelete`, which shuts its stream down first.
   */
  deviceDeleteInstalled(args: { udid: string }): Promise<void>;
  /** The lane's device without touching `simctl`. Null when the lane has none. */
  get(laneId: string): AppleLaneDevice | null;
  /** Every lane device this project knows about. */
  list(): AppleLaneDevice[];
  /** Create on first ask — what `launch` and `open-device` call. */
  ensure(args: { laneId: string }): Promise<AppleLaneDevice>;
  /**
   * Bring the rows, the marker files and the real device set back into line.
   *
   * - A row whose simulator no longer exists is dropped.
   * - A row whose lane ended (archived, deleted, or merged away) is released:
   *   an ADE device is deleted; an attached one is powered off and loses only
   *   the apps ADE installed.
   * - A marked ADE device of this project that no live lane holds is deleted.
   * - A row for an ADE device that has no marker (made before markers) gets one.
   *
   * Never throws; each failure is one entry in `errors`. Refuses to delete
   * anything when the device set cannot be read.
   */
  reconcile(): Promise<AppleDeviceCleanupResult>;
  /** True when `udid` is a lane's ATTACHED device, the only kind whose installs ADE records. */
  tracksInstallsOn(udid: string): boolean;
  /** Remember that ADE installed `bundleId` on `udid`, when `udid` is an attached lane device. */
  noteAppInstalled(args: { udid: string; bundleId: string }): void;
};

/**
 * The lane device's name.
 *
 * `ADE · <lane>` is the locked pattern: the separator makes an ADE device
 * obvious in Xcode's own device list, which is the list a user reaches for when
 * something looks wrong. A collision gets a numeric suffix rather than being
 * refused — two lanes can legitimately carry the same display name.
 */
export function appleLaneDeviceName(input: {
  laneId: string;
  laneName?: string | null;
  requested?: string | null;
  taken?: string[];
}): string {
  const requested = input.requested?.trim();
  const label = (input.laneName?.trim() || input.laneId.slice(0, 8)).replace(/\s+/g, " ");
  const base = requested || `ADE · ${label}`;
  const taken = new Set(input.taken ?? []);
  if (!taken.has(base)) return base;
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${base} (${suffix})`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base} (${Date.now()})`;
}

/**
 * Does this string name the device the lane already holds?
 *
 * The same udid-then-name precedence `deviceAttach` matches installed
 * simulators with, so "attach the device I already have" is recognised without
 * a `simctl` call — and so a re-attach is never mistaken for a takeover of
 * somebody else's device.
 */
export function namesLaneDevice(device: AppleLaneDevice, wanted: string): boolean {
  return matchesSimulatorName(device, wanted);
}

export function createLaneDeviceRegistry(deps: LaneDeviceRegistryDeps): LaneDeviceRegistry {
  const now = deps.now ?? (() => new Date());
  // Used only when no lanes DB was handed in — the CLI's chat-only runtime has
  // no store, and a lane device that vanishes on restart is better there than a
  // crash on every call.
  const memory = new Map<string, AppleLaneDevice>();

  const readAll = (): AppleLaneDevice[] => {
    if (!deps.store) return [...memory.values()];
    try {
      return deps.store
        .all<LaneDeviceRow>(`select ${LANE_DEVICE_COLUMNS} from ${LANE_APPLE_DEVICES_TABLE}`)
        .map(rowToDevice);
    } catch (error) {
      deps.logger.debug("apple.lane_device_read_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  };

  const readOne = (laneId: string): AppleLaneDevice | null => {
    const trimmed = laneId.trim();
    if (!trimmed) return null;
    if (!deps.store) return memory.get(trimmed) ?? null;
    try {
      return readLaneAppleDevice(deps.store, trimmed);
    } catch (error) {
      deps.logger.debug("apple.lane_device_read_failed", {
        laneId: trimmed,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  };

  const write = (device: AppleLaneDevice): void => {
    if (!deps.store) {
      memory.set(device.laneId, device);
      return;
    }
    deps.store.run(
      `insert into ${LANE_APPLE_DEVICES_TABLE} (lane_id, udid, name, origin, family, runtime, created_at, ade_installed_bundle_ids)
       values (?, ?, ?, ?, ?, ?, ?, null)
       on conflict(lane_id) do update set
         udid = excluded.udid,
         name = excluded.name,
         origin = excluded.origin,
         family = excluded.family,
         runtime = excluded.runtime,
         created_at = excluded.created_at,
         ade_installed_bundle_ids = null`,
      [
        device.laneId,
        device.udid,
        device.name,
        device.origin,
        device.family,
        device.runtime,
        device.createdAt,
      ],
    );
  };

  /**
   * Move one device's binding from one lane to another, in ONE step.
   *
   * `lane_id` is this table's primary key, so re-keying the row IS the move:
   * there is no instant at which both lanes own the device, and no row is left
   * behind for the old lane to read. A delete-then-insert pair would have a
   * window between the two statements, and a crash inside it would leave the
   * device owned by nobody at best and by both at worst.
   *
   * `origin` and `ade_installed_bundle_ids` are deliberately not in the SET
   * list — they describe the simulator, and they travel with it.
   */
  const rebind = (previous: AppleLaneDevice, device: AppleLaneDevice): void => {
    if (!deps.store) {
      memory.delete(previous.laneId);
      memory.set(device.laneId, device);
      return;
    }
    deps.store.run(
      `update ${LANE_APPLE_DEVICES_TABLE}
          set lane_id = ?, name = ?, family = ?, runtime = ?, created_at = ?
        where lane_id = ? and udid = ?`,
      [
        device.laneId,
        device.name,
        device.family,
        device.runtime,
        device.createdAt,
        previous.laneId,
        previous.udid,
      ],
    );
  };

  const forget = (laneId: string): void => {
    if (!deps.store) {
      memory.delete(laneId);
      return;
    }
    deps.store.run(`delete from ${LANE_APPLE_DEVICES_TABLE} where lane_id = ?`, [laneId]);
  };

  /**
   * Mark a device as ADE's. Never fails the caller: a device without a marker
   * is still deleted with its lane through the row; the marker is what finds it
   * when the row is lost.
   */
  const writeMarker = (udid: string, marker: Omit<AppleDeviceMarker, "version" | "projectRoot">): void => {
    const projectRoot = deps.projectRoot?.trim();
    if (!projectRoot) return;
    try {
      writeAppleDeviceMarker(dataRoot(), udid, { version: 1, projectRoot, ...marker });
    } catch (error) {
      deps.logger.warn?.("apple.lane_device_marker_write_failed", {
        udid,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const isLaneLive = (laneId: string): boolean => {
    if (!deps.store) return true;
    try {
      const row = deps.store.get<{ status: string | null }>("select status from lanes where id = ?", [laneId]);
      return Boolean(row) && row?.status !== "archived";
    } catch {
      // A read that failed says nothing about the lane. Treat it as live, so
      // nothing is deleted on a guess.
      return true;
    }
  };

  /** The attached lane device with this udid, or null. An ADE device is deleted whole, so only these track installs. */
  const attachedHolder = (udid: string): AppleLaneDevice | null =>
    readAll().find((device) => device.udid === udid && device.origin === "attached") ?? null;

  /**
   * Record, on the lane's own local-only row, that ADE installed `bundleId`.
   * The caller checks the app was NOT on the device before: an app the user
   * already had is theirs, even after ADE installs a new build over it.
   */
  const noteAppInstalled = (args: { udid: string; bundleId: string }): void => {
    const udid = args.udid.trim();
    const bundleId = args.bundleId.trim();
    if (!udid || !bundleId || !deps.store) return;
    const holder = attachedHolder(udid);
    if (!holder) return;
    try {
      const record = readLaneAppleDeviceRecord(deps.store, holder.laneId);
      const list = new Set(record?.adeInstalledBundleIds ?? []);
      if (list.has(bundleId)) return;
      list.add(bundleId);
      deps.store.run(
        `update ${LANE_APPLE_DEVICES_TABLE} set ade_installed_bundle_ids = ? where lane_id = ? and udid = ?`,
        [JSON.stringify([...list]), holder.laneId, udid],
      );
    } catch (error) {
      deps.logger.debug("apple.installed_app_note_failed", {
        udid,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const rememberDeviceType = (identifier: string): void => {
    try {
      deps.store?.setJson(APPLE_LAST_DEVICE_TYPE_KEY, identifier);
    } catch (error) {
      deps.logger.debug("apple.device_type_remember_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const lastDeviceType = (): string | null => {
    try {
      const value = deps.store?.getJson<string>(APPLE_LAST_DEVICE_TYPE_KEY);
      return typeof value === "string" && value.trim() ? value.trim() : null;
    } catch {
      return null;
    }
  };

  const dataRoot = (): string => deps.deviceDataRoot?.trim() || appleDeviceDataRoot();

  const listRuntimes = async (): Promise<AppleInstalledRuntime[]> => {
    if (deps.listInstalledRuntimes) return deps.listInstalledRuntimes();
    const { stdout } = await deps.run("xcrun", ["simctl", "list", "runtimes", "available", "--json"], { timeoutMs: 30_000 });
    return parseAppleInstalledRuntimes(stdout);
  };

  /**
   * The lane's display name, for the device's name.
   *
   * Read straight from the `lanes` table when no resolver was injected: the
   * hosts hand this registry the same database the lane row lives in, and a
   * synchronous read here is what lets `appleLaneDeviceName` stay pure. Falls
   * back to the id, which is what an un-named lane has anyway.
   */
  const laneNameFor = (laneId: string): string | null => {
    const injected = deps.resolveLaneName?.(laneId);
    if (injected) return injected;
    try {
      return deps.store?.get<{ name: string | null }>("select name from lanes where id = ?", [laneId])?.name ?? null;
    } catch {
      return null;
    }
  };

  /**
   * Who holds what, by display name, for the lane that is asking.
   *
   * Built from EVERY lane's row, not the caller's: a picker that cannot see
   * lane B's binding offers Open on lane B's device, which is the defect this
   * exists to close. The lane name is resolved per row — five rows at most on
   * a real machine — and a missing name degrades to null rather than to the
   * id, so the renderer decides how to word "a lane we cannot name".
   */
  const ownersFor = (laneId: string | null): AppleSimulatorOwner[] =>
    readAll().map((device) => ({
      udid: device.udid,
      laneId: device.laneId,
      laneName: laneNameFor(device.laneId),
      origin: device.origin,
      mine: laneId != null && device.laneId === laneId,
    }));

  /**
   * The disk measurement, cached for a minute.
   *
   * The picker asks once per open, but the pane re-lists on every refresh and
   * on every device event; a `du` per event would turn a status poll into a
   * filesystem walk. A minute is short enough that a delete the user just made
   * shows up while they are still looking at the page.
   */
  let diskCache: { at: number; value: AppleDeviceDiskUsage } | null = null;
  const DISK_CACHE_MS = 60_000;

  const measureDisk = async (): Promise<AppleDeviceDiskUsage | null> => {
    const root = deps.deviceDataRoot?.trim() || appleDeviceDataRoot();
    const cached = diskCache;
    if (cached && Date.now() - cached.at < DISK_CACHE_MS && cached.value.root === root) {
      return cached.value;
    }
    let stdout = "";
    try {
      ({ stdout } = await deps.run("du", ["-d", "1", "-k", root], { timeoutMs: 120_000 }));
    } catch (error) {
      // A store that is not there yet, or a `du` that hit a permission wall, is
      // an unknown number — never a failed device list. The picker simply says
      // nothing about disk.
      deps.logger.debug("apple.device_disk_measure_failed", {
        root,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    const parsed = parseAppleDeviceDiskUsage({ stdout, root });
    const value: AppleDeviceDiskUsage = {
      totalBytes: parsed.totalBytes,
      devices: parsed.devices,
      root,
      measuredAt: now().toISOString(),
    };
    diskCache = { at: Date.now(), value };
    return value;
  };

  const requireLaneId = (laneId: string | null | undefined): string => {
    const trimmed = laneId?.trim();
    if (!trimmed) throw new Error("A laneId is required: an Apple device belongs to exactly one lane.");
    return trimmed;
  };

  const create = async (args: LaneDeviceCreateArgs): Promise<AppleLaneDevice> => {
    const laneId = requireLaneId(args.laneId);
    const existing = readOne(laneId);
    if (existing) throw new AppleDeviceExistsError(existing);
    const [runtimes, installed] = await Promise.all([
      listRuntimes(),
      // Only `from` and the name collision check need it.
      deps.listInstalledSimulators(),
    ]);
    const spec = pickAppleDeviceSpec({
      runtimes,
      installed,
      runtime: args.runtime,
      deviceType: args.deviceType,
      from: args.from,
      lastDeviceType: lastDeviceType(),
    });
    const name = appleLaneDeviceName({
      laneId,
      laneName: laneNameFor(laneId),
      requested: args.name,
      taken: installed.map((device) => device.name),
    });
    // `simctl create` prints the new udid and nothing else. Anything on stderr
    // is a warning, not the answer, which is why only stdout is parsed.
    const { stdout } = await deps.run(
      "xcrun",
      ["simctl", "create", name, spec.deviceType.identifier, spec.runtime.identifier],
      { timeoutMs: 120_000 },
    );
    const udid = stdout.trim().split(/\s+/).filter(Boolean).pop() ?? "";
    if (!udid) {
      throw new Error(`simctl create did not report a udid for ${name}. Check \`xcrun simctl list devices\` and try again.`);
    }
    const createdAt = now().toISOString();
    // The marker first, then the row: a crash between the two leaves a marked
    // device with no row, which the cleanup pass re-adopts or deletes. The other
    // order would leave an unmarked device, which nothing would ever delete.
    writeMarker(udid, { laneId, name, createdAt });
    const device: AppleLaneDevice = {
      laneId,
      udid,
      name,
      origin: "created",
      family: spec.deviceType.family,
      runtime: spec.runtime.name,
      createdAt,
    };
    write(device);
    rememberDeviceType(spec.deviceType.identifier);
    deps.logger.info("apple.lane_device_created", {
      laneId,
      udid,
      name,
      runtime: spec.runtime.identifier,
      deviceType: spec.deviceType.identifier,
    });
    return device;
  };

  const attach = async (args: { laneId: string; simulator: string; agentCaller?: boolean | null }): Promise<AppleLaneDevice> => {
    const laneId = requireLaneId(args.laneId);
    const wanted = args.simulator?.trim();
    if (!wanted) throw new Error("device-attach needs a simulator udid or name.");
    const existing = readOne(laneId);
    if (existing) {
      // Already ours. An attach of the device this lane holds is the state the
      // caller asked for, so it is answered, not refused and not moved —
      // checked before `simctl` is consulted, because it needs no device list.
      if (namesLaneDevice(existing, wanted)) return existing;
      throw new AppleDeviceExistsError(existing);
    }
    const installed = await deps.listInstalledSimulators();
    if (!installed.length) throw new AppleNoInstalledSimulatorsError();
    // A udid match wins over a device whose NAME happens to equal it.
    const match = installed.find((device) => device.udid === wanted)
      ?? installed.find((device) => matchesSimulatorName(device, wanted));
    if (!match) {
      throw new Error(`No installed simulator matches ${wanted}. Run device-list --installed to see what this Mac has.`);
    }
    /*
     * EVERY other lane holding this udid, not just the first.
     *
     * `rebind` moves one row. On the owner's machine ADE Repro was bound to
     * two lanes at once — a state this code is supposed to make impossible,
     * and which predates the atomic move — and a takeover would have moved one
     * row and left the other, so the duplicate survived the very operation
     * meant to end it. Two lanes believing they own one simulator is how one
     * powers it off under the other.
     */
    const holders = readAll().filter((device) => device.udid === match.udid && device.laneId !== laneId);
    /*
     * An agent may attach an installed simulator that no lane holds: that is
     * the user naming a device for the lane ("use my iPhone 17 Pro"). It may
     * never take one another lane holds — that is a takeover, and a takeover
     * stays the user's, through the picker, which never sets this flag.
     */
    const marker = readAppleDeviceMarker(dataRoot(), match.udid);
    const projectRoot = deps.projectRoot?.trim() || null;
    const otherProject = Boolean(marker && projectRoot && !appleMarkerIsProject(marker, projectRoot));
    if (args.agentCaller && (holders.length || otherProject)) {
      // Another project's ADE device may be that project's lane's right now,
      // and this project cannot see its rows. Only the user takes it.
      const holder = holders[0] ?? null;
      const reason: AppleDeviceNotLaneOwnedReason = holder
        ? { kind: "other-lane", laneLabel: laneNameFor(holder.laneId) ?? holder.laneId }
        : { kind: "other-project" };
      deps.logger.info("apple.lane_device_attach_refused_agent", {
        laneId,
        udid: match.udid,
        reason: reason.kind,
        ...(holder ? { holderLaneId: holder.laneId } : {}),
      });
      throw new AppleDeviceNotLaneOwnedError(match, reason);
    }
    if (holders.length > 1) {
      // Impossible by construction, so say so rather than repairing in silence.
      deps.logger.warn?.("apple.lane_device_multiple_holders", {
        udid: match.udid,
        laneIds: holders.map((device) => device.laneId),
      });
    }
    const previous = holders[0] ?? null;
    const device: AppleLaneDevice = {
      laneId,
      udid: match.udid,
      name: match.name,
      /*
       * `origin` travels WITH the device, not with the lane. It describes where
       * the simulator came from: a device ADE made is still ADE's to delete
       * after it changes hands, and re-labelling it "attached" would leak it
       * forever when the new lane is archived. A device with this project's
       * marker and no holder (a detached leftover) is ADE's for the same
       * reason. Another project's ADE device is NOT: that project may still
       * hold it, so here it is only ever attached, and never deleted.
       * `createdAt` is the opposite — it dates the BINDING, so it is now.
       */
      origin: previous?.origin ?? (marker && !otherProject ? "created" : "attached"),
      family: match.family,
      runtime: match.runtime,
      createdAt: now().toISOString(),
    };
    // An ADE device of this project now belongs to this lane: the marker says
    // so, and a detached leftover stops being one.
    if (isAdeOwnedLaneDevice(device.origin) && !otherProject) {
      writeMarker(device.udid, { laneId, name: device.name, createdAt: marker?.createdAt || device.createdAt, detachedAt: null });
    }
    if (previous) {
      /*
       * A takeover MOVES the binding. Nothing here may leave two lanes owning
       * one simulator: both would believe it is theirs, and either could power
       * it off or delete it out from under the other. The picker's "Take
       * over…" button is what makes this reachable, so the rule lives at the
       * only door — every surface attaches through here.
       *
       * The losing lane is released FIRST, while it still owns the row, so it
       * never holds a live stream on a device it no longer owns. A release that
       * fails is logged and the move still happens: a stream that would not
       * stop must not strand the binding half-moved.
       */
      // try/catch rather than `.catch` on the returned promise: a hook that
      // throws SYNCHRONOUSLY never produces a promise to attach a handler to,
      // and that throw would have escaped and left the binding unmoved.
      try {
        await deps.releaseLaneDevice?.(previous);
      } catch (error) {
        deps.logger.warn?.("apple.lane_device_release_failed", {
          laneId: previous.laneId,
          udid: previous.udid,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      rebind(previous, device);
      // Any remaining holder is dropped, never moved: the binding has already
      // landed on this lane, and a second `rebind` would move it straight back
      // out again.
      for (const stale of holders.slice(1)) forget(stale.laneId);
      deps.logger.info("apple.lane_device_moved", {
        laneId,
        fromLaneId: previous.laneId,
        udid: device.udid,
        name: device.name,
        origin: device.origin,
      });
      return device;
    }
    write(device);
    deps.logger.info("apple.lane_device_attached", { laneId, udid: device.udid, name: device.name });
    return device;
  };

  const remove = async (args: { laneId: string; udid?: string | null }): Promise<void> => {
    const laneId = requireLaneId(args.laneId);
    const device = readOne(laneId);
    if (!device) return;
    if (args.udid && device.udid !== args.udid) {
      deps.logger.info("apple.lane_device_delete_skipped_changed", { laneId, expected: args.udid, actual: device.udid });
      return;
    }
    // ADE does not delete a simulator it did not create: a user's own device
    // being erased because a lane was archived is not a recoverable mistake.
    if (!isAdeOwnedLaneDevice(device.origin)) throw new AppleDeviceAttachedNotDeletableError(device);
    try {
      await deleteAppleSimulator(device.udid, { run: deps.run, powerOff: deps.powerOffDevice });
    } catch (error) {
      // A device the user already deleted in Xcode must not strand the row.
      deps.logger.warn?.("apple.lane_device_delete_failed", {
        laneId,
        udid: device.udid,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    forget(laneId);
    deps.logger.info("apple.lane_device_deleted", { laneId, udid: device.udid });
  };

  /**
   * Delete one installed simulator the owner picked out of the list.
   *
   * Refuses anything a lane holds. The picker already renders those as taken
   * and offers no menu, but the guard belongs here: a CLI caller and a stale
   * renderer reach this same method, and the cost of getting it wrong is
   * another lane's live view vanishing mid-test.
   *
   * ADE's "never delete a simulator it did not create" rule governs what ADE
   * does BY ITSELF — on lane archive, without anyone asking. An owner clicking
   * Delete on a named device in a confirmed menu is the opposite of that, and
   * reclaiming the disk is usually the whole point.
   */
  const removeInstalled = async (args: { udid: string }): Promise<void> => {
    const udid = args.udid?.trim();
    if (!udid) throw new Error("A simulator udid is required.");
    const holder = readAll().find((device) => device.udid === udid);
    if (holder) throw new AppleDeviceOwnedByLaneError(holder);
    await deleteAppleSimulator(udid, { run: deps.run, powerOff: deps.powerOffDevice });
    deps.logger.info("apple.installed_device_deleted", { udid });
  };

  /** Who each installed simulator belongs to, for the storage view. */
  const ownershipFor = (installed: AppleInstalledSimulator[]): AppleSimulatorOwnershipInfo[] => {
    const rows = new Set(readAll().map((device) => device.udid));
    const root = dataRoot();
    const projectRoot = deps.projectRoot?.trim() || null;
    return installed.map((device) => {
      const marker = readAppleDeviceMarker(root, device.udid);
      let ownership: AppleSimulatorOwnershipInfo["ownership"] = "unknown";
      if (rows.has(device.udid)) ownership = "lane";
      else if (marker && projectRoot && !appleMarkerIsProject(marker, projectRoot)) ownership = "ade-other-project";
      else if (marker) ownership = "ade-orphan";
      return {
        udid: device.udid,
        ownership,
        markerLaneId: marker?.laneId ?? null,
        looksLikeAde: !marker && looksLikeAdeDeviceName(device.name),
      };
    });
  };

  /** A lane row holds this udid right now. Read fresh: the pass awaits between devices. */
  const heldNow = (udid: string): boolean => readAll().some((device) => device.udid === udid);

  const reconcile = async (): Promise<AppleDeviceCleanupResult> => {
    const result: AppleDeviceCleanupResult = { deleted: [], poweredOff: [], forgottenRows: [], released: [], errors: [] };
    const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
    let all: Map<string, SimctlListedDevice>;
    try {
      const { stdout } = await deps.run("xcrun", ["simctl", "list", "devices", "--json"], { timeoutMs: 30_000 });
      all = parseSimctlDevices(stdout);
    } catch (error) {
      // Nothing is deleted on a device set ADE could not read: an empty answer
      // would otherwise read as "every row's simulator is gone".
      result.errors.push({ udid: null, message: `Could not read the simulator list: ${errorText(error)}` });
      return result;
    }
    const root = dataRoot();

    for (const row of readAll()) {
      if (!all.has(row.udid)) {
        // Deleted outside ADE (Xcode, `simctl delete`). The row is all that is left.
        try {
          forget(row.laneId);
          result.forgottenRows.push({ laneId: row.laneId, udid: row.udid });
        } catch (error) {
          result.errors.push({ udid: row.udid, message: errorText(error) });
        }
        continue;
      }
      if (!isLaneLive(row.laneId)) {
        try {
          // A live lane bound to the same udid keeps the device; this lane only
          // lets go of its row.
          const shared = readAll().some((other) => other.udid === row.udid && other.laneId !== row.laneId);
          let deleted = false;
          let complete = true;
          if (!shared) {
            await deps.releaseDeviceHolds?.(row.udid).catch(() => undefined);
            const record = deps.store ? readLaneAppleDeviceRecord(deps.store, row.laneId) : null;
            const ended = await endLaneDeviceOnDisk({
              device: row,
              adeInstalledBundleIds: record?.adeInstalledBundleIds ?? [],
              run: deps.run,
              powerOff: deps.powerOffDevice,
              logger: deps.logger,
            });
            ({ deleted, complete } = ended);
            if (!complete && deps.store && !isAdeOwnedLaneDevice(row.origin)) {
              deps.store.run(
                `update ${LANE_APPLE_DEVICES_TABLE} set ade_installed_bundle_ids = ? where lane_id = ? and udid = ?`,
                [JSON.stringify(ended.remainingBundleIds), row.laneId, row.udid],
              );
            }
          }
          if (!complete) {
            // Kept, so the next pass tries again.
            result.errors.push({ udid: row.udid, message: `The device of ended lane ${row.laneId} could not be fully released yet.` });
            continue;
          }
          forget(row.laneId);
          result.released.push({ laneId: row.laneId, udid: row.udid });
          if (deleted) result.deleted.push({ udid: row.udid, name: row.name, reason: "lane ended" });
        } catch (error) {
          result.errors.push({ udid: row.udid, message: errorText(error) });
        }
        continue;
      }
      // A device made before markers existed: give it one, so a lost row can
      // no longer turn it into a device nobody deletes.
      if (isAdeOwnedLaneDevice(row.origin) && !readAppleDeviceMarker(root, row.udid)) {
        writeMarker(row.udid, { laneId: row.laneId, name: row.name, createdAt: row.createdAt });
      }
    }

    /*
     * Marked devices no lane holds. Only this project's: another project's ADE
     * devices are that project's to clean up, and a project that looks gone
     * from here may only be moved or on an unmounted volume. The storage view
     * lists them for the user.
     */
    const projectRoot = deps.projectRoot?.trim() || null;
    const nowMs = now().getTime();
    for (const { udid, marker } of projectRoot ? listAppleDeviceMarkers(root) : []) {
      const listed = all.get(udid);
      if (!listed || !appleMarkerIsProject(marker, projectRoot!) || heldNow(udid)) continue;
      const since = Date.parse(marker.detachedAt || marker.createdAt);
      if (Number.isFinite(since) && nowMs - since < APPLE_DEVICE_MARKER_GRACE_MS) continue;
      if (!marker.detachedAt && isLaneLive(marker.laneId) && !readOne(marker.laneId)) {
        // The lane is still here and lost only its row. Give the device back.
        try {
          write({
            laneId: marker.laneId,
            udid,
            name: listed.name,
            origin: "created",
            family: appleDeviceFamily({ deviceTypeIdentifier: listed.deviceTypeIdentifier, name: listed.name }),
            runtime: listed.runtime,
            createdAt: marker.createdAt || now().toISOString(),
          });
          deps.logger.info("apple.lane_device_readopted", { laneId: marker.laneId, udid });
        } catch (error) {
          result.errors.push({ udid, message: errorText(error) });
        }
        continue;
      }
      try {
        // Checked again right before the delete: a re-adopt or an attach in
        // another process may have bound it while this pass awaited.
        if (heldNow(udid)) continue;
        await deps.releaseDeviceHolds?.(udid).catch(() => undefined);
        await deleteAppleSimulator(udid, { run: deps.run, powerOff: deps.powerOffDevice });
        result.deleted.push({ udid, name: listed.name, reason: marker.detachedAt ? "detached from its lane" : "no live lane holds it" });
      } catch (error) {
        result.errors.push({ udid, message: errorText(error) });
      }
    }
    if (result.deleted.length || result.forgottenRows.length || result.released.length || result.errors.length) {
      deps.logger.info("apple.lane_devices_reconciled", {
        deleted: result.deleted.map((entry) => entry.udid),
        forgottenRows: result.forgottenRows.length,
        released: result.released.length,
        errors: result.errors.length,
      });
    }
    return result;
  };

  return {
    deviceCreate: create,
    deviceAttach: attach,
    deviceDeleteInstalled: removeInstalled,
    async deviceList(args = {}) {
      const wantInstalled = args.installed !== false;
      const installed = wantInstalled ? await deps.listInstalledSimulators() : [];
      const laneId = args.laneId?.trim() || null;
      const [disk, runtimes] = await Promise.all([
        args.disk ? measureDisk() : Promise.resolve(null),
        args.runtimes ? listRuntimes().catch(() => []) : Promise.resolve(null),
      ]);
      // The service's own default, so the picker starts where `device-create`
      // with no flags would land.
      let defaultNewDevice: AppleDeviceListResult["defaultNewDevice"] = null;
      if (runtimes?.length) {
        try {
          const spec = pickAppleDeviceSpec({ runtimes, lastDeviceType: lastDeviceType() });
          defaultNewDevice = { runtime: spec.runtime.identifier, deviceType: spec.deviceType.identifier };
        } catch {
          defaultNewDevice = null;
        }
      }
      return {
        installed,
        lane: laneId ? readOne(laneId) : null,
        owners: ownersFor(laneId),
        laneId,
        disk,
        ...(runtimes ? { runtimes, defaultNewDevice } : {}),
        // The storage read asks with `installed: false`; ownership still needs the list.
        ...(args.disk
          ? { ownership: ownershipFor(wantInstalled ? installed : await deps.listInstalledSimulators().catch(() => [])) }
          : {}),
      };
    },
    deviceDelete: remove,
    async deviceDetach(args: { laneId: string }) {
      const laneId = requireLaneId(args.laneId);
      const device = readOne(laneId);
      if (!device) return null;
      const installedByAde = !isAdeOwnedLaneDevice(device.origin) && deps.store
        ? readLaneAppleDeviceRecord(deps.store, laneId)?.adeInstalledBundleIds ?? []
        : [];
      forget(laneId);
      // The user's device goes back to them without the apps ADE put on it.
      // In the background, and its power state is left as it was.
      if (installedByAde.length && process.platform === "darwin") {
        void uninstallAdeApps({
          udid: device.udid,
          bundleIds: installedByAde,
          run: deps.run,
          powerOff: deps.powerOffDevice,
          restorePower: true,
          logger: { info: deps.logger.info, ...(deps.logger.warn ? { warn: deps.logger.warn } : {}) },
        }).catch(() => undefined);
      }
      // An ADE device no lane holds is a leftover. Stamp it, so the cleanup
      // pass deletes it after the grace period instead of handing it back.
      if (isAdeOwnedLaneDevice(device.origin)) {
        const marker = readAppleDeviceMarker(dataRoot(), device.udid);
        writeMarker(device.udid, {
          laneId,
          name: device.name,
          createdAt: marker?.createdAt || device.createdAt,
          detachedAt: now().toISOString(),
        });
      }
      deps.logger.info("apple.lane_device_detached", { laneId, udid: device.udid, origin: device.origin });
      return device;
    },
    get: (laneId: string) => readOne(laneId),
    list: readAll,
    async ensure(args: { laneId: string }) {
      const laneId = requireLaneId(args.laneId);
      const existing = readOne(laneId);
      if (existing) return existing;
      return create({ laneId });
    },
    reconcile,
    tracksInstallsOn: (udid: string) => attachedHolder(udid) !== null,
    noteAppInstalled,
  };
}
