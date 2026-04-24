// ---------------------------------------------------------------------------
// Core / project-wide types
// ---------------------------------------------------------------------------

export type AppInfo = {
  appVersion: string;
  isPackaged: boolean;
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
};

export type RecentlyInstalledUpdate = {
  version: string;
  installedAt: string;
  releaseNotesUrl: string | null;
};

export type AutoUpdateStatus = "idle" | "checking" | "downloading" | "ready" | "error";

export type AutoUpdateSnapshot = {
  status: AutoUpdateStatus;
  version: string | null;
  progressPercent: number | null;
  bytesPerSecond: number | null;
  transferredBytes: number | null;
  totalBytes: number | null;
  releaseNotesUrl: string | null;
  error: string | null;
  recentlyInstalled: RecentlyInstalledUpdate | null;
};

export type ProjectInfo = {
  rootPath: string;
  displayName: string;
  baseRef: string;
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

export type ProjectDetail = {
  rootPath: string;
  isGitRepo: boolean;
  branchName: string | null;
  dirtyCount: number | null;
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

export type RecentProjectSummary = {
  rootPath: string;
  displayName: string;
  lastOpenedAt: string;
  exists: boolean;
  laneCount?: number;
};

export type ProviderMode = "guest" | "subscription";

/** Universal model identifier, e.g. "anthropic/claude-sonnet-4-6" or "openai/gpt-5.3-codex" */
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

export type OnboardingTourEntry = {
  completedAt: string | null;
  dismissedAt: string | null;
  lastStepIndex: number;
};

// Round 2: variant-aware tour storage. A tour can now be run as a full
// step-by-step walkthrough or as a "highlights" capsule; each variant
// tracks progress independently. `OnboardingTourVariantEntry` is the
// shape used inside the new `tourVariants` map.
export type OnboardingTourVariantEntry = {
  completedAt: string | null;
  dismissedAt: string | null;
  lastStepIndex: number;
};

export type OnboardingTourEntryV2 = {
  full: OnboardingTourVariantEntry;
  highlights: OnboardingTourVariantEntry;
};

export type OnboardingTourVariant = "full" | "highlights";

// Round 2: first-session tutorial (13-act story). Independent of the
// per-tab tours and of the welcome wizard. `dismissedAt` captures a
// "Not now" click; `silenced` captures a permanent "Don't show this
// again"; `completedAt` means the tutorial finished.
export type OnboardingTutorialState = {
  completedAt: string | null;
  dismissedAt: string | null;
  silenced: boolean;
  inProgress: boolean;
  lastActIndex: number;
  ctxSnapshot: Record<string, unknown>;
};

export type OnboardingTourProgress = {
  wizardCompletedAt: string | null;
  wizardDismissedAt: string | null;
  // Legacy flat per-tour progress. Preserved for backward compat with
  // existing renderer callers; new variant-aware callers should prefer
  // `tourVariants`.
  tours: Record<string, OnboardingTourEntry>;
  // Round 2: variant-aware progress keyed by base tour id. Optional on
  // the type to ease migration — callers that don't care about variants
  // can omit it. The main-process service always returns it populated.
  tourVariants?: Record<string, OnboardingTourEntryV2>;
  // Round 2: first-session tutorial slab. Optional for the same reason.
  tutorial?: OnboardingTutorialState;
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
  scope: "global" | "lanes" | "files" | "run" | "graph" | "conflicts" | "history";
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
