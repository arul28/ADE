import { createHash } from "node:crypto";
import fs from "node:fs";

export function computeRuntimeBuildHash(filePath: string): string | null {
  try {
    return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  } catch {
    return null;
  }
}

export async function computeRuntimeBuildHashAsync(
  filePath: string,
): Promise<string | null> {
  try {
    return createHash("sha256")
      .update(await fs.promises.readFile(filePath))
      .digest("hex");
  } catch {
    return null;
  }
}

/**
 * A cheap build identity: the version, and the bundle's size and time so two
 * builds of one version still differ. A stat, not a hash of the 30 MB bundle;
 * the restart-loop report compares it at every brain start.
 */
export function computeRuntimeBuildStamp(filePath: string, version: string): string {
  try {
    const stat = fs.statSync(filePath);
    return `${version}+${stat.size}-${Math.round(stat.mtimeMs)}`;
  } catch {
    return version;
  }
}
