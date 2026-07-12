import fs from "node:fs";
import path from "node:path";

export const MAX_LAUNCHD_LOG_BYTES = 10 * 1024 * 1024;
export const ROTATED_LAUNCHD_LOG_BYTES = 1024 * 1024;

export function copytruncateLogIfOversized(
  filePath: string,
  maxBytes = MAX_LAUNCHD_LOG_BYTES,
  retainedBytes = ROTATED_LAUNCHD_LOG_BYTES,
): boolean {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size <= maxBytes) return false;
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(`${base}.`) || name === `${base}.1`) continue;
      if (/^\d+$/.test(name.slice(base.length + 1))) {
        fs.rmSync(path.join(dir, name), { force: true });
      }
    }
    const fd = fs.openSync(filePath, "r");
    try {
      const keep = Math.min(retainedBytes, stat.size);
      const tail = Buffer.allocUnsafe(keep);
      const bytesRead = fs.readSync(fd, tail, 0, keep, stat.size - keep);
      fs.writeFileSync(`${filePath}.1`, tail.subarray(0, bytesRead));
    } finally {
      fs.closeSync(fd);
    }
    fs.truncateSync(filePath, 0);
    return true;
  } catch (error) {
    try {
      process.stderr.write(`ADE could not bound runtime log ${path.basename(filePath)}: ${error instanceof Error ? error.message : String(error)}\n`);
    } catch {}
    return false;
  }
}

export function boundLaunchdLogs(runtimeDir: string): void {
  for (const name of ["launchd.err.log", "launchd.out.log"]) {
    copytruncateLogIfOversized(path.join(runtimeDir, name));
  }
}
