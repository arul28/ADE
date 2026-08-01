import type {
  GitHubAuthFailure,
  GitHubCredentialCapability,
  GitHubCredentialSource,
  GitHubRateLimitState,
  GitHubTokenType,
} from "./types/git";
import { getGitHubTokenAccessState } from "./githubScopes";

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

export function resolveGithubOperationCredentialCandidate<
  T extends {
    source: GithubOperationCredentialSource;
    token: string;
    capabilities: readonly GithubOperationCredentialCapability[];
  },
>(args: {
  candidates: readonly T[];
  capability: GithubOperationCredentialCapability;
  isAvailable: (candidate: T) => boolean;
}): T | null {
  return githubOperationCredentialCandidates(args.candidates, args.capability)
    .find(args.isAvailable) ?? null;
}

export function evaluateGithubCredentialCapabilities(args: {
  source: GithubOperationCredentialSource;
  tokenType: GitHubTokenType;
  scopes: readonly string[];
  userLogin: string | null;
  repositoryPresent: boolean;
  repositoryReadValidated: boolean | null;
}): Readonly<{ read: boolean; write: boolean }> {
  if (!args.userLogin) return { read: false, write: false };

  const repositoryReadAvailable = !args.repositoryPresent
    || args.repositoryReadValidated === true;
  if (args.source === "app") {
    return { read: repositoryReadAvailable, write: false };
  }
  if (args.tokenType === "fine-grained") {
    // GitHub does not expose fine-grained token permissions during validation.
    // A successful repository probe establishes that the user-selected token
    // can target this repo; actual write requests still fail over on 403.
    return { read: repositoryReadAvailable, write: repositoryReadAvailable };
  }
  if (
    args.tokenType === "classic"
    || args.tokenType === "oauth"
    || args.scopes.length > 0
  ) {
    const access = getGitHubTokenAccessState(args.scopes);
    return {
      read: access.requirements.repo.present,
      write: access.hasRequiredAccess,
    };
  }
  return { read: true, write: true };
}

export type GithubStatusCredentialProbeResult<Probe> =
  | { ok: true; value: Probe }
  | {
      ok: false;
      error: string;
      authFailure: GitHubAuthFailure;
      rateLimit: GitHubRateLimitState | null;
      value?: Probe;
    };

export async function resolveGithubStatusCredentials<
  Candidate extends {
    source: GithubOperationCredentialSource;
    token: string;
  },
  Probe,
>(args: {
  readCandidates: readonly Candidate[];
  writeCandidates: readonly Candidate[];
  cooldown: (candidate: Candidate) => {
    failure: GitHubAuthFailure;
    rateLimit: GitHubRateLimitState | null;
  } | null;
  probe: (candidate: Candidate) => Promise<GithubStatusCredentialProbeResult<Probe>>;
  capabilities: (
    candidate: Candidate,
    probe: Probe,
  ) => Readonly<{ read: boolean; write: boolean }>;
  isRepositoryAccessFailure: (
    result: Extract<GithubStatusCredentialProbeResult<Probe>, { ok: false }>,
  ) => boolean;
  onAuthenticatedProbe: (candidate: Candidate, probe: Probe) => void;
  onUsableProbe: (candidate: Candidate, probe: Probe) => void;
  onRejectedProbe: (
    candidate: Candidate,
    result: Extract<GithubStatusCredentialProbeResult<Probe>, { ok: false }>,
    context: { repositoryAccessFailure: boolean; phase: "read" | "write" },
  ) => void;
}): Promise<{
  active: { candidate: Candidate; value: Probe } | null;
  activeWriteSource: Exclude<GithubOperationCredentialSource, "app"> | null;
  failures: Array<{
    candidate: Candidate;
    error: string;
    authFailure: GitHubAuthFailure;
    rateLimit: GitHubRateLimitState | null;
  }>;
}> {
  const failures: Array<{
    candidate: Candidate;
    error: string;
    authFailure: GitHubAuthFailure;
    rateLimit: GitHubRateLimitState | null;
  }> = [];
  const successfulProbes = new Map<string, Probe>();
  let active: { candidate: Candidate; value: Probe } | null = null;

  for (const [candidateIndex, candidate] of args.readCandidates.entries()) {
    const cooldown = args.cooldown(candidate);
    if (cooldown) {
      failures.push({
        candidate,
        error: cooldown.failure.message,
        authFailure: cooldown.failure,
        rateLimit: cooldown.rateLimit,
      });
      continue;
    }
    const result = await args.probe(candidate);
    if (!result.ok) {
      const repositoryAccessFailure = args.isRepositoryAccessFailure(result);
      const hasFallback = args.readCandidates
        .slice(candidateIndex + 1)
        .some((fallback) => !args.cooldown(fallback));
      if (repositoryAccessFailure && result.value && !hasFallback) {
        active = { candidate, value: result.value };
        args.onAuthenticatedProbe(candidate, result.value);
        break;
      }
      failures.push({ candidate, ...result });
      args.onRejectedProbe(candidate, result, { repositoryAccessFailure, phase: "read" });
      if (result.authFailure.kind === "network" || result.authFailure.kind === "unknown") break;
      continue;
    }
    const candidateCapabilities = args.capabilities(candidate, result.value);
    if (!candidateCapabilities.read) {
      successfulProbes.set(candidate.token, result.value);
      const hasFallback = args.readCandidates
        .slice(candidateIndex + 1)
        .some((fallback) => !args.cooldown(fallback));
      if (!hasFallback) {
        active = { candidate, value: result.value };
        args.onAuthenticatedProbe(candidate, result.value);
        break;
      }
      const capabilityFailure = {
        ok: false as const,
        error: "This credential does not grant GitHub repository read access.",
        authFailure: {
          kind: "permission_denied" as const,
          message: "This credential does not grant GitHub repository read access.",
          retryAt: null,
        },
        rateLimit: null,
        value: result.value,
      };
      failures.push({ candidate, ...capabilityFailure });
      args.onAuthenticatedProbe(candidate, result.value);
      args.onRejectedProbe(candidate, capabilityFailure, {
        repositoryAccessFailure: false,
        phase: "read",
      });
      continue;
    }
    active = { candidate, value: result.value };
    successfulProbes.set(candidate.token, result.value);
    args.onAuthenticatedProbe(candidate, result.value);
    args.onUsableProbe(candidate, result.value);
    break;
  }

  let activeWriteSource: Exclude<GithubOperationCredentialSource, "app"> | null = null;
  if (active) {
    for (const candidate of args.writeCandidates) {
      if (candidate.source === "app" || args.cooldown(candidate)) continue;
      const existingProbe = successfulProbes.get(candidate.token);
      const result = existingProbe
        ? { ok: true as const, value: existingProbe }
        : await args.probe(candidate);
      if (!result.ok) {
        const repositoryAccessFailure = args.isRepositoryAccessFailure(result);
        args.onRejectedProbe(candidate, result, { repositoryAccessFailure, phase: "write" });
        continue;
      }
      successfulProbes.set(candidate.token, result.value);
      if (!existingProbe) {
        args.onAuthenticatedProbe(candidate, result.value);
        args.onUsableProbe(candidate, result.value);
      }
      if (args.capabilities(candidate, result.value).write) {
        activeWriteSource = candidate.source;
        break;
      }
    }
  }

  return { active, activeWriteSource, failures };
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
