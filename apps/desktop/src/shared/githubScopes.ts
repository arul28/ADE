export const REQUIRED_GITHUB_CLASSIC_SCOPES = [
  "repo",
  "workflow",
  "read:org",
] as const;

export type GitHubClassicScope = (typeof REQUIRED_GITHUB_CLASSIC_SCOPES)[number];

type ScopeRequirementState = {
  id: GitHubClassicScope;
  present: boolean;
};

export type GitHubTokenAccessState = {
  normalizedScopes: string[];
  usesFineGrainedPermissions: boolean;
  hasRequiredAccess: boolean;
  missingClassicScopes: GitHubClassicScope[];
  missingDescriptions: string[];
  requirements: Record<GitHubClassicScope, ScopeRequirementState>;
};

const REPO_FINE_GRAINED_PERMISSIONS = ["contents", "pull_requests"] as const;
const WORKFLOW_FINE_GRAINED_PERMISSIONS = ["workflow", "workflows", "actions", "checks"] as const;
const ORG_FINE_GRAINED_PERMISSIONS = ["read:org", "admin:org", "members", "organization_members", "read_org"] as const;
const FINE_GRAINED_PERMISSION_PREFIXES = [
  ...REPO_FINE_GRAINED_PERMISSIONS,
  ...WORKFLOW_FINE_GRAINED_PERMISSIONS,
  ...ORG_FINE_GRAINED_PERMISSIONS,
  "metadata",
] as const;

function normalizeScopeToken(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "");
}

function splitHeaderScopes(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map(normalizeScopeToken)
    .filter(Boolean);
}

function hasScopeLike(normalizedScopes: Set<string>, candidate: string): boolean {
  return [...normalizedScopes].some((scope) => (
    scope === candidate
    || scope.startsWith(`${candidate}=`)
    || (candidate !== "read:org" && candidate !== "admin:org" && scope.startsWith(`${candidate}:`))
  ));
}

function hasAnyScopeLike(normalizedScopes: Set<string>, candidates: readonly string[]): boolean {
  return candidates.some((candidate) => hasScopeLike(normalizedScopes, candidate));
}

export function parseGitHubScopeHeaders(headers: Pick<Headers, "get">): string[] {
  const merged = new Set<string>([
    ...splitHeaderScopes(headers.get("x-oauth-scopes")),
    ...splitHeaderScopes(headers.get("x-accepted-oauth-scopes")),
    ...splitHeaderScopes(headers.get("x-accepted-scopes")),
  ]);
  return [...merged];
}

export function getGitHubTokenAccessState(scopes: Iterable<string>): GitHubTokenAccessState {
  const normalizedScopes = new Set(
    [...scopes]
      .map((value) => normalizeScopeToken(String(value ?? "")))
      .filter(Boolean),
  );

  const repoPresent = hasScopeLike(normalizedScopes, "repo")
    || REPO_FINE_GRAINED_PERMISSIONS.every((permission) => hasScopeLike(normalizedScopes, permission));
  const workflowPresent = hasAnyScopeLike(normalizedScopes, WORKFLOW_FINE_GRAINED_PERMISSIONS);
  const orgPresent = hasAnyScopeLike(normalizedScopes, ORG_FINE_GRAINED_PERMISSIONS);

  const usesFineGrainedPermissions = [...normalizedScopes].some((scope) => (
    FINE_GRAINED_PERMISSION_PREFIXES.some((candidate) => (
      scope === candidate
      || scope.startsWith(`${candidate}=`)
      || (candidate !== "read:org" && candidate !== "admin:org" && scope.startsWith(`${candidate}:`))
    ))
  ));

  const missingClassicScopes = REQUIRED_GITHUB_CLASSIC_SCOPES.filter((scope) => {
    switch (scope) {
      case "repo":
        return !repoPresent;
      case "workflow":
        return !workflowPresent;
      case "read:org":
        return !orgPresent;
      default:
        return true;
    }
  });

  const missingDescriptions = usesFineGrainedPermissions
    ? [
        !repoPresent ? "Contents and Pull requests" : null,
        !workflowPresent ? "Actions/Workflows or Checks" : null,
        !orgPresent ? "Members" : null,
      ].filter((value): value is string => Boolean(value))
    : [...missingClassicScopes];

  return {
    normalizedScopes: [...normalizedScopes],
    usesFineGrainedPermissions,
    hasRequiredAccess: missingClassicScopes.length === 0,
    missingClassicScopes,
    missingDescriptions,
    requirements: {
      repo: { id: "repo", present: repoPresent },
      workflow: { id: "workflow", present: workflowPresent },
      "read:org": { id: "read:org", present: orgPresent },
    },
  };
}
