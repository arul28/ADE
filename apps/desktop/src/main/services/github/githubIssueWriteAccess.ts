import type {
  GitHubAppIssuePermission,
  GitHubCredentialSource,
  GitHubIssueWriteAccess,
} from "../../../shared/types";

/**
 * Whether the ADE GitHub App may change issues in a repository, and which
 * credential an issue write will use.
 *
 * Issue writes (`issue-write`) try the App first, then `gh`, then a PAT. The
 * App is only tried when its installation on the repository's owner actually
 * grants `Issues: write`: an installation that has not approved the permission
 * would answer 403 on every edit, and a recorded 403 feeds the request budget
 * that slows PR polling. So the grant is read once (the user's installations,
 * one request) and cached, and an ungranted App is skipped before any request.
 *
 * Shared by the desktop GitHub service and its headless twin.
 */

export const APP_ISSUE_GRANT_TTL_MS = 15 * 60_000;

export type AppIssueGrant = {
  installed: boolean;
  issuesPermission: GitHubAppIssuePermission;
  installationId: number | null;
  /** Where an owner reviews and approves the App's permission request. */
  manageUrl: string | null;
};

const NOT_INSTALLED: AppIssueGrant = { installed: false, issuesPermission: "none", installationId: null, manageUrl: null };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Pick the installation on `owner` out of `GET /user/installations`. */
export function appIssueGrantForOwner(data: unknown, owner: string): AppIssueGrant {
  const installations = record(data)?.installations;
  if (!Array.isArray(installations)) return NOT_INSTALLED;
  const wanted = owner.trim().toLowerCase();
  for (const entry of installations) {
    const installation = record(entry);
    const account = record(installation?.account);
    const login = typeof account?.login === "string" ? account.login.toLowerCase() : "";
    if (login !== wanted) continue;
    const id = typeof installation?.id === "number" ? installation.id : null;
    const permission = record(installation?.permissions)?.issues;
    const issuesPermission: GitHubAppIssuePermission = permission === "write" ? "write" : permission === "read" ? "read" : "none";
    const manageUrl = id == null
      ? null
      : account?.type === "Organization"
        ? `https://github.com/organizations/${encodeURIComponent(String(account.login))}/settings/installations/${id}`
        : `https://github.com/settings/installations/${id}`;
    return { installed: true, issuesPermission, installationId: id, manageUrl };
  }
  return NOT_INSTALLED;
}

type GrantEntry = { grant: AppIssueGrant | null; checkedAt: number; promise: Promise<AppIssueGrant | null> | null };

/**
 * The App's grant per owner, cached for `APP_ISSUE_GRANT_TTL_MS`. A failed
 * read answers null (unknown), and unknown is treated as "not granted": the
 * write then goes to `gh` or a PAT, which is the behaviour before this existed.
 */
export function createAppIssueGrantReader(listInstallations: (appToken: string) => Promise<unknown>) {
  const entries = new Map<string, GrantEntry>();
  return async (owner: string, appToken: string, options: { force?: boolean } = {}): Promise<AppIssueGrant | null> => {
    const key = owner.trim().toLowerCase();
    const current = entries.get(key);
    if (current?.promise) return current.promise;
    if (!options.force && current && Date.now() - current.checkedAt < APP_ISSUE_GRANT_TTL_MS) return current.grant;
    const promise = listInstallations(appToken)
      .then((data) => appIssueGrantForOwner(data, owner))
      .catch(() => null)
      .then((grant) => {
        entries.set(key, { grant, checkedAt: Date.now(), promise: null });
        return grant;
      });
    entries.set(key, { grant: current?.grant ?? null, checkedAt: current?.checkedAt ?? 0, promise });
    return promise;
  };
}

/**
 * Drop the App from an issue write's candidates unless its installation grants
 * `Issues: write`. Other credentials pass through in order.
 */
export async function issueWriteCandidates<T extends { source: GitHubCredentialSource; token: string }>(
  candidates: readonly T[],
  owner: string | null,
  readGrant: (owner: string, appToken: string) => Promise<AppIssueGrant | null>,
): Promise<T[]> {
  const out: T[] = [];
  for (const candidate of candidates) {
    if (candidate.source === "app") {
      if (!owner) continue;
      const grant = await readGrant(owner, candidate.token);
      if (grant?.issuesPermission !== "write") continue;
    }
    out.push(candidate);
  }
  return out;
}

/** What the renderer needs to enable controls and word the permission banner. */
export async function describeIssueWriteAccess<T extends { source: GitHubCredentialSource; token: string }>(args: {
  owner: string;
  name: string;
  candidates: readonly T[];
  readGrant: (owner: string, appToken: string, options?: { force?: boolean }) => Promise<AppIssueGrant | null>;
  force?: boolean;
}): Promise<GitHubIssueWriteAccess> {
  const app = args.candidates.find((candidate) => candidate.source === "app") ?? null;
  const grant = app ? await args.readGrant(args.owner, app.token, { force: args.force }) : null;
  const writable = await issueWriteCandidates(args.candidates, args.owner, async () => grant);
  return {
    owner: args.owner,
    name: args.name,
    app: app
      ? {
        installed: grant?.installed ?? false,
        issuesPermission: grant?.issuesPermission ?? null,
        needsApproval: Boolean(grant?.installed && grant.issuesPermission !== "write"),
        manageUrl: grant?.manageUrl ?? null,
      }
      : null,
    writeSource: writable[0]?.source ?? null,
    checkedAt: new Date().toISOString(),
  };
}
