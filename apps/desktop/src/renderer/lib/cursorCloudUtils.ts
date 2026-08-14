// Shared helpers for Cursor Cloud renderer components.

/**
 * Normalize a git remote URL to a canonical "host/owner/repo" key so we can
 * match a lane's `git@github.com:owner/repo.git` against Cursor Cloud's
 * `https://github.com/owner/repo` form.
 */
export function repoMatchKey(url: string | null | undefined): string {
  if (!url) return "";
  let s = url.trim();
  if (!s) return "";
  // SSH form: git@host:owner/repo(.git)
  const sshMatch = s.match(/^[^@]+@([^:]+):(.+)$/);
  if (sshMatch) {
    s = `${sshMatch[1]}/${sshMatch[2]}`;
  } else {
    s = s.replace(/^[a-z+]+:\/\//i, "");
    // Strip any leading user@ (e.g. https://user@host/...)
    s = s.replace(/^[^/@]+@/, "");
  }
  s = s.replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase();
  return s;
}

/**
 * Strip Electron's `Error invoking remote method '…':` wrapper so Cursor Cloud
 * failures show the underlying message (API key missing, repo access, etc.).
 */
export function cursorCloudErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']+':\s*/i, "").trim()
    || "Cursor Cloud request failed.";
}

export type CursorCloudExistingPr = {
  prUrl: string;
  prNumber: number | null;
  title: string | null;
};

/**
 * `prUrl` and `autoCreatePR` are create-time only. If the branch already has a
 * PR, attach to it — do not also ask Cursor to open another.
 */
export function resolveCursorCloudPrCreateFields(input: {
  existingPrUrl?: string | null;
  autoCreatePR?: boolean;
}): { autoCreatePR: boolean; prUrl?: string } {
  const prUrl = input.existingPrUrl?.trim() || "";
  if (prUrl) return { autoCreatePR: false, prUrl };
  return { autoCreatePR: input.autoCreatePR === true };
}

/** Public Cursor Cloud agent URL. The in-app `#/cloud` route is not shipped. */
export function cursorCloudAgentWebUrl(agentId: string | null | undefined): string | null {
  const id = agentId?.trim();
  if (!id) return null;
  return `https://cursor.com/agents?id=${encodeURIComponent(id)}`;
}
