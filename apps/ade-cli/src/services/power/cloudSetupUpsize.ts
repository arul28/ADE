/**
 * Moves an ADE Cloud computer from Small to Medium when a lane launch's setup
 * runs out of memory on it (`CLOUD_AUTO_SIZE`), the way `cloudDiskGrow.ts`
 * grows its disk when setup fills it: the launch waits, the computer
 * restarts at the new size, and the launch's setup runs again
 * (`chatLaunchService`'s room mark). One step, once per launch.
 *
 * Only for a server launch whose size was ADE's default (nobody picked one);
 * the server decides that from the launch's own record, and checks hours,
 * the wake rules and the size's disk as for any resize. A move it refuses
 * fails setup with the memory guard's sentence and why the size stayed. A
 * move that didn't start is not counted (the history entry goes back), and
 * the server records the launch and the repository only with a resize that
 * really started, so a refused one never makes later launches start at Medium.
 *
 * This is ADE's launch machinery acting on the person's launch, like the
 * disk grow: it goes through the account server's resize with the
 * computer's own account sign-in, never through `cloud.resize`, which stays
 * the person's alone.
 */

import fs from "node:fs";
import path from "node:path";
import {
  CLOUD_AUTO_SIZE,
  cloudAutoSizeRefusalSentence,
  cloudAutoSizeSentence,
} from "../../../../account-directory/src/cloud/contract";
import { cloudCatalogOf } from "../../../../desktop/src/shared/adeCloud";
import { cloudTier } from "../../../../desktop/src/shared/cloudTiers";
import type { CloudProvider } from "../../../../desktop/src/main/services/adeCloud/cloudProvider";
import { CloudProviderError } from "../../../../desktop/src/main/services/adeCloud/cloudProvider";
import type {
  ChatLaunchEnvironmentDisk,
  ChatLaunchEnvironmentRoom,
} from "../../../../desktop/src/main/services/chat/chatLaunchService";
import { cloudDiskGrowStatePath } from "./cloudDiskGuard";

/** A computer with at most this much memory is a Small (4 GB reads as ~3.8 GB). */
const SMALL_MAX_MEMORY_MB = 6 * 1024;
/** The move landed once memory reads this much more than before (8 GB reads as ~7.7). */
const MOVED_MARGIN_MB = 1024;
/** A move is waited on this long while this brain still runs (the restart it brings ends the wait sooner). */
const MOVE_WAIT_MS = 10 * 60_000;
const MOVE_POLL_MS = 5_000;
/** A launch's move history goes after this long (no launch's setup waits a day). */
const HISTORY_TTL_MS = 24 * 60 * 60_000;

type MoveHistory = Record<string, number>;
type Logger = { info(event: string, data?: unknown): void; warn(event: string, data?: unknown): void };

function readMemTotalMb(): number | null {
  try {
    const match = /^MemTotal:\s+(\d+)\s*kB/m.exec(fs.readFileSync("/proc/meminfo", "utf8"));
    return match ? Math.round(Number(match[1]) / 1024) : null;
  } catch {
    return null;
  }
}

const trimEnd = (text: string): string => text.replace(/[.\s]+$/, "");

export function createCloudSetupUpsizer(deps: {
  instanceId: string;
  client: () => Promise<CloudProvider | null>;
  /** The brain's `$ADE_HOME`: the move history sits beside the disk grow's notes. */
  adeHome: string;
  logger?: Logger;
  now?: () => number;
  /** This computer's memory in MB (`/proc/meminfo`), or null when unreadable. */
  memTotalMb?: () => number | null;
  /**
   * The server launch's record (`GET /cloud/launches/:id`), read before the
   * ask: null when the account server has no such launch (a launch made on
   * this computer, not by the server launcher). A size that wasn't ADE's
   * default stays without asking, and an account server too old to keep the
   * choice never sees a move it couldn't check.
   */
  readLaunch?: (launchId: string) => Promise<{ request: { sizeChoice?: string | null } | null } | null>;
}) {
  const now = deps.now ?? (() => Date.now());
  const memTotalMb = deps.memTotalMb ?? readMemTotalMb;
  const historyFile = path.join(path.dirname(cloudDiskGrowStatePath(deps.adeHome)), "setup-memory-moves.json");

  const readHistory = (): MoveHistory => {
    try {
      const parsed = JSON.parse(fs.readFileSync(historyFile, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const out: MoveHistory = {};
      for (const [launchId, at] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof at === "number" && now() - at < HISTORY_TTL_MS) out[launchId] = at;
      }
      return out;
    } catch {
      return {};
    }
  };

  const writeHistory = (history: MoveHistory): boolean => {
    const tmp = `${historyFile}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(historyFile), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(history), { mode: 0o600 });
      fs.renameSync(tmp, historyFile);
      return true;
    } catch (error) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
      deps.logger?.warn("cloud.setup_upsize_history_write_failed", { error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  };

  /** A move that never started isn't one: a Retry after the person fixed the reason may move it. */
  const takeBack = (launchId: string): void => {
    const history = readHistory();
    if (!(launchId in history)) return;
    delete history[launchId];
    writeHistory(history);
  };

  /** Resolves true once memory reads bigger than `fromMb`, false at the wait's end or on abort. */
  const waitForMove = (fromMb: number, signal: AbortSignal): Promise<boolean> => new Promise((resolve) => {
    const startedAt = now();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (moved: boolean) => {
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(moved);
    };
    const onAbort = () => finish(false);
    const check = () => {
      const total = memTotalMb();
      if (total != null && total > fromMb + MOVED_MARGIN_MB) return finish(true);
      if (now() - startedAt >= MOVE_WAIT_MS) return finish(false);
      timer = setTimeout(check, MOVE_POLL_MS);
      timer.unref?.();
    };
    if (signal.aborted) return resolve(false);
    signal.addEventListener("abort", onAbort, { once: true });
    check();
  });

  /** Setups that may move, by launch, with the guard's sentence: set by `outOfMemory`, taken by `moreMemory`. */
  const pending = new Map<string, { error: string; fromMb: number }>();

  return {
    /**
     * The lane launches' side of a setup that ran out of memory
     * (`ChatLaunchEnvironmentDisk.outOfMemory` / `moreMemory`). `stillIdle`
     * is the disk grow's own check: a move restarts the computer, so only
     * while nothing but this launch's setup runs.
     */
    setupMemory(stillIdle: () => boolean | Promise<boolean>): Required<Pick<ChatLaunchEnvironmentDisk, "outOfMemory" | "moreMemory">> {
      return {
        outOfMemory({ launchId, error }) {
          const total = memTotalMb();
          if (readHistory()[launchId] != null) {
            deps.logger?.info("cloud.setup_upsize_already_moved", { launchId, totalMb: total });
            return { upsize: false, error: `${trimEnd(error)}. ${cloudAutoSizeRefusalSentence("moved")}` };
          }
          // Already bigger than a Small (picked, or started at Medium): the guard's sentence as it is.
          if (total == null || total > SMALL_MAX_MEMORY_MB) return { upsize: false, error };
          pending.set(launchId, { error, fromMb: total });
          return { upsize: true };
        },
        async moreMemory({ launchId, signal, onAsking }): Promise<ChatLaunchEnvironmentRoom | null> {
          const asked = pending.get(launchId);
          pending.delete(launchId);
          if (!asked) return null;
          const { error, fromMb } = asked;
          const keep = (why: string): ChatLaunchEnvironmentRoom => {
            takeBack(launchId);
            return { state: "refused", error: `${trimEnd(error)}. ${why}` };
          };
          // Counted before the ask, so a restart that comes before the answer still counts it:
          // the next run on this launch never asks again. Unsaved, memory itself says it moved.
          writeHistory({ ...readHistory(), [launchId]: now() });
          /** Set once the move is asked for: an error before it never moved anything. */
          let moveAsked = false;
          try {
            // Unreadable (the network): the server still checks the choice when asked.
            const launch = deps.readLaunch
              ? await deps.readLaunch(launchId).catch((error: unknown) => {
                deps.logger?.warn("cloud.setup_upsize_launch_read_failed", { launchId, error: error instanceof Error ? error.message : String(error) });
                return undefined;
              })
              : undefined;
            // Not a server launch: no move, the guard's sentence.
            if (launch === null) {
              takeBack(launchId);
              return null;
            }
            if (launch) {
              const choice = launch.request?.sizeChoice ?? "picked";
              if (choice !== "default") {
                deps.logger?.info("cloud.setup_upsize_kept", { launchId, reason: choice });
                return keep(cloudAutoSizeRefusalSentence(choice === "capped" ? "capped" : "picked"));
              }
            }
            const client = await deps.client();
            if (!client) {
              takeBack(launchId);
              return null;
            }
            const instance = await client.getInstance(deps.instanceId);
            const small = instance.resources?.cpu === 2 && instance.resources.memory === CLOUD_AUTO_SIZE.fromMemoryGb;
            if (!small) return keep(cloudAutoSizeRefusalSentence("moved"));
            const account = await client.getAccount().catch(() => null);
            const to = cloudTier(cloudCatalogOf(account), CLOUD_AUTO_SIZE.to);
            if (!to) return keep(`ADE Cloud doesn't offer ${CLOUD_AUTO_SIZE.toLabel} right now.`);
            // A move restarts the computer, and work may have started during those reads.
            if (!(await stillIdle())) {
              return keep(`ADE can't move it to ${CLOUD_AUTO_SIZE.toLabel} while something else runs there (a move restarts the computer). Retry once that's done.`);
            }
            if (signal.aborted) {
              takeBack(launchId);
              return null;
            }
            deps.logger?.info("cloud.setup_upsize_asked", { launchId, fromMb });
            // Said (and written down) as it is asked for: the restart often comes before the answer.
            try {
              onAsking?.(cloudAutoSizeSentence("moving"));
            } catch {
              // Only words on a card: never in the move's way.
            }
            moveAsked = true;
            await client.resizeInstance(deps.instanceId, { cpu: to.cpu, memory: to.memoryGb }, { computerIdle: true, origin: "auto", launchId });
            deps.logger?.info("cloud.setup_upsized", { launchId });
            return { state: "growing", detail: cloudAutoSizeSentence("moving"), ready: waitForMove(fromMb, signal) };
          } catch (caught) {
            const message = caught instanceof Error ? caught.message : String(caught);
            if (!moveAsked) {
              deps.logger?.warn("cloud.setup_upsize_failed", { launchId, error: message });
              return keep(`ADE couldn't move it to ${CLOUD_AUTO_SIZE.toLabel} right now (${trimEnd(message)}). Retry to try again.`);
            }
            if (caught instanceof CloudProviderError && caught.code === "size_kept") {
              deps.logger?.info("cloud.setup_upsize_kept", { launchId, reason: caught.detail.reason });
              return keep(message);
            }
            // No answer, or one that came after the provider may have resized: the move may have
            // happened and its restart may be coming. Held as started; the history keeps it to one.
            const lost = !(caught instanceof CloudProviderError)
              || caught.status === 0
              || (caught.status >= 500 && caught.code !== "unavailable");
            if (lost) {
              deps.logger?.warn("cloud.setup_upsize_answer_lost", { launchId, error: message });
              return { state: "growing", detail: cloudAutoSizeSentence("moving"), ready: waitForMove(fromMb, signal) };
            }
            // Out of hours, the wake rules, the size's disk: the server's own sentence.
            deps.logger?.info("cloud.setup_upsize_refused", { launchId, code: caught.code });
            return keep(`ADE couldn't move it to ${CLOUD_AUTO_SIZE.toLabel}: ${trimEnd(message)}.`);
          }
        },
      };
    },
  };
}
