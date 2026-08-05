import { spawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import { resolveTrustedWindowsTool } from "../../lib/trustedWindowsTools";
import { ToolError } from "./errors";

export type ToolExtractor = (archivePath: string, destDir: string) => Promise<void>;

/**
 * Resolve the `tar` to run. On Windows this must be System32's bsdtar by
 * absolute path — a PATH-planted `tar.exe` would otherwise get to unpack a
 * 300 MB archive with our privileges.
 */
function resolveTarCommand(platform: NodeJS.Platform): string {
  return platform === "win32" ? resolveTrustedWindowsTool("tar") : "tar";
}

/**
 * Unpack an npm tarball into `destDir`.
 *
 * Uses the system `tar` for the same reason `commands/brainUpdate.ts` does —
 * ADE ships no tar library and adding one to unpack a 300 MB binary would cost
 * more than it saves. `--strip-components 1` drops npm's `package/` root so the
 * destination mirrors what a `node_modules/<pkg>` directory looks like.
 *
 * Async on purpose: this runs inside the long-lived brain, where a synchronous
 * multi-hundred-megabyte extraction would stall every other session.
 */
export const extractNpmTarball: ToolExtractor = async (archivePath, destDir) => {
  await fsp.mkdir(destDir, { recursive: true });
  const command = resolveTarCommand(process.platform);
  const args = ["-xzf", archivePath, "-C", destDir, "--strip-components", "1"];

  const failure = await new Promise<string | null>((resolve) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      // Keep the tail only; a corrupt archive can produce megabytes of noise.
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4096);
    });
    child.on("error", (error) => resolve(error.message));
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve(null);
        return;
      }
      const reason = signal ? `signal ${signal}` : `exit code ${code}`;
      resolve(stderr.trim() || `tar failed with ${reason}`);
    });
  });

  if (failure) {
    throw new ToolError(`Failed to unpack ${archivePath}: ${failure}`, { kind: "extract" });
  }
};
