import type {
  GitHubAppIssuePermission,
  GitHubCredentialSource,
  GitHubIssueWriteAccess,
} from "../types";

/**
 * What the ADE GitHub App may do on a repository owner, read from the App
 * installation on that owner, and which App credential a request may use.
 *
 * A GitHub App user token can never do more than the installation on the
 * repository's owner allows. GitHub keeps an installation on its old rights
 * until an owner of it accepts the new ones, so a token of the same App can
 * write on one owner and only read on another. ADE reads the installations
 * once (`GET /user/installations`, one request per token user, cached for
 * 15 minutes) and skips an App credential before it sends a request that the
 * installation would refuse. A refused write would also feed the request
 * budget that slows PR polling.
 *
 * Two App credentials exist during the migration:
 * - `app`: the legacy device-flow token kept on this machine. Its rights stay
 *   as before: reads, and issue edits where the installation grants
 *   `issues: write`.
 * - `account_app`: the ADE account's GitHub App sign-in. Reads always; issue
 *   edits with `issues: write`; other writes with `contents: write` and
 *   `pull_requests: write`; git push and fetch with `contents: write`.
 *
 * Pure (no Node imports): the desktop service, its headless twin and later the
 * web client share it.
 */

export const APP_GRANT_TTL_MS = 15 * 60_000;

/** The rights ADE asks for. An installation is "fully accepted" when it has all of them. */
export const APP_REQUIRED_PERMISSIONS = {
  metadata: "read",
  contents: "write",
  pull_requests: "write",
  issues: "write",
} as const satisfies Record<string, "read" | "write">;

export type AppPermissionLevel = "read" | "write";

export type AppInstallationGrant = {
  installed: boolean;
  installationId: number | null;
  accountLogin: string | null;
  accountType: "User" | "Organization" | null;
  permissions: Record<string, AppPermissionLevel>;
  repositorySelection: "all" | "selected" | null;
  /** Where an owner reviews and approves the App's permission request. */
  manageUrl: string | null;
};

/** What a request needs from the installation. `git` is git push, pull and fetch over https. */
export type AppGrantCapability = "read" | "write" | "issue-write" | "git";

const NOT_INSTALLED: AppInstallationGrant = {
  installed: false,
  installationId: null,
  accountLogin: null,
  accountType: null,
  permissions: {},
  repositorySelection: null,
  manageUrl: null,
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Pick the installation on `owner` out of `GET /user/installations`. */
export function appInstallationGrantForOwner(data: unknown, owner: string): AppInstallationGrant {
  const installations = record(data)?.installations;
  if (!Array.isArray(installations)) return NOT_INSTALLED;
  const wanted = owner.trim().toLowerCase();
  for (const entry of installations) {
    const installation = record(entry);
    const account = record(installation?.account);
    const login = typeof account?.login === "string" ? account.login : "";
    if (login.toLowerCase() !== wanted) continue;
    const id = typeof installation?.id === "number" ? installation.id : null;
    const permissions: Record<string, AppPermissionLevel> = {};
    for (const [name, level] of Object.entries(record(installation?.permissions) ?? {})) {
      if (level === "write" || level === "read") permissions[name] = level;
      // GitHub also says "admin" for some rights; it includes write.
      else if (level === "admin") permissions[name] = "write";
    }
    const accountType = account?.type === "Organization" ? "Organization" : account?.type === "User" ? "User" : null;
    const selection = installation?.repository_selection;
    const manageUrl = id == null
      ? null
      : accountType === "Organization"
        ? `https://github.com/organizations/${encodeURIComponent(login)}/settings/installations/${id}`
        : `https://github.com/settings/installations/${id}`;
    return {
      installed: true,
      installationId: id,
      accountLogin: login,
      accountType,
      permissions,
      repositorySelection: selection === "all" || selection === "selected" ? selection : null,
      manageUrl,
    };
  }
  return NOT_INSTALLED;
}

/** True when the installation grants `permission` at `level` or above. */
export function appGrantAllows(
  grant: AppInstallationGrant | null | undefined,
  permission: string,
  level: AppPermissionLevel,
): boolean {
  if (!grant?.installed) return false;
  const granted = grant.permissions[permission];
  return level === "read" ? granted === "read" || granted === "write" : granted === "write";
}

/** The required rights the installation does not grant yet, by GitHub's names. */
export function appGrantMissingPermissions(grant: AppInstallationGrant | null | undefined): string[] {
  if (!grant?.installed) return [];
  return Object.entries(APP_REQUIRED_PERMISSIONS)
    .filter(([permission, level]) => !appGrantAllows(grant, permission, level))
    .map(([permission]) => permission);
}

/** Installed, and an owner still has to approve one of the rights ADE asks for. */
export function appGrantNeedsApproval(grant: AppInstallationGrant | null | undefined): boolean {
  return appGrantMissingPermissions(grant).length > 0;
}

/** Whether the account App may serve a request that needs `capability` on this owner. */
export function appGrantAllowsCapability(
  grant: AppInstallationGrant | null | undefined,
  capability: AppGrantCapability,
): boolean {
  switch (capability) {
    case "read":
      return true;
    case "issue-write":
      return appGrantAllows(grant, "issues", "write");
    case "write":
      return appGrantAllows(grant, "contents", "write") && appGrantAllows(grant, "pull_requests", "write");
    case "git":
      return appGrantAllows(grant, "contents", "write");
  }
}

export type AppGrantReader = ((
  owner: string,
  appToken: string,
  options?: { force?: boolean; identity?: string },
) => Promise<AppInstallationGrant | null>) & {
  /**
   * The last answer for `owner`, with no request: `stale` once it is older
   * than the cache time. Null when nothing was asked yet.
   */
  peek?: (owner: string, identity?: string, appToken?: string) => { grant: AppInstallationGrant | null; checkedAt: number; stale: boolean } | null;
};

type GrantEntry = {
  grant: AppInstallationGrant | null;
  checkedAt: number;
  promise: Promise<AppInstallationGrant | null> | null;
  /** Which token the answer is for (`tokenMark`), so a new sign-in never reuses another user's answer. */
  tokenMark: string;
};

/** A short, non-secret mark of a token (FNV-1a), to tell answers for different tokens apart. */
function tokenMark(token: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

/**
 * The installation on each owner, cached for `APP_GRANT_TTL_MS` per token
 * user (`identity`: the legacy and the account App can be different GitHub
 * users) and owner. An answer belongs to the token it was read with: a new
 * token (a renewal, or a sign-in as another GitHub user) reads again. A failed read answers null (unknown), and unknown is
 * treated as "not granted": the request then goes to the next credential,
 * which is the behaviour before App writes existed.
 */
export function createAppInstallationGrantReader(
  listInstallations: (appToken: string) => Promise<unknown>,
  now: () => number = () => Date.now(),
): AppGrantReader {
  const entries = new Map<string, GrantEntry>();
  const keyOf = (owner: string, identity: string | undefined) => `${identity ?? "app"}:${owner.trim().toLowerCase()}`;
  const read: AppGrantReader = async (owner, appToken, options = {}) => {
    const key = keyOf(owner, options.identity);
    const mark = tokenMark(appToken);
    const stored = entries.get(key);
    const current = stored?.tokenMark === mark ? stored : undefined;
    if (current?.promise) return current.promise;
    if (!options.force && current && now() - current.checkedAt < APP_GRANT_TTL_MS) return current.grant;
    const promise = listInstallations(appToken)
      .then((data) => appInstallationGrantForOwner(data, owner))
      .catch(() => null)
      .then((grant) => {
        // A read for an older token that ends after a newer one started does not overwrite it.
        if (entries.get(key)?.tokenMark === mark) entries.set(key, { grant, checkedAt: now(), promise: null, tokenMark: mark });
        return grant;
      });
    entries.set(key, { grant: current?.grant ?? null, checkedAt: current?.checkedAt ?? 0, promise, tokenMark: mark });
    return promise;
  };
  read.peek = (owner, identity, appToken) => {
    const current = entries.get(keyOf(owner, identity));
    if (!current || current.checkedAt === 0) return null;
    if (appToken !== undefined && current.tokenMark !== tokenMark(appToken)) return null;
    return { grant: current.grant, checkedAt: current.checkedAt, stale: now() - current.checkedAt >= APP_GRANT_TTL_MS };
  };
  return read;
}

const isAppSource = (source: GitHubCredentialSource): boolean => source === "app" || source === "account_app";

/**
 * Drops each App credential that the installation on `owner` would refuse for
 * `capability`. Other credentials pass through in order.
 *
 * - `app` (legacy): only issue edits are gated, on `issues: write`.
 * - `account_app`: reads pass; issue edits, writes and git need the right on
 *   the owner. With no owner, a write or an issue edit skips it (ADE cannot
 *   tell which installation applies), and git keeps it last.
 */
export async function gateAppCandidates<T extends { source: GitHubCredentialSource; token: string }>(
  candidates: readonly T[],
  args: { capability: AppGrantCapability; owner: string | null; readGrant: AppGrantReader },
): Promise<T[]> {
  const out: T[] = [];
  let accountAppWithoutOwner: T | null = null;
  for (const candidate of candidates) {
    if (candidate.source === "app") {
      if (args.capability === "issue-write") {
        if (!args.owner) continue;
        const grant = await args.readGrant(args.owner, candidate.token, { identity: "app" });
        if (!appGrantAllows(grant, "issues", "write")) continue;
      }
      out.push(candidate);
      continue;
    }
    if (candidate.source === "account_app") {
      if (args.capability === "read") {
        out.push(candidate);
        continue;
      }
      if (!args.owner) {
        if (args.capability === "git") accountAppWithoutOwner = candidate;
        continue;
      }
      const grant = await args.readGrant(args.owner, candidate.token, { identity: "account_app" });
      if (appGrantAllowsCapability(grant, args.capability)) out.push(candidate);
      continue;
    }
    out.push(candidate);
  }
  if (accountAppWithoutOwner) out.push(accountAppWithoutOwner);
  return out;
}

/** What the renderer needs to enable controls and word the permission banner. */
export async function describeIssueWriteAccess<T extends { source: GitHubCredentialSource; token: string }>(args: {
  owner: string;
  name: string;
  candidates: readonly T[];
  readGrant: AppGrantReader;
  force?: boolean;
}): Promise<GitHubIssueWriteAccess> {
  const app = args.candidates.find((candidate) => isAppSource(candidate.source)) ?? null;
  const identity = app?.source === "account_app" ? "account_app" : "app";
  const grant = app ? await args.readGrant(args.owner, app.token, { force: args.force, identity }) : null;
  // Each App credential is gated on its own grant: during a login mismatch
  // the legacy sign-in may lack the right that the account's sign-in has.
  // The grant read above serves its own credential; another one reads its own.
  const writable = await gateAppCandidates(args.candidates, {
    capability: "issue-write",
    owner: args.owner,
    readGrant: async (owner, token, options) =>
      app && token === app.token && (options?.identity ?? "app") === identity
        ? grant
        : args.readGrant(owner, token, { ...options, force: args.force }),
  });
  const issues = grant?.permissions.issues;
  const issuesPermission: GitHubAppIssuePermission = issues === "write" ? "write" : issues === "read" ? "read" : "none";
  return {
    owner: args.owner,
    name: args.name,
    app: app
      ? {
        installed: grant?.installed ?? false,
        issuesPermission: grant ? issuesPermission : null,
        needsApproval: Boolean(grant?.installed && issuesPermission !== "write"),
        manageUrl: grant?.manageUrl ?? null,
      }
      : null,
    writeSource: writable[0]?.source ?? null,
    checkedAt: new Date().toISOString(),
  };
}
