import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Whether this host can create a file symlink. Windows needs Developer Mode or
 * an elevated token (SeCreateSymbolicLinkPrivilege); without it `fs.symlinkSync`
 * throws EPERM. Tests that plant a symlink guard on this instead of failing
 * before their first assertion. The probe is honest rather than a platform
 * check so an elevated Windows CI runner still runs those tests.
 */
export const symlinksSupported = process.platform !== "win32" ? true : probeSymlinks();

function probeSymlinks(): boolean {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-symlink-probe-"));
  try {
    fs.writeFileSync(path.join(root, "target"), "");
    fs.symlinkSync(path.join(root, "target"), path.join(root, "link"));
    return true;
  } catch {
    return false;
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // Best effort: the setup file's temp tracker also cleans this up.
    }
  }
}
