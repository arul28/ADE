// ---------------------------------------------------------------------------
// Git types
// ---------------------------------------------------------------------------

import type { GitHubServiceHealth } from "../githubServiceHealth";

export type GitSyncMode = "merge" | "rebase";
export type GitPullMode = "ff-only" | "rebase" | "merge";

export type GitFileActionArgs = {
  laneId: string;
  path: string;
};

export type GitBatchFileActionArgs = {
  laneId: string;
  paths: string[];
};

export type GitCommitArgs = {
  laneId: string;
  message: string;
  amend?: boolean;
};

export type GitGenerateCommitMessageArgs = {
  laneId: string;
  amend?: boolean;
};

export type GitGenerateCommitMessageResult = {
  message: string;
  model: string | null;
};

export type GitRevertArgs = {
  laneId: string;
  commitSha: string;
};

export type GitCherryPickArgs = {
  laneId: string;
  commitSha: string;
};

export type GitCreateTagArgs = {
  laneId: string;
  commitSha: string;
  tagName: string;
  message?: string;
};

export type GitResetCommitArgs = {
  laneId: string;
  commitSha: string;
  mode: "soft" | "mixed" | "hard";
};

export type GitStashPushArgs = {
  laneId: string;
  message?: string;
  includeUntracked?: boolean;
};

export type GitStashRefArgs = {
  laneId: string;
  stashRef: string;
  stashOid?: string;
};

export type GitSyncArgs = {
  laneId: string;
  mode?: GitSyncMode;
  baseRef?: string;
};

export type GitPullArgs = {
  laneId: string;
  mode?: GitPullMode;
};

export type GitHeadChangeActionArgs = {
  laneId: string;
};

export type GitPushArgs = {
  laneId: string;
  forceWithLease?: boolean;
};

export type GitRecommendedAction = "none" | "pull" | "push" | "force_push_lease";
export type GitUpstreamState = "none" | "tracking" | "missing";

export type GitUpstreamSyncStatus = {
  hasUpstream: boolean;
  upstreamState: GitUpstreamState;
  upstreamRef: string | null;
  ahead: number;
  behind: number;
  diverged: boolean;
  recommendedAction: GitRecommendedAction;
};

export type GitConflictKind = "merge" | "rebase" | null;

export type GitConflictState = {
  laneId: string;
  kind: GitConflictKind;
  inProgress: boolean;
  conflictedFiles: string[];
  canContinue: boolean;
  canAbort: boolean;
};

export type GitActionResult = {
  operationId: string;
  preHeadSha: string | null;
  postHeadSha: string | null;
};

export type GitCommitSummary = {
  sha: string;
  shortSha: string;
  parents: string[];
  authorName: string;
  authoredAt: string;
  subject: string;
  pushed: boolean;
};

export type GitFileHistoryEntry = {
  commitSha: string;
  shortSha: string;
  authorName: string;
  authoredAt: string;
  subject: string;
  path: string;
  previousPath?: string | null;
  changeType: "added" | "modified" | "deleted" | "renamed" | "copied" | "unknown";
};

export type GitListCommitFilesArgs = {
  laneId: string;
  commitSha: string;
};

export type GitGetCommitMessageArgs = {
  laneId: string;
  commitSha: string;
};

export type GitGetFileHistoryArgs = {
  laneId: string;
  path: string;
  limit?: number;
};

export type GitStashSummary = {
  oid: string;
  ref: string;
  subject: string;
  createdAt: string | null;
};

export type DiffMode = "unstaged" | "staged" | "commit";

export type FileChange = {
  path: string;
  oldPath?: string;
  kind: "modified" | "added" | "deleted" | "renamed" | "untracked" | "unknown";
  additions?: number;
  deletions?: number;
  isBinary?: boolean;
};

export type DiffChanges = {
  unstaged: FileChange[];
  staged: FileChange[];
};

export type DiffLineStats = {
  additions: number;
  deletions: number;
  files: number;
};

export type GetDiffChangesArgs = {
  laneId: string;
};

export type GetFileDiffArgs = {
  laneId: string;
  path: string; // repo-relative path
  mode: DiffMode;
  compareRef?: string;
  compareTo?: "worktree" | "parent";
};

export type GetFilePatchArgs = GetFileDiffArgs;

export type DiffSide = {
  exists: boolean;
  text: string;
  size?: number;
  isTruncated?: boolean;
};

export type FilePatch = {
  path: string;
  oldPath?: string;
  mode: DiffMode;
  patch: string;
  additions?: number;
  deletions?: number;
  status?: FileChange["kind"];
  isBinary?: boolean;
  isTruncated?: boolean;
  size?: number;
};

export type FileDiff = {
  path: string;
  mode: DiffMode;
  original: DiffSide;
  modified: DiffSide;
  isBinary?: boolean;
  language?: string;
};

export type WriteTextAtomicArgs = {
  laneId: string;
  path: string; // repo-relative path
  text: string;
};

export type GitBranchSummary = {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
  upstream: string | null;
  ownedByLaneId?: string | null;
  ownedByLaneName?: string | null;
  profiledInCurrentLane?: boolean;
  hasOpenPr?: boolean;
  /** SHA of the branch tip (most recent commit). */
  lastCommitSha?: string;
  /** Subject line of the most recent commit. */
  lastCommitMessage?: string;
  /** ISO-8601 timestamp of the most recent commit. */
  lastCommitDate?: string;
  /** Author name of the most recent commit. */
  lastCommitAuthor?: string;
};

export type GitListBranchesArgs = {
  laneId: string;
};

export type GitUserIdentity = {
  name: string;
  email: string;
};

export type GitHubAutolink = {
  id: number;
  keyPrefix: string;
  urlTemplate: string;
  isAlphanumeric: boolean;
};

export type GitGetUserIdentityArgs = {
  laneId: string;
};

/**
 * Lightweight PR info keyed by branch — used by the branch picker. Independent
 * of the full PrSummary because we want to surface PRs whose head branch may
 * not be tied to any local lane yet.
 */
export type BranchPullRequest = {
  branch: string;
  prNumber: number;
  title: string;
  state: "open" | "closed" | "merged" | "draft";
  url: string;
  author: string | null;
  updatedAt: string | null;
};

export type GitCheckoutBranchArgs = {
  laneId: string;
  branchName: string;
  mode?: "existing" | "create";
  startPoint?: string;
  baseRef?: string;
  acknowledgeActiveWork?: boolean;
};

export type GitHubRepoRef = {
  owner: string;
  name: string;
};

export type GitHubRateLimitState = {
  limit: number | null;
  remaining: number | null;
  used: number | null;
  resetAt: string | null;
  resource: string | null;
};

export type GitHubAuthFailure = {
  // `service_unavailable` means GitHub itself returned 5xx. It is NOT a
  // credential problem, and clients must not offer reconnect/re-auth for it —
  // reconnecting during a GitHub outage cannot help and risks the user
  // replacing a perfectly good token.
  kind:
    | "rate_limited"
    | "invalid_token"
    | "permission_denied"
    | "service_unavailable"
    | "network"
    | "unknown";
  message: string;
  retryAt: string | null;
};

export type GitHubAuthFailureKind = GitHubAuthFailure["kind"];

/**
 * What every *automatic* GitHub reader needs to know before it spends a
 * request, delivered as data rather than as an error message — a rejection
 * cannot carry it, because Electron IPC and the runtime's JSON-RPC both flatten
 * an error to its message.
 *
 * Zero-network to produce, so it is safe to consult on a timer and while GitHub
 * is refusing. Every field is optional-by-nullability: a runtime that does not
 * implement the read leaves clients on their own local backoff rather than
 * breaking them. See `docs/features/pull-requests/README.md`, "Keeping
 * automatic GitHub reads inside the quota".
 */
export type GitHubRequestBudget = {
  /**
   * The quota reset instant, set once an available credential reaches the
   * 500-request background reserve; null while requests may proceed. Callers
   * resume by themselves because the value is the instant the quota refills.
   */
  pausedUntil: string | null;
  /**
   * The worst failure currently recorded on a PR-read resource — worst meaning
   * the one that justifies the longest stand-down — or null when the most
   * recent request succeeded, or when the failure is old enough that it no
   * longer describes the request the caller just made. `service_unavailable` carries no `pausedUntil`
   * (a GitHub 5xx must never park a credential) but still tells a poller to
   * lengthen its cadence.
   */
  failureKind: GitHubAuthFailureKind | null;
  /** Retry instant GitHub supplied for {@link failureKind}, when it gave one. */
  retryAt: string | null;
};

export type GitHubCredentialSource = "environment" | "app" | "gh" | "pat";

export type GitHubCredentialCapability = "read" | "write";

export type GitHubCredentialState = {
  source: GitHubCredentialSource;
  available: boolean;
  capabilities: GitHubCredentialCapability[];
  activeFor: GitHubCredentialCapability[];
  state: "active" | "ready" | "cooldown" | "unavailable";
  failure: GitHubAuthFailure | null;
  rateLimit: GitHubRateLimitState | null;
};

export type GitHubCredentialVerification = {
  source: GitHubCredentialSource;
  capabilities: GitHubCredentialCapability[];
  userLogin: string | null;
  failure: GitHubAuthFailure | null;
  rateLimit: GitHubRateLimitState | null;
};

export type GitHubCredentialFallback = {
  capability: GitHubCredentialCapability;
  fromSource: GitHubCredentialSource;
  toSource: GitHubCredentialSource;
  reason: GitHubAuthFailure["kind"];
  retryAt: string | null;
};

export type GitHubTokenType = "classic" | "fine-grained" | "oauth" | "unknown";

export type GitHubStatus = {
  tokenStored: boolean;
  patTokenStored: boolean;
  tokenDecryptionFailed: boolean;
  /**
   * True when ADE's encrypted credential store could not be decrypted on this
   * read. Optional for compatibility with older remote runtimes, which simply
   * omit it.
   *
   * An unreadable store returns an EMPTY view instead of throwing, so every
   * "no token" conclusion downstream of it is indistinguishable from a fresh
   * install. Clients MUST NOT render this as "never connected": the saved
   * credentials are still on disk, and inviting the user to reconnect over them
   * is how a recoverable read failure turns into real credential loss.
   */
  credentialStoreUnreadable?: boolean;
  storageScope: "app";
  authSource: "app" | "pat" | "environment" | "gh" | "none";
  tokenType?: GitHubTokenType;
  repo: GitHubRepoRef | null;
  // True when the project has any `origin` remote, even non-GitHub. Distinct
  // from `repo != null`, which is only true for GitHub origins. The Publish
  // CTA must hide for non-GitHub origins or it dead-ends in remote_already_exists.
  hasOrigin: boolean;
  userLogin: string | null;
  scopes: string[];
  ghCliPath: string | null;
  ghAuthError: string | null;
  checkedAt: string | null;
  // Optional for compatibility with older remote runtimes. A present failure
  // means ADE found a token but could not finish validating it; it must not be
  // flattened into "missing scopes" by clients.
  authFailure?: GitHubAuthFailure | null;
  rateLimit?: GitHubRateLimitState | null;
  // Set only when a GitHub request failed AND githubstatus.com corroborates an
  // incident on a surface ADE depends on. Present means "this failure is
  // GitHub's, not the user's"; absent means ADE makes no claim either way (the
  // status page lags real incidents, so absence proves nothing).
  serviceHealth?: GitHubServiceHealth | null;
  // Optional for compatibility with older runtimes. These fields describe the
  // operation credential chain without exposing credential material.
  writeAuthSource?: Exclude<GitHubStatus["authSource"], "app">;
  writeUserLogin?: string | null;
  credentialStates?: GitHubCredentialState[];
  credentialFallback?: GitHubCredentialFallback | null;
  backgroundRefreshPausedUntil?: string | null;
  // null = no repo to probe / probe not run; true/false = result of GET /repos/{owner}/{repo}.
  // Required because fine-grained tokens pass /user validation even when the user forgot to
  // grant the active repo, which then 403s every PR-tab call.
  repoAccessOk: boolean | null;
  repoAccessError: string | null;
  // Single source of truth for "GitHub reads are usable here". Write surfaces
  // additionally require writeAuthSource !== "none".
  connected: boolean;
};

/**
 * The one wording for `credentialStoreUnreadable`, shared by every surface that
 * has to say it: the PR tab's empty state (built in the main process), the
 * integration banner, and the Settings card. Lives beside the field rather than
 * in a renderer helper because the main process needs it too, and two hand-kept
 * copies of the same sentence is how the "not connected" masking survived in
 * more than one place to begin with.
 */
export const GITHUB_CREDENTIAL_STORE_UNREADABLE_COPY = {
  subState: "credential-store-unreadable",
  statusLabel: "Can't read sign-in",
  title: "ADE can't read your saved sign-in on this computer",
  detail: "Your GitHub connection may still be there — ADE just can't open it. Repair it in Settings → Connections.",
  action: "Open connections",
} as const;

export type GitHubSetTokenResult = GitHubStatus & {
  credentialVerification: GitHubCredentialVerification;
};

export type GitHubAppInstallationStatus = {
  repo: GitHubRepoRef | null;
  appName: string;
  appSlug: string;
  installUrl: string;
  manageUrl: string;
  relayConfigured: boolean;
  installed: boolean;
  state: "configured" | "not_installed" | "unconfigured" | "unknown" | "error";
  installationId: number | null;
  repositorySelection: "all" | "selected" | "unknown" | null;
  lastSeenAt: string | null;
  webhookEvents: string[];
  missingWebhookEvents: string[];
  webhookState: "active" | "deleted" | "unknown";
  webhookLastSeenAt: string | null;
  checkedAt: string;
  error: string | null;
};

export type GitHubAppUserAuthCredentialState = "missing" | "authorized" | "blocked" | "needs_reauth";

export type GitHubAppUserAuthRefreshError = {
  kind: "rate_limited" | "outage" | "network" | "dead_token" | "unknown";
  message: string;
  status: number | null;
  at: string;
};

export type GitHubAppUserAuthStatus = {
  configured: boolean;
  tokenStored: boolean;
  userLogin: string | null;
  expiresAt: string | null;
  refreshTokenExpiresAt: string | null;
  // The honest account state. An access token past its 8-hour life with a live
  // refresh token is still "authorized": it renews on use. "blocked" means the
  // refresh endpoint is failing transiently (rate limit, outage, network) and
  // retries are paused until refreshBlockedUntil. "needs_reauth" means the
  // refresh token is absent, expired, or rejected by GitHub — only then may the
  // UI ask the user to re-authorize.
  credentialState: GitHubAppUserAuthCredentialState;
  refreshBlockedUntil: string | null;
  lastRefreshError: GitHubAppUserAuthRefreshError | null;
  checkedAt: string;
  error: string | null;
};

export type GitHubAppDeviceAuthStartResult = {
  sessionId: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  expiresAt: string;
  intervalSec: number;
};

export type GitHubAppDeviceAuthPollResult = {
  status: "pending" | "slow_down" | "authorized" | "expired" | "denied" | "error";
  intervalSec: number | null;
  message: string | null;
  authStatus: GitHubAppUserAuthStatus | null;
};

export type ListOperationsArgs = {
  laneId?: string;
  kind?: string;
  status?: "running" | "succeeded" | "failed" | "canceled";
  limit?: number;
};

export type OperationRecord = {
  id: string;
  laneId: string | null;
  laneName: string | null;
  kind: string;
  startedAt: string;
  endedAt: string | null;
  status: "running" | "succeeded" | "failed" | "canceled";
  preHeadSha: string | null;
  postHeadSha: string | null;
  metadataJson: string | null;
};

export type ExportHistoryArgs = Omit<ListOperationsArgs, "status"> & {
  status?: OperationRecord["status"] | "all";
  format: "csv" | "json";
};

export type ExportHistoryResult =
  | { cancelled: true }
  | {
      cancelled: false;
      savedPath: string;
      bytesWritten: number;
      exportedAt: string;
      rowCount: number;
      format: "csv" | "json";
    };

// ---------------------------------------------------------------------------
// Metadata type aliases
// ---------------------------------------------------------------------------

/** Metadata stored on operation rows (git operations service). Known keys:
 *  path, count, amend, message, commitSha, stashRef, mode, branchName, etc. */
export type OperationMetadata = Record<string, unknown> & {
  error?: string;
};
