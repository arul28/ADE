import type {
  GitHubCredentialCapability,
  GitHubCredentialSource,
} from "./types/git";

export type GithubOperationCredentialSource = GitHubCredentialSource;
export type GithubOperationCredentialCapability = GitHubCredentialCapability;

export const GITHUB_OPERATION_CREDENTIALS = [
  { source: "environment", capabilities: ["read", "write"] },
  { source: "app", capabilities: ["read"] },
  { source: "gh", capabilities: ["read", "write"] },
  { source: "pat", capabilities: ["read", "write"] },
] as const satisfies readonly {
  source: GithubOperationCredentialSource;
  capabilities: readonly GithubOperationCredentialCapability[];
}[];

export const GITHUB_OPERATION_CREDENTIAL_PRECEDENCE:
  readonly GithubOperationCredentialSource[] = GITHUB_OPERATION_CREDENTIALS.map(
    ({ source }) => source,
  );

const GITHUB_WRITE_CREDENTIAL_PRECEDENCE:
  readonly Exclude<GithubOperationCredentialSource, "app">[] =
    GITHUB_OPERATION_CREDENTIAL_PRECEDENCE.filter(
      (source): source is Exclude<GithubOperationCredentialSource, "app"> => source !== "app",
    );

export function githubOperationCredentialPrecedence(
  capability: GithubOperationCredentialCapability,
): readonly GithubOperationCredentialSource[] {
  return capability === "read"
    ? GITHUB_OPERATION_CREDENTIAL_PRECEDENCE
    : GITHUB_WRITE_CREDENTIAL_PRECEDENCE;
}

export function githubOperationCredentialCapabilities(
  source: GithubOperationCredentialSource,
): readonly GithubOperationCredentialCapability[] {
  return GITHUB_OPERATION_CREDENTIALS.find((credential) => credential.source === source)
    ?.capabilities ?? [];
}

export function githubOperationCredentialCandidates<
  T extends {
    source: GithubOperationCredentialSource;
    token: string;
    capabilities: readonly GithubOperationCredentialCapability[];
  },
>(
  candidates: readonly T[],
  capability: GithubOperationCredentialCapability,
): T[] {
  const seenTokens = new Set<string>();
  return githubOperationCredentialPrecedence(capability)
    .flatMap((source) => candidates.filter((candidate) => candidate.source === source))
    .filter((candidate) => {
      if (!candidate.capabilities.includes(capability)) return false;
      // Different sources can expose the same OAuth token. Retrying it cannot
      // recover and only consumes another request.
      if (seenTokens.has(candidate.token)) return false;
      seenTokens.add(candidate.token);
      return true;
    });
}

type CredentialResolvers<T> = Record<
  GithubOperationCredentialSource,
  () => T | null
>;

export function selectGithubOperationCredential<T>(
  resolvers: CredentialResolvers<T>,
  capability: GithubOperationCredentialCapability = "read",
): T | null {
  for (const source of githubOperationCredentialPrecedence(capability)) {
    const credential = resolvers[source]();
    if (credential) return credential;
  }
  return null;
}
