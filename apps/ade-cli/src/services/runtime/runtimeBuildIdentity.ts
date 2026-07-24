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
