import {
  PROJECT_CONFIG_CHANGED_ON_DISK,
  type OpenProjectBinding,
  type ProjectConfigFile,
  type ProjectConfigSnapshot,
} from "../../shared/types";
import { parseCodedErrorMessage } from "../../shared/codedError";

const MAX_ATTEMPTS = 3;

/**
 * Read `.ade/local.yaml`, apply `edit`, and save the result. The save names the
 * file it was edited from, so an edit made outside ADE between the read and
 * the write (an editor, an agent) is never written over: the brain refuses the
 * stale copy and this reads again and re-applies `edit` to the new file.
 *
 * `edit` may run more than once; keep it a pure function of the snapshot.
 * `pin` routes both the read and the save to the machine that owns the project.
 */
export async function saveProjectLocalConfig(
  edit: (snapshot: ProjectConfigSnapshot) => ProjectConfigFile,
  pin?: OpenProjectBinding | null,
): Promise<ProjectConfigSnapshot> {
  for (let attempt = 1; ; attempt += 1) {
    const snapshot = await window.ade.projectConfig.get(pin);
    // A snapshot without a hash (an older host) saves as is, as before.
    const baseLocalHash = typeof snapshot.trust?.localHash === "string" ? snapshot.trust.localHash : undefined;
    try {
      return await window.ade.projectConfig.save({
        shared: snapshot.shared,
        local: edit(snapshot),
        ...(baseLocalHash !== undefined ? { baseLocalHash } : {}),
      }, pin);
    } catch (error) {
      const parsed = parseCodedErrorMessage(error);
      if (parsed.code !== PROJECT_CONFIG_CHANGED_ON_DISK) throw error;
      // Out of retries: say it plainly, without the IPC wrapper and code.
      if (attempt >= MAX_ATTEMPTS) throw new Error(parsed.message);
    }
  }
}
