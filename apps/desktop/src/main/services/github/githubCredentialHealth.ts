import { createHash } from "node:crypto";
import type {
  GitHubAuthFailure,
  GitHubCredentialCapability,
  GitHubCredentialSource,
  GitHubCredentialState,
  GitHubRateLimitState,
  GitHubRepoRef,
} from "../../../shared/types";
import {
  githubRateLimitRetryAtMs,
  readGitHubRateLimitState,
} from "./githubRateLimit";
import {
  GITHUB_OPERATION_CREDENTIAL_PRECEDENCE,
  githubOperationCredentialCapabilities,
} from "../../../shared/githubOperationCredential";

const FALLBACK_COOLDOWN_MS = 5 * 60_000;
const SECONDARY_RATE_LIMIT_COOLDOWN_MS = 60_000;
const REPOSITORY_ACCESS_TTL_MS = 2 * 60_000;
export const GITHUB_BACKGROUND_RATE_LIMIT_RESERVE = 500;

export type GithubCredentialCandidate = {
  source: GitHubCredentialSource;
  token: string;
  capabilities: readonly GitHubCredentialCapability[];
  userLogin?: string | null;
};

type CredentialResourceHealth = {
  failure: GitHubAuthFailure | null;
  rateLimit: GitHubRateLimitState | null;
  cooldownUntilMs: number;
};

type CredentialHealth = {
  resources: Map<string, CredentialResourceHealth>;
  userLogin: string | null;
};

const healthByTokenDigest = new Map<string, CredentialHealth>();
const repositoryAccessByTokenAndRepo = new Map<string, {
  accessible: boolean;
  expiresAtMs: number;
}>();

export function githubCredentialTokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function githubCredentialInventoryKey(
  candidates: readonly GithubCredentialCandidate[],
): string {
  return candidates
    .map((candidate) => `${candidate.source}:${githubCredentialTokenDigest(candidate.token)}`)
    .join("|");
}

function repositoryAccessKey(
  candidate: GithubCredentialCandidate,
  repo: GitHubRepoRef,
): string {
  return `${githubCredentialTokenDigest(candidate.token)}:${repo.owner.trim().toLowerCase()}/${repo.name.trim().toLowerCase()}`;
}

export function githubCredentialRepositoryAccess(
  candidate: GithubCredentialCandidate,
  repo: GitHubRepoRef,
  nowMs = Date.now(),
): boolean | null {
  const key = repositoryAccessKey(candidate, repo);
  const entry = repositoryAccessByTokenAndRepo.get(key);
  if (!entry) return null;
  if (entry.expiresAtMs <= nowMs) {
    repositoryAccessByTokenAndRepo.delete(key);
    return null;
  }
  return entry.accessible;
}

export function recordGithubCredentialRepositoryAccess(
  candidate: GithubCredentialCandidate,
  repo: GitHubRepoRef,
  accessible: boolean,
  nowMs = Date.now(),
): void {
  repositoryAccessByTokenAndRepo.set(repositoryAccessKey(candidate, repo), {
    accessible,
    expiresAtMs: nowMs + REPOSITORY_ACCESS_TTL_MS,
  });
}

function normalizedLogin(login: string | null | undefined): string | null {
  const value = login?.trim().toLowerCase() ?? "";
  return value || null;
}

function healthFor(candidate: GithubCredentialCandidate): CredentialHealth | null {
  return healthByTokenDigest.get(githubCredentialTokenDigest(candidate.token)) ?? null;
}

function rateLimitResource(rateLimit: GitHubRateLimitState | null): string {
  return rateLimit?.resource?.trim().toLowerCase() || "unknown";
}

function updateResourceHealth(
  existing: CredentialHealth | undefined,
  rateLimit: GitHubRateLimitState | null,
  update: (current: CredentialResourceHealth | undefined) => CredentialResourceHealth,
): Map<string, CredentialResourceHealth> {
  const resources = new Map(existing?.resources ?? []);
  const resource = rateLimitResource(rateLimit);
  resources.set(resource, update(resources.get(resource)));
  return resources;
}

export function registerGithubCredentialIdentity(
  candidate: GithubCredentialCandidate,
  userLogin: string | null,
): void {
  const digest = githubCredentialTokenDigest(candidate.token);
  const existing = healthByTokenDigest.get(digest);
  healthByTokenDigest.set(digest, {
    resources: new Map(existing?.resources ?? []),
    userLogin: normalizedLogin(userLogin ?? candidate.userLogin),
  });
}

export function recordGithubCredentialSuccess(
  candidate: GithubCredentialCandidate,
  headers: Pick<Headers, "get">,
  userLogin?: string | null,
): GitHubRateLimitState | null {
  const digest = githubCredentialTokenDigest(candidate.token);
  const existing = healthByTokenDigest.get(digest);
  const rateLimit = readGitHubRateLimitState(headers);
  healthByTokenDigest.set(digest, {
    resources: updateResourceHealth(existing, rateLimit, (current) => ({
      failure: null,
      rateLimit: rateLimit ?? current?.rateLimit ?? null,
      cooldownUntilMs: 0,
    })),
    userLogin: normalizedLogin(userLogin ?? candidate.userLogin ?? existing?.userLogin),
  });
  return rateLimit;
}

export function recordGithubCredentialProbeSuccess(
  candidate: GithubCredentialCandidate,
  rateLimit: GitHubRateLimitState | null,
  userLogin: string | null,
): void {
  const digest = githubCredentialTokenDigest(candidate.token);
  const existing = healthByTokenDigest.get(digest);
  healthByTokenDigest.set(digest, {
    resources: updateResourceHealth(existing, rateLimit, (current) => ({
      failure: null,
      rateLimit: rateLimit ?? current?.rateLimit ?? null,
      cooldownUntilMs: 0,
    })),
    userLogin: normalizedLogin(userLogin ?? candidate.userLogin ?? existing?.userLogin),
  });
}

function recordGithubFailure(
  candidate: GithubCredentialCandidate,
  failure: GitHubAuthFailure,
  rateLimit: GitHubRateLimitState | null,
  cooldownUntilMs: number,
): void {
  const digest = githubCredentialTokenDigest(candidate.token);
  const existing = healthByTokenDigest.get(digest);
  const userLogin = normalizedLogin(candidate.userLogin ?? existing?.userLogin);
  const next: CredentialHealth = {
    resources: updateResourceHealth(existing, rateLimit, (current) => ({
      failure,
      rateLimit: rateLimit ?? current?.rateLimit ?? null,
      cooldownUntilMs,
    })),
    userLogin,
  };
  healthByTokenDigest.set(digest, next);

  // GitHub App user tokens, OAuth tokens, and PATs used on behalf of the same
  // account share the user's primary quota. Once GitHub reports that quota as
  // exhausted, stop every credential already known to represent that account.
  if (failure.kind !== "rate_limited" || !userLogin || rateLimit?.remaining !== 0) return;
  const resource = rateLimitResource(rateLimit);
  for (const [candidateDigest, candidateHealth] of healthByTokenDigest) {
    if (candidateHealth.userLogin !== userLogin) continue;
    const resources = new Map(candidateHealth.resources);
    const current = resources.get(resource);
    resources.set(resource, {
      failure,
      rateLimit: rateLimit ?? current?.rateLimit ?? null,
      cooldownUntilMs,
    });
    healthByTokenDigest.set(candidateDigest, {
      ...candidateHealth,
      resources,
    });
  }
}

export function recordGithubCredentialFailure(
  candidate: GithubCredentialCandidate,
  failure: GitHubAuthFailure,
  rateLimit: GitHubRateLimitState | null,
): void {
  const now = Date.now();
  const cooldownUntilMs = failure.kind === "rate_limited"
    ? Math.max(
        now + SECONDARY_RATE_LIMIT_COOLDOWN_MS,
        githubRateLimitRetryAtMs(failure, rateLimit) ?? 0,
      )
    : failure.kind === "invalid_token" || failure.kind === "permission_denied"
      ? now + FALLBACK_COOLDOWN_MS
      : 0;
  recordGithubFailure(candidate, failure, rateLimit, cooldownUntilMs);
}

export function recordGithubOperationFailure(
  candidate: GithubCredentialCandidate,
  failure: GitHubAuthFailure,
  rateLimit: GitHubRateLimitState | null,
): void {
  const now = Date.now();
  const cooldownUntilMs = failure.kind === "rate_limited"
    ? Math.max(
        now + SECONDARY_RATE_LIMIT_COOLDOWN_MS,
        githubRateLimitRetryAtMs(failure, rateLimit) ?? 0,
      )
    : failure.kind === "invalid_token"
      ? now + FALLBACK_COOLDOWN_MS
      : 0;
  recordGithubFailure(candidate, failure, rateLimit, cooldownUntilMs);
}

function githubCredentialCooldownMatching(
  candidate: GithubCredentialCandidate,
  nowMs = Date.now(),
  options: { resource?: string | null } = {},
  matches: (failure: GitHubAuthFailure) => boolean,
): { failure: GitHubAuthFailure; rateLimit: GitHubRateLimitState | null } | null {
  const health = healthFor(candidate);
  if (!health) return null;
  const requestedResource = options.resource?.trim().toLowerCase() || null;
  const entries = requestedResource
    ? [health.resources.get(requestedResource), health.resources.get("unknown")]
    : [...health.resources.values()];
  const cooling = entries
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(
      entry?.failure
      && entry.cooldownUntilMs > nowMs
      && matches(entry.failure),
    ))
    .sort((left, right) => right.cooldownUntilMs - left.cooldownUntilMs)[0];
  if (!cooling?.failure) return null;
  return { failure: cooling.failure, rateLimit: cooling.rateLimit };
}

export function githubCredentialCooldown(
  candidate: GithubCredentialCandidate,
  nowMs = Date.now(),
  options: { resource?: string | null } = {},
): { failure: GitHubAuthFailure; rateLimit: GitHubRateLimitState | null } | null {
  return githubCredentialCooldownMatching(candidate, nowMs, options, () => true);
}

export function githubCredentialRateLimitCooldown(
  candidate: GithubCredentialCandidate,
  nowMs = Date.now(),
  options: { resource?: string | null } = {},
): { failure: GitHubAuthFailure; rateLimit: GitHubRateLimitState | null } | null {
  return githubCredentialCooldownMatching(
    candidate,
    nowMs,
    options,
    (failure) => failure.kind === "rate_limited",
  );
}

export function githubCredentialNonRateLimitCooldown(
  candidate: GithubCredentialCandidate,
  nowMs = Date.now(),
  options: { resource?: string | null } = {},
): { failure: GitHubAuthFailure; rateLimit: GitHubRateLimitState | null } | null {
  return githubCredentialCooldownMatching(
    candidate,
    nowMs,
    options,
    (failure) => failure.kind !== "rate_limited",
  );
}

export function clearGithubCredentialHealth(token?: string): void {
  if (token) {
    const digest = githubCredentialTokenDigest(token);
    healthByTokenDigest.delete(digest);
    for (const key of repositoryAccessByTokenAndRepo.keys()) {
      if (key.startsWith(`${digest}:`)) repositoryAccessByTokenAndRepo.delete(key);
    }
    return;
  }
  healthByTokenDigest.clear();
  repositoryAccessByTokenAndRepo.clear();
}

export function githubCredentialStates(args: {
  candidates: readonly GithubCredentialCandidate[];
  availableSources: ReadonlySet<GitHubCredentialSource>;
  activeReadSource: GitHubCredentialSource | null;
  activeWriteSource: Exclude<GitHubCredentialSource, "app"> | null;
}): GitHubCredentialState[] {
  const bySource = new Map(args.candidates.map((candidate) => [candidate.source, candidate]));
  const sources: readonly GitHubCredentialSource[] = GITHUB_OPERATION_CREDENTIAL_PRECEDENCE;
  return sources.map((source) => {
    const candidate = bySource.get(source) ?? null;
    const health = candidate ? healthFor(candidate) : null;
    const cooling = candidate ? githubCredentialCooldown(candidate) : null;
    const capabilities = [...githubOperationCredentialCapabilities(source)];
    const activeFor: GitHubCredentialCapability[] = [];
    if (args.activeReadSource === source) activeFor.push("read");
    if (args.activeWriteSource === source) activeFor.push("write");
    let state: GitHubCredentialState["state"] = "unavailable";
    if (args.availableSources.has(source)) state = "ready";
    if (cooling) state = "cooldown";
    if (activeFor.length > 0) state = "active";
    return {
      source,
      available: args.availableSources.has(source),
      capabilities,
      activeFor,
      state,
      failure: cooling?.failure ?? null,
      rateLimit: cooling?.rateLimit
        ?? [...(health?.resources.values() ?? [])].find((entry) => entry.rateLimit)?.rateLimit
        ?? null,
    };
  });
}

export function githubBackgroundRequestPauseUntilMs(
  nowMs = Date.now(),
  candidates?: readonly GithubCredentialCandidate[],
): number | null {
  let pauseUntilMs: number | null = null;
  const healthEntries = candidates
    ? candidates.map((candidate) => healthFor(candidate)).filter(Boolean)
    : [...healthByTokenDigest.values()];
  for (const health of healthEntries) {
    if (!health) continue;
    for (const [resource, resourceHealth] of health.resources) {
      const rateLimit = resourceHealth.rateLimit;
      const protectsPullRequestReads = resource === "core"
        || resource === "graphql"
        || (resource === "unknown" && (rateLimit?.limit ?? 0) >= 1_000);
      if (!protectsPullRequestReads) continue;
      const remaining = rateLimit?.remaining;
      const resetAt = rateLimit?.resetAt ? Date.parse(rateLimit.resetAt) : NaN;
      if (remaining == null || remaining > GITHUB_BACKGROUND_RATE_LIMIT_RESERVE) continue;
      if (!Number.isFinite(resetAt) || resetAt <= nowMs) continue;
      pauseUntilMs = Math.max(pauseUntilMs ?? 0, resetAt);
    }
  }
  return pauseUntilMs;
}
