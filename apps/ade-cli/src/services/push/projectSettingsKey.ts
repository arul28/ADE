import { createHash } from "node:crypto";
import { readGitOriginUrlFromConfigOrGit } from "../../../../desktop/src/main/services/projects/recentProjectSummary";
import { gitRemoteIdentity } from "../../../../desktop/src/main/services/github/githubSshAlias";

/**
 * The key project notification settings use (`AttentionProjectRef.settingsKey`):
 * the repository, from its canonical git origin, so one choice holds for every
 * checkout of it on every machine; `folderId` (the folder's canonical id) when
 * the folder has no origin. A config read, at worst one cached git spawn:
 * callers read it once per root.
 */
export function deriveProjectSettingsKey(rootPath: string, folderId: string | null): string | null {
  const origin = gitRemoteIdentity(readGitOriginUrlFromConfigOrGit(rootPath));
  return origin
    ? `repo_${createHash("sha256").update(origin).digest("hex").slice(0, 24)}`
    : folderId;
}
