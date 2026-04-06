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

export type ProjectInfo = {
  rootPath: string;
  displayName: string;
  baseRef: string;
  /** Stable id for project-scoped KV (SQLite); empty when project context is dormant. */
  projectId?: string;
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
