import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "../shared/ipc";
import type {
  BatchAssessmentResult,
  ApplyConflictProposalArgs,
  AttachLaneArgs,
  AppInfo,
  ArchiveLaneArgs,
  ConflictProposal,
  ConflictEventPayload,
  ConflictOverlap,
  ConflictStatus,
  CreateLaneArgs,
  CreateChildLaneArgs,
  DeleteLaneArgs,
  DiffChanges,
  DockLayout,
  GraphPersistedState,
  FileChangeEvent,
  FileContent,
  FileDiff,
  FileTreeNode,
  FilesCreateDirectoryArgs,
  FilesCreateFileArgs,
  FilesDeleteArgs,
  FilesListTreeArgs,
  FilesListWorkspacesArgs,
  FilesQuickOpenArgs,
  FilesQuickOpenItem,
  FilesReadFileArgs,
  FilesRenameArgs,
  FilesSearchTextArgs,
  FilesSearchTextMatch,
  FilesWatchArgs,
  FilesWorkspace,
  FilesWriteTextArgs,
  GitActionResult,
  GitCherryPickArgs,
  GitCommitArgs,
  GitCommitSummary,
  GitListCommitFilesArgs,
  GitFileActionArgs,
  GitPushArgs,
  GitRevertArgs,
  GitStashPushArgs,
  GitStashRefArgs,
  GitStashSummary,
  GitSyncArgs,
  GitHubStatus,
  CreatePrFromLaneArgs,
  LinkPrToLaneArgs,
  PrCheck,
  PrReview,
  PrStatus,
  PrSummary,
  UpdatePrDescriptionArgs,
  LandPrArgs,
  LandStackArgs,
  LandResult,
  GetDiffChangesArgs,
  GetLaneConflictStatusArgs,
  GetFileDiffArgs,
  GetProcessLogTailArgs,
  GetTestLogTailArgs,
  HostedArtifactResult,
  HostedBootstrapConfig,
  HostedJobStatusResult,
  HostedJobSubmissionArgs,
  HostedJobSubmissionResult,
  HostedMirrorSyncArgs,
  HostedMirrorSyncResult,
  HostedSignInArgs,
  HostedSignInResult,
  HostedStatus,
  LaneSummary,
  ListOverlapsArgs,
  ListLanesArgs,
  ListOperationsArgs,
  ListSessionsArgs,
  ListTestRunsArgs,
  MergeSimulationArgs,
  MergeSimulationResult,
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
  RiskMatrixEntry,
  RunConflictPredictionArgs,
  RequestConflictProposalArgs,
  UndoConflictProposalArgs,
  ReadTranscriptTailArgs,
  RenameLaneArgs,
  ReparentLaneArgs,
  ReparentLaneResult,
  RestackArgs,
  RestackResult,
  UpdateLaneAppearanceArgs,
  RunTestSuiteArgs,
  SessionDeltaSummary,
  StackChainItem,
  StopTestRunArgs,
  TerminalSessionDetail,
  TerminalSessionSummary,
  TestEvent,
  TestRunSummary,
  TestSuiteDefinition,
  WriteTextAtomicArgs
} from "../shared/types";

contextBridge.exposeInMainWorld("ade", {
  app: {
    ping: async (): Promise<"pong"> => ipcRenderer.invoke(IPC.appPing),
    getInfo: async (): Promise<AppInfo> => ipcRenderer.invoke(IPC.appGetInfo),
    getProject: async (): Promise<ProjectInfo> => ipcRenderer.invoke(IPC.appGetProject)
  },
  project: {
    openRepo: async (): Promise<ProjectInfo> => ipcRenderer.invoke(IPC.projectOpenRepo),
    openAdeFolder: async (): Promise<void> => ipcRenderer.invoke(IPC.projectOpenAdeFolder)
  },
  lanes: {
    list: async (args: ListLanesArgs = {}): Promise<LaneSummary[]> => ipcRenderer.invoke(IPC.lanesList, args),
    create: async (args: CreateLaneArgs): Promise<LaneSummary> => ipcRenderer.invoke(IPC.lanesCreate, args),
    createChild: async (args: CreateChildLaneArgs): Promise<LaneSummary> => ipcRenderer.invoke(IPC.lanesCreateChild, args),
    attach: async (args: AttachLaneArgs): Promise<LaneSummary> => ipcRenderer.invoke(IPC.lanesAttach, args),
    rename: async (args: RenameLaneArgs): Promise<void> => ipcRenderer.invoke(IPC.lanesRename, args),
    reparent: async (args: ReparentLaneArgs): Promise<ReparentLaneResult> => ipcRenderer.invoke(IPC.lanesReparent, args),
    updateAppearance: async (args: UpdateLaneAppearanceArgs): Promise<void> =>
      ipcRenderer.invoke(IPC.lanesUpdateAppearance, args),
    archive: async (args: ArchiveLaneArgs): Promise<void> => ipcRenderer.invoke(IPC.lanesArchive, args),
    delete: async (args: DeleteLaneArgs): Promise<void> => ipcRenderer.invoke(IPC.lanesDelete, args),
    getStackChain: async (laneId: string): Promise<StackChainItem[]> =>
      ipcRenderer.invoke(IPC.lanesGetStackChain, { laneId }),
    getChildren: async (laneId: string): Promise<LaneSummary[]> => ipcRenderer.invoke(IPC.lanesGetChildren, { laneId }),
    restack: async (args: RestackArgs): Promise<RestackResult> => ipcRenderer.invoke(IPC.lanesRestack, args),
    openFolder: async (args: { laneId: string }): Promise<void> => ipcRenderer.invoke(IPC.lanesOpenFolder, args)
  },
  sessions: {
    list: async (args: ListSessionsArgs = {}): Promise<TerminalSessionSummary[]> =>
      ipcRenderer.invoke(IPC.sessionsList, args),
    get: async (sessionId: string): Promise<TerminalSessionDetail | null> =>
      ipcRenderer.invoke(IPC.sessionsGet, { sessionId }),
    readTranscriptTail: async (args: ReadTranscriptTailArgs): Promise<string> =>
      ipcRenderer.invoke(IPC.sessionsReadTranscriptTail, args),
    getDelta: async (sessionId: string): Promise<SessionDeltaSummary | null> =>
      ipcRenderer.invoke(IPC.sessionsGetDelta, { sessionId })
  },
  pty: {
    create: async (args: PtyCreateArgs): Promise<PtyCreateResult> => ipcRenderer.invoke(IPC.ptyCreate, args),
    write: async (arg: { ptyId: string; data: string }): Promise<void> => ipcRenderer.invoke(IPC.ptyWrite, arg),
    resize: async (arg: { ptyId: string; cols: number; rows: number }): Promise<void> =>
      ipcRenderer.invoke(IPC.ptyResize, arg),
    dispose: async (arg: { ptyId: string }): Promise<void> => ipcRenderer.invoke(IPC.ptyDispose, arg),
    onData: (cb: (ev: PtyDataEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: PtyDataEvent) => cb(payload);
      ipcRenderer.on(IPC.ptyData, listener);
      return () => ipcRenderer.removeListener(IPC.ptyData, listener);
    },
    onExit: (cb: (ev: PtyExitEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: PtyExitEvent) => cb(payload);
      ipcRenderer.on(IPC.ptyExit, listener);
      return () => ipcRenderer.removeListener(IPC.ptyExit, listener);
    }
  },
  diff: {
    getChanges: async (args: GetDiffChangesArgs): Promise<DiffChanges> => ipcRenderer.invoke(IPC.diffGetChanges, args),
    getFile: async (args: GetFileDiffArgs): Promise<FileDiff> => ipcRenderer.invoke(IPC.diffGetFile, args)
  },
  files: {
    writeTextAtomic: async (args: WriteTextAtomicArgs): Promise<void> => ipcRenderer.invoke(IPC.filesWriteTextAtomic, args),
    listWorkspaces: async (args: FilesListWorkspacesArgs = {}): Promise<FilesWorkspace[]> =>
      ipcRenderer.invoke(IPC.filesListWorkspaces, args),
    listTree: async (args: FilesListTreeArgs): Promise<FileTreeNode[]> => ipcRenderer.invoke(IPC.filesListTree, args),
    readFile: async (args: FilesReadFileArgs): Promise<FileContent> => ipcRenderer.invoke(IPC.filesReadFile, args),
    writeText: async (args: FilesWriteTextArgs): Promise<void> => ipcRenderer.invoke(IPC.filesWriteText, args),
    createFile: async (args: FilesCreateFileArgs): Promise<void> => ipcRenderer.invoke(IPC.filesCreateFile, args),
    createDirectory: async (args: FilesCreateDirectoryArgs): Promise<void> =>
      ipcRenderer.invoke(IPC.filesCreateDirectory, args),
    rename: async (args: FilesRenameArgs): Promise<void> => ipcRenderer.invoke(IPC.filesRename, args),
    delete: async (args: FilesDeleteArgs): Promise<void> => ipcRenderer.invoke(IPC.filesDelete, args),
    watchChanges: async (args: FilesWatchArgs): Promise<void> => ipcRenderer.invoke(IPC.filesWatchChanges, args),
    stopWatching: async (args: FilesWatchArgs): Promise<void> => ipcRenderer.invoke(IPC.filesStopWatching, args),
    quickOpen: async (args: FilesQuickOpenArgs): Promise<FilesQuickOpenItem[]> => ipcRenderer.invoke(IPC.filesQuickOpen, args),
    searchText: async (args: FilesSearchTextArgs): Promise<FilesSearchTextMatch[]> => ipcRenderer.invoke(IPC.filesSearchText, args),
    onChange: (cb: (ev: FileChangeEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: FileChangeEvent) => cb(payload);
      ipcRenderer.on(IPC.filesChange, listener);
      return () => ipcRenderer.removeListener(IPC.filesChange, listener);
    }
  },
  git: {
    stageFile: async (args: GitFileActionArgs): Promise<GitActionResult> => ipcRenderer.invoke(IPC.gitStageFile, args),
    unstageFile: async (args: GitFileActionArgs): Promise<GitActionResult> => ipcRenderer.invoke(IPC.gitUnstageFile, args),
    discardFile: async (args: GitFileActionArgs): Promise<GitActionResult> => ipcRenderer.invoke(IPC.gitDiscardFile, args),
    restoreStagedFile: async (args: GitFileActionArgs): Promise<GitActionResult> =>
      ipcRenderer.invoke(IPC.gitRestoreStagedFile, args),
    commit: async (args: GitCommitArgs): Promise<GitActionResult> => ipcRenderer.invoke(IPC.gitCommit, args),
    listRecentCommits: async (args: { laneId: string; limit?: number }): Promise<GitCommitSummary[]> =>
      ipcRenderer.invoke(IPC.gitListRecentCommits, args),
    listCommitFiles: async (args: GitListCommitFilesArgs): Promise<string[]> =>
      ipcRenderer.invoke(IPC.gitListCommitFiles, args),
    revertCommit: async (args: GitRevertArgs): Promise<GitActionResult> => ipcRenderer.invoke(IPC.gitRevertCommit, args),
    cherryPickCommit: async (args: GitCherryPickArgs): Promise<GitActionResult> =>
      ipcRenderer.invoke(IPC.gitCherryPickCommit, args),
    stashPush: async (args: GitStashPushArgs): Promise<GitActionResult> => ipcRenderer.invoke(IPC.gitStashPush, args),
    stashList: async (args: { laneId: string }): Promise<GitStashSummary[]> => ipcRenderer.invoke(IPC.gitStashList, args),
    stashApply: async (args: GitStashRefArgs): Promise<GitActionResult> => ipcRenderer.invoke(IPC.gitStashApply, args),
    stashPop: async (args: GitStashRefArgs): Promise<GitActionResult> => ipcRenderer.invoke(IPC.gitStashPop, args),
    stashDrop: async (args: GitStashRefArgs): Promise<GitActionResult> => ipcRenderer.invoke(IPC.gitStashDrop, args),
    fetch: async (args: { laneId: string }): Promise<GitActionResult> => ipcRenderer.invoke(IPC.gitFetch, args),
    sync: async (args: GitSyncArgs): Promise<GitActionResult> => ipcRenderer.invoke(IPC.gitSync, args),
    push: async (args: GitPushArgs): Promise<GitActionResult> => ipcRenderer.invoke(IPC.gitPush, args)
  },
  conflicts: {
    getLaneStatus: async (args: GetLaneConflictStatusArgs): Promise<ConflictStatus> =>
      ipcRenderer.invoke(IPC.conflictsGetLaneStatus, args),
    listOverlaps: async (args: ListOverlapsArgs): Promise<ConflictOverlap[]> =>
      ipcRenderer.invoke(IPC.conflictsListOverlaps, args),
    getRiskMatrix: async (): Promise<RiskMatrixEntry[]> => ipcRenderer.invoke(IPC.conflictsGetRiskMatrix),
    simulateMerge: async (args: MergeSimulationArgs): Promise<MergeSimulationResult> =>
      ipcRenderer.invoke(IPC.conflictsSimulateMerge, args),
    runPrediction: async (args: RunConflictPredictionArgs = {}): Promise<BatchAssessmentResult> =>
      ipcRenderer.invoke(IPC.conflictsRunPrediction, args),
    getBatchAssessment: async (): Promise<BatchAssessmentResult> => ipcRenderer.invoke(IPC.conflictsGetBatchAssessment),
    listProposals: async (laneId: string): Promise<ConflictProposal[]> =>
      ipcRenderer.invoke(IPC.conflictsListProposals, { laneId }),
    requestProposal: async (args: RequestConflictProposalArgs): Promise<ConflictProposal> =>
      ipcRenderer.invoke(IPC.conflictsRequestProposal, args),
    applyProposal: async (args: ApplyConflictProposalArgs): Promise<ConflictProposal> =>
      ipcRenderer.invoke(IPC.conflictsApplyProposal, args),
    undoProposal: async (args: UndoConflictProposalArgs): Promise<ConflictProposal> =>
      ipcRenderer.invoke(IPC.conflictsUndoProposal, args),
    onEvent: (cb: (ev: ConflictEventPayload) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: ConflictEventPayload) => cb(payload);
      ipcRenderer.on(IPC.conflictsEvent, listener);
      return () => ipcRenderer.removeListener(IPC.conflictsEvent, listener);
    }
  },
  packs: {
    getProjectPack: async (): Promise<PackSummary> => ipcRenderer.invoke(IPC.packsGetProjectPack),
    getLanePack: async (laneId: string): Promise<PackSummary> => ipcRenderer.invoke(IPC.packsGetLanePack, { laneId }),
    refreshLanePack: async (laneId: string): Promise<PackSummary> => ipcRenderer.invoke(IPC.packsRefreshLanePack, { laneId }),
    applyHostedNarrative: async (args: { laneId: string; narrative: string }): Promise<PackSummary> =>
      ipcRenderer.invoke(IPC.packsApplyHostedNarrative, args),
    generateNarrative: async (laneId: string): Promise<PackSummary> =>
      ipcRenderer.invoke(IPC.packsGenerateNarrative, { laneId })
  },
  github: {
    getStatus: async (): Promise<GitHubStatus> => ipcRenderer.invoke(IPC.githubGetStatus),
    setToken: async (token: string): Promise<GitHubStatus> => ipcRenderer.invoke(IPC.githubSetToken, { token }),
    clearToken: async (): Promise<GitHubStatus> => ipcRenderer.invoke(IPC.githubClearToken)
  },
  prs: {
    createFromLane: async (args: CreatePrFromLaneArgs): Promise<PrSummary> => ipcRenderer.invoke(IPC.prsCreateFromLane, args),
    linkToLane: async (args: LinkPrToLaneArgs): Promise<PrSummary> => ipcRenderer.invoke(IPC.prsLinkToLane, args),
    getForLane: async (laneId: string): Promise<PrSummary | null> => ipcRenderer.invoke(IPC.prsGetForLane, { laneId }),
    listAll: async (): Promise<PrSummary[]> => ipcRenderer.invoke(IPC.prsListAll),
    refresh: async (args: { prId?: string } = {}): Promise<PrSummary[]> => ipcRenderer.invoke(IPC.prsRefresh, args),
    getStatus: async (prId: string): Promise<PrStatus> => ipcRenderer.invoke(IPC.prsGetStatus, { prId }),
    getChecks: async (prId: string): Promise<PrCheck[]> => ipcRenderer.invoke(IPC.prsGetChecks, { prId }),
    getReviews: async (prId: string): Promise<PrReview[]> => ipcRenderer.invoke(IPC.prsGetReviews, { prId }),
    updateDescription: async (args: UpdatePrDescriptionArgs): Promise<void> => ipcRenderer.invoke(IPC.prsUpdateDescription, args),
    draftDescription: async (laneId: string): Promise<{ title: string; body: string }> =>
      ipcRenderer.invoke(IPC.prsDraftDescription, { laneId }),
    land: async (args: LandPrArgs): Promise<LandResult> => ipcRenderer.invoke(IPC.prsLand, args),
    landStack: async (args: LandStackArgs): Promise<LandResult[]> => ipcRenderer.invoke(IPC.prsLandStack, args),
    openInGitHub: async (prId: string): Promise<void> => ipcRenderer.invoke(IPC.prsOpenInGitHub, { prId })
  },
  hosted: {
    getStatus: async (): Promise<HostedStatus> => ipcRenderer.invoke(IPC.hostedGetStatus),
    getBootstrapConfig: async (): Promise<HostedBootstrapConfig | null> => ipcRenderer.invoke(IPC.hostedGetBootstrapConfig),
    applyBootstrapConfig: async (): Promise<HostedBootstrapConfig> => ipcRenderer.invoke(IPC.hostedApplyBootstrapConfig),
    signIn: async (args: HostedSignInArgs = {}): Promise<HostedSignInResult> => ipcRenderer.invoke(IPC.hostedSignIn, args),
    signOut: async (): Promise<void> => ipcRenderer.invoke(IPC.hostedSignOut),
    syncMirror: async (args: HostedMirrorSyncArgs = {}): Promise<HostedMirrorSyncResult> =>
      ipcRenderer.invoke(IPC.hostedSyncMirror, args),
    submitJob: async (args: HostedJobSubmissionArgs): Promise<HostedJobSubmissionResult> =>
      ipcRenderer.invoke(IPC.hostedSubmitJob, args),
    getJob: async (jobId: string): Promise<HostedJobStatusResult> =>
      ipcRenderer.invoke(IPC.hostedGetJob, { jobId }),
    getArtifact: async (artifactId: string): Promise<HostedArtifactResult> =>
      ipcRenderer.invoke(IPC.hostedGetArtifact, { artifactId })
  },
  history: {
    listOperations: async (args: ListOperationsArgs = {}): Promise<OperationRecord[]> =>
      ipcRenderer.invoke(IPC.historyListOperations, args)
  },
  layout: {
    get: async (layoutId: string): Promise<DockLayout | null> => ipcRenderer.invoke(IPC.layoutGet, { layoutId }),
    set: async (layoutId: string, layout: DockLayout): Promise<void> =>
      ipcRenderer.invoke(IPC.layoutSet, { layoutId, layout })
  },
  graphState: {
    get: async (projectId: string): Promise<GraphPersistedState | null> =>
      ipcRenderer.invoke(IPC.graphStateGet, { projectId }),
    set: async (projectId: string, state: GraphPersistedState): Promise<void> =>
      ipcRenderer.invoke(IPC.graphStateSet, { projectId, state })
  },
  processes: {
    listDefinitions: async (): Promise<ProcessDefinition[]> => ipcRenderer.invoke(IPC.processesListDefinitions),
    listRuntime: async (laneId: string): Promise<ProcessRuntime[]> => ipcRenderer.invoke(IPC.processesListRuntime, { laneId }),
    start: async (args: ProcessActionArgs): Promise<ProcessRuntime> => ipcRenderer.invoke(IPC.processesStart, args),
    stop: async (args: ProcessActionArgs): Promise<ProcessRuntime> => ipcRenderer.invoke(IPC.processesStop, args),
    restart: async (args: ProcessActionArgs): Promise<ProcessRuntime> => ipcRenderer.invoke(IPC.processesRestart, args),
    kill: async (args: ProcessActionArgs): Promise<ProcessRuntime> => ipcRenderer.invoke(IPC.processesKill, args),
    startStack: async (args: ProcessStackArgs): Promise<void> => ipcRenderer.invoke(IPC.processesStartStack, args),
    stopStack: async (args: ProcessStackArgs): Promise<void> => ipcRenderer.invoke(IPC.processesStopStack, args),
    restartStack: async (args: ProcessStackArgs): Promise<void> => ipcRenderer.invoke(IPC.processesRestartStack, args),
    startAll: async (args: { laneId: string }): Promise<void> => ipcRenderer.invoke(IPC.processesStartAll, args),
    stopAll: async (args: { laneId: string }): Promise<void> => ipcRenderer.invoke(IPC.processesStopAll, args),
    getLogTail: async (args: GetProcessLogTailArgs): Promise<string> => ipcRenderer.invoke(IPC.processesGetLogTail, args),
    onEvent: (cb: (ev: ProcessEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: ProcessEvent) => cb(payload);
      ipcRenderer.on(IPC.processesEvent, listener);
      return () => ipcRenderer.removeListener(IPC.processesEvent, listener);
    }
  },
  tests: {
    listSuites: async (): Promise<TestSuiteDefinition[]> => ipcRenderer.invoke(IPC.testsListSuites),
    run: async (args: RunTestSuiteArgs): Promise<TestRunSummary> => ipcRenderer.invoke(IPC.testsRun, args),
    stop: async (args: StopTestRunArgs): Promise<void> => ipcRenderer.invoke(IPC.testsStop, args),
    listRuns: async (args: ListTestRunsArgs = {}): Promise<TestRunSummary[]> => ipcRenderer.invoke(IPC.testsListRuns, args),
    getLogTail: async (args: GetTestLogTailArgs): Promise<string> => ipcRenderer.invoke(IPC.testsGetLogTail, args),
    onEvent: (cb: (ev: TestEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: TestEvent) => cb(payload);
      ipcRenderer.on(IPC.testsEvent, listener);
      return () => ipcRenderer.removeListener(IPC.testsEvent, listener);
    }
  },
  projectConfig: {
    get: async (): Promise<ProjectConfigSnapshot> => ipcRenderer.invoke(IPC.projectConfigGet),
    validate: async (candidate: ProjectConfigCandidate): Promise<ProjectConfigValidationResult> =>
      ipcRenderer.invoke(IPC.projectConfigValidate, { candidate }),
    save: async (candidate: ProjectConfigCandidate): Promise<ProjectConfigSnapshot> =>
      ipcRenderer.invoke(IPC.projectConfigSave, { candidate }),
    diffAgainstDisk: async (): Promise<ProjectConfigDiff> => ipcRenderer.invoke(IPC.projectConfigDiffAgainstDisk),
    confirmTrust: async (arg: { sharedHash?: string } = {}): Promise<ProjectConfigTrust> =>
      ipcRenderer.invoke(IPC.projectConfigConfirmTrust, arg)
  }
});
