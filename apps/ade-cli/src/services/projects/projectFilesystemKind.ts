import fs from "node:fs";
import path from "node:path";

/** File systems whose reads go over a network (or a user-space bridge to one). */
const NETWORK_FS_TYPES = new Set([
  "nfs", "nfs4", "cifs", "smb3", "smbfs", "9p", "ceph", "glusterfs", "lustre", "gpfs", "beegfs", "afs",
  "fuse.sshfs", "fuse.s3fs", "fuse.gcsfuse", "fuse.rclone", "fuse.juicefs", "fuse.glusterfs", "fuse.cephfs",
]);

export type ProjectFilesystemKind = {
  /** `network`, `fuse` (a user-space file system of unknown kind), `local`, or `unknown`. */
  kind: "network" | "fuse" | "local" | "unknown";
  /** The mount's type as the kernel names it (`nfs4`, `ext4`), or null off Linux. */
  fsType: string | null;
};

/** Undo the octal escapes (`\040` for a space) `/proc/self/mountinfo` uses. */
function unescapeMountPath(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

/**
 * What file system a project folder lives on, for the slow-open log line.
 * Linux only: one read of `/proc/self/mountinfo`, matched against the
 * folder's real path. Elsewhere, and on any failure, it says `unknown`. Read
 * only when an open was already slow, never on the normal path.
 */
export function projectFilesystemKind(
  projectRoot: string,
  deps: { platform?: NodeJS.Platform; readMountInfo?: () => string; realpath?: (target: string) => string } = {},
): ProjectFilesystemKind {
  if ((deps.platform ?? process.platform) !== "linux") return { kind: "unknown", fsType: null };
  try {
    const mountInfo = (deps.readMountInfo ?? (() => fs.readFileSync("/proc/self/mountinfo", "utf8")))();
    const target = (deps.realpath ?? ((value: string) => fs.realpathSync.native(value)))(projectRoot);
    let best: { mountPoint: string; fsType: string } | null = null;
    for (const line of mountInfo.split("\n")) {
      const separator = line.indexOf(" - ");
      if (separator < 0) continue;
      const mountPoint = unescapeMountPath(line.slice(0, separator).split(" ")[4] ?? "");
      const fsType = line.slice(separator + 3).split(" ")[0] ?? "";
      if (!mountPoint || !fsType) continue;
      const inside = target === mountPoint
        || target.startsWith(mountPoint.endsWith(path.sep) ? mountPoint : `${mountPoint}${path.sep}`);
      if (inside && (!best || mountPoint.length > best.mountPoint.length)) best = { mountPoint, fsType };
    }
    if (!best) return { kind: "unknown", fsType: null };
    const fsType = best.fsType.slice(0, 40);
    if (NETWORK_FS_TYPES.has(fsType)) return { kind: "network", fsType };
    if (fsType === "fuse" || fsType.startsWith("fuse.")) return { kind: "fuse", fsType };
    return { kind: "local", fsType };
  } catch {
    return { kind: "unknown", fsType: null };
  }
}
