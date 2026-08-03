import fs from "node:fs";
import path from "node:path";

/**
 * Creates a directory link without requiring Windows Developer Mode or an
 * elevated test process. Junctions preserve the realpath/containment contract
 * exercised by these tests while remaining available to ordinary users.
 */
export function createTestDirectoryLink(target: string, linkPath: string): void {
  fs.symlinkSync(
    process.platform === "win32" ? path.resolve(target) : target,
    linkPath,
    process.platform === "win32" ? "junction" : "dir",
  );
}

/**
 * Windows can briefly retain SQLite and filesystem handles after close. Use
 * Node's bounded recursive-rm retry support, and let the final error fail the
 * test instead of hiding a leaked handle.
 */
export async function removeTestTree(target: string): Promise<void> {
  await fs.promises.rm(target, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}
