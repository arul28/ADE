import path from "node:path";
import { estimateInstalledToolBytes, type FreeSpaceReader } from "./diskSpace";
import { ToolError } from "./errors";
import { acquireToolLock, type ToolLockOptions } from "./lock";
import type { ToolTargetPin, ToolsManifest } from "./manifest";
import { type ToolsRootLayout, toolsLockRoot, toolUsageRoot } from "./paths";
import { makeRoomInSystemCache } from "./systemCache";
import { warnTools } from "./toolsLog";

/**
 * Which root a tool installs into. The primary root, unless it has a budget
 * (a system cache) that cannot make room for this tool, or its disk is full:
 * then the fallback root. Without a fallback this is the plain primary install.
 *
 * Making room is one at a time, across this process (a queue) and across
 * processes (a lock beside the tools' own locks), so two evictions never
 * count the same removed folder. A tool this process is still installing
 * into the budget holds its size reserved until it lands, so two installs at
 * once can't both pass against the same free bytes. (Another process's
 * install in progress is counted only by what it has written so far.)
 */
let makeRoomQueue: Promise<unknown> = Promise.resolve();
let reservedBytes = 0;

function budgetLockPath(primary: string): string {
  return path.join(toolsLockRoot(primary), "system-cache-budget.lock");
}

async function reserveRoom(args: {
  layout: ToolsRootLayout;
  budget: NonNullable<ToolsRootLayout["budget"]>;
  manifest: ToolsManifest;
  keepDir: string;
  needBytes: number;
  freeBytes?: FreeSpaceReader;
  lock?: Pick<ToolLockOptions, "staleMs" | "pollIntervalMs" | "timeoutMs" | "now" | "sleep">;
}): Promise<boolean> {
  const run = makeRoomQueue.then(async () => {
    const acquisition = await acquireToolLock({ ...args.lock, lockPath: budgetLockPath(args.layout.primary) });
    if (acquisition.kind !== "acquired") return false;
    try {
      const fits = await makeRoomInSystemCache({
        root: args.budget.root,
        budgetBytes: args.budget.bytes,
        needBytes: args.needBytes + reservedBytes,
        manifest: args.manifest,
        keepDir: args.keepDir,
        usageRoot: toolUsageRoot(args.layout),
        freeBytes: args.freeBytes,
        log: (event, fields) => warnTools(event, fields),
      });
      if (fits) reservedBytes += args.needBytes;
      return fits;
    } finally {
      await acquisition.release();
    }
  });
  makeRoomQueue = run.catch(() => undefined);
  return await run;
}

export async function installIntoBestRoot(args: {
  name: string;
  layout: ToolsRootLayout;
  manifest: ToolsManifest;
  targetPin: ToolTargetPin;
  /** The version's folder under the primary root: never evicted to make room for itself. */
  primaryDir: string;
  freeBytes?: FreeSpaceReader;
  lock?: Pick<ToolLockOptions, "staleMs" | "pollIntervalMs" | "timeoutMs" | "now" | "sleep">;
  installAt: (root: string) => Promise<void>;
}): Promise<void> {
  const { layout } = args;
  const fallback = layout.fallback;
  if (!fallback) {
    await args.installAt(layout.primary);
    return;
  }
  const budget = layout.budget;
  const needBytes = budget ? estimateInstalledToolBytes(args.targetPin) : 0;
  let fits = true;
  if (budget) {
    try {
      fits = await reserveRoom({
        layout,
        budget,
        manifest: args.manifest,
        keepDir: args.primaryDir,
        needBytes,
        freeBytes: args.freeBytes,
        lock: args.lock,
      });
    } catch (error) {
      warnTools("tools.system_cache_make_room_failed", {
        tool: args.name,
        // The typed kind is the diagnosis; a message can carry local paths.
        kind: error instanceof ToolError ? error.kind : (error as NodeJS.ErrnoException | null)?.code ?? "unknown",
      });
      fits = false;
    }
  }
  if (!fits) {
    warnTools("tools.system_cache_full", { tool: args.name, fallback: "home" });
    await args.installAt(fallback);
    return;
  }
  try {
    await args.installAt(layout.primary);
  } catch (error) {
    // The system layer's own disk filled up under its budget: the home disk still may not be.
    if (!(error instanceof ToolError && error.kind === "disk-space")) throw error;
    warnTools("tools.system_cache_disk_full", { tool: args.name, fallback: "home" });
    await args.installAt(fallback);
  } finally {
    if (budget) reservedBytes = Math.max(0, reservedBytes - needBytes);
  }
}
