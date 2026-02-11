import type {
  AppInfo,
  ArchiveLaneArgs,
  CreateLaneArgs,
  DeleteLaneArgs,
  DiffChanges,
  DockLayout,
  FileDiff,
  GetDiffChangesArgs,
  GetFileDiffArgs,
  GetProcessLogTailArgs,
  GetTestLogTailArgs,
  GitActionResult,
  GitCherryPickArgs,
  GitCommitArgs,
  GitCommitSummary,
  GitFileActionArgs,
  GitPushArgs,
  GitRevertArgs,
  GitStashPushArgs,
  GitStashRefArgs,
  GitStashSummary,
  GitSyncArgs,
  LaneSummary,
  ListLanesArgs,
  ListOperationsArgs,
  ListSessionsArgs,
  ListTestRunsArgs,
  OperationRecord,
  PackSummary,
  ProcessActionArgs,
  ProcessDefinition,
  ProcessEvent,
  ProcessRuntime,
  ProcessStackArgs,
  ProjectConfigCandidate,
  ProjectConfigDiff,
  ProjectConfigSnapshot,
  ProjectConfigTrust,
  ProjectConfigValidationResult,
  ProjectInfo,
  PtyCreateArgs,
  PtyCreateResult,
  PtyDataEvent,
  PtyExitEvent,
  ReadTranscriptTailArgs,
  RenameLaneArgs,
  RunTestSuiteArgs,
  SessionDeltaSummary,
  StopTestRunArgs,
  TerminalSessionDetail,
  TerminalSessionSummary,
  TestEvent,
  TestRunSummary,
  TestSuiteDefinition,
  WriteTextAtomicArgs
} from "../shared/types";

export {};

declare global {
  interface Window {
    ade: {
      app: {
        ping: () => Promise<"pong">;
        getInfo: () => Promise<AppInfo>;
        getProject: () => Promise<ProjectInfo>;
      };
      project: {
        openRepo: () => Promise<ProjectInfo>;
        openAdeFolder: () => Promise<void>;
      };
      lanes: {
        list: (args?: ListLanesArgs) => Promise<LaneSummary[]>;
        create: (args: CreateLaneArgs) => Promise<LaneSummary>;
        rename: (args: RenameLaneArgs) => Promise<void>;
        archive: (args: ArchiveLaneArgs) => Promise<void>;
        delete: (args: DeleteLaneArgs) => Promise<void>;
        openFolder: (args: { laneId: string }) => Promise<void>;
      };
      sessions: {
        list: (args?: ListSessionsArgs) => Promise<TerminalSessionSummary[]>;
        get: (sessionId: string) => Promise<TerminalSessionDetail | null>;
        readTranscriptTail: (args: ReadTranscriptTailArgs) => Promise<string>;
        getDelta: (sessionId: string) => Promise<SessionDeltaSummary | null>;
      };
      pty: {
        create: (args: PtyCreateArgs) => Promise<PtyCreateResult>;
        write: (args: { ptyId: string; data: string }) => Promise<void>;
        resize: (args: { ptyId: string; cols: number; rows: number }) => Promise<void>;
        dispose: (args: { ptyId: string }) => Promise<void>;
        onData: (cb: (ev: PtyDataEvent) => void) => () => void;
        onExit: (cb: (ev: PtyExitEvent) => void) => () => void;
      };
      diff: {
        getChanges: (args: GetDiffChangesArgs) => Promise<DiffChanges>;
        getFile: (args: GetFileDiffArgs) => Promise<FileDiff>;
      };
      files: {
        writeTextAtomic: (args: WriteTextAtomicArgs) => Promise<void>;
      };
      git: {
        stageFile: (args: GitFileActionArgs) => Promise<GitActionResult>;
        unstageFile: (args: GitFileActionArgs) => Promise<GitActionResult>;
        discardFile: (args: GitFileActionArgs) => Promise<GitActionResult>;
        restoreStagedFile: (args: GitFileActionArgs) => Promise<GitActionResult>;
        commit: (args: GitCommitArgs) => Promise<GitActionResult>;
        listRecentCommits: (args: { laneId: string; limit?: number }) => Promise<GitCommitSummary[]>;
        revertCommit: (args: GitRevertArgs) => Promise<GitActionResult>;
        cherryPickCommit: (args: GitCherryPickArgs) => Promise<GitActionResult>;
        stashPush: (args: GitStashPushArgs) => Promise<GitActionResult>;
        stashList: (args: { laneId: string }) => Promise<GitStashSummary[]>;
        stashApply: (args: GitStashRefArgs) => Promise<GitActionResult>;
        stashPop: (args: GitStashRefArgs) => Promise<GitActionResult>;
        stashDrop: (args: GitStashRefArgs) => Promise<GitActionResult>;
        fetch: (args: { laneId: string }) => Promise<GitActionResult>;
        sync: (args: GitSyncArgs) => Promise<GitActionResult>;
        push: (args: GitPushArgs) => Promise<GitActionResult>;
      };
      packs: {
        getProjectPack: () => Promise<PackSummary>;
        getLanePack: (laneId: string) => Promise<PackSummary>;
        refreshLanePack: (laneId: string) => Promise<PackSummary>;
      };
      history: {
        listOperations: (args?: ListOperationsArgs) => Promise<OperationRecord[]>;
      };
      layout: {
        get: (layoutId: string) => Promise<DockLayout | null>;
        set: (layoutId: string, layout: DockLayout) => Promise<void>;
      };
      processes: {
        listDefinitions: () => Promise<ProcessDefinition[]>;
        listRuntime: () => Promise<ProcessRuntime[]>;
        start: (args: ProcessActionArgs) => Promise<ProcessRuntime>;
        stop: (args: ProcessActionArgs) => Promise<ProcessRuntime>;
        restart: (args: ProcessActionArgs) => Promise<ProcessRuntime>;
        kill: (args: ProcessActionArgs) => Promise<ProcessRuntime>;
        startStack: (args: ProcessStackArgs) => Promise<void>;
        stopStack: (args: ProcessStackArgs) => Promise<void>;
        restartStack: (args: ProcessStackArgs) => Promise<void>;
        startAll: () => Promise<void>;
        stopAll: () => Promise<void>;
        getLogTail: (args: GetProcessLogTailArgs) => Promise<string>;
        onEvent: (cb: (ev: ProcessEvent) => void) => () => void;
      };
      tests: {
        listSuites: () => Promise<TestSuiteDefinition[]>;
        run: (args: RunTestSuiteArgs) => Promise<TestRunSummary>;
        stop: (args: StopTestRunArgs) => Promise<void>;
        listRuns: (args?: ListTestRunsArgs) => Promise<TestRunSummary[]>;
        getLogTail: (args: GetTestLogTailArgs) => Promise<string>;
        onEvent: (cb: (ev: TestEvent) => void) => () => void;
      };
      projectConfig: {
        get: () => Promise<ProjectConfigSnapshot>;
        validate: (candidate: ProjectConfigCandidate) => Promise<ProjectConfigValidationResult>;
        save: (candidate: ProjectConfigCandidate) => Promise<ProjectConfigSnapshot>;
        diffAgainstDisk: () => Promise<ProjectConfigDiff>;
        confirmTrust: (arg?: { sharedHash?: string }) => Promise<ProjectConfigTrust>;
      };
    };
  }
}
