import {
  PROJECT_CONFIG_CHANGED_ON_DISK,
  type OpenProjectBinding,
  type ProjectConfigFile,
  type ProjectConfigSnapshot,
} from "../../shared/types";

const MAX_ATTEMPTS = 3;

function changedOnDisk(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.includes(PROJECT_CONFIG_CHANGED_ON_DISK);
}

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
    try {
      return await window.ade.projectConfig.save({
        shared: snapshot.shared,
        local: edit(snapshot),
        baseLocalHash: snapshot.trust.localHash,
      }, pin);
    } catch (error) {
      if (attempt >= MAX_ATTEMPTS || !changedOnDisk(error)) throw error;
    }
  }
}
