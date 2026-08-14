import fs from "node:fs";
import path from "node:path";
import { openKvDb } from "../state/kvDb";
import type { Logger } from "../logging/logger";
import { resolveAdeLayout } from "../../../shared/adeLayout";

const FIRST_OPEN_STABILITY_MARKER = "first-open-stability";

function firstOpenStabilityMarkerPath(projectRoot: string): string {
  return path.join(resolveAdeLayout(projectRoot).cacheDir, FIRST_OPEN_STABILITY_MARKER);
}

/**
 * Remember that this machine has never completed a real project bind, even
 * after scaffold warms `ade.db`. Packaged first-open still throttles
 * background tasks on the following bind.
 */
export function markFirstOpenStability(projectRoot: string): void {
  const { cacheDir } = resolveAdeLayout(projectRoot);
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, FIRST_OPEN_STABILITY_MARKER), "");
}

/** True when scaffold asked the next bind to stay in first-open stability mode. */
export function consumeFirstOpenStabilityMarker(projectRoot: string): boolean {
  const markerPath = firstOpenStabilityMarkerPath(projectRoot);
  if (!fs.existsSync(markerPath)) return false;
  try {
    fs.unlinkSync(markerPath);
  } catch {
    // Keep treating this bind as first-open even if unlink fails.
  }
  return true;
}

/**
 * Open (creating if needed) and immediately close `ade.db` so first project
 * bind does not pay schema setup on the Work paint path.
 */
export async function ensureProjectLocalDatabase(
  projectRoot: string,
  logger: Logger,
): Promise<void> {
  const { dbPath } = resolveAdeLayout(projectRoot);
  const db = await openKvDb(dbPath, logger);
  db.close();
  markFirstOpenStability(projectRoot);
}
