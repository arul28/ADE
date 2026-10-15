import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { readVolumeSpace } from "../../../../../desktop/src/main/services/storage/volume";
import type { ProjectMoveVolume } from "../../../../../desktop/src/shared/types/projectMove";

const execFileAsync = promisify(execFile);

/** The nearest folder of `target` that exists: a destination is usually not created yet. */
export function nearestExistingDir(target: string): string {
  let current = path.resolve(target);
  for (;;) {
    try {
      if (fs.statSync(current).isDirectory()) return current;
    } catch {
      // keep walking up
    }
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

async function mountPointOf(target: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("/bin/df", ["-P", nearestExistingDir(target)], { timeout: 10_000 });
    const line = stdout.trim().split("\n").at(-1) ?? "";
    // The mount point is everything after the 5th column; it may hold spaces.
    const match = line.match(/^\S+\s+\d+\s+\d+\s+\d+\s+\d+%\s+(.+)$/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

type DiskutilInfo = {
  VolumeName?: string;
  VolumeUUID?: string;
  Internal?: boolean;
  FilesystemType?: string;
  FilesystemUserVisibleName?: string;
  MountPoint?: string;
};

async function diskutilInfo(mountPoint: string): Promise<DiskutilInfo | null> {
  try {
    const { stdout } = await execFileAsync("/usr/sbin/diskutil", ["info", "-plist", mountPoint], {
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const { stdout: json } = await new Promise<{ stdout: string }>((resolve, reject) => {
      const child = execFile("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], { timeout: 10_000 }, (error, out) => {
        if (error) reject(error);
        else resolve({ stdout: out });
      });
      child.stdin?.end(stdout);
    });
    return JSON.parse(json) as DiskutilInfo;
  } catch {
    return null;
  }
}

/**
 * The volume a path lives on, or would live on once created. macOS only:
 * other platforms return null and the move refuses to start.
 */
export async function readMoveVolume(target: string): Promise<ProjectMoveVolume | null> {
  if (process.platform !== "darwin") return null;
  const mountPath = await mountPointOf(target);
  if (!mountPath) return null;
  const info = await diskutilInfo(mountPath);
  // Zeros when unreadable: the space check then blocks with a clear message.
  const { freeBytes, totalBytes } = readVolumeSpace(nearestExistingDir(target)) ?? { freeBytes: 0, totalBytes: 0 };
  const internal = info?.Internal === true;
  const visible = info?.FilesystemUserVisibleName ?? "";
  return {
    mountPath,
    name: internal ? "This Mac" : info?.VolumeName || path.basename(mountPath),
    uuid: info?.VolumeUUID ?? null,
    freeBytes,
    totalBytes,
    internal,
    fileSystem: (info?.FilesystemType ?? "").toLowerCase(),
    caseSensitive: /case-sensitive/i.test(visible),
    suggestedFolder: internal ? path.join(os.homedir(), "Projects") : path.join(mountPath, "Projects"),
  };
}

/** Mounted volumes other than system ones, for the destination picker. */
export async function listMoveVolumes(): Promise<ProjectMoveVolume[]> {
  if (process.platform !== "darwin") return [];
  const candidates = ["/System/Volumes/Data"];
  try {
    for (const name of fs.readdirSync("/Volumes")) {
      const full = path.join("/Volumes", name);
      try {
        // "/Volumes/Macintosh HD" is a link to "/"; skip links.
        if (fs.lstatSync(full).isDirectory()) candidates.push(full);
      } catch {
        // gone between readdir and lstat
      }
    }
  } catch {
    // no /Volumes
  }
  const volumes = await Promise.all(candidates.map((candidate) => readMoveVolume(candidate)));
  const seen = new Set<string>();
  return volumes.filter((volume): volume is ProjectMoveVolume => {
    if (!volume || seen.has(volume.mountPath)) return false;
    seen.add(volume.mountPath);
    // Simulator runtimes, installers and other read-only images mount here too.
    return volume.mountPath === "/System/Volumes/Data" || isWritableDir(volume.mountPath);
  });
}

function isWritableDir(dir: string): boolean {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}
