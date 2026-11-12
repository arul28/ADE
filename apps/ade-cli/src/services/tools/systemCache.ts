import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import type { ToolsManifest } from "./manifest";
import { SYSTEM_CACHE_TOOLS_DIR, TOOL_INSTALL_SENTINEL } from "./paths";
import { readToolUsage } from "./usage";

/**
 * The budget of a cache folder that is not the person's disk
 * (`ADE_SYSTEM_CACHE_ROOT`, an ADE Cloud computer's system layer).
 *
 * Only rebuildable things live there: ADE's tool downloads under `tools/`,
 * and package caches the machine image points there (npm, pip, ...). Before
 * a tool installs, the folder must fit it within the budget; the least
 * recently used entries go first. A tool that ran in the last
 * {@link RECENT_USE_PROTECT_MS} is never removed (a running agent may still
 * load files from it). What still does not fit goes to the per-user cache.
 *
 * Runs only right before an install, never on a timer, so it costs nothing
 * on an idle computer.
 */
export const RECENT_USE_PROTECT_MS = 24 * 60 * 60_000;

type Candidate = { dir: string; bytes: number; lastUsedAt: number };

/** Bytes under `dir`, files only, symlinks not followed. Unreadable entries count as zero. */
export async function directoryBytes(dir: string): Promise<number> {
  let total = 0;
  const pending = [dir];
  while (pending.length) {
    const current = pending.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(full);
      } else if (entry.isFile()) {
        try {
          total += (await fsp.lstat(full)).size;
        } catch {
          // Gone between the listing and the stat.
        }
      }
    }
  }
  return total;
}

function mtimeMs(target: string): number {
  try {
    return fs.statSync(target).mtimeMs;
  } catch {
    return 0;
  }
}

/** Package name -> tool name, for the packages this build pins. */
function packageTools(manifest: ToolsManifest): Map<string, string> {
  const out = new Map<string, string>();
  for (const tool of manifest.tools) {
    for (const target of Object.values(tool.targets)) {
      if (target) out.set(target.package, tool.name);
    }
  }
  return out;
}

/** Every finished `<package>/<version>` install under the tools folder. */
function installedVersionDirs(toolsRoot: string): Array<{ dir: string; packageName: string }> {
  const out: Array<{ dir: string; packageName: string }> = [];
  const visitPackage = (packageDir: string, packageName: string) => {
    let versions: fs.Dirent[];
    try {
      versions = fs.readdirSync(packageDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const version of versions) {
      const dir = path.join(packageDir, version.name);
      if (version.isDirectory() && fs.existsSync(path.join(dir, TOOL_INSTALL_SENTINEL))) out.push({ dir, packageName });
    }
  };
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(toolsRoot, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const full = path.join(toolsRoot, entry.name);
    if (entry.name.startsWith("@")) {
      let scoped: fs.Dirent[];
      try {
        scoped = fs.readdirSync(full, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const inner of scoped) {
        if (inner.isDirectory()) visitPackage(path.join(full, inner.name), `${entry.name}/${inner.name}`);
      }
    } else {
      visitPackage(full, entry.name);
    }
  }
  return out;
}

/**
 * Make room for `needBytes` in the budgeted folder. Resolves true when the
 * folder then fits it within the budget, false when it cannot (the caller
 * installs elsewhere). `keepDir` is never removed (the version being installed).
 */
export async function makeRoomInSystemCache(args: {
  root: string;
  budgetBytes: number;
  needBytes: number;
  manifest: ToolsManifest;
  keepDir: string;
  /** Where the record of tool use lives (`toolUsageRoot`). */
  usageRoot: string;
  now?: number;
  log?: (event: string, fields: Record<string, unknown>) => void;
}): Promise<boolean> {
  const now = args.now ?? Date.now();
  if (args.needBytes > args.budgetBytes) return false;
  let used = await directoryBytes(args.root);
  if (used + args.needBytes <= args.budgetBytes) return true;

  const toolsRoot = path.join(args.root, SYSTEM_CACHE_TOOLS_DIR);
  const usage = readToolUsage(args.usageRoot);
  const toolOfPackage = packageTools(args.manifest);
  const candidates: Candidate[] = [];
  for (const { dir, packageName } of installedVersionDirs(toolsRoot)) {
    if (path.resolve(dir) === path.resolve(args.keepDir)) continue;
    const tool = toolOfPackage.get(packageName);
    // The install time, unless the tool ran since.
    const lastUsedAt = Math.max(tool ? usage[tool] ?? 0 : 0, mtimeMs(path.join(dir, TOOL_INSTALL_SENTINEL)));
    if (tool && usage[tool] !== undefined && now - usage[tool]! < RECENT_USE_PROTECT_MS) {
      // A recently used tool keeps its current copy; a superseded version of it can go.
      const pinned = args.manifest.tools.find((entry) => entry.name === tool);
      const current = pinned && Object.values(pinned.targets).some((target) => target && path.basename(dir) === target.version);
      if (current) continue;
    }
    candidates.push({ dir, bytes: await directoryBytes(dir), lastUsedAt });
  }
  // Other rebuildable caches the image put here (npm, pip, ...), whole, by their own time.
  let others: fs.Dirent[] = [];
  try {
    others = await fsp.readdir(args.root, { withFileTypes: true });
  } catch {
    others = [];
  }
  for (const entry of others) {
    if (entry.name === SYSTEM_CACHE_TOOLS_DIR || !entry.isDirectory()) continue;
    const dir = path.join(args.root, entry.name);
    candidates.push({ dir, bytes: await directoryBytes(dir), lastUsedAt: mtimeMs(dir) });
  }

  candidates.sort((left, right) => left.lastUsedAt - right.lastUsedAt);
  for (const candidate of candidates) {
    if (used + args.needBytes <= args.budgetBytes) break;
    try {
      await fsp.rm(candidate.dir, { recursive: true, force: true });
      used -= candidate.bytes;
      args.log?.("tools.system_cache_evicted", { dir: candidate.dir, bytes: candidate.bytes });
    } catch {
      // In use or unreadable: try the next one.
    }
  }
  return used + args.needBytes <= args.budgetBytes;
}
