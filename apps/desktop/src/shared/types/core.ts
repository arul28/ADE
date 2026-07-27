// ---------------------------------------------------------------------------
// Core / project-wide types
// ---------------------------------------------------------------------------

import type { DeeplinkEnvelope } from "../deeplinks";
import type {
  SyncAccountDirectoryLegDurations,
  SyncAccountDirectoryState,
} from "./sync";

export type LocalRuntimeServiceInstallState =
  | "not_attempted"
  | "installing"
  | "installed"
  | "failed"
  | "skipped";

export type LocalRuntimeServiceHealthState =
  | "unknown"
  | "not_installed"
  | "installed"
  | "running"
  | "error"
  | "unsupported";

export type LocalRuntimeConnectionState =
  | "idle"
  | "connecting"
  | "connected";

export type LocalRuntimeStatus = {
  connectionState: LocalRuntimeConnectionState;
  pid?: number | null;
  syncPort?: number | null;
  publishHealth?: {
    state: SyncAccountDirectoryState;
    failingSinceMs: number | null;
    lastLegDurations: SyncAccountDirectoryLegDurations;
  } | null;
  lastWedge?: {
    lastCommand: string;
    blockedMs: number;
    ts: string;
  } | null;
  /**
   * "isolated" means the desktop fell back to an app-owned no-sync brain
   * (phone sync and ADE Code attach to the channel service, which is down).
   * The pool keeps probing and reinstalling until it migrates back to
   * "primary".
   */
  runtimeMode: "primary" | "isolated";
  versionSkew: {
    state: "none" | "runtime_newer" | "runtime_older" | "build_mismatch" | "role_mismatch" | "unknown";
    appVersion: string | null;
    runtimeVersion: string | null;
    message: string | null;
    updatedAt: string | null;
  };
  serviceInstall: {
    state: LocalRuntimeServiceInstallState;
    attempted: boolean;
    path: string | null;
    message: string | null;
    exitCode: number | null;
    updatedAt: string | null;
  };
  serviceHealth: {
    state: LocalRuntimeServiceHealthState;
    installed: boolean | null;
    running: boolean | null;
    path: string | null;
    message: string | null;
    checkedAt: string | null;
  };
};

export type AppInfo = {
  appVersion: string;
  isPackaged: boolean;
  automationsEnabled: boolean;
  platform: NodeJS.Platform;
  arch: string;
  versions: {
    electron: string;
    chrome: string;
    node: string;
    v8: string;
  };
  env: {
    nodeEnv?: string;
    viteDevServerUrl?: string;
  };
  localRuntime: LocalRuntimeStatus | null;
};

export type AppWelcomeVideoState = {
  videoId: string;
  version: number;
  completedAt: string | null;
  dismissedAt: string | null;
};

export type PtyProcessResourceUsageSnapshot = {
  activePtyCount: number;
  ptyProcessCount: number;
  ptyCpuPercent: number | null;
  ptyMemoryMB: number | null;
};

/**
 * Disjoint process-role buckets for resource attribution. Every sampled PID is
 * classified into at most one role. Provider agents and shells are not ADE
 * infrastructure even when they descend from an ADE runtime; descendants that
 * cannot be classified from explicit spawn metadata are "unknown".
 */
export type AppResourceProcessRole =
  | "electron-main"
  | "electron-renderer"
  | "electron-helper"
  | "ade-runtime"
  | "ade-pty-host"
  | "shell"
  | "provider-agent"
  | "unknown";

export type AppResourceRoleUsage = {
  role: AppResourceProcessRole;
  processCount: number;
  cpuPercent: number | null;
  /** Summed resident set size (RSS). Shared pages count once per process, so this is aggregate resident memory — not unique/private memory and not leak evidence. */
  memoryMB: number | null;
};

export type AppResourceProcessSampleInfo = {
  /** "skipped" means nothing was active so no process sample was taken. */
  status: "ok" | "unavailable" | "skipped";
  reason: "timeout" | "spawn-error" | "exit-code" | "oversized-output" | "idle" | null;
  sampledAt: string | null;
  durationMs: number | null;
};

export type AppResourceUsageSnapshot = PtyProcessResourceUsageSnapshot & {
  sampledAt: string;
  processCount: number;
  cpuPercent: number | null;
  mainCpuPercent: number | null;
  rendererCpuPercent: number | null;
  memoryMB: number | null;
  mainMemoryMB: number | null;
  rendererMemoryMB: number | null;
  freeMemoryMB: number | null;
  totalMemoryMB: number | null;
  /** Availability/staleness of the machine process sample. Absent on legacy peers. */
  processSample?: AppResourceProcessSampleInfo | null;
  /** Disjoint per-role attribution for sampled processes. Absent on legacy peers. */
  roleUsage?: AppResourceRoleUsage[] | null;
};

export type LatestReleaseInfo = {
  version: string;
  htmlUrl: string | null;
  publishedAt: string | null;
  updateAvailable: boolean;
};

export type RecentlyInstalledUpdate = {
  version: string;
  installedAt: string;
  releaseNotesUrl: string | null;
  githubReleaseUrl: string | null;
};

export type AutoUpdateStatus = "idle" | "checking" | "downloading" | "ready" | "installing" | "error";

export type AutoUpdatePhase = "download" | "staging" | "verification" | "install";

export type AutoUpdateErrorKind =
  | "insufficient_space"
  | "disk_full"
  | "quota"
  | "network"
  | "signature"
  | "permission"
  | "verification"
  | "installer"
  | "unknown";

export type AutoUpdateErrorDetails = {
  kind: AutoUpdateErrorKind;
  phase: AutoUpdatePhase;
  message: string;
  availableBytes: number | null;
  requiredBytes: number | null;
  volumePath: string | null;
  preservesDownload: boolean;
};

export const AUTO_UPDATE_INSTALL_ABORT_REASONS = [
  "refresh_failed",
  "install_preflight_failed",
  "prepare_failed",
  "prepare_timeout",
  "handoff_failed",
] as const;

export type AutoUpdateInstallAbortReason =
  (typeof AUTO_UPDATE_INSTALL_ABORT_REASONS)[number];

export type AutoUpdateSnapshot = {
  status: AutoUpdateStatus;
  currentVersion: string;
  /** Latest version observed from electron-updater's configured feed. */
  latestKnownVersion: string | null;
  version: string | null;
  progressPercent: number | null;
  bytesPerSecond: number | null;
  transferredBytes: number | null;
  totalBytes: number | null;
  releaseNotesUrl: string | null;
  error: string | null;
  errorDetails: AutoUpdateErrorDetails | null;
  recentlyInstalled: RecentlyInstalledUpdate | null;
  /** A consented install that aborted before the native updater could take over. */
  parked: { reason: AutoUpdateInstallAbortReason; at: number } | null;
  /** Renderer-visible countdown before an idle update is applied. */
  autoApplyPending: { deadlineAt: number } | null;
  /** Explicit user cancellation suppresses another idle countdown until this epoch. */
  autoApplySuppressedUntil: number | null;
};

export type RuntimeActivityCounts = {
  activeAgentTurns: number;
  activeWorkSessions: number;
};

export type RuntimeActivitySummary = RuntimeActivityCounts & {
  idle: boolean;
};

export type UpdateInstallImpactPhone = {
  deviceId: string;
  deviceName: string;
};

/**
 * Live connections that drop while ADE (and its brain service) restarts for an
 * update. Best-effort: probes are time-boxed, so an empty list means "none
 * detected", not a guarantee.
 */
export type UpdateInstallImpact = {
  connectedPhones: UpdateInstallImpactPhone[];
};

export type ProjectInfo = {
  rootPath: string;
  displayName: string;
  baseRef: string;
};

export type WorktreeParentRef = {
  rootPath: string;
  displayName: string;
};

export type WorktreeParentInfo = WorktreeParentRef & {
  isKnownAdeProject: boolean;
  existingLane: {
    id: string;
    name: string;
    branchRef: string;
    color: string | null;
    laneType: string;
  } | null;
};

export type ProjectPathInspection = {
  inputPath: string;
  worktreeRoot: string | null;
  kind: "not-git" | "repo-root" | "ade-managed-worktree" | "linked-worktree";
  branchRef: string | null;
  parent: WorktreeParentInfo | null;
  standaloneState: { chatCount: number; laneCount: number } | null;
};

export type OpenProjectBinding =
  | {
      kind: "local";
      key: string;
      rootPath: string;
      displayName: string;
    }
  | {
      kind: "remote";
      key: string;
      targetId: string;
      runtimeName: string;
      hostname?: string;
      projectId: string;
      rootPath: string;
      displayName: string;
      /**
       * The remote project's icon as a base64 data URL, resolved on the host
       * machine. Lets the project tab show the real project logo instead of a
       * blank folder. Null/absent when the host couldn't resolve an icon.
       */
      iconDataUrl?: string | null;
    };

export type AppNavigationTarget =
  | {
      kind: "work" | "chat";
      sessionId?: string | null;
      laneId?: string | null;
      envelope?: DeeplinkEnvelope | null;
      event?: number | null;
      offset?: number | null;
    }
  | {
      kind: "file";
      path: string;
      line?: number | null;
      laneId?: string | null;
    }
  | {
      kind: "commit";
      sha: string;
      laneId?: string | null;
      envelope?: DeeplinkEnvelope | null;
    }
  | {
      kind: "artifact";
      artifactId: string;
      envelope?: DeeplinkEnvelope | null;
    }
  | {
      kind: "lane";
      laneId: string;
      sessionId?: string | null;
      envelope?: DeeplinkEnvelope | null;
    }
  | {
      kind: "pr";
      prId?: string | null;
      prNumber?: number | null;
      laneId?: string | null;
      // For inbound deeplinks: when the PR isn't local yet, the renderer needs the
      // owner/name to either jump to the PRs tab pre-filtered or fall back to the
      // create-lane-from-PR-branch modal.
      repoOwner?: string | null;
      repoName?: string | null;
    }
  | {
      kind: "branch";
      // Cross-machine deeplink target. The renderer opens the existing
      // "Create lane from PR branch" preflight modal with these inputs;
      // if a lane already exists for this branch the renderer routes to it
      // instead of showing the modal.
      repoOwner: string;
      repoName: string;
      branch: string;
      prNumber?: number | null;
    }
  | {
      kind: "linear-issue";
      // Linear coding-tool hand-off. The renderer resolves the actual lane
      // by looking up lane.linearIssue.identifier; if no lane matches, the
      // user is offered a fallback (e.g., open lanes filtered by branch).
      issueIdentifier: string;
      branch?: string | null;
    }
  | {
      kind: "route";
      route: string;
    }
  | {
      kind: "files-external";
      /** Absolute local path requested by Finder/Open With or a native OS drop. */
      path: string;
    };

export type AppNavigationRequest = {
  target: AppNavigationTarget;
  source?: "ade-code" | "desktop" | "cli" | string;
};

/**
 * Window-zoom command dispatched from the native View menu to the renderer so
 * menu/keyboard zoom flows through the same path as the in-app zoom counter
 * (display %, persistence, and the macOS traffic-light inset stay in sync).
 */
export type AppZoomCommand = "in" | "out" | "reset";

export type AppNavigationResult = {
  ok: boolean;
  mode: "desktop" | "unavailable";
  windowId?: number | null;
  route?: string;
  message?: string;
};

export type ProjectBrowseInput = {
  partialPath?: string;
  cwd?: string | null;
  limit?: number;
};

export type ProjectBrowseEntry = {
  name: string;
  fullPath: string;
  isGitRepo: boolean;
  /**
   * When the entry is a linked git worktree, the repo it belongs to. Populated
   * cheaply from the `.git` gitdir pointer (no git shell-out) for git entries.
   */
  worktreeOf?: WorktreeParentRef;
};

export type ProjectLanguageShare = {
  name: string;
  fraction: number;
};

export type ProjectLastCommit = {
  subject: string;
  isoDate: string;
  shortSha: string;
};

export type ProjectDirtyBreakdown = {
  staged: number;
  unstaged: number;
  untracked: number;
};

export type ProjectDetail = {
  rootPath: string;
  isGitRepo: boolean;
  worktreeOf?: WorktreeParentRef;
  branchName: string | null;
  dirtyCount: number | null;
  /** Split of the dirty count into staged / unstaged / untracked for the hover tooltip. */
  dirtyBreakdown: ProjectDirtyBreakdown | null;
  aheadBehind: { ahead: number; behind: number } | null;
  lastCommit: ProjectLastCommit | null;
  readmeExcerpt: string | null;
  languages: ProjectLanguageShare[];
  laneCount: number | null;
  lastOpenedAt: string | null;
  subdirectoryCount: number | null;
};

export type ProjectBrowseResult = {
  inputPath: string;
  resolvedPath: string;
  directoryPath: string;
  parentPath: string | null;
  exactDirectoryPath: string | null;
  openableProjectRoot: string | null;
  entries: ProjectBrowseEntry[];
};

export type ClearLocalAdeDataArgs = {
  packs?: boolean;
  logs?: boolean;
  transcripts?: boolean;
};

export type ClearLocalAdeDataResult = {
  deletedPaths: string[];
  clearedAt: string;
};

export type RecentProjectRemoteRef = {
  targetId: string;
  projectId: string;
  /** Human-friendly machine name shown on the recents row chip. */
  runtimeName: string;
  hostname: string;
  /** Host-resolved project logo for remote recents, when available. */
  iconDataUrl?: string | null;
};

export type RecentProjectSummary = {
  rootPath: string;
  displayName: string;
  lastOpenedAt: string;
  exists: boolean;
  worktreeOf?: WorktreeParentRef;
  laneCount?: number;
  /** Defaults to "local" when absent (back-compat with older callers). */
  kind?: "local" | "remote";
  /** Present iff kind === "remote". */
  remote?: RecentProjectRemoteRef;
  /**
   * The repo's `origin` remote, when it has one. Normalized through
   * `normalizeGitRemoteIdentity` this is what joins a local checkout and a
   * remote checkout of the same repository into a single project tab.
   */
  gitOriginUrl?: string | null;
  /** Pinned recents sort above the recency order. */
  pinned?: boolean;
};

export type ProjectFindForRepoArgs = {
  repoOwner: string;
  repoName: string;
};

/** A known local project (active or recent) whose git origin matches the repo. */
export type ProjectFindForRepoResult = {
  rootPath: string;
  displayName: string;
} | null;

export type CreateProjectInput = {
  name: string;
  parentDir: string;
};

export type CreateProjectResult = {
  rootPath: string;
};

export type CloneProjectInput = {
  url: string;
  parentDir: string;
  name?: string;
  githubAuthHeader?: string;
};

export type CloneProjectResult = {
  rootPath: string;
};

export type MyGitHubRepoSummary = {
  owner: string;
  name: string;
  fullName: string;
  isPrivate: boolean;
  pushedAt: string | null;
  defaultBranch: string;
  htmlUrl: string;
  cloneUrl: string;
  sshUrl: string;
};

export type ListMyGitHubReposInput = {
  search?: string;
};

export type ListMyGitHubReposResult = {
  repos: MyGitHubRepoSummary[];
};

export type PublishProjectInput = {
  owner?: string;
  name: string;
  description?: string;
  isPrivate: boolean;
};

export type PublishProjectResult = {
  state: "pushed" | "remote_added";
  owner: string;
  name: string;
  fullName: string;
  htmlUrl: string;
};

export type ProjectIcon = {
  dataUrl: string | null;
  sourcePath: string | null;
  mimeType: string | null;
};

export type ProviderMode = "guest" | "subscription";

/** Universal model identifier, e.g. "anthropic/claude-sonnet-5" or "openai/gpt-5.3-codex" */
export type ModelId = string;

// react-resizable-panels uses a map of panel id -> percentage (0..100)
export type DockLayout = Record<string, number>;

export type OnboardingStatus = {
  completedAt: string | null;
  dismissedAt: string | null;
  freshProject?: boolean;
};

export type OnboardingDetectionIndicator = {
  file: string;
  type: string;
  confidence: number;
};

export type OnboardingDetectionResult = {
  projectTypes: string[];
  indicators: OnboardingDetectionIndicator[];
  suggestedConfig: import("./config").ProjectConfigFile;
  suggestedWorkflows: Array<{ path: string; kind: "github-actions" | "gitlab-ci" | "other" }>;
};

export type OnboardingExistingLaneCandidate = {
  branchRef: string;
  isCurrent: boolean;
  hasRemote: boolean;
  ahead: number;
  behind: number;
};

export type OnboardingHelpState = {
  glossaryTermsSeen: string[];
};

export type KeybindingOverride = {
  id: string;
  binding: string;
};

export type KeybindingDefinition = {
  id: string;
  description: string;
  defaultBinding: string;
  scope: "global" | "lanes" | "files" | "graph" | "conflicts" | "history";
};

export type KeybindingsSnapshot = {
  definitions: KeybindingDefinition[];
  overrides: KeybindingOverride[];
};

export type AgentTool = {
  id: string;
  label: string;
  command: string;
  installed: boolean;
  detectedPath: string | null;
  detectedVersion: string | null;
};
