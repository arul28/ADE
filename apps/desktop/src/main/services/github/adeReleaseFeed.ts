export const ADE_RELEASE_REPO = { owner: "arul28", name: "ADE" } as const;

export type AdeLatestRelease = {
  version: string;
  tagName: string;
  htmlUrl: string | null;
  publishedAt: string | null;
};

type AdeReleaseFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Fetches the latest stable ADE release without depending on Electron or the
 * desktop GitHub service. GitHub's `releases/latest` endpoint excludes drafts
 * and prereleases.
 */
export async function fetchAdeLatestRelease(options?: {
  token?: string | null;
  repo?: { owner: string; name: string };
  fetchImpl?: AdeReleaseFetch;
}): Promise<AdeLatestRelease | null> {
  const repo = options?.repo ?? ADE_RELEASE_REPO;
  const doFetch = options?.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "ade-desktop",
  };
  const token = options?.token?.trim();
  if (token) headers.authorization = `Bearer ${token}`;

  let response: Response;
  try {
    response = await doFetch(
      `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/releases/latest`,
      { method: "GET", headers },
    );
  } catch {
    return null;
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    return null;
  }

  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!payload) return null;

  const tagName = optionalString(payload.tag_name);
  if (!tagName) return null;
  return {
    version: tagName.replace(/^v/i, "").trim() || tagName,
    tagName,
    htmlUrl: optionalString(payload.html_url),
    publishedAt: optionalString(payload.published_at),
  };
}
