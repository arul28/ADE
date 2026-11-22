/**
 * Grows a cloud computer's disk before ADE's storage guard has to stop work
 * on it. A grow restarts the computer, so it runs only when nothing runs
 * there: at the idle point once the disk is near full, and at once (the next
 * keep-awake check) once the guard would soon stop turns. There is no plan or
 * account disk: the server holds a disk only to its size's own maximum
 * (`tier_limit`); what it refuses turns into a plain sentence on the
 * computer's card and in the chat's refusal. The card reads the exact reason;
 * builds before plans read the older key.
 *
 * A lane launch's setup that fills the disk (every size starts with the same
 * small disk, and a big repository's install outgrows it) asks for a step at
 * once (`makeRoomForSetup`): the launch waits, the computer restarts, and the
 * launch's setup runs again on the bigger disk, a step at a time up to the
 * size's limit, inside every rule the server checks.
 *
 * An agent (`ade cloud resize --free`) and the Android emulator's first start
 * ask for room through `growToFit` (`cloudDiskGrowHost.ts`): up to the size's
 * maximum it grows with nothing to ask; past it the answer is `limit`
 * (`tier_limit`: move the lane to a bigger size). Its chat hears of the grow
 * before the restart and again once
 * the computer is back (`afterRestart`).
 *
 * The lines come from this computer's own disk (`diskPressureThresholdsForSize`):
 * the guard stops agent turns at "exhausted", the grow comes at "critical" or
 * earlier, so on any disk size the grow is asked for before a turn is refused.
 */

import fs from "node:fs";
import path from "node:path";
import {
  CLOUD_DISK_FULL_METADATA,
  CLOUD_DISK_FULL_REASON_METADATA,
  cloudCatalogOf,
  cloudDiskFullLegacyReason,
  cloudDiskGrowFit,
  cloudDiskGrowRefusedWayOut,
  type CloudAccountState,
  type CloudDiskRefusalReason,
} from "../../../../desktop/src/shared/adeCloud";
import type {
  CloudDiskGrowAnswer,
  CloudDiskGrowAsk,
  CloudDiskGrowChat,
} from "../../../../desktop/src/main/services/adeCloud/cloudDiskGrowHost";
import type { CloudProvider } from "../../../../desktop/src/main/services/adeCloud/cloudProvider";
import type {
  ChatLaunchEnvironmentDisk,
  ChatLaunchEnvironmentRoom,
} from "../../../../desktop/src/main/services/chat/chatLaunchService";
import { CloudProviderError } from "../../../../desktop/src/main/services/adeCloud/cloudProvider";
import { patchCloudMetadata } from "../../../../desktop/src/main/services/adeCloud/cloudInstanceOps";
import {
  classifyDiskPressure,
  diskPressureThresholdsForSize,
  type DiskPressureState,
} from "../../../../desktop/src/main/services/storage/diskPressure";
import {
  diskFullLine,
  isUrgentDiskPressure,
  LANE_SETUP_NO_ROOM_TO_SAVE_ERROR,
} from "../../../../desktop/src/shared/types/storage";
import {
  CLOUD_DISK_GROW_STARTED_COOLDOWN_MS,
  cloudDiskGrowStatePath,
  readCloudDiskGrowState,
  type CloudDiskGrowOrigin,
  type CloudDiskGrowState,
} from "./cloudDiskGuard";

/**
 * Near full: at this much used, or the guard's warning if that comes first,
 * grow at the idle point. On a disk over 80 GB the warning comes later than
 * this (its line is a fixed number of bytes), and the grow still comes here.
 */
const NEAR_FULL = 0.85;
/** A refused grow is asked again only this often: a computer's size changes rarely. */
const REFUSED_RETRY_MS = 60 * 60_000;
/** A grow that failed for another reason (out of hours, the server or network) waits this long before the next try. */
const FAILED_RETRY_MS = 5 * 60_000;

/** A lane setup's grow is waited on this long while this brain still runs (the restart a grow brings ends the wait sooner). */
const SETUP_GROW_WAIT_MS = 10 * 60_000;
const SETUP_GROW_POLL_MS = 5_000;
/** A setup's grow that lost the account's disk reservation to another computer's asks again after these waits (plus up to a second). */
const SETUP_GROW_RACE_RETRY_MS = [2_000, 6_000];
/** The filesystem reads this much bigger once a grow landed (a step is whole GB; the filesystem keeps a little of it). */
const GREW_MARGIN_BYTES = 512 * 1024 * 1024;

/**
 * Really short, for a setup that said ENOSPC: under this much free, or under
 * the fraction, or past the guard's own warning. Above it the error came
 * from something else (a quota, a full inode table, a tool's own limit), and
 * a bigger disk wouldn't help.
 */
const SETUP_SHORT_FREE_BYTES = 1024 * 1024 * 1024;
const SETUP_SHORT_FREE_FRACTION = 0.1;
/** Kept on the disk while a setup runs and freed just before the launch writes its grow mark, so a full disk can still take it. */
const SETUP_RESERVE_BYTES = 4 * 1024 * 1024;
/**
 * How often a running setup's free space is read (a local statfs). A failed
 * install often deletes what it wrote, so the disk reads roomy again right
 * after ENOSPC: the run's lowest reading says how short it really ran.
 */
const SETUP_SAMPLE_MS = 2_000;
/** One launch's setup grows at most this often, however much more each run used. */
const SETUP_MAX_GROWS = 4;
/** A launch's grow history goes after this long (no launch's setup waits a day). */
const SETUP_HISTORY_TTL_MS = 24 * 60 * 60_000;
/** The chats a grow told are told again after the restart only this long after the ask (a later boot is another story). */
const AFTER_RESTART_NOTICE_MS = 30 * 60_000;

type DiskSpace = { freeBytes: number; totalBytes: number };

/**
 * One launch's setup grows so far, and its last grown run's peak use (the
 * disk's size less the lowest free space that run read). Peak, not what the
 * run itself added: an installer that leaves its files behind on failure
 * frees them in the next run, which then adds about as much as the last one
 * did while it fills a bigger disk.
 */
type SetupGrowHistory = Record<string, { grows: number; peakBytes: number; at: number }>;

/** A short line of command output for the log: token-like runs and home paths cut. */
function safeExcerpt(text: string | null): string | null {
  if (!text) return null;
  return text
    .replace(/[A-Za-z0-9_+/=-]{24,}/g, "…")
    .replace(/\/(?:home|Users|root)\/[^\s/]+/g, "~")
    .slice(0, 160);
}

const gb = (bytes: number): string => `${Math.max(0, bytes / 1024 ** 3).toFixed(1)} GB`;
/** Bytes as GB with one decimal, for an answer's `freeGb`. */
const gbOneDecimal = (bytes: number): number => Math.round((bytes / 1024 ** 3) * 10) / 10;

/** One step's ask: started, refused by the server, held back because something runs, or no way to ask. */
type GrowStep =
  | { state: "growing"; toGb: number }
  /** The account's disk changed under the ask (another computer's grow won the reservation): ask again shortly. */
  | { state: "changed" }
  | { state: "refused"; reason: CloudDiskRefusalReason; wayOut: string; diskGb: number }
  | { state: "busy" }
  /** The note that a grow is under way couldn't be written (a full disk): no grow without it. */
  | { state: "unsaved" }
  | { state: "unavailable" };

function readDiskSpace(target: string): DiskSpace | null {
  try {
    const stats = fs.statfsSync(target);
    if (!(stats.blocks > 0)) return null;
    return { freeBytes: stats.bavail * stats.bsize, totalBytes: stats.blocks * stats.bsize };
  } catch {
    return null;
  }
}

/** The guard's state for this disk, by the same size-scaled lines the brain's guard uses. */
function pressureOf(space: DiskSpace): DiskPressureState {
  return classifyDiskPressure(
    { freeBytes: space.freeBytes, freeFraction: space.freeBytes / space.totalBytes },
    diskPressureThresholdsForSize(space.totalBytes),
  );
}

export function createCloudDiskGrower(deps: {
  instanceId: string;
  client: () => Promise<CloudProvider | null>;
  /** The path whose filesystem is the computer's disk. */
  path: string;
  /** The brain's `$ADE_HOME`: `CloudDiskGrowState` goes to `cloudDiskGrowStatePath` there, for the guard's refusal. */
  adeHome: string;
  logger?: { info(event: string, data?: unknown): void; warn(event: string, data?: unknown): void };
  now?: () => number;
}) {
  const now = deps.now ?? (() => Date.now());
  const stateFile = cloudDiskGrowStatePath(deps.adeHome);
  const historyFile = path.join(path.dirname(stateFile), "setup-disk-grows.json");
  const reserveDir = path.join(path.dirname(stateFile), "setup-reserve");
  // No setup runs before the brain starts: a reserve left by the last boot goes.
  try { fs.rmSync(reserveDir, { recursive: true, force: true }); } catch { /* nothing to free */ }
  // A grow restarts the computer, so the last boot's grow or refusal is read
  // back from the state file it wrote: the cooldown and the refusal's wait
  // hold across that restart instead of growing again at the first check.
  const previous = readCloudDiskGrowState(stateFile, deps.instanceId);
  let refusedAt: number | null = previous?.state === "refused" ? previous.at : null;
  let grewAt: number | null = previous?.state === "growing" ? previous.at : null;
  let failedAt: number | null = null;
  let stateWritten = previous !== null;
  /** One grow at a time: a check that comes while one runs answers false. */
  let inFlight = false;
  /**
   * The exact reason shown on the card: undefined until this brain wrote or
   * read it. A notice an earlier boot wrote (before a grow, a resize or Clear
   * caches made room) is read once and cleared.
   */
  let shown: string | null | undefined = undefined;

  const setNotice = async (client: CloudProvider, reason: string | null): Promise<void> => {
    if (reason === shown) return;
    if (shown === undefined && reason === null) {
      const metadata = (await client.getInstance(deps.instanceId)).metadata;
      if (!metadata[CLOUD_DISK_FULL_METADATA] && !metadata[CLOUD_DISK_FULL_REASON_METADATA]) {
        shown = null;
        return;
      }
    }
    await patchCloudMetadata(client, deps.instanceId, {
      [CLOUD_DISK_FULL_METADATA]: reason ? cloudDiskFullLegacyReason(reason) : "",
      [CLOUD_DISK_FULL_REASON_METADATA]: reason ?? "",
    });
    shown = reason;
  };

  /** Writes (or clears) the state file whole; false when it couldn't (a full disk), and the old copy stays. */
  const writeState = (state: CloudDiskGrowState | null): boolean => {
    const tmp = `${stateFile}.${process.pid}.tmp`;
    try {
      if (!state) {
        if (stateWritten || fs.existsSync(stateFile)) fs.rmSync(stateFile, { force: true });
        stateWritten = false;
        return true;
      }
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(tmp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, stateFile);
      stateWritten = true;
      return true;
    } catch (error) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
      deps.logger?.warn("cloud.disk_grow_state_write_failed", { error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  };

  const readHistory = (): SetupGrowHistory => {
    try {
      const parsed = JSON.parse(fs.readFileSync(historyFile, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const out: SetupGrowHistory = {};
      for (const [launchId, entry] of Object.entries(parsed as Record<string, unknown>)) {
        const e = entry as { grows?: unknown; peakBytes?: unknown; at?: unknown };
        if (typeof e?.grows !== "number" || typeof e.peakBytes !== "number" || typeof e.at !== "number") continue;
        if (now() - e.at > SETUP_HISTORY_TTL_MS) continue;
        out[launchId] = { grows: e.grows, peakBytes: e.peakBytes, at: e.at };
      }
      return out;
    } catch {
      return {};
    }
  };

  const writeHistory = (history: SetupGrowHistory): boolean => {
    const tmp = `${historyFile}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(historyFile), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(history), { mode: 0o600 });
      fs.renameSync(tmp, historyFile);
      return true;
    } catch (error) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
      deps.logger?.warn("cloud.disk_grow_history_write_failed", { error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  };

  /**
   * Grows taken back (they never started) whose rollback couldn't be saved yet:
   * the disk that just filled may have no room for the rewrite. Read over the
   * file, and saved with the next history write that succeeds. This boot only,
   * which is enough: a grow that never started brings no restart.
   */
  const rollbacks = new Map<string, SetupGrowHistory[string] | null>();
  const currentHistory = (): SetupGrowHistory => {
    const history = readHistory();
    for (const [launchId, entry] of rollbacks) {
      if (entry) history[launchId] = entry;
      else delete history[launchId];
    }
    return history;
  };
  const saveHistory = (history: SetupGrowHistory): boolean => {
    if (!writeHistory(history)) return false;
    rollbacks.clear();
    return true;
  };

  /**
   * Each running setup, by launch (this boot only: a resumed run starts
   * again): the free space it started with, the lowest it read while it ran,
   * and the sampler reading it (stopped once the run says ENOSPC or ends).
   */
  type SetupRun = { startFree: number | null; lowFree: number | null; sampler: ReturnType<typeof setInterval> | null };
  const setupRuns = new Map<string, SetupRun>();
  const noteLow = (run: SetupRun, freeBytes: number | null | undefined): void => {
    if (freeBytes != null && (run.lowFree == null || freeBytes < run.lowFree)) run.lowFree = freeBytes;
  };
  const stopSampling = (run: SetupRun | undefined): void => {
    if (run?.sampler) clearInterval(run.sampler);
    if (run) run.sampler = null;
  };
  const reservePath = (launchId: string): string => path.join(reserveDir, `${launchId.replace(/[^A-Za-z0-9_-]/g, "_")}.bin`);
  /** The launches whose reserve should be on disk; a write that finishes after its launch let go of it is removed. */
  const reserved = new Set<string>();
  let reserveZeros: Buffer | null = null;
  const freeReserve = (launchId: string): void => {
    reserved.delete(launchId);
    try { fs.rmSync(reservePath(launchId), { force: true }); } catch { /* nothing to free */ }
  };
  /** Written off the event loop (one write on libuv's pool): a setup's start never waits on it. */
  const keepReserve = (launchId: string): void => {
    const target = reservePath(launchId);
    const space = readDiskSpace(deps.path);
    // Too little room to set any aside: the launch's mark may not land, and then it doesn't grow.
    if (!space || space.freeBytes < SETUP_RESERVE_BYTES * 4) return;
    reserved.add(launchId);
    // Real blocks: a sparse file holds no room.
    reserveZeros ??= Buffer.alloc(SETUP_RESERVE_BYTES);
    void fs.promises.mkdir(reserveDir, { recursive: true })
      .then(() => fs.promises.writeFile(target, reserveZeros!, { mode: 0o600 }))
      .then(() => {
        if (!reserved.has(launchId)) fs.rmSync(target, { force: true });
      })
      .catch((error: unknown) => {
        deps.logger?.warn("cloud.setup_reserve_failed", { error: error instanceof Error ? error.message : String(error) });
        try { fs.rmSync(target, { force: true }); } catch { /* nothing to free */ }
      });
  };

  /** A setup that may grow, once its launch's mark is saved: the history entry `makeRoom` writes first. */
  const pendingGrows = new Map<string, { grows: number; peakBytes: number }>();

  /** The disk as the grow sees it, or null when unreadable. */
  const measure = (): { space: DiskSpace; used: number; pressure: DiskPressureState } | null => {
    const space = readDiskSpace(deps.path);
    if (!space) return null;
    return { space, used: 1 - space.freeBytes / space.totalBytes, pressure: pressureOf(space) };
  };

  /** A refused grow, a started one, or a failed one still holds the next try back. */
  const holding = (): boolean =>
    (refusedAt != null && now() - refusedAt < REFUSED_RETRY_MS)
    || (grewAt != null && now() - grewAt < CLOUD_DISK_GROW_STARTED_COOLDOWN_MS)
    || (failedAt != null && now() - failedAt < FAILED_RETRY_MS);

  /**
   * Asks the server for one more step of disk, or for `ask.toGb`. A grow
   * restarts the computer, so `stillIdle` is asked right before. `ask.note`
   * goes into the state file with the grow (who asked, the chats to tell).
   */
  const growOneStep = async (
    stillIdle: () => boolean | Promise<boolean>,
    disk: { space: DiskSpace; pressure: DiskPressureState },
    signal?: AbortSignal,
    onAsking?: (toGb: number) => void | Promise<void>,
    ask: { toGb?: number; note?: { origin?: CloudDiskGrowOrigin; reason?: string; chats?: CloudDiskGrowChat[] } } = {},
  ): Promise<GrowStep> => {
    const client = await deps.client();
    if (!client) return { state: "unavailable" };
    const instance = await client.getInstance(deps.instanceId);
    if (!instance.resources) return { state: "unavailable" };
    const account = await client.getAccount().catch((error: unknown) => {
      deps.logger?.warn("cloud.disk_catalog_read_failed", { error: error instanceof Error ? error.message : String(error) });
      return null;
    });
    const catalog = cloudCatalogOf(account);
    // A grow restarts the computer, and work may have started during those reads.
    if (!(await stillIdle())) return { state: "busy" };
    // Cancelled while it read: nothing grows for a launch that's gone.
    if (signal?.aborted) return { state: "unavailable" };
    const { cpu, memory, disk: diskGb } = instance.resources;
    const toGb = ask.toGb ?? diskGb + catalog.diskStepGb;
    // The note is what holds the cooldown and the pending grow across the restart: no grow without it.
    if (!writeState({ ...ask.note, v: 1, state: "growing", toGb, at: now(), instanceId: deps.instanceId, fromBytes: disk.space.totalBytes, fromGb: diskGb })) {
      return { state: "unsaved" };
    }
    try {
      // Waited on (a few seconds at most): a chat's card is saved before the restart takes the computer down.
      const said = onAsking?.(toGb);
      if (said) await Promise.race([said, new Promise((resolve) => setTimeout(resolve, 5_000).unref?.())]);
    } catch (error) {
      // Only words on a card: never in the grow's way.
      deps.logger?.warn("cloud.disk_grow_card_failed", { error: error instanceof Error ? error.message : String(error) });
    }
    // The card's wait gave work and a cancel time to come: check both again before the restart.
    if (signal?.aborted || !(await stillIdle())) {
      writeState(null);
      return signal?.aborted ? { state: "unavailable" } : { state: "busy" };
    }
    try {
      await client.resizeInstance(deps.instanceId, { cpu, memory, disk: toGb }, { computerIdle: true, origin: "auto" });
    } catch (error) {
      // The server's "the disk changed while this ran" (409, no reason): room may be there, so it isn't a refusal.
      if (error instanceof CloudProviderError && error.code === "disk_limit" && error.status === 409 && !error.detail.reason) {
        writeState(null);
        deps.logger?.info("cloud.disk_grow_raced", { toGb });
        return { state: "changed" };
      }
      // No answer, or one that came after the provider may have resized (the network, a timeout,
      // a gateway, the server failing after the provider): the grow may have happened, and its
      // restart may be coming. Held as started, so nothing asks again for it inside the cooldown;
      // the state stays "growing" with the size it came from. That includes a 503 with no
      // code of ours (Cloudflare's transient answer when D1 fails after the provider resized).
      // A deliberate no (code `unavailable`: no provider key, can't record) is a refusal below.
      const lost = !(error instanceof CloudProviderError)
        || error.status === 0
        || (error.status >= 500 && error.code !== "unavailable");
      if (lost) {
        grewAt = now();
        deps.logger?.warn("cloud.disk_grow_answer_lost", { toGb, error: error instanceof Error ? error.message : String(error) });
        return { state: "growing", toGb };
      }
      if (error.code === "needs_paid_plan" || error.code === "disk_limit") {
        refusedAt = now();
        // The server names its reason (the size's maximum, `tier_limit`, or `unavailable`).
        // A reason this build doesn't know still reads as a refusal with a way out.
        const reason = (error.detail.reason ?? "tier_limit") as CloudDiskRefusalReason;
        const wayOut = cloudDiskGrowRefusedWayOut(null, reason) ?? "It can't grow right now.";
        writeState({ v: 1, state: "refused", reason, wayOut, at: now(), instanceId: deps.instanceId });
        // The card says "full" once the guard stops heavy work; the chat's refusal says it at once.
        if (isUrgentDiskPressure(disk.pressure)) await setNotice(client, reason);
        deps.logger?.info("cloud.disk_grow_refused", { code: error.code, reason });
        return { state: "refused", reason, wayOut, diskGb };
      }
      // Refused for another reason (out of hours, the computer busy): the caller holds the next try back a little.
      writeState(null);
      throw error;
    }
    grewAt = now();
    failedAt = null;
    deps.logger?.info("cloud.disk_grown", { instanceId: deps.instanceId, toGb, pressure: disk.pressure });
    // The restart is on its way; a notice left from before goes once it can.
    await setNotice(client, null).catch((error: unknown) => {
      deps.logger?.warn("cloud.disk_notice_clear_failed", { error: error instanceof Error ? error.message : String(error) });
    });
    return { state: "growing", toGb };
  };

  const grow = async (stillIdle: () => boolean | Promise<boolean>): Promise<boolean> => {
    const disk = measure();
    if (!disk) return false;
    const nearFull = disk.used >= NEAR_FULL || disk.pressure !== "normal";
    if (!nearFull) {
      if (shown !== null) {
        // Never in the way of the idle sleep that follows: tried again at the next idle point.
        try {
          const client = await deps.client();
          if (client) await setNotice(client, null);
        } catch (error) {
          deps.logger?.warn("cloud.disk_notice_clear_failed", { error: error instanceof Error ? error.message : String(error) });
        }
      }
      writeState(null);
      refusedAt = null;
      failedAt = null;
      return false;
    }
    if (holding()) return false;
    const step = await growOneStep(stillIdle, disk);
    if (step.state === "unsaved") failedAt = now();
    return step.state === "growing";
  };

  /** Resolves true once the filesystem reads bigger than `fromBytes`, false at the wait's end or on abort. */
  /** `stillAsked`: false once the grow waited on is gone (cancelled or refused before its resize), which ends the wait. */
  const waitForGrowth = (fromBytes: number, signal: AbortSignal, stillAsked?: () => boolean): Promise<boolean> => new Promise((resolve) => {
    const startedAt = now();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (grew: boolean) => {
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(grew);
    };
    const onAbort = () => finish(false);
    const check = () => {
      const space = readDiskSpace(deps.path);
      if (space && space.totalBytes > fromBytes + GREW_MARGIN_BYTES) return finish(true);
      if (now() - startedAt >= SETUP_GROW_WAIT_MS || (stillAsked && !stillAsked())) return finish(false);
      timer = setTimeout(check, SETUP_GROW_POLL_MS);
      timer.unref?.();
    };
    if (signal.aborted) return resolve(false);
    signal.addEventListener("abort", onAbort, { once: true });
    check();
  });

  /** The last boot's grow, when it named chats to tell once the computer is back (read before anything rewrites the file). */
  const toldBeforeRestart = previous?.state === "growing" && previous.chats?.length && now() - previous.at < AFTER_RESTART_NOTICE_MS
    ? previous
    : null;

  const growingDetail = (toGb: number): string =>
    `The disk filled up during setup. ADE is growing it to ${toGb} GB: the computer restarts for a moment, then setup runs again.`;

  const grower = {
    /**
     * At the idle point: grows the disk if it's near full. True when a grow
     * started; the computer restarts and the idle sleep waits for that.
     */
    async growIfNeeded(stillIdle: () => boolean | Promise<boolean>): Promise<boolean> {
      if (inFlight) return false;
      inFlight = true;
      try {
        return await grow(stillIdle);
      } catch (error) {
        // Out of hours, the server or the network: not asked again every minute while the disk stays full.
        failedAt = now();
        throw error;
      } finally {
        inFlight = false;
      }
    },
    /**
     * A lane launch's setup filled the disk (`setupDisk().makeRoom`): one
     * more step now, whatever the near-full line says (a failed install can
     * leave the disk roomy again) and past an earlier refusal's wait (the
     * server is asked; it holds every rule). Only while nothing else runs:
     * the grow restarts the computer. A grow already asked for whose disk
     * hasn't grown yet is waited on, not asked again.
     */
    async makeRoomForSetup(args: { stillIdle: () => boolean | Promise<boolean>; signal: AbortSignal; onAsking?: (detail: string) => void }): Promise<ChatLaunchEnvironmentRoom | null> {
      const onAsking = args.onAsking ? (toGb: number) => args.onAsking!(growingDetail(toGb)) : undefined;
      if (args.signal.aborted) return null;
      const disk = measure();
      if (!disk) return null;
      const asked = readCloudDiskGrowState(stateFile, deps.instanceId);
      if (
        asked?.state === "growing"
        && asked.fromBytes != null
        && disk.space.totalBytes <= asked.fromBytes + GREW_MARGIN_BYTES
        && now() - asked.at < CLOUD_DISK_GROW_STARTED_COOLDOWN_MS
      ) {
        return { state: "growing", detail: growingDetail(asked.toGb), ready: waitForGrowth(asked.fromBytes, args.signal) };
      }
      if (inFlight) return { state: "refused", error: "Setup filled this computer's disk while ADE was already growing it. Retry in a minute or two." };
      inFlight = true;
      try {
        let step = await growOneStep(args.stillIdle, disk, args.signal, onAsking);
        // Two of the account's computers growing at once: the one that lost the reservation asks again, twice at most.
        for (const waitMs of SETUP_GROW_RACE_RETRY_MS) {
          if (step.state !== "changed" || args.signal.aborted) break;
          await new Promise((resolve) => setTimeout(resolve, waitMs + Math.floor(Math.random() * 1_000)).unref?.());
          // Checked again before it asks: a Cancel during the wait grows nothing.
          step = await growOneStep(args.stillIdle, disk, args.signal, onAsking);
        }
        switch (step.state) {
          case "growing":
            return { state: "growing", detail: growingDetail(step.toGb), ready: waitForGrowth(disk.space.totalBytes, args.signal) };
          case "refused":
            return { state: "refused", error: `Setup filled this computer's ${step.diskGb} GB disk, and it can't grow: ${step.wayOut} Then retry.` };
          case "busy":
            return { state: "refused", error: "Setup filled this computer's disk, and ADE can't grow it while something else runs there (a grow restarts the computer). Retry once that's done." };
          case "changed":
            return { state: "refused", error: "Setup filled this computer's disk, and your computers' disk kept changing while ADE grew it. Retry in a moment." };
          case "unsaved":
            return { state: "refused", error: LANE_SETUP_NO_ROOM_TO_SAVE_ERROR };
          case "unavailable":
            return null;
        }
      } catch (error) {
        failedAt = now();
        const message = error instanceof Error ? error.message : String(error);
        deps.logger?.warn("cloud.disk_grow_for_setup_failed", { error: message });
        return { state: "refused", error: `Setup filled this computer's disk, and ADE couldn't grow it right now (${message.replace(/[.\s]+$/, "")}). Retry to try again.` };
      } finally {
        inFlight = false;
      }
    },
    /**
     * Room asked for by an agent (`cloud.grow_disk`) or the Android
     * emulator's first start: grows to the smallest step that frees
     * `needFreeBytes` (or to `toGb`). Up to the size's own disk maximum it
     * grows with nothing to ask; past it, it answers `limit` (`tier_limit`).
     * A running chat turn
     * doesn't hold it back (ADE continues it after the restart); what
     * `stillIdle` says would be cut does. Once asked for, it waits for the
     * restart, which ends this brain: the asking turn is cut there and
     * continued after it.
     */
    async growToFit(ask: CloudDiskGrowAsk & {
      stillIdle: () => boolean | Promise<boolean>;
      /** Once the grow is asked for, before the restart: the chat's card goes up under `cardId`. */
      onGrowing?: (grow: { fromGb: number; toGb: number; cardId: string }) => void | Promise<void>;
    }): Promise<CloudDiskGrowAnswer> {
      const signal = ask.signal ?? new AbortController().signal;
      const disk = measure();
      if (!disk) return { state: "unavailable", message: "ADE couldn't read this computer's disk, so it didn't grow it." };
      const totalGb = Math.round(disk.space.totalBytes / 1024 ** 3);
      if (ask.needFreeBytes != null && disk.space.freeBytes >= ask.needFreeBytes) {
        return { state: "fits", diskGb: totalGb, freeGb: gbOneDecimal(disk.space.freeBytes), message: `This computer's disk already has ${gb(disk.space.freeBytes)} free, so nothing grew.` };
      }
      /** Once a grow is asked for: waits for the bigger disk (the restart ends this brain first, as a rule). */
      const awaitGrowth = async (fromBytes: number, fromGb: number, toGb: number, already: boolean, stillAsked?: () => boolean): Promise<CloudDiskGrowAnswer> => {
        const grew = await waitForGrowth(fromBytes, signal, stillAsked);
        const after = readDiskSpace(deps.path);
        // Grown, yet less free than this ask needs (other work wrote meanwhile): say so.
        const short = after && ask.needFreeBytes != null && after.freeBytes < ask.needFreeBytes
          ? ` That's less than the ${gb(ask.needFreeBytes)} asked for: free some space, or ask again.`
          : "";
        return grew && after
          ? { state: "grown", fromGb, toGb, message: `This computer's disk grew to ${toGb} GB; ${gb(after.freeBytes)} is free now.${short}` }
          : { state: "growing", fromGb, toGb, message: `ADE ${already ? "already " : ""}asked to grow this disk to ${toGb} GB, and the computer hasn't restarted yet. Try again in a few minutes.` };
      };
      // A grow already asked for whose disk hasn't grown yet: wait for it, never ask twice.
      const asked = readCloudDiskGrowState(stateFile, deps.instanceId);
      if (
        asked?.state === "growing"
        && asked.fromBytes != null
        && disk.space.totalBytes <= asked.fromBytes + GREW_MARGIN_BYTES
        && now() - asked.at < CLOUD_DISK_GROW_STARTED_COOLDOWN_MS
      ) {
        const sameAsk = () => {
          const current = readCloudDiskGrowState(stateFile, deps.instanceId);
          return current?.state === "growing" && current.at === asked.at;
        };
        const earlier = await awaitGrowth(asked.fromBytes, asked.fromGb ?? totalGb, asked.toGb, true, sameAsk);
        // The grow waited on was cancelled or refused before it resized: this ask goes on by itself.
        if (earlier.state !== "grown") return sameAsk() ? earlier : await grower.growToFit(ask);
        // That grow was someone else's size: when this caller needs more, ask again from the new disk.
        const after = measure();
        const met = !after
          || ((ask.needFreeBytes == null || after.space.freeBytes >= ask.needFreeBytes) && (ask.toGb == null || asked.toGb >= ask.toGb));
        return met ? earlier : await grower.growToFit(ask);
      }
      if (inFlight) return { state: "unavailable", message: "ADE is already growing this computer's disk. Try again in a minute or two." };
      inFlight = true;
      try {
        const client = await deps.client();
        if (!client) return { state: "unavailable", message: "This computer can't reach ADE Cloud right now, so it didn't grow the disk." };
        const instance = await client.getInstance(deps.instanceId);
        if (!instance.resources) return { state: "unavailable", message: "ADE Cloud didn't say how big this computer's disk is, so ADE didn't grow it." };
        const fromGb = instance.resources.disk;
        if (ask.toGb != null && ask.toGb <= fromGb) {
          return { state: "fits", diskGb: fromGb, freeGb: gbOneDecimal(disk.space.freeBytes), message: `This computer's disk is already ${fromGb} GB, so nothing grew.` };
        }
        const computer = { type: instance.type, cpu: instance.resources.cpu, memoryGb: instance.resources.memory, diskGb: fromGb };
        /** What to grow for, from a fresh reading of the free space: other work writes while a grow waits. */
        const want = (): { toGb: number } | { shortMb: number } => {
          if (ask.toGb != null) return { toGb: ask.toGb };
          const free = (measure() ?? disk).space.freeBytes;
          return { shortMb: Math.max(1, Math.ceil(((ask.needFreeBytes ?? 0) - free) / 2 ** 20)) };
        };
        const readAccount = (): Promise<CloudAccountState | null> => client.getAccount().catch((error: unknown) => {
          deps.logger?.warn("cloud.disk_catalog_read_failed", { error: error instanceof Error ? error.message : String(error) });
          return null;
        });
        const limitAnswer = (toGb: number, reason: CloudDiskRefusalReason, message: string): CloudDiskGrowAnswer => {
          deps.logger?.info("cloud.disk_grow_to_fit_limit", { origin: ask.origin, reason, fromGb, toGb });
          return { state: "limit", fromGb, toGb, reason, message };
        };
        /** The size to grow to, on a fresh read of the account and the free space; an answer when it can't grow. */
        const fitNow = async (): Promise<CloudDiskGrowAnswer | number> => {
          const fit = cloudDiskGrowFit(computer, await readAccount(), want());
          return fit.kind === "limit" ? limitAnswer(fit.toGb, fit.reason, fit.sentence) : fit.toGb;
        };
        const first = await fitNow();
        if (typeof first !== "number") return first;
        let toGb = first;
        const cardId = `cloud-disk-grow:${deps.instanceId}:${now()}`;
        const note = { origin: ask.origin, reason: ask.reason.slice(0, 200), ...(ask.chat ? { chats: [ask.chat], cardId } : {}) };
        const onAsking = (askedGb: number) => ask.onGrowing?.({ fromGb, toGb: askedGb, cardId });
        if (signal.aborted) return { state: "unavailable", message: "Cancelled before the disk grew." };
        let step = await growOneStep(ask.stillIdle, disk, signal, onAsking, { toGb, note });
        // Two of the account's computers growing at once: the one that lost the reservation asks again, on the fit read again.
        for (const waitMs of SETUP_GROW_RACE_RETRY_MS) {
          if (step.state !== "changed" || signal.aborted) break;
          await new Promise((resolve) => setTimeout(resolve, waitMs + Math.floor(Math.random() * 1_000)).unref?.());
          const again = await fitNow();
          if (typeof again !== "number") return again;
          toGb = again;
          step = await growOneStep(ask.stillIdle, disk, signal, onAsking, { toGb, note });
        }
        deps.logger?.info("cloud.disk_grow_to_fit", { origin: ask.origin, step: step.state, fromGb, toGb });
        switch (step.state) {
          case "growing":
            return await awaitGrowth(disk.space.totalBytes, fromGb, step.toGb, false);
          case "refused":
            return limitAnswer(toGb, step.reason, `This computer's disk can't grow to ${toGb} GB: ${step.wayOut}`);
          case "busy":
            return { state: "busy", message: "Something the restart would cut runs on this computer (a command in a terminal, a lane's setup, a copy or a move, or a chat waiting on a person's answer). The grow restarts the computer, so ADE didn't grow it. Try again once that's done." };
          case "changed":
            return { state: "unavailable", message: "Your computers' disk kept changing while ADE grew this one. Try again in a moment." };
          case "unsaved":
            return { state: "unavailable", message: "This computer's disk is too full for ADE to note the grow before the restart. Free a little space (or Clear caches in Settings › ADE Cloud), then try again." };
          case "unavailable":
            return { state: "unavailable", message: "This computer can't reach ADE Cloud right now, so it didn't grow the disk." };
        }
      } catch (error) {
        failedAt = now();
        const message = error instanceof Error ? error.message : String(error);
        deps.logger?.warn("cloud.disk_grow_to_fit_failed", { origin: ask.origin, error: message });
        return { state: "unavailable", message: `ADE couldn't grow this computer's disk right now (${message.replace(/[.\s]+$/, "")}). Try again in a minute.` };
      } finally {
        inFlight = false;
      }
    },
    /**
     * A grow another path asks for (the lane's size-change job, from the
     * Android pane's Grow the disk): the same note as this grower's own, so
     * the restart reads as a disk grow and continues the turns it cuts.
     */
    noteOutsideGrow(toGb: number, jobId: string | null): boolean {
      const disk = measure();
      if (!disk) return false;
      return writeState({ v: 1, state: "growing", origin: "person", toGb: Math.ceil(toGb), at: now(), instanceId: deps.instanceId, fromBytes: disk.space.totalBytes, ...(jobId ? { jobId } : {}) });
    },
    /**
     * The chats the last boot's grow told before its restart, and what to
     * tell them now that the computer is back: the disk it has now. Null when
     * there's nothing to tell. `noticesSent` clears them from the state file.
     */
    afterRestart(): {
      chats: CloudDiskGrowChat[];
      grew: boolean | null;
      cardId: string | null;
      fromGb: number | null;
      toGb: number;
      reason: string | null;
      freeGb: number | null;
    } | null {
      if (!toldBeforeRestart || toldBeforeRestart.state !== "growing") return null;
      const chats = (toldBeforeRestart.chats ?? []).filter((chat) => typeof chat?.chatSessionId === "string" && chat.chatSessionId.trim());
      if (!chats.length) return null;
      const space = readDiskSpace(deps.path);
      const grew = space && toldBeforeRestart.fromBytes != null ? space.totalBytes > toldBeforeRestart.fromBytes + GREW_MARGIN_BYTES : null;
      return {
        chats,
        grew,
        cardId: toldBeforeRestart.cardId ?? null,
        fromGb: toldBeforeRestart.fromGb ?? null,
        toGb: toldBeforeRestart.toGb,
        reason: toldBeforeRestart.reason ?? null,
        freeGb: space ? gbOneDecimal(space.freeBytes) : null,
      };
    },
    /** The after-restart notices went out: the state keeps its cooldown, without the chats. */
    noticesSent(): void {
      const current = readCloudDiskGrowState(stateFile, deps.instanceId);
      if (current?.state !== "growing" || !toldBeforeRestart || current.at !== toldBeforeRestart.at) return;
      const { chats: _told, cardId: _card, ...rest } = current;
      writeState(rest);
    },
    /**
     * Whether the disk is close enough to the guard's stop line that the grow
     * shouldn't wait for the idle point: a local `statfs`, no server call.
     * False while a refused, started or failed grow still holds.
     */
    growDueNow(): boolean {
      if (inFlight || holding()) return false;
      const disk = measure();
      return disk != null && isUrgentDiskPressure(disk.pressure);
    },
    /**
     * The lane launches' side of a setup that fills the disk
     * (`ChatLaunchEnvironmentDisk`). Each run keeps a small reserve on the
     * disk, freed just before the launch writes its grow mark, so the mark
     * lands even on a full disk. An ENOSPC grows only when this disk really
     * ran short (by the lowest free space the run read), and a launch grows
     * again only when its run's peak use passed the last grown run's (a grow
     * that didn't help won't help twice), four times at most. A grow counts
     * toward that only once the launch's mark is saved (`makeRoom`).
     */
    setupDisk(stillIdle: () => boolean | Promise<boolean>): ChatLaunchEnvironmentDisk {
      return {
        setupStarting({ launchId }) {
          stopSampling(setupRuns.get(launchId));
          const startFree = readDiskSpace(deps.path)?.freeBytes ?? null;
          const run: SetupRun = { startFree, lowFree: startFree, sampler: null };
          run.sampler = setInterval(() => noteLow(run, readDiskSpace(deps.path)?.freeBytes), SETUP_SAMPLE_MS);
          run.sampler.unref?.();
          setupRuns.set(launchId, run);
          keepReserve(launchId);
        },
        setupEnded({ launchId }) {
          pendingGrows.delete(launchId);
          stopSampling(setupRuns.get(launchId));
          setupRuns.delete(launchId);
          freeReserve(launchId);
        },
        diskFull({ launchId, error }) {
          const space = readDiskSpace(deps.path);
          const run = setupRuns.get(launchId);
          stopSampling(run);
          const startFree = run?.startFree ?? null;
          const line = safeExcerpt(diskFullLine(error));
          if (!space) return { grow: false, error };
          // The lowest the disk read during the run: a failed install that cleaned up after itself reads roomy now.
          if (run) noteLow(run, space.freeBytes);
          const lowFree = Math.min(run?.lowFree ?? space.freeBytes, space.freeBytes);
          const pressure = pressureOf({ freeBytes: lowFree, totalBytes: space.totalBytes });
          const short = lowFree < SETUP_SHORT_FREE_BYTES
            || lowFree / space.totalBytes < SETUP_SHORT_FREE_FRACTION
            || pressure !== "normal";
          const usedBytes = startFree == null ? null : Math.max(0, startFree - lowFree);
          const peakBytes = space.totalBytes - lowFree;
          if (rollbacks.size) saveHistory(currentHistory());
          const history = currentHistory();
          const before = history[launchId];
          const log = { launchId, freeMb: Math.round(space.freeBytes / 2 ** 20), lowMb: Math.round(lowFree / 2 ** 20), totalMb: Math.round(space.totalBytes / 2 ** 20), pressure, usedMb: usedBytes == null ? null : Math.round(usedBytes / 2 ** 20), peakMb: Math.round(peakBytes / 2 ** 20), grows: before?.grows ?? 0, line };
          if (!short) {
            deps.logger?.info("cloud.setup_disk_full_not_short", log);
            return { grow: false, error: `Setup said there's no space left on the device, but this computer's disk kept at least ${gb(lowFree)} free during setup, so ADE didn't grow it (a tool's own limit or a full inode table says the same).${line ? ` Last error: ${line}` : ""} Fix that, then retry.` };
          }
          if (before && (before.grows >= SETUP_MAX_GROWS || peakBytes <= before.peakBytes)) {
            deps.logger?.info("cloud.setup_disk_full_no_regrow", log);
            return { grow: false, error: `Setup filled this computer's disk again after it grew to ${gb(space.totalBytes)}, and another step wouldn't help. Free some space (or use Clear caches in Settings > ADE Cloud), or make the setup lighter, then retry.` };
          }
          // The reserve goes now, so the launch's mark (and the grow's own notes) have room on a full disk.
          freeReserve(launchId);
          pendingGrows.set(launchId, { grows: (before?.grows ?? 0) + 1, peakBytes });
          deps.logger?.info("cloud.setup_disk_full_grow", log);
          return { grow: true };
        },
        async makeRoom({ launchId, signal, onAsking }) {
          // The launch's mark is saved: only now does this grow count toward the next one's rule.
          const pending = pendingGrows.get(launchId);
          pendingGrows.delete(launchId);
          if (!pending) return null;
          const history = currentHistory();
          const before = history[launchId];
          if (!saveHistory({ ...history, [launchId]: { ...pending, at: now() } })) {
            return { state: "refused", error: LANE_SETUP_NO_ROOM_TO_SAVE_ERROR };
          }
          const room = await grower.makeRoomForSetup({ stillIdle, signal, ...(onAsking ? { onAsking } : {}) });
          // A grow that never started (refused by the plan, busy, cancelled) isn't one:
          // a Retry after the person makes room must grow again, not read "another step wouldn't help".
          if (room?.state !== "growing") {
            rollbacks.set(launchId, before ?? null);
            saveHistory(currentHistory());
          }
          return room;
        },
      };
    },
  };
  return grower;
}
