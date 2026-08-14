import { openKvDb } from "../state/kvDb";
import type { Logger } from "../logging/logger";
import { resolveAdeLayout } from "../../../shared/adeLayout";

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
}
