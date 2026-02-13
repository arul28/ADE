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
};

export type LaneType = "primary" | "worktree" | "attached";

export type ProviderMode = "guest" | "hosted" | "byok" | "cli";

export type LaneStatus = {
  dirty: boolean;
  ahead: number;
  behind: number;
};

export type LaneSummary = {
  id: string;
  name: string;
  description?: string | null;
  laneType: LaneType;
  baseRef: string;
  branchRef: string;
  worktreePath: string;
  attachedRootPath?: string | null;
  parentLaneId: string | null;
  childCount: number;
  stackDepth: number;
  parentStatus: LaneStatus | null;
  isEditProtected: boolean;
  status: LaneStatus;
  color: string | null;
  icon: LaneIcon | null;
  tags: string[];
  createdAt: string;
  archivedAt?: string | null;
};

export type LaneIcon = "star" | "flag" | "bolt" | "shield" | "tag" | null;

export type ConflictStatusValue =
  | "merge-ready"
  | "behind-base"
  | "conflict-predicted"
  | "conflict-active"
  | "unknown";

export type ConflictRiskLevel = "none" | "low" | "medium" | "high";

export type ConflictFileType = "content" | "rename" | "delete" | "add";

export type ConflictStatus = {
  laneId: string;
  status: ConflictStatusValue;
  overlappingFileCount: number;
  peerConflictCount: number;
  lastPredictedAt: string | null;
};

export type ConflictOverlap = {
  peerId: string | null;
  peerName: string;
  files: Array<{
    path: string;
    conflictType: ConflictFileType;
  }>;
  riskLevel: ConflictRiskLevel;
};

export type RiskMatrixEntry = {
  laneAId: string;
  laneBId: string;
  riskLevel: ConflictRiskLevel;
  overlapCount: number;
  hasConflict: boolean;
  computedAt: string | null;
  stale: boolean;
};

export type BatchOverlapEntry = {
  laneAId: string;
  laneBId: string;
  files: string[];
};

export type MergeSimulationArgs = {
  laneAId: string;
  laneBId?: string;
};

export type MergeSimulationResult = {
  outcome: "clean" | "conflict" | "error";
  mergedFiles: string[];
  conflictingFiles: Array<{
    path: string;
    conflictMarkers: string;
  }>;
  diffStat: {
    insertions: number;
    deletions: number;
    filesChanged: number;
  };
  error?: string;
};

export type ConflictPrediction = {
  id: string;
  laneAId: string;
  laneBId: string | null;
  status: "clean" | "conflict" | "unknown";
  conflictingFiles: Array<{ path: string; conflictType: string }>;
  overlapFiles: string[];
  laneASha: string;
  laneBSha: string | null;
  predictedAt: string;
};

export type BatchAssessmentResult = {
  lanes: ConflictStatus[];
  matrix: RiskMatrixEntry[];
  overlaps: BatchOverlapEntry[];
  computedAt: string;
  progress?: {
    completedPairs: number;
    totalPairs: number;
  };
  truncated?: boolean;
  maxAutoLanes?: number;
  totalLanes?: number;
  comparedLaneIds?: string[];
};

export type GetLaneConflictStatusArgs = { laneId: string };
export type ListOverlapsArgs = { laneId: string };
export type RunConflictPredictionArgs = { laneId?: string; laneIds?: string[] };

export type ConflictChipKind = "new-overlap" | "high-risk";

export type ConflictChip = {
  laneId: string;
  peerId: string | null;
  kind: ConflictChipKind;
  overlapCount: number;
};

export type ConflictEventPayload =
  | {
      type: "prediction-progress";
      computedAt: string;
      laneIds: string[];
      completedPairs: number;
      totalPairs: number;
      pair?: { laneAId: string; laneBId: string };
    }
  | {
      type: "prediction-complete";
      computedAt: string;
      laneIds: string[];
      chips: ConflictChip[];
      completedPairs: number;
      totalPairs: number;
    };

export type ConflictProposalSource = "hosted" | "local";
export type ConflictProposalStatus = "pending" | "applied" | "rejected";

export type ConflictProposal = {
  id: string;
  laneId: string;
  peerLaneId: string | null;
  predictionId: string | null;
  source: ConflictProposalSource;
  confidence: number | null;
  explanation: string;
  diffPatch: string;
  status: ConflictProposalStatus;
  jobId: string | null;
  artifactId: string | null;
  appliedOperationId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RequestConflictProposalArgs = {
  laneId: string;
  peerLaneId?: string | null;
};

export type ApplyConflictProposalArgs = {
  laneId: string;
  proposalId: string;
  applyMode?: "unstaged" | "staged" | "commit";
  commitMessage?: string;
};

export type UndoConflictProposalArgs = {
  laneId: string;
  proposalId: string;
};

export type GitHubRepoRef = {
  owner: string;
  name: string;
};

export type GitHubStatus = {
  tokenStored: boolean;
  repo: GitHubRepoRef | null;
  userLogin: string | null;
  scopes: string[];
  checkedAt: string | null;
};

export type HostedGitHubAppStatus = {
  configured: boolean;
  connected: boolean;
  installationId: string | null;
  connectedAt: string | null;
  appSlug: string | null;
};

export type HostedGitHubConnectStartResult = {
  installUrl: string;
  state: string;
  expiresAt: string;
  callbackUrl: string;
};

export type HostedGitHubDisconnectResult = {
  disconnected: true;
};

export type HostedGitHubEvent = {
  eventId: string;
  githubEvent: string;
  action: string | null;
  repoFullName: string | null;
  prNumber: number | null;
  summary: string;
  createdAt: string;
};

export type HostedGitHubEventsResult = {
  events: HostedGitHubEvent[];
};

export type HostedGitHubProxyRequestArgs = {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
};

export type PrState = "draft" | "open" | "merged" | "closed";
export type PrChecksStatus = "pending" | "passing" | "failing" | "none";
export type PrReviewStatus = "none" | "requested" | "approved" | "changes_requested";
export type MergeMethod = "merge" | "squash" | "rebase";

export type PrSummary = {
  id: string;
  laneId: string;
  projectId: string;
  repoOwner: string;
  repoName: string;
  githubPrNumber: number;
  githubUrl: string;
  githubNodeId: string | null;
  title: string;
  state: PrState;
  baseBranch: string;
  headBranch: string;
  checksStatus: PrChecksStatus;
  reviewStatus: PrReviewStatus;
  additions: number;
  deletions: number;
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PrStatus = {
  prId: string;
  state: PrState;
  checksStatus: PrChecksStatus;
  reviewStatus: PrReviewStatus;
  isMergeable: boolean;
  mergeConflicts: boolean;
  behindBaseBy: number;
};

export type PrCheck = {
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: "success" | "failure" | "neutral" | "skipped" | "cancelled" | null;
  detailsUrl: string | null;
  startedAt: string | null;
  completedAt: string | null;
};

export type PrReview = {
  reviewer: string;
  state: "pending" | "approved" | "changes_requested" | "commented" | "dismissed";
  body: string | null;
  submittedAt: string | null;
};

export type LandResult = {
  prId: string;
  prNumber: number;
  success: boolean;
  mergeCommitSha: string | null;
  branchDeleted: boolean;
  laneArchived: boolean;
  error: string | null;
};

export type CreatePrFromLaneArgs = {
  laneId: string;
  title: string;
  body: string;
  draft: boolean;
  baseBranch?: string;
  labels?: string[];
  reviewers?: string[];
};

export type LinkPrToLaneArgs = {
  laneId: string;
  prUrlOrNumber: string;
};

export type UpdatePrDescriptionArgs = {
  prId: string;
  body: string;
};

export type LandPrArgs = {
  prId: string;
  method: MergeMethod;
};

export type LandStackArgs = {
  rootLaneId: string;
  method: MergeMethod;
};

export type HostedJobType =
  | "NarrativeGeneration"
  | "ConflictResolution"
  | "ProposeConflictResolution"
  | "DraftPrDescription";

export type HostedMirrorSyncArgs = {
  laneId?: string;
  includeTranscripts?: boolean;
};

export type HostedMirrorSyncResult = {
  remoteProjectId: string;
  lanesSynced: string[];
  uploaded: number;
  deduplicated: number;
  excluded: number;
  manifestCount: number;
  transcriptCount: number;
  packCount: number;
  syncedAt: string;
};

export type HostedJobSubmissionArgs = {
  type: HostedJobType;
  laneId: string;
  params?: Record<string, unknown>;
};

export type HostedJobSubmissionResult = {
  remoteProjectId: string;
  jobId: string;
  status: "queued" | "processing" | "completed" | "failed";
};

export type HostedJobStatusResult = {
  jobId: string;
  status: "queued" | "processing" | "completed" | "failed";
  artifactId?: string;
  completedAt?: string;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
};

export type HostedArtifactResult = {
  artifactId: string;
  type: string;
  content: unknown;
  createdAt: string;
  contentHash: string;
};

export type HostedAuthStatus = {
  signedIn: boolean;
  expiresAt: string | null;
  hasRefreshToken: boolean;
  userId: string | null;
  email: string | null;
  displayName: string | null;
};

export type HostedBootstrapConfig = {
  stage: string;
  apiBaseUrl: string;
  region: string;
  clerkPublishableKey: string;
  clerkOauthClientId: string;
  clerkIssuer: string;
  clerkFrontendApiUrl: string;
  clerkOauthMetadataUrl: string;
  clerkOauthAuthorizeUrl: string;
  clerkOauthTokenUrl: string;
  clerkOauthRevocationUrl: string;
  clerkOauthUserInfoUrl: string;
  clerkOauthScopes: string;
  generatedAt?: string;
};

export type HostedStatus = {
  enabled: boolean;
  mode: ProviderMode;
  consentGiven: boolean;
  apiConfigured: boolean;
  remoteProjectId: string | null;
  auth: HostedAuthStatus;
  mirrorExcludePatterns: string[];
  transcriptUploadEnabled: boolean;
};

export type HostedSignInResult = {
  signedIn: boolean;
  expiresAt: string;
};

export type HostedSignInProvider = "github" | "google";

export type HostedSignInArgs = {
  provider?: HostedSignInProvider;
};

export type TerminalSessionStatus = "running" | "completed" | "failed" | "disposed";

export type TerminalSessionSummary = {
  id: string;
  laneId: string;
  laneName: string;
  ptyId: string | null;
  tracked: boolean;
  title: string;
  status: TerminalSessionStatus;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  transcriptPath: string;
  headShaStart: string | null;
  headShaEnd: string | null;
  lastOutputPreview: string | null;
};

export type TerminalSessionDetail = TerminalSessionSummary & {
  // Reserved for future expansion (goal/tool templates, derived deltas, etc.)
};

export type PtyCreateArgs = {
  laneId: string;
  cwd?: string;
  cols: number;
  rows: number;
  title: string;
  tracked?: boolean;
};

export type PtyCreateResult = {
  ptyId: string;
  sessionId: string;
};

export type PtyDataEvent = {
  ptyId: string;
  sessionId: string;
  data: string;
};

export type PtyExitEvent = {
  ptyId: string;
  sessionId: string;
  exitCode: number | null;
};

export type ListSessionsArgs = {
  laneId?: string;
  status?: TerminalSessionStatus;
  limit?: number;
};

export type ReadTranscriptTailArgs = {
  sessionId: string;
  maxBytes?: number;
};

export type ListLanesArgs = {
  includeArchived?: boolean;
};

export type CreateLaneArgs = {
  name: string;
  description?: string;
  parentLaneId?: string;
};

export type CreateChildLaneArgs = {
  parentLaneId: string;
  name: string;
  description?: string;
};

export type AttachLaneArgs = {
  name: string;
  attachedPath: string;
  description?: string;
};

export type RenameLaneArgs = {
  laneId: string;
  name: string;
};

export type ReparentLaneArgs = {
  laneId: string;
  newParentLaneId: string;
};

export type ReparentLaneResult = {
  laneId: string;
  previousParentLaneId: string | null;
  newParentLaneId: string;
  previousBaseRef: string;
  newBaseRef: string;
  preHeadSha: string | null;
  postHeadSha: string | null;
};

export type UpdateLaneAppearanceArgs = {
  laneId: string;
  color?: string | null;
  icon?: LaneIcon;
  tags?: string[] | null;
};

export type ArchiveLaneArgs = {
  laneId: string;
};

export type DeleteLaneArgs = {
  laneId: string;
  deleteBranch?: boolean;
  deleteRemoteBranch?: boolean;
  remoteName?: string;
  force?: boolean;
};

export type StackChainItem = {
  laneId: string;
  laneName: string;
  branchRef: string;
  depth: number;
  parentLaneId: string | null;
  status: LaneStatus;
};

export type RestackArgs = {
  laneId: string;
  recursive?: boolean;
};

export type RestackResult = {
  restackedLanes: string[];
  failedLaneId: string | null;
  error: string | null;
};

export type OpenLaneFolderArgs = {
  laneId: string;
};

export type ProjectOpenRepoResult = ProjectInfo;

export type DiffMode = "unstaged" | "staged" | "commit";

export type FileChange = {
  path: string;
  kind: "modified" | "added" | "deleted" | "renamed" | "untracked" | "unknown";
};

export type DiffChanges = {
  unstaged: FileChange[];
  staged: FileChange[];
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

export type DiffSide = {
  exists: boolean;
  text: string;
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

export type FilesWorkspaceKind = "primary" | "worktree" | "attached";

export type FilesWorkspace = {
  id: string;
  kind: FilesWorkspaceKind;
  laneId: string | null;
  name: string;
  rootPath: string;
  isReadOnlyByDefault: boolean;
};

export type FilesListWorkspacesArgs = {
  includeArchived?: boolean;
};

export type FileTreeChangeStatus = "M" | "A" | "D" | null;

export type FileTreeNode = {
  name: string;
  path: string; // relative to workspace root
  type: "file" | "directory";
  hasChildren?: boolean;
  children?: FileTreeNode[];
  changeStatus?: FileTreeChangeStatus;
  size?: number;
};

export type FilesListTreeArgs = {
  workspaceId: string;
  parentPath?: string;
  depth?: number;
  includeIgnored?: boolean;
};

export type FileContent = {
  content: string;
  encoding: string;
  size: number;
  languageId: string;
  isBinary: boolean;
};

export type FilesReadFileArgs = {
  workspaceId: string;
  path: string; // relative to workspace root
};

export type FilesWriteTextArgs = {
  workspaceId: string;
  path: string; // relative to workspace root
  text: string;
};

export type FilesCreateFileArgs = {
  workspaceId: string;
  path: string; // relative path
  content?: string;
};

export type FilesCreateDirectoryArgs = {
  workspaceId: string;
  path: string; // relative path
};

export type FilesRenameArgs = {
  workspaceId: string;
  oldPath: string;
  newPath: string;
};

export type FilesDeleteArgs = {
  workspaceId: string;
  path: string;
};

export type FilesWatchArgs = {
  workspaceId: string;
};

export type FileChangeEvent = {
  workspaceId: string;
  type: "created" | "modified" | "deleted" | "renamed";
  path: string;
  oldPath?: string;
  ts: string;
};

export type FilesQuickOpenArgs = {
  workspaceId: string;
  query: string;
  limit?: number;
};

export type FilesQuickOpenItem = {
  path: string;
  score: number;
};

export type FilesSearchTextArgs = {
  workspaceId: string;
  query: string;
  limit?: number;
};

export type FilesSearchTextMatch = {
  path: string;
  line: number;
  column: number;
  preview: string;
};

// react-resizable-panels uses a map of panel id -> percentage (0..100)
export type DockLayout = Record<string, number>;

export type GraphViewMode = "stack" | "risk" | "activity" | "all";

export type GraphNodePosition = {
  x: number;
  y: number;
};

export type GraphStatusFilter = "conflict" | "at-risk" | "clean" | "unknown";

export type GraphFilterState = {
  status: GraphStatusFilter[];
  laneTypes: LaneType[];
  tags: string[];
  hidePrimary: boolean;
  hideAttached: boolean;
  hideArchived: boolean;
  rootLaneId: string | null;
  search: string;
};

export type GraphLayoutSnapshot = {
  nodePositions: Record<string, GraphNodePosition>;
  collapsedLaneIds: string[];
  viewMode: GraphViewMode;
  filters: GraphFilterState;
  updatedAt: string;
};

export type GraphLayoutPreset = {
  name: string;
  byViewMode: Record<GraphViewMode, GraphLayoutSnapshot>;
  updatedAt: string;
};

export type GraphPersistedState = {
  presets: GraphLayoutPreset[];
  activePreset: string;
};

export type ProcessRestartPolicy = "never" | "on_crash";
export type StackStartOrder = "parallel" | "dependency";
export type ProcessReadinessType = "none" | "port" | "logRegex";
export type ProcessRuntimeStatus = "stopped" | "starting" | "running" | "degraded" | "stopping" | "exited" | "crashed";
export type ProcessReadinessState = "unknown" | "ready" | "not_ready";
export type StackAggregateStatus = "running" | "partial" | "stopped" | "error";
export type TestRunStatus = "running" | "passed" | "failed" | "canceled" | "timed_out";
export type TestSuiteTag = "unit" | "lint" | "integration" | "e2e" | "custom";

export type ProcessReadinessConfig =
  | { type: "none" }
  | { type: "port"; port: number }
  | { type: "logRegex"; pattern: string };

export type ConfigProcessReadiness =
  | { type?: "none" }
  | { type: "port"; port?: number }
  | { type: "logRegex"; pattern?: string };

export type ProcessDefinition = {
  id: string;
  name: string;
  command: string[];
  cwd: string;
  env: Record<string, string>;
  autostart: boolean;
  restart: ProcessRestartPolicy;
  gracefulShutdownMs: number;
  dependsOn: string[];
  readiness: ProcessReadinessConfig;
};

export type StackButtonDefinition = {
  id: string;
  name: string;
  processIds: string[];
  startOrder: StackStartOrder;
};

export type TestSuiteDefinition = {
  id: string;
  name: string;
  command: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number | null;
  tags: TestSuiteTag[];
};

export type ConfigProcessDefinition = {
  id: string;
  name?: string;
  command?: string[];
  cwd?: string;
  env?: Record<string, string>;
  autostart?: boolean;
  restart?: ProcessRestartPolicy;
  gracefulShutdownMs?: number;
  dependsOn?: string[];
  readiness?: ConfigProcessReadiness;
};

export type ConfigStackButtonDefinition = {
  id: string;
  name?: string;
  processIds?: string[];
  startOrder?: StackStartOrder;
};

export type ConfigTestSuiteDefinition = {
  id: string;
  name?: string;
  command?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  tags?: TestSuiteTag[];
};

export type LaneOverlayMatch = {
  laneIds?: string[];
  laneTypes?: LaneType[];
  namePattern?: string;
  branchPattern?: string;
  tags?: string[];
};

export type LaneOverlayOverrides = {
  env?: Record<string, string>;
  cwd?: string;
  processIds?: string[];
  testSuiteIds?: string[];
};

export type LaneOverlayPolicy = {
  id: string;
  name: string;
  enabled: boolean;
  match: LaneOverlayMatch;
  overrides: LaneOverlayOverrides;
};

export type ConfigLaneOverlayPolicy = {
  id: string;
  name?: string;
  enabled?: boolean;
  match?: LaneOverlayMatch;
  overrides?: LaneOverlayOverrides;
};

export type ProjectConfigFile = {
  version?: number;
  processes?: ConfigProcessDefinition[];
  stackButtons?: ConfigStackButtonDefinition[];
  testSuites?: ConfigTestSuiteDefinition[];
  laneOverlayPolicies?: ConfigLaneOverlayPolicy[];
  providers?: Record<string, unknown>;
};

export type ProjectConfigCandidate = {
  shared: ProjectConfigFile;
  local: ProjectConfigFile;
};

export type EffectiveProjectConfig = {
  version: number;
  processes: ProcessDefinition[];
  stackButtons: StackButtonDefinition[];
  testSuites: TestSuiteDefinition[];
  laneOverlayPolicies: LaneOverlayPolicy[];
  providerMode?: ProviderMode;
  providers?: Record<string, unknown>;
};

export type ProjectConfigValidationIssue = {
  path: string;
  message: string;
};

export type ProjectConfigValidationResult = {
  ok: boolean;
  issues: ProjectConfigValidationIssue[];
};

export type ProjectConfigTrust = {
  sharedHash: string;
  localHash: string;
  approvedSharedHash: string | null;
  requiresSharedTrust: boolean;
};

export type ProjectConfigSnapshot = {
  shared: ProjectConfigFile;
  local: ProjectConfigFile;
  effective: EffectiveProjectConfig;
  validation: ProjectConfigValidationResult;
  trust: ProjectConfigTrust;
  paths: {
    sharedPath: string;
    localPath: string;
  };
};

export type ProjectConfigDiff = {
  sharedChanged: boolean;
  localChanged: boolean;
  sharedHash: string;
  localHash: string;
  approvedSharedHash: string | null;
  requiresSharedTrust: boolean;
};

export type ProcessRuntime = {
  laneId: string;
  processId: string;
  status: ProcessRuntimeStatus;
  readiness: ProcessReadinessState;
  pid: number | null;
  startedAt: string | null;
  endedAt: string | null;
  exitCode: number | null;
  lastExitCode: number | null;
  lastEndedAt: string | null;
  uptimeMs: number | null;
  ports: number[];
  logPath: string | null;
  updatedAt: string;
};

export type ProcessListItem = {
  definition: ProcessDefinition;
  runtime: ProcessRuntime;
};

export type StackButtonStatus = StackButtonDefinition & {
  status: StackAggregateStatus;
};

export type ProcessLogEvent = {
  type: "log";
  laneId: string;
  processId: string;
  stream: "stdout" | "stderr";
  chunk: string;
  ts: string;
};

export type ProcessRuntimeEvent = {
  type: "runtime";
  runtime: ProcessRuntime;
};

export type ProcessEvent = ProcessLogEvent | ProcessRuntimeEvent;

export type TestRunSummary = {
  id: string;
  suiteId: string;
  suiteName: string;
  laneId: string | null;
  status: TestRunStatus;
  exitCode: number | null;
  durationMs: number | null;
  startedAt: string;
  endedAt: string | null;
  logPath: string;
};

export type TestRunEvent = {
  type: "run";
  run: TestRunSummary;
};

export type TestLogEvent = {
  type: "log";
  runId: string;
  suiteId: string;
  stream: "stdout" | "stderr";
  chunk: string;
  ts: string;
};

export type TestEvent = TestRunEvent | TestLogEvent;

export type ProcessActionArgs = {
  laneId: string;
  processId: string;
};

export type ProcessStackArgs = {
  laneId: string;
  stackId: string;
};

export type GetProcessLogTailArgs = {
  laneId: string;
  processId: string;
  maxBytes?: number;
};

export type RunTestSuiteArgs = {
  laneId: string;
  suiteId: string;
};

export type StopTestRunArgs = {
  runId: string;
};

export type ListTestRunsArgs = {
  laneId?: string;
  suiteId?: string;
  limit?: number;
};

export type GetTestLogTailArgs = {
  runId: string;
  maxBytes?: number;
};

export type ProjectConfigValidateArgs = {
  candidate: ProjectConfigCandidate;
};

export type ProjectConfigSaveArgs = {
  candidate: ProjectConfigCandidate;
};

export type ProjectConfigConfirmTrustArgs = {
  sharedHash?: string;
};

export type GitSyncMode = "merge" | "rebase";

export type GitFileActionArgs = {
  laneId: string;
  path: string;
};

export type GitCommitArgs = {
  laneId: string;
  message: string;
  amend?: boolean;
};

export type GitRevertArgs = {
  laneId: string;
  commitSha: string;
};

export type GitCherryPickArgs = {
  laneId: string;
  commitSha: string;
};

export type GitStashPushArgs = {
  laneId: string;
  message?: string;
  includeUntracked?: boolean;
};

export type GitStashRefArgs = {
  laneId: string;
  stashRef: string;
};

export type GitSyncArgs = {
  laneId: string;
  mode?: GitSyncMode;
  baseRef?: string;
};

export type GitPushArgs = {
  laneId: string;
  forceWithLease?: boolean;
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
};

export type GitListCommitFilesArgs = {
  laneId: string;
  commitSha: string;
};

export type GitStashSummary = {
  ref: string;
  subject: string;
  createdAt: string | null;
};

export type PackType = "project" | "lane";

export type PackSummary = {
  packType: PackType;
  path: string;
  exists: boolean;
  deterministicUpdatedAt: string | null;
  narrativeUpdatedAt: string | null;
  lastHeadSha: string | null;
  body: string;
};

export type SessionDeltaSummary = {
  sessionId: string;
  laneId: string;
  startedAt: string;
  endedAt: string | null;
  headShaStart: string | null;
  headShaEnd: string | null;
  filesChanged: number;
  insertions: number;
  deletions: number;
  touchedFiles: string[];
  failureLines: string[];
  computedAt: string | null;
};

export type ListOperationsArgs = {
  laneId?: string;
  kind?: string;
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
