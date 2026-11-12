/**
 * Ask GitHub for a repository's numeric id, its current owner and name, and
 * its default branch. The account project list keys a project by that id, so
 * a rename or a transfer keeps one project.
 *
 * It tries the machine's own GitHub credentials first (whatever the brain's
 * GitHub service holds: the account's token, `gh`, an environment token).
 * With no credential at all it asks GitHub's public API, which answers for a
 * public repository only (60 requests an hour per address). It never throws.
 *
 * Only github.com: the brain's GitHub service talks to api.github.com alone,
 * so a GitHub Enterprise project stays address-only (`unsupported`).
 */

export type GithubRepoLookupResult =
  | { kind: "found"; repoId: number; owner: string; name: string; defaultBranch: string | null }
  /** GitHub says there is no such repository for these credentials: deleted, or private and unreadable. */
  | { kind: "not_found" }
  /** No answer now (offline, rate limited, GitHub down): try later. */
  | { kind: "unavailable"; reason: string }
  /** ADE cannot ask this host. */
  | { kind: "unsupported" };

export type GithubRepoLookup = (repo: { host: string; owner: string; name: string }) => Promise<GithubRepoLookupResult>;

/** The part of the brain's GitHub service this needs. */
export type GithubApiRequest = (args: {
  method: "GET";
  path: string;
  capability: "read";
}) => Promise<{ data: unknown }>;

const PUBLIC_LOOKUP_TIMEOUT_MS = 10_000;

function readRepo(data: unknown): GithubRepoLookupResult {
  if (!data || typeof data !== "object") return { kind: "unavailable", reason: "bad_response" };
  const record = data as Record<string, unknown>;
  const owner = record.owner && typeof record.owner === "object" ? (record.owner as Record<string, unknown>).login : null;
  if (typeof record.id !== "number" || !Number.isSafeInteger(record.id) || record.id <= 0
    || typeof owner !== "string" || typeof record.name !== "string") {
    return { kind: "unavailable", reason: "bad_response" };
  }
  return {
    kind: "found",
    repoId: record.id,
    owner,
    name: record.name,
    defaultBranch: typeof record.default_branch === "string" && record.default_branch ? record.default_branch : null,
  };
}

function errorStatus(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : null;
}

/** The brain's GitHub service has no credential for a read. */
function isNoCredential(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return /^GitHub auth missing|^No usable GitHub credential/.test(message);
}

export function createGithubRepoLookup(options: {
  /** Null when the brain cannot build its GitHub service right now. */
  getApiRequest: () => Promise<GithubApiRequest | null>;
  fetchImpl?: typeof fetch;
}): GithubRepoLookup {
  const fetchImpl = options.fetchImpl ?? fetch;

  const publicLookup = async (owner: string, name: string): Promise<GithubRepoLookupResult> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PUBLIC_LOOKUP_TIMEOUT_MS);
    try {
      const response = await fetchImpl(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
        { headers: { accept: "application/vnd.github+json", "user-agent": "ADE" }, signal: controller.signal },
      );
      if (response.status === 404) {
        await response.body?.cancel().catch(() => {});
        return { kind: "not_found" };
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        return { kind: "unavailable", reason: `http_${response.status}` };
      }
      return readRepo(await response.json());
    } catch {
      return { kind: "unavailable", reason: "network" };
    } finally {
      clearTimeout(timer);
    }
  };

  return async ({ host, owner, name }) => {
    if (host !== "github.com") return { kind: "unsupported" };
    let apiRequest: GithubApiRequest | null = null;
    try {
      apiRequest = await options.getApiRequest();
    } catch {
      apiRequest = null;
    }
    if (apiRequest) {
      try {
        const { data } = await apiRequest({ method: "GET", path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, capability: "read" });
        return readRepo(data);
      } catch (error) {
        if (errorStatus(error) === 404) return { kind: "not_found" };
        if (!isNoCredential(error)) {
          return { kind: "unavailable", reason: errorStatus(error) ? `http_${errorStatus(error)}` : "github_error" };
        }
      }
    }
    return publicLookup(owner, name);
  };
}
