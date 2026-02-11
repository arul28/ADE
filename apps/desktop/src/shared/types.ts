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

export type LaneStatus = {
  dirty: boolean;
  ahead: number;
  behind: number;
};

export type LaneSummary = {
  id: string;
  name: string;
  description?: string | null;
  baseRef: string;
  branchRef: string;
  worktreePath: string;
  status: LaneStatus;
  createdAt: string;
  archivedAt?: string | null;
};

export type TerminalSessionStatus = "running" | "completed" | "failed" | "disposed";

export type TerminalSessionSummary = {
  id: string;
  laneId: string;
  laneName: string;
  ptyId: string | null;
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
};

export type RenameLaneArgs = {
  laneId: string;
  name: string;
};

export type ArchiveLaneArgs = {
  laneId: string;
};

export type DeleteLaneArgs = {
  laneId: string;
  deleteBranch?: boolean;
  force?: boolean;
};

export type OpenLaneFolderArgs = {
  laneId: string;
};

export type ProjectOpenRepoResult = ProjectInfo;

export type DiffMode = "unstaged" | "staged";

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

// react-resizable-panels uses a map of panel id -> percentage (0..100)
export type DockLayout = Record<string, number>;

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

export type ProjectConfigFile = {
  version?: number;
  processes?: ConfigProcessDefinition[];
  stackButtons?: ConfigStackButtonDefinition[];
  testSuites?: ConfigTestSuiteDefinition[];
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
  processId: string;
};

export type ProcessStackArgs = {
  stackId: string;
};

export type GetProcessLogTailArgs = {
  processId: string;
  maxBytes?: number;
};

export type RunTestSuiteArgs = {
  suiteId: string;
};

export type StopTestRunArgs = {
  runId: string;
};

export type ListTestRunsArgs = {
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
  authorName: string;
  authoredAt: string;
  subject: string;
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
