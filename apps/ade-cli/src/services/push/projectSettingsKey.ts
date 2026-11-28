import { createHash } from "node:crypto";
import { readGitOriginUrlFromConfigOrGit } from "../../../../desktop/src/main/services/projects/recentProjectSummary";
import { gitRemoteIdentity } from "../../../../desktop/src/main/services/github/githubSshAlias";

// Refresh on demand so a running brain picks up a new or changed origin.
const PROJECT_SETTINGS_KEY_MAX_AGE_MS = 60_000;

export function createProjectSettingsKeyReader() {
  const byRoot = new Map<string, { key: string | null; expiresAt: number }>();

  return (rootPath: string, folderId: string | null): string | null => {
    const now = Date.now();
    const cached = byRoot.get(rootPath);
    if (cached && cached.expiresAt > now) return cached.key ?? folderId;

    const origin = gitRemoteIdentity(readGitOriginUrlFromConfigOrGit(rootPath));
    const key = origin ? `repo_${createHash("sha256").update(origin).digest("hex").slice(0, 24)}` : null;
    byRoot.set(rootPath, { key, expiresAt: now + PROJECT_SETTINGS_KEY_MAX_AGE_MS });
    return key ?? folderId;
  };
}
