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
